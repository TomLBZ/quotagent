"""AC-NEGO-003：谈判轮次与让步（服务层）——FR-NEGO-001 / FR-NEGO-002。

规格来源：`docs/design/17-negotiation-contract.md` §2–§5、`docs/design/16-negotiation-design.md` §3（机检点 15 条）、
ADR-0019。本机检要求（逐条对应设计 §3 的 15 个机检点）：

  ① 正常链（开线程→声明边界→请求门→人批准→提交轮次）落 `negotiate/round`（intent，键齐、round_key 可手算）；
  ② 越界被拒且**落痕**：超 `max_concession_pct` / 低于 `floor` / 超 `band` 三种各一条，都落 `negotiate/round-rejected`
     （带 `code`/`reason`/`next_action`），都**不落** `negotiate/round`，且**不过门**（门请求数不增）；
  ③ 缺门必拒（`ApprovalRequired`）且不落 `negotiate/round`；门绑定 `scope`+`ref`，不可跨线程/跨轮复用；
  ④ 轮次上限（含被拒尝试计入用量；**重启后从账本重建**，用量不重置，第 N+1 次仍被拒）；
  ⑤ `recompute` 同输入逐字节一致、只用账本行内数字、不含时间戳；跨 realm 抛 `PrivateAccessDenied`；
  ⑥ 同 `(thread_id, attempt_no)` 重复提交：同内容幂等（同一 `round_key`、账本行数不变），不同内容抛
     `NegotiationRoundConflict`（不静默追加第二条事实）；
  ⑦ **不产生义务**：运行期账本无 `commitment` 类事件、无 PO/授标/对外报价事件；静态（AST）无承诺出口调用；
  ⑧ 账本链仍真（`verify_report()["ok"]`、投影计数与实际行数一致）；
  ⑨ **无墙钟**：静态（AST）无 `datetime.now`/`time.time`/`utc_now`/`utcnow` 等时钟调用与时钟模块导入，
     拒绝消息里也没有绝对时刻；
  ⑩ 未知线程/未知轮次抛对应异常；缺 `negotiate.*` 任一键即拒（**不兜默认值**）；事件模式与设计 §5 一致（无 waterfall）。

【未验证 / 契约耦合（如实写在代码里，不假装通过）】
  · `attempt_no` 的取法：本机检按契约 §2.2 的"`approval_ref` 恒为 `{thread_id}:a{attempt_no}`"把**批准 ref 里的轮号**
    当作该轮的 `attempt_no`（无批准时按 `rounds_used + 1`）。若实现把 `attempt_no` 一律取成"用量 +1"，
    则第 ⑥ 条（幂等/冲突）会红——那是真源冲突，需要实现方或契约一方让步，不能靠放水掩盖。
  · `policy` 形状：按契约 §2.3 的键路径，`policy` 是**根策略**（含 `negotiate.*` 与 `pricing.authorized_band`）。
  · 三种越界值由本文件按成本基线手算（见 `FLOOR`/`CEILING` 注释），不引用实现的内部常量。
  · 静态扫描与运行期动态断言都落在**实际被加载的那个模块文件**上（`negotiation.__file__`），
    因此 `tmp/t256-mutate.py` 的影子变异体也逃不过静态断言。
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

from ..kernel.canon import canonical_json, digest
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services import negotiation as negotiation_module
from ..services.approval import (AgentCannotApprove, ApprovalError, ApprovalRequired, ApprovalService,
                                 UnknownApproval)
from ..services.costmodel import CostLibrary, CostModelService, PrivateAccessDenied
from ..services.negotiation import (ConcessionBelowFloor, ConcessionLimitExceeded, ConcessionOutOfBand,
                                    NegotiationError, NegotiationPolicyMissing, NegotiationRoundConflict,
                                    NegotiationService, RoundLimitExceeded, ThreadClosedError, UnknownRound,
                                    UnknownThread, UnsupportedMoveDimension)
from ..services.pricing import PriceNotConfirmed, PricingService
from .registry import Assertion, register

# 事件类型名取自契约 §5（**名字是契约，不随实现的常量命名走**）
BOUNDS_DECLARED_EVENT = "negotiate/bounds-declared"
OPENED_EVENT = "negotiate/opened"
ROUND_EVENT = "negotiate/round"
REJECTED_EVENT = "negotiate/round-rejected"
CLOSED_EVENT = "negotiate/closed"

REALM = "supplier:sup-A"
OTHER_REALM = "buyer:buy-B"
GATE_SCOPE = "negotiate.price-concession"
HUMAN = "human:zhang"

ITEMS = [{"item_id": "L-001", "unit": "m", "qty": 120, "spec_refs": ["spec://piping/DN100"]}]
LIBRARY = {"L-001": {"material": {"unit_rate": 42.0, "unit": "m"},
                     "labour": {"unit_rate": 18.0, "unit": "m"},
                     "plant": {"unit_rate": 6.0, "unit": "m"},
                     "overhead_pct": 8.0, "risk_pct": 3.0, "finance_pct": 1.5, "tax_pct": 13.0}}
BAND = {"min_unit_price": 80.0, "max_unit_price": 100.0}
NEGOTIATE = {"max_rounds": 3, "max_concession_pct": 5.0, "min_margin_pct": 10.0}
POLICY = {"pricing": {"markup_pct": 12.0, "risk_reserve_pct": 3.0, "authorized_band": BAND,
                      "market_reference": {"L-001": 10500.0}},
          "negotiate": dict(NEGOTIATE)}

# 手算（与 AC-PRICE-001 同一套成本库）：L-001 不含税单位成本 = 17897.2/120×0.6… 见 checks_pricing.py；
# 本文件只用手算后的三个数与边界：
#   cost_baseline = 74.4876（成本构成 L-001 不含税单价）
#   floor  = max(74.4876 × (1 + 10/100), band.min=80) = max(81.93636, 80) = 81.93636
#   ceiling = band.max_unit_price = 100.0
COST_BASELINE = 74.4876
FLOOR = 81.93636
CEILING = 100.0

MOVE_OK = {"dimension": "price", "item_id": "L-001", "from": 95.0, "to": 93.0, "unit": "m"}
# 手算幅度：(95 − 93)/95 = 2.105263…% ≤ 5%
MOVE_OK_2 = {"dimension": "price", "item_id": "L-001", "from": 95.0, "to": 93.5, "unit": "m"}
# 手算幅度：(95 − 93.5)/95 = 1.578947…%
MOVE_OK_3 = {"dimension": "price", "item_id": "L-001", "from": 95.0, "to": 92.5, "unit": "m"}
# 手算幅度：(95 − 92.5)/95 = 2.631578…%
MOVE_CONFLICT = {"dimension": "price", "item_id": "L-001", "from": 95.0, "to": 92.0, "unit": "m"}
# 手算幅度：(95 − 92)/95 = 3.157894…%（与 MOVE_OK_2 同轮号、不同内容 → 冲突）
MOVE_OVER_LIMIT = {"dimension": "price", "item_id": "L-001", "from": 95.0, "to": 89.0, "unit": "m"}
# 手算幅度：(95 − 89)/95 = 6.315789…% > 5%
MOVE_BELOW_FLOOR = {"dimension": "price", "item_id": "L-001", "from": 85.0, "to": 81.0, "unit": "m"}
# 手算幅度：(85 − 81)/85 = 4.705882…% ≤ 5%，而 81.0 < floor 81.93636
MOVE_OUT_OF_BAND = {"dimension": "price", "item_id": "L-001", "from": 120.0, "to": 119.0, "unit": "m"}
# 手算幅度：(120 − 119)/120 = 0.833333…% ≤ 5%，而 119.0 > ceiling 100.0
MOVE_WRONG_DIM = {"dimension": "qty", "item_id": "L-001", "from": 95.0, "to": 93.0, "unit": "m"}

EVENT_MODES = {BOUNDS_DECLARED_EVENT: "emit", OPENED_EVENT: "emit", ROUND_EVENT: "serial",
               REJECTED_EVENT: "bail", CLOSED_EVENT: "emit"}
OBLIGATION_TYPES = ("award/committed", "po/issued", "quote/submitted", "quote/revised",
                    "capacity/committed", "purchase-order/issued")
CLOCK_MODULES = ("time", "datetime", "os", "subprocess", "socket", "requests", "urllib")
FORBIDDEN_CALLS = ("decide", "issue_po", "commit", "submit_quote", "open", "write_text", "unlink")


def _ensure_events(bus: EventBus) -> list:
    """设计 §5 的 5 个事件模式：内核表已登记就用它，未登记（父方尚未接线）则由本机检按设计声明。"""
    added = []
    for name, mode in EVENT_MODES.items():
        if bus.mode_of(name) is None:
            bus.declare(name, mode, durable=True, reason="ADR-0019：谈判族无 waterfall")
            added.append(name)
    return added


def _stack(root: Path, *, policy: dict | None = None, realm: str = REALM, tag: str = "main"):
    ledger = Ledger(root / f"ledger-{tag}.jsonl", realm=realm)
    bus = EventBus()
    bus.install_defaults()
    added = _ensure_events(bus)
    approval = ApprovalService(ledger=ledger, events=bus, actor="agent:approval")
    cost = CostModelService(realm=realm, library=CostLibrary(LIBRARY), ledger=ledger, events=bus,
                            store_root=root / f"private-{tag}")
    pricing = PricingService(cost_service=cost, policy=dict(POLICY["pricing"]), ledger=ledger,
                             events=bus, approval=approval, actor="agent:price")
    cost.build(ITEMS, quote_id="q-0007")
    proposal = pricing.price(quote_id="q-0007", item_id="L-001")
    pricing.confirm(proposal["proposal_id"], by=HUMAN)
    nego = NegotiationService(cost_service=cost, pricing=pricing, approval=approval, ledger=ledger,
                              events=bus, policy=dict(policy or POLICY), actor="agent:negotiate")
    return {"root": root, "ledger": ledger, "bus": bus, "approval": approval, "cost": cost,
            "pricing": pricing, "nego": nego, "proposal": proposal["proposal_id"],
            "events_added": added, "threads_before": len(nego.threads())}


def _open(stack: dict, **overrides) -> dict:
    payload = {"package_id": "pkg-031", "rfq_rev": 2, "counterparty": OTHER_REALM,
               "role": "supplier", "quote_id": "q-0007", "proposal_id": stack["proposal"],
               "item_id": "L-001", "declared_by": HUMAN}
    payload.update(overrides)
    return stack["nego"].open_thread(**payload)


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


def _grant(stack: dict, approval_id: str) -> dict:
    return stack["approval"].decide(approval_id, by=HUMAN, decision="granted", comment="同意本次让步")


def _round_key(thread_id: str, attempt_no: int, move: dict, bounds_hash: str) -> str:
    """契约 §2.2 逐字：round_key = "neg:" + digest({thread_id, attempt_no, move, bounds_hash})[:12]
    （内容寻址、无时间戳 → 同输入同输出）。"""
    return "neg:" + digest({"thread_id": thread_id, "attempt_no": attempt_no, "move": move,
                            "bounds_hash": bounds_hash})[:12]


def _module_source() -> tuple[Path, str]:
    """实际被加载的那个实现文件（影子变异体也在这里被读到）。"""
    path = Path(getattr(negotiation_module, "__file__", "") or "")
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    return path, text


def _literals_and_calls(tree: ast.AST) -> tuple[set, set, set]:
    literals: set = set()
    calls: set = set()
    names: set = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            literals.add(node.value)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute):
                calls.add(node.func.attr)
            elif isinstance(node.func, ast.Name):
                calls.add(node.func.id)
        elif isinstance(node, ast.Name):
            names.add(node.id)
    return literals, calls, names


def _imported_modules(tree: ast.AST) -> set:
    modules: set = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level:
            modules.add((node.module or "").split(".")[0])
    return modules


def _obligation_rows(ledger: Ledger) -> dict:
    """账本里的"义务"痕迹：承诺类事件 + PO/授标/对外报价出口。"""
    commitments = [row for row in ledger.read() if row["class"] == "commitment"]
    exits = [row for row in ledger.read() if row["type"] in OBLIGATION_TYPES]
    return {"commitments": commitments, "exits": exits,
            "project": ledger.project("commitments")["commitments"]}


@register("AC-NEGO-003", "P2",
          "谈判轮次与让步（服务层）：让步必过人工门、越界/越限是拒绝且留痕、轮次上限从账本重建、"
          "recompute 逐字节可复现、不产生任何义务",
          "qa ac AC-NEGO-003", evidence_refs=("EV-092",))
def check_nego_003() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("nego-003")
    stack = _stack(root)
    ledger, approval, nego = stack["ledger"], stack["approval"], stack["nego"]
    obligations_before = _obligation_rows(ledger)

    # --- 1. 事件模式（设计 §5：4 新名 + negotiate/round=serial；绝无 waterfall） ----------
    table = EventBus.DEFAULT_TABLE
    mismatch = {name: (table[name][0], mode) for name, mode in EVENT_MODES.items()
                if name in table and table[name][0] != mode}
    modes_after = {name: stack["bus"].mode_of(name) for name in EVENT_MODES}
    out.append(Assertion("事件模式与设计 §5 一致：4 个新名（bounds-declared/opened/round-rejected/closed）"
                         "与既有 negotiate/round 都是 emit/emit/serial/bail/emit，没有 waterfall"
                         "（内核表若已登记则必须同名同模式）",
                         not mismatch and modes_after == EVENT_MODES
                         and "waterfall" not in set(modes_after.values()),
                         f"内核表已登记={[n for n in EVENT_MODES if n in table]} "
                         f"本机检按设计补登={stack['events_added']} modes={modes_after} mismatch={mismatch}"))
    attach_error = _attempt(lambda: nego.attach_defaults())
    out.append(Assertion("装配：attach_defaults() 不抛错，且 serial 判定链挂在 negotiate/round 上"
                         "（模式必须仍是 serial，不是 waterfall）",
                         attach_error is None
                         and stack["bus"].mode_of(ROUND_EVENT) == "serial"
                         and stack["bus"].listener_count(ROUND_EVENT) >= 1,
                         f"error={attach_error} mode={stack['bus'].mode_of(ROUND_EVENT)} "
                         f"listeners={stack['bus'].listener_count(ROUND_EVENT)}"))

    # --- 2. 开线程（正控） --------------------------------------------------------------
    thread = _open(stack)
    tid = thread["thread_id"]
    bounds = thread["bounds"]
    out.append(Assertion("正控·开线程：Thread 视图键齐（thread_id/package_id/rfq_rev/counterparty/role/quote_id/"
                         "proposal_id/item_id/bounds/bounds_hash/status/rounds_used/max_rounds/refs），"
                         "thread_id 形如 nt-0001，rounds_used=0，bounds_hash=digest(bounds)，status=open",
                         thread["thread_id"] == "nt-0001" and thread["status"] == "open"
                         and thread["rounds_used"] == 0 and thread["max_rounds"] == NEGOTIATE["max_rounds"]
                         and thread["bounds_hash"] == digest(bounds)
                         and thread["proposal_id"] == stack["proposal"]
                         and thread["refs"]["thread_id"] == tid
                         and all(key in thread for key in ("package_id", "rfq_rev", "counterparty", "role",
                                                           "quote_id", "item_id", "refs")),
                         f"thread={ {k: thread[k] for k in ('thread_id', 'status', 'rounds_used', 'bounds_hash')} }"))
    out.append(Assertion("正控·开线程落账：negotiate/bounds-declared + negotiate/opened 各一条 fact 行，"
                         "correlation_id=thread_id，bounds-declared 带 §5 的 max_rounds/max_concession_pct/"
                         "min_margin_pct/band/cost_baseline/cost_artifact_ref/policy_hash/source，"
                         "且边界数字与手算一致（cost_baseline=74.4876 / floor=81.93636 / ceiling=100.0）",
                         len(ledger.read(type=BOUNDS_DECLARED_EVENT, correlation_id=tid)) == 1
                         and len(ledger.read(type=OPENED_EVENT, correlation_id=tid)) == 1
                         and all(row["class"] == "fact"
                                 for row in ledger.read(correlation_id=tid))
                         and set(("thread_id", "max_rounds", "max_concession_pct", "min_margin_pct", "band",
                                  "cost_baseline", "cost_artifact_ref", "policy_hash", "source"))
                         <= set(ledger.read(type=BOUNDS_DECLARED_EVENT, correlation_id=tid)[0]["body"])
                         and abs(bounds["cost_baseline"] - COST_BASELINE) < 1e-3
                         and abs(bounds["floor"] - FLOOR) < 1e-3 and abs(bounds["ceiling"] - CEILING) < 1e-6
                         and str(bounds["source"]).startswith("human:"),
                         f"declared={ledger.read(type=BOUNDS_DECLARED_EVENT, correlation_id=tid)[0]['body'] if ledger.read(type=BOUNDS_DECLARED_EVENT, correlation_id=tid) else None}"))
    bad_open = {
        "rfq_rev=0": _attempt(lambda: _open(stack, rfq_rev=0)),
        "proposal 未人确认": _attempt(lambda: _open(stack, proposal_id="pp-9999")),
        "declared_by=agent": _attempt(lambda: _open(stack, declared_by="agent:negotiate")),
    }
    out.append(Assertion("负控·开线程：rfq_rev 非正整数 / proposal 未人确认 / declared_by 非 human:* 三种都被拒"
                         "（PriceNotConfirmed 或 NegotiationError；绝不静默建线程），且不落第二条 opened",
                         isinstance(bad_open["rfq_rev=0"], NegotiationError)
                         and isinstance(bad_open["proposal 未人确认"], PriceNotConfirmed)
                         and isinstance(bad_open["declared_by=agent"], (NegotiationError, AgentCannotApprove))
                         and len(ledger.read(type=OPENED_EVENT)) == 1,
                         f"probes={ {k: type(v).__name__ for k, v in bad_open.items()} } "
                         f"opened={len(ledger.read(type=OPENED_EVENT))}"))
    # --- 3. 门（请求 / 不做预批准 / 非法策略被既有实现拒） -------------------------------
    request = nego.request_concession(tid, MOVE_OK, reason="首轮让步", timeout_policy="remind")
    out.append(Assertion("正控·请求门：scope=negotiate.price-concession、ref=\"{thread_id}:a{attempt_no}\"、"
                         "status=pending、timeout_policy=remind，payload 带 §5 的判定数字"
                         "（from/to/delta_pct/floor/ceiling/cost_artifact_ref/bounds_hash），落 approval/requested",
                         request["scope"] == GATE_SCOPE and request["ref"] == f"{tid}:a1"
                         and request["status"] == "pending" and request["timeout_policy"] == "remind"
                         and request["payload"]["thread_id"] == tid and request["payload"]["attempt_no"] == 1
                         and abs(request["payload"]["delta_pct"] - 2.105263) < 1e-5
                         and len(ledger.read(type="approval/requested", correlation_id=request["ref"])) == 1,
                         f"record={ {k: request[k] for k in ('approval_id', 'scope', 'ref', 'status')} } "
                         f"payload={request['payload']}"))
    out.append(Assertion("负控·不做预批准：请求门之后 approval.granted(scope,ref) 仍为 None、队列里仍是 pending；"
                         "非法 timeout_policy（auto/approve）与 escalate 无人类上级都被既有实现拒绝",
                         approval.granted(scope=GATE_SCOPE, ref=f"{tid}:a1") is None
                         and all(item["status"] == "pending" for item in approval.pending())
                         and all(isinstance(_attempt(lambda p=policy: nego.request_concession(
                             tid, MOVE_OK, timeout_policy=p)), ApprovalError)
                             for policy in ("auto", "approve", "granted"))
                         and isinstance(_attempt(lambda: nego.request_concession(
                             tid, MOVE_OK, timeout_policy="escalate")), ApprovalError),
                         f"granted={approval.granted(scope=GATE_SCOPE, ref=f'{tid}:a1')} "
                         f"policies={[item['status'] for item in approval.pending()]}"))

    # --- 4. 正常链：人批准 → 落 negotiate/round ----------------------------------------
    _grant(stack, request["approval_id"])
    round1 = nego.submit_round(tid, move=MOVE_OK, rationale="首轮让 2%", approval_id=request["approval_id"])
    rows1 = ledger.read(type=ROUND_EVENT, correlation_id=tid)
    expected_key = _round_key(tid, 1, MOVE_OK, thread["bounds_hash"])
    out.append(Assertion("正控·正常链：人批准后提交 → status=conceded、round_id=\"nt-0001#01\"、"
                         "round_key 与按契约 §2.2 手算的一致（\"neg:\"+digest({thread_id,attempt_no,move,"
                         "bounds_hash})[:12]）、delta_pct 手算 2.105263%、in_band 为真",
                         round1["status"] == "conceded" and round1["attempt_no"] == 1
                         and round1["round_id"] == f"{tid}#01" and round1["round_key"] == expected_key
                         and abs(round1["delta_pct"] - 2.105263) < 1e-5 and round1["in_band"] is True
                         and round1["requested_price"] == 93.0
                         and round1["approval_id"] == request["approval_id"],
                         f"round={ {k: round1.get(k) for k in ('round_id', 'round_key', 'status', 'delta_pct', 'in_band')} } "
                         f"expected_key={expected_key}"))
    out.append(Assertion("正控·落账：negotiate/round 是 **intent** 行、correlation_id=thread_id、body 带 §5 的键"
                         "（move/delta_pct/floor/ceiling/band/in_band/approval_id/status/citations），"
                         "citations 只用既有前缀集合（ledger:/package:/quote:/policy:），且没有 commitment 类行",
                         len(rows1) == 1 and rows1[0]["class"] == "intent"
                         and set(("thread_id", "attempt_no", "round_key", "move", "delta_pct", "floor",
                                  "ceiling", "band", "in_band", "approval_id", "status", "citations"))
                         <= set(rows1[0]["body"])
                         and set(str(c).split(":", 1)[0] for c in rows1[0]["body"]["citations"])
                         <= {"ledger", "package", "quote", "policy"}
                         and all(row["class"] != "commitment" for row in ledger.read(type=ROUND_EVENT)),
                         f"class={rows1[0]['class']} citations={rows1[0]['body']['citations']}"))
    thread_b = _open(stack, package_id="pkg-032")
    tid_b = thread_b["thread_id"]
    cross_gate = _attempt(lambda: nego.submit_round(tid_b, move=MOVE_OK,
                                                    approval_id=request["approval_id"]))
    cross_rows = [row["body"] for row in ledger.read(type=REJECTED_EVENT, correlation_id=tid_b)]
    out.append(Assertion("门只批了本次（scope+ref 绑定，不可跨线程/跨轮复用）：拿 nt-0001 的 a1 批准去给 "
                         "nt-0002 提交 → ApprovalRequired（FR-APPROVE-002），且**不落** negotiate/round，"
                         "只落一条指向缺门的 round-rejected",
                         tid_b == "nt-0002" and isinstance(cross_gate, ApprovalRequired)
                         and not ledger.read(type=ROUND_EVENT, correlation_id=tid_b)
                         and len(cross_rows) == 1 and cross_rows[0]["attempt_no"] == 1
                         and str(cross_rows[0].get("code") or "").startswith("approval"),
                         f"thread_b={tid_b} raised={type(cross_gate).__name__}: {str(cross_gate)[:70]} "
                         f"trace={cross_rows}"))
    declared = _attempt(lambda: nego.declare_bounds(tid_b, {"max_concession_pct": 4.0}, by="agent:x"))
    redeclared = _attempt(lambda: nego.declare_bounds(tid_b, {"max_concession_pct": 4.0}, by=HUMAN,
                                                      reason="收紧到 4%"))
    bounds_rows_b = ledger.read(type=BOUNDS_DECLARED_EVENT, correlation_id=tid_b)
    out.append(Assertion("负控·改限：只有 human:* 能追加 negotiate/bounds-declared（agent 改限被拒），"
                         "人工改限**只追加新行、不改旧行**（旧行仍在且旧值未被改写，条数 +1）",
                         isinstance(declared, (NegotiationError, AgentCannotApprove))
                         and isinstance(redeclared, dict) and len(bounds_rows_b) == 2
                         and bounds_rows_b[0]["body"]["max_concession_pct"] == NEGOTIATE["max_concession_pct"]
                         and bounds_rows_b[1]["body"]["max_concession_pct"] == 4.0,
                         f"agent→{type(declared).__name__} human→{type(redeclared).__name__} "
                         f"rows={len(bounds_rows_b)}"))

    # --- 5. 幂等与冲突（同 (thread_id, attempt_no)） -------------------------------------
    rounds_before = len(ledger.read(type=ROUND_EVENT))
    replay = nego.submit_round(tid, move=MOVE_OK, rationale="重提同一轮", approval_id=request["approval_id"])
    out.append(Assertion("正控·幂等：同 (thread_id, attempt_no) + 同 body 二次提交 → 返回同一 round_key、"
                         "账本 negotiate/round 行数不变（命中 (correlation_id,type,body_hash) 去重）、"
                         "用量不推进",
                         replay["round_key"] == round1["round_key"] and replay["round_id"] == round1["round_id"]
                         and len(ledger.read(type=ROUND_EVENT)) == rounds_before
                         and nego.rounds_used(tid) == 1,
                         f"row_key={replay['round_key']} rows={len(ledger.read(type=ROUND_EVENT))}"
                         f"(before {rounds_before}) used={nego.rounds_used(tid)}"))
    request2 = nego.request_concession(tid, MOVE_OK_2, reason="第二轮")
    _grant(stack, request2["approval_id"])
    round2 = nego.submit_round(tid, move=MOVE_OK_2, approval_id=request2["approval_id"])
    rows_before_conflict = len(ledger.read(type=ROUND_EVENT))
    conflict = _attempt(lambda: nego.submit_round(tid, move=MOVE_CONFLICT,
                                                  approval_id=request2["approval_id"]))
    out.append(Assertion("负控·冲突：同 (thread_id, attempt_no) 但**内容不同** → NegotiationRoundConflict"
                         "（不静默追加第二条事实），账本 negotiate/round 行数一条不增",
                         round2["attempt_no"] == 2
                         and isinstance(conflict, NegotiationRoundConflict)
                         and len(ledger.read(type=ROUND_EVENT)) == rows_before_conflict == 2
                         and len([row for row in ledger.read(type=ROUND_EVENT, correlation_id=tid)
                                  if row["body"]["attempt_no"] == 2]) == 1,
                         f"raised={type(conflict).__name__}: {str(conflict)[:90]} "
                         f"rows={len(ledger.read(type=ROUND_EVENT))}(before {rows_before_conflict})"))
    thread_d = _open(stack, package_id="pkg-033")
    tid_d = thread_d["thread_id"]
    hasty = _attempt(lambda: nego.submit_round(tid_d, move=MOVE_OK))   # 没有任何批准
    hasty_rows = [row["body"] for row in ledger.read(type=REJECTED_EVENT, correlation_id=tid_d)]
    out.append(Assertion("负控·缺门必拒：不带任何批准提交 → ApprovalRequired，且**不落 negotiate/round**，"
                         "而是落 negotiate/round-rejected（code/reason/next_action 都非空），"
                         "被拒尝试计入该线程用量（1）",
                         isinstance(hasty, ApprovalRequired) and len(hasty_rows) == 1
                         and hasty_rows[0]["attempt_no"] == 1
                         and all(hasty_rows[0].get(key) for key in ("code", "reason", "next_action"))
                         and not ledger.read(type=ROUND_EVENT, correlation_id=tid_d)
                         and nego.rounds_used(tid_d) == 1,
                         f"raised={type(hasty).__name__}: {str(hasty)[:80]} trace={hasty_rows} "
                         f"rounds={len(ledger.read(type=ROUND_EVENT, correlation_id=tid_d))} "
                         f"used={nego.rounds_used(tid_d)}"))

    # --- 6. 三种越界各一条（拒绝 + 留痕 + 不过门） ---------------------------------------
    # max_rounds 放到 10：让"越界/维度"被拒的原因只可能是它自己，不受轮次上限顺序影响
    stack_c = _stack(root, tag="bounds", policy={"pricing": POLICY["pricing"],
                                                 "negotiate": {**NEGOTIATE, "max_rounds": 10}})
    tid_c = _open(stack_c)["thread_id"]
    cases = [("超幅度上限", MOVE_OVER_LIMIT, ConcessionLimitExceeded, "concession-over-limit"),
             ("低于成本底线", MOVE_BELOW_FLOOR, ConcessionBelowFloor, "concession-below-floor"),
             ("超出授权区间", MOVE_OUT_OF_BAND, ConcessionOutOfBand, "concession-out-of-band")]
    gate_calls_before = len(stack_c["ledger"].read(type="approval/requested"))
    seen: list[dict] = []
    for label, move, exc_type, code in cases:
        raised = _attempt(lambda m=move: stack_c["nego"].submit_round(tid_c, move=m))
        rows = stack_c["ledger"].read(type=REJECTED_EVENT, correlation_id=tid_c)
        bodies = [row["body"] for row in rows]
        match = [body for body in bodies if body.get("code") == code]
        seen.append({"label": label, "raised": type(raised).__name__,
                     "isinstance": isinstance(raised, exc_type),
                     "code": match[0]["code"] if match else None,
                     "traced": bool(match and match[0].get("reason") and match[0].get("next_action")),
                     "attempt": match[0]["attempt_no"] if match else None})
    rounds_c = stack_c["ledger"].read(type=ROUND_EVENT, correlation_id=tid_c)
    out.append(Assertion("负控·越界三种各一条（超 max_concession_pct / 低于 floor / 超 band）→ 各自抛 "
                         "ConcessionLimitExceeded / ConcessionBelowFloor / ConcessionOutOfBand，"
                         "**都落** negotiate/round-rejected（code 取 §4 表里的 concession-over-limit / "
                         "concession-below-floor / concession-out-of-band，且 reason 与 next_action 非空），"
                         "**都不落** negotiate/round，attempt_no 依次 1/2/3（被拒尝试占号）",
                         all(item["isinstance"] and item["traced"] for item in seen)
                         and [item["code"] for item in seen] == [code for _l, _m, _e, code in cases]
                         and [item["attempt"] for item in seen] == [1, 2, 3]
                         and not rounds_c and stack_c["nego"].rounds_used(tid_c) == 3,
                         f"seen={seen} rounds={len(rounds_c)}"))
    out.append(Assertion("负控·越界是**拒绝**不是过门：三种越界提交都没有新增任何 approval/requested"
                         "（判定链在门之前就停，给「越界开门放行」的路被堵死）",
                         len(stack_c["ledger"].read(type="approval/requested")) == gate_calls_before,
                         f"approval/requested={len(stack_c['ledger'].read(type='approval/requested'))}"
                         f"（越界前 {gate_calls_before}）"))
    wrong_dim = _attempt(lambda: stack_c["nego"].submit_round(tid_c, move=MOVE_WRONG_DIM))
    dim_rows = [row["body"] for row in stack_c["ledger"].read(type=REJECTED_EVENT, correlation_id=tid_c)]
    out.append(Assertion("负控·维度：dimension != \"price\" → UnsupportedMoveDimension"
                         "（code=unsupported-dimension），同样留痕不留轮次",
                         isinstance(wrong_dim, UnsupportedMoveDimension)
                         and any(body.get("code") == "unsupported-dimension" for body in dim_rows)
                         and not stack_c["ledger"].read(type=ROUND_EVENT, correlation_id=tid_c),
                         f"raised={type(wrong_dim).__name__} codes={[b['code'] for b in dim_rows]}"))

    # --- 7. 轮次上限 + 重启后从账本重建 --------------------------------------------------
    request3 = nego.request_concession(tid, MOVE_OK_3, reason="第三轮")
    _grant(stack, request3["approval_id"])
    round3 = nego.submit_round(tid, move=MOVE_OK_3, approval_id=request3["approval_id"])
    request4 = nego.request_concession(tid, MOVE_CONFLICT, reason="第四轮（超上限）")
    _grant(stack, request4["approval_id"])
    over = _attempt(lambda: nego.submit_round(tid, move=MOVE_CONFLICT, approval_id=request4["approval_id"]))
    limit_rows = [row["body"] for row in ledger.read(type=REJECTED_EVENT, correlation_id=tid)]
    out.append(Assertion(f"负控·轮次上限：max_rounds={NEGOTIATE['max_rounds']} 的线程前 3 轮已落账，"
                         "第 4 次提交 → RoundLimitExceeded（code=round-limit-exceeded），"
                         "**不落** negotiate/round，用量含被拒尝试（4）",
                         round3["attempt_no"] == 3
                         and isinstance(over, RoundLimitExceeded)
                         and any(body.get("code") == "round-limit-exceeded" for body in limit_rows)
                         and len(ledger.read(type=ROUND_EVENT, correlation_id=tid)) == 3
                         and nego.rounds_used(tid) == 4,
                         f"raised={type(over).__name__} codes={[b['code'] for b in limit_rows]} "
                         f"used={nego.rounds_used(tid)}"))
    rebuilt = _stack(root, tag="main")          # 同一份 ledger-main.jsonl → 等价于进程重启后重建
    rebuilt_used = rebuilt["nego"].rounds_used(tid)
    after_restart = _attempt(lambda: rebuilt["nego"].submit_round(tid, move=MOVE_CONFLICT,
                                                                  approval_id=request4["approval_id"]))
    out.append(Assertion("正控·用量从账本重建（重启不重置）：用同一份 ledger.jsonl 新建服务 → "
                         "rounds_used 与重启前一致（4，含被拒尝试），继续提交仍被 RoundLimitExceeded，"
                         "且不落新的 negotiate/round",
                         rebuilt_used == 4 and nego.rounds_used(tid) == rebuilt_used
                         and isinstance(after_restart, RoundLimitExceeded)
                         and len(rebuilt["ledger"].read(type=ROUND_EVENT, correlation_id=tid)) == 3,
                         f"rebuilt_used={rebuilt_used} before={nego.rounds_used(tid)} "
                         f"raised={type(after_restart).__name__}"))

    # --- 8. recompute：逐字节一致、只用账本数字、不读私域 -------------------------------
    target = f"{tid}#02"
    first = nego.recompute(target)
    second = nego.recompute(target)
    stamped = [key for key in first if re.search(r"(^|_)(at|ts|time|seq|now)$", str(key))]
    view2 = nego.get_round(target)
    out.append(Assertion("正控·可复算：recompute(round_id) 两次调用**逐字节一致**（canonical JSON），"
                         "round_key 与落账的一致，返回值不含时间戳/自增号（无 at/ts/time/seq 键），"
                         "且重算出的 floor/ceiling/delta_pct/in_band 与账本行内数字逐项相等",
                         canonical_json(first) == canonical_json(second)
                         and first["round_key"] == view2["round_key"] == round2["round_key"]
                         and not stamped
                         and first["floor"] == view2["floor"] and first["ceiling"] == view2["ceiling"]
                         and abs(first["delta_pct"] - view2["delta_pct"]) < 1e-9
                         and first["in_band"] is True,
                         f"bytes={len(canonical_json(first))} stamped={stamped} keys={sorted(first)}"))
    leak = [key for key in first
            if str(key) in ("elements", "element_rates", "cost_model", "cost_detail", "private")]
    cross_cost = CostModelService(realm=OTHER_REALM, library=CostLibrary(LIBRARY), ledger=ledger,
                                  events=stack["bus"], store_root=root / "private-cross")
    cross_nego = NegotiationService(cost_service=cross_cost, pricing=stack["pricing"],
                                    approval=approval, ledger=ledger, events=stack["bus"],
                                    policy=dict(POLICY))
    blocked = _attempt(lambda: cross_nego.recompute(target))   # 对方 realm 的成本服务实例
    out.append(Assertion("负控·recompute 不读私域：返回体里没有成本要素明细（elements/element_rates/"
                         "cost_detail），且在**对方 realm** 的成本服务实例上复算抛 PrivateAccessDenied"
                         "（INV-008 / FR-COST-002：私域不出 realm）",
                         not leak
                         and not any(str(key) in canonical_json(first) for key in ("element_rates", "labour"))
                         and isinstance(blocked, PrivateAccessDenied),
                         f"leak={leak} cross_realm={type(blocked).__name__}: {str(blocked)[:80]}"))
    unknown = {"UnknownThread": _attempt(lambda: nego.get_thread("nt-9999")),
               "UnknownRound": _attempt(lambda: nego.get_round(f"{tid}#99")),
               "submit 未知线程": _attempt(lambda: nego.submit_round("nt-9999", move=MOVE_OK)),
               "recompute 未知轮次": _attempt(lambda: nego.recompute(f"{tid}#99"))}
    out.append(Assertion("负控·未知 id：未知线程抛 UnknownThread、未知轮次抛 UnknownRound"
                         "（含 recompute 路径），都不静默返回空",
                         isinstance(unknown["UnknownThread"], UnknownThread)
                         and isinstance(unknown["UnknownRound"], UnknownRound)
                         and isinstance(unknown["submit 未知线程"], UnknownThread)
                         and isinstance(unknown["recompute 未知轮次"], UnknownRound),
                         f"probes={ {k: type(v).__name__ for k, v in unknown.items()} }"))

    # --- 9. 缺策略键即拒（不兜默认值） --------------------------------------------------
    probes = {}
    for key in NEGOTIATE:
        bad = {name: value for name, value in NEGOTIATE.items() if name != key}
        probe_service = NegotiationService(cost_service=stack["cost"], pricing=stack["pricing"],
                                           approval=approval, ledger=ledger, events=stack["bus"],
                                           policy={"pricing": POLICY["pricing"], "negotiate": bad})
        probes[key] = _attempt(lambda svc=probe_service: _open({"nego": svc, "proposal": stack["proposal"]}))
    out.append(Assertion("负控·缺策略键即拒（**不设默认值、不凭空生成数字**）：negotiate.max_rounds / "
                         "max_concession_pct / min_margin_pct 缺任一 → NegotiationPolicyMissing，"
                         "且没有多出 negotiate/opened 行（3 条线程仍是 3 条）",
                         all(isinstance(value, NegotiationPolicyMissing) for value in probes.values())
                         and len(ledger.read(type=OPENED_EVENT)) == 3,
                         f"probes={ {k: type(v).__name__ for k, v in probes.items()} } "
                         f"opened={len(ledger.read(type=OPENED_EVENT))}"))

    # --- 10. 关闭（含 accepted 的前置条件）与线程关闭后不可提交 -------------------------
    # 「proposal 已不再是人确认态」的探针：另建一个没有任何已确认定价的栈（同账本）
    stale_pricing = PricingService(cost_service=stack["cost"], policy=dict(POLICY["pricing"]),
                                   ledger=ledger, events=stack["bus"], approval=approval,
                                   actor="agent:price")
    stale_nego = NegotiationService(cost_service=stack["cost"], pricing=stale_pricing,
                                    approval=approval, ledger=ledger, events=stack["bus"],
                                    policy=dict(POLICY))
    closed = nego.close(tid, outcome="accepted", by=HUMAN, comment="双方同意本轮让步")
    closed_rows = ledger.read(type=CLOSED_EVENT, correlation_id=tid)
    after_close = _attempt(lambda: nego.submit_round(tid, move=MOVE_OK_3))
    unconfirmed_close = _attempt(lambda: stale_nego.close(tid_b, outcome="accepted", by=HUMAN))
    agent_close = _attempt(lambda: nego.close(tid_b, outcome="rejected", by="agent:negotiate"))
    out.append(Assertion("正控/负控·关闭：close(outcome=accepted) 落 negotiate/closed（带 outcome/decided_by/"
                         "rounds_used/round_keys）；关闭后提交抛 ThreadClosedError（code=thread-closed）；"
                         "accepted 要求该线程的 proposal 仍处于人确认态（重建后的栈里已不再确认 → "
                         "PriceNotConfirmed）；by 非 human:* 被拒",
                         closed["outcome"] == "accepted" and closed["status"] == "closed"
                         and len(closed_rows) == 1
                         and closed_rows[0]["class"] == "fact"
                         and set(("thread_id", "outcome", "decided_by", "rounds_used", "round_keys"))
                         <= set(closed_rows[0]["body"])
                         and isinstance(after_close, ThreadClosedError)
                         and isinstance(unconfirmed_close, PriceNotConfirmed)
                         and isinstance(agent_close, (NegotiationError, AgentCannotApprove)),
                         f"closed={closed_rows[0]['body'] if closed_rows else None} "
                         f"after_close={type(after_close).__name__} "
                         f"unconfirmed={type(unconfirmed_close).__name__} agent={type(agent_close).__name__}"))

    # --- 11. 不产生义务（运行期） + 账本链仍真 -----------------------------------------
    after = _obligation_rows(ledger)
    negotiate_rows = ledger.read()
    negotiate_rows = [row for row in negotiate_rows if str(row["type"]).startswith("negotiate/")]
    types_projection = ledger.project("types")["by_type"]
    out.append(Assertion("**不产生义务**（运行期）：整条链跑完后账本里没有 commitment 类事件、没有 PO/授标/"
                         "对外报价事件（award/committed · po/issued · quote/submitted · quote/revised · "
                         "capacity/committed），commitments 投影为空，negotiate/* 全部是 fact/intent",
                         not after["commitments"] and not after["exits"] and not after["project"]
                         and len(after["commitments"]) == len(obligations_before["commitments"])
                         and all(row["class"] in ("fact", "intent") for row in negotiate_rows)
                         and all(row["class"] != "commitment" for row in ledger.read()),
                         f"commitments={len(after['commitments'])} exits={[r['type'] for r in after['exits']]} "
                         f"classes={sorted({r['class'] for r in negotiate_rows})}"))
    chain_ok = ledger.verify_report()["ok"] is True and ledger.verify_chain() is True
    counts_match = all(types_projection.get(row["type"], 0) == len(ledger.read(type=row["type"]))
                       for row in negotiate_rows)
    projected = ledger.incremental("types")["by_type"] == types_projection
    out.append(Assertion("账本链仍真：verify_report()[\"ok\"] 为真、verify_chain() 为真；"
                         "project(\"types\") 里 negotiate/* 的逐类计数 == 实际行数，"
                         "增量投影与全量重建一致（FR-LEDGER-002/003）",
                         chain_ok and counts_match and projected,
                         f"ok={ledger.verify_report()['ok']} chain_ok={chain_ok} counts_match={counts_match} "
                         f"incremental==project={projected} count={ledger.count} "
                         f"negotiate_types={ {k: v for k, v in types_projection.items() if k.startswith('negotiate/')} }"))

    # --- 12. 不产生义务（静态·AST）与无墙钟（静态·AST） --------------------------------
    path, source = _module_source()
    out.append(Assertion("静态扫描可用：实际被加载的实现文件可读（影子变异体也在这个路径上被扫到）",
                         bool(source) and source.strip().startswith('"""'),
                         f"path={path} bytes={len(source)}"))
    if not source:
        return out
    tree = ast.parse(source)
    literals, calls, names = _literals_and_calls(tree)
    imports = _imported_modules(tree)
    obligation_literals = sorted(lit for lit in literals
                                 if lit == "commitment" or lit.endswith("/committed")
                                 or lit in ("po/issued", "quote/submitted", "quote/revised"))
    out.append(Assertion("**不产生义务**（静态·AST）：实现源码里没有承诺类事件名字面量（\"commitment\" / "
                         "以 /committed 结尾 / po/issued / quote/submitted / quote/revised），"
                         "也没有 decide(/issue_po/submit_quote 这类承诺出口调用（注释不算，AST 才作数）",
                         not obligation_literals
                         and not (calls & {"decide", "issue_po", "submit_quote", "commit", "commit_quote"}),
                         f"literals={obligation_literals} calls={sorted(calls & {'decide', 'issue_po', 'submit_quote', 'commit'})}"))
    clock_calls = sorted(calls & {"now", "utcnow", "today", "time", "monotonic", "perf_counter"})
    clock_names = sorted(names & {"utc_now", "datetime", "time", "time_ns"})
    clock_imports = sorted(imports & set(CLOCK_MODULES))
    io_imports = sorted(imports & {"io", "shutil", "pathlib", "tempfile", "subprocess", "socket", "requests",
                                   "urllib", "http"})
    messages = [str(item) for item in
                (hasty, conflict, over, after_restart, wrong_dim, unknown["UnknownThread"],
                 probes.get("max_rounds"), after_close) if isinstance(item, BaseException)]
    stamped_messages = [text for text in messages if re.search(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", text)]
    out.append(Assertion("**无墙钟**（静态·AST）：实现源码没有时钟调用（datetime.now / time.time / utc_now / "
                         "utcnow / today / monotonic）、没有引用 utc_now/datetime/time 名字、"
                         "也没有导入 time/datetime/os/subprocess/socket/requests 等时钟与 IO/网络模块；"
                         "拒绝消息里也不含绝对时刻（D-042 / FR-LEDGER-003 纪律）",
                         not clock_calls and not clock_names and not clock_imports and not io_imports
                         and not stamped_messages,
                         f"clock_calls={clock_calls} clock_names={clock_names} imports={sorted(imports)} "
                         f"io_imports={io_imports} stamped_messages={stamped_messages[:2]}"))

    # --- 13. 计数自证：断言数（≥15）与"门/拒绝/轮次"三本账 -------------------------------
    rejected_codes = [body["code"] for thread_rows in
                      (ledger.read(type=REJECTED_EVENT), stack_c["ledger"].read(type=REJECTED_EVENT))
                      for row in thread_rows for body in [row["body"]]]
    out.append(Assertion("账本三本账核对：negotiate/round 行数 == 已提交轮次数（3，全在 nt-0001），"
                         "negotiate/round-rejected 行数 == 被拒尝试数（nt-0001 一次 + nt-0002 一次 + "
                         "nt-0003 一次 + 越界线程四类各一次 = 7），negotiate/opened == 3，"
                         "approval/requested 全部带 scope=negotiate.price-concession",
                         len(ledger.read(type=ROUND_EVENT)) == 3
                         and len(rejected_codes) == 7
                         and set(rejected_codes) >= {"approval-required", "round-limit-exceeded",
                                                     "concession-over-limit", "concession-below-floor",
                                                     "concession-out-of-band", "unsupported-dimension"}
                         and len(ledger.read(type=OPENED_EVENT)) == 3
                         and {row["body"]["scope"] for row in ledger.read(type="approval/requested")}
                         == {GATE_SCOPE},
                         f"rounds={len(ledger.read(type=ROUND_EVENT))} rejected={rejected_codes} "
                         f"opened={len(ledger.read(type=OPENED_EVENT))} "
                         f"scopes={ {row['body']['scope'] for row in ledger.read(type='approval/requested')} }"))

    return out
