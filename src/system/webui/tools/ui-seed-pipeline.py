#!/usr/bin/env python3
"""UI 种子驱动：用**真服务**把谈判 / FAQ / 邮件三域事件种进 UI 账本（D-054 / T-261）。
**位置（本批迁移）**：实体在 `src/system/webui/tools/ui-seed-pipeline.py`；旧位置 `tools/ui-seed-pipeline.py` 只剩**薄转发**
（`runpy` 指到本文件）—— 门名、`tools/verify.sh` 的分支、`./run` 与文档里的既有命令**一行未改**。

为什么要有它：T-260 把三域接进了运维面板（`/quotagent/api/pipeline` ← `tmp/ui-shared/pipeline.json`），
但**真账本里没有这三域的事件** → 面板恒为 0，而"空面板"与"坏了的面板"从外观上分不出来。
本工具用**真服务**（真人工门、真账本、真哈希链、真事件总线）在两侧账本各跑一遍三域流程，
让面板显示真数字 —— 判定逻辑一行都不在这里重写（`ADR-0012`：判定属于事实层）。

用法::

    python3 src/system/webui/tools/ui-seed-pipeline.py                                  # 两侧，默认 tmp/ui-shared
    python3 src/system/webui/tools/ui-seed-pipeline.py --shared-dir tmp/t261-seed
    python3 src/system/webui/tools/ui-seed-pipeline.py --sides contractor --now 2026-09-21T12:00:00Z

输出：**stdout 恰好一行 JSON**（便于调用方解析），过程说明走 stderr::

    {"ok": true, "shared_dir": "...", "now": "...", "added": {"contractor": 17, "supplier": 17},
     "counts": {"contractor": {"negotiate": {...}, "faq": {...}, "mail": {...}}, "supplier": {...}}}

三条纪律（D-054，逐条落在代码里）：

1. **演员可识别**：本工具的所有写入只用 `human:ui-seed` / `agent:ui-seed`，**不得**冒充真实业务主体。
   `--verify-actors`（默认开）在运行末尾逐行核对"本次新增的每一行"的 `actor` 前缀，不符即报错退出非 0 ——
   纪律不是注释，是机检。（FAQS / Mail 服务的观测行 actor 是类属性 `agent:faq` / `agent:mail`；
   本工具用两个**只覆盖类属性 `actor`** 的子类把它换成 `agent:ui-seed`，服务逻辑一行未改。）
2. **幂等**：重复运行不得把账本无限撑大。三条路径合起来做到：
   · 前置栈（成本 → 定价 → 人确认）与 FAQ / 邮件两域靠**内容寻址**自然去重（同 body 不产生第二条事实）；
   · 谈判域的 `thread_id` / 轮次号是**计数器**派生的（服务接口没有"指定 id"的口子），因此按**账本事实**
     检测既存线程：已完整 → 整段跳过（明确报告 `skipped: 原因`）；只做了一半 → 从既有事实**续做**缺失的步，
     绝不重开线程。输出里报 `added`（本次新增几行）与 `added_by_domain`。
3. **不读墙钟**：时间由 `--now` 传入（默认写死一个 ISO 时间戳）。本工具自己不读时钟，并把
   服务里 `utc_now` 的绑定在**本进程内**钉成 `--now`（`Ledger.append` 的 `ts`、成本工件的 `built_at`
   都因此确定）；运行末尾逐行核对新增行的 `ts == --now`，不符即报错退出非 0。

其它硬约束：

· **只追加、不清理**：本工具**不删除、不清空** `--shared-dir`（`webui-serve.py` 会先跑 g1 走查，
  那里已经有一整套真账本；种子只能往后追加事实）。
· **失败不静默**：任何一步失败都抛错 → 非 0 退出（stdout 给 `{"ok": false, ...}`）；
  唯一被"捕获"的是**故意制造的那次越界**，且捕获后要求它真的落了 `negotiate/round-rejected`
  且 `code` 与预期一致，否则照样报错。
· **realm**：账本文件已有行时沿用它的 `realm`（同一本账 = 一个 realm）；空账本才用 `<side>:ui-seed`。
· **三域计数**取自 `tools/refresh-ui-snapshots.py` 的 `_view()`（面板的同一份重建逻辑，
  不在这里另写一套计数）→ `counts` 就是面板将要显示的数字。

【已知偏差（如实登记，不假装）】

· 谈判线程 id（`nt-0001`）与批准 id（`ap-0001`）由服务内的计数器派生，服务接口没有"指定 id"的口子，
  因此**跨进程/跨目录**的两次全新运行不会得到同一批 id（这也正是谈判域要靠"检测 + 续做"而不是
  靠内容去重的原因）。同一账本上的重复运行不新增任何行（实测：`added == 0`）。
· `quote/cost-built` 的 body 里带 `artifact_hash`，而工件里含成本服务的 `built_at`：本工具把这个
  时钟钉成 `--now` 后两次运行完全一致；若父方改动成本服务的时间来源，本工具的 `ts` 自检不会抓到
  这一处（它只管账本行的 `ts`），届时"两次运行的工件哈希不同"会表现为账本多出一行而非报错。
· 只做**本工具能证明的**：种出来的是"三域事件真的能被面板数出来"，不是"面板 UI 渲染正确"。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.services import clarify as clarify_module  # noqa: E402,F401  只为把模块加载进 sys.modules（时钟钉死要按模块扫）
from quotagent.services import costmodel as costmodel_module  # noqa: E402,F401
from quotagent.services import pricing as pricing_module  # noqa: E402,F401
from quotagent.services.approval import ApprovalService  # noqa: E402
from quotagent.services.clarify import ClarificationService  # noqa: E402
from quotagent.services.costmodel import CostLibrary, CostModelService  # noqa: E402
from quotagent.services.faq import FaqService  # noqa: E402
from quotagent.services.mail import MailService  # noqa: E402
from quotagent.services.negotiation import (  # noqa: E402
    BOUNDS_DECLARED_EVENT,
    CLOSED_EVENT,
    OPENED_EVENT,
    ROUND_EVENT,
    ROUND_REJECTED_EVENT,
    NegotiationError,
    NegotiationService,
)
from quotagent.services.pricing import PricingService  # noqa: E402

# --- 常量（名字即纪律；改动这里等于改动种子的语义） -------------------------------
HUMAN = "human:ui-seed"          # 一切"人做的决定"的写入者
AGENT = "agent:ui-seed"          # 一切"服务代劳"的写入者
DEFAULT_SHARED = ROOT / "tmp" / "ui-shared"
DEFAULT_NOW = "2026-09-21T12:00:00Z"
SIDES = ("contractor", "supplier")
LEDGER_NAME = "ledger.jsonl"
LANDED_ROUND_STATUS = "conceded"  # 与 refresh-ui-snapshots.py 同一口径（落账轮 vs 被拒轮）
ACTOR_PREFIXES = ("human:ui-seed", "agent:ui-seed")

# --- 种子内容（确定性：同输入 → 同事实） -----------------------------------------
ITEM = "L-001"
QUOTE = "q-ui-seed"                       # 本工具专属：用于检测前置栈是否已经种过
ITEMS = [{"item_id": ITEM, "unit": "m", "qty": 120, "spec_refs": ["spec://piping/DN100"]}]
# 费率库（与 AC-PRICE-001 / AC-NEGO-003 同一套手算基准）：L-001 不含税单位成本 74.4876
RATES = {ITEM: {"material": {"unit_rate": 42.0, "unit": "m"},
                "labour": {"unit_rate": 18.0, "unit": "m"},
                "plant": {"unit_rate": 6.0, "unit": "m"},
                "overhead_pct": 8.0, "risk_pct": 3.0, "finance_pct": 1.5, "tax_pct": 13.0}}
BAND = {"min_unit_price": 80.0, "max_unit_price": 100.0}
# floor = max(74.4876 × 1.10, band.min=80) = 81.93636；ceiling = 100.0
POLICY = {
    "pricing": {"markup_pct": 12.0, "risk_reserve_pct": 3.0, "authorized_band": dict(BAND),
                "market_reference": {ITEM: 10500.0}},
    "negotiate": {"max_rounds": 3, "max_concession_pct": 5.0, "min_margin_pct": 10.0},
}
# 人工改限：5% → 8%（被拒轮的 reason 里会带新上限，是"人工声明真的生效了"的正面证据）
DECLARE_BOUNDS = {"max_concession_pct": 8.0}
DECLARE_REASON = "人工放宽单次让步上限（UI 种子：5% → 8%，后续越界轮按新上限判定）"

SIDE_SPEC = {
    "contractor": {
        "package_id": "pkg-ui-seed",
        "rfq_rev": 1,
        "counterparty": "supplier:ui-seed",
        "role": "contractor",
        "proposal_id": "pp-0001",
        # role=contractor 的"让步"是**上调**单价：95 → 96 = +1.0526% ≤ 8%
        "move_ok": {"dimension": "price", "item_id": ITEM, "from": 95.0, "to": 96.0, "unit": "m"},
        # 故意越界：90 → 100 = +11.1111% > 8%（且仍在区间/底线内 → 唯一失败的环就是让步上限）
        "move_over_limit": {"dimension": "price", "item_id": ITEM, "from": 90.0, "to": 100.0, "unit": "m"},
        "ticket_id": "cl-ui-seed-con",
        "question": "UI 种子演示问题（contractor 侧）：DN100 管道的验收口径按哪一版附表？",
        "answer_text": "按当前版本的附表执行；变更后 3 日内答复（UI 种子演示答复）。",
        "answer_fields": {"unit": "m", "deadline_note": "UI-SEED-DEADLINE-NOTE-CON"},
        "mail_from": "ui-seed-contractor@example.com",
        "mail_to": ["ui-seed-supplier@example.com"],
        "mail_subject": "[pkg-ui-seed] RFQ notice rev1",
        "mail_body": "UI 种子演示报文（contractor 侧）：本封不会被发出（无 SMTP/IMAP 凭据，D-052）。",
    },
    "supplier": {
        "package_id": "pkg-ui-seed-sup",
        "rfq_rev": 1,
        "counterparty": "contractor:ui-seed",
        "role": "supplier",
        "proposal_id": "pp-0001",
        # role=supplier 的"让步"是**下调**单价：95 → 93 = -2.1053% ≤ 8%
        "move_ok": {"dimension": "price", "item_id": ITEM, "from": 95.0, "to": 93.0, "unit": "m"},
        # 故意越界：95 → 82 = -13.6842% > 8%（82 ≥ floor 81.93636 → 唯一失败的环就是让步上限）
        "move_over_limit": {"dimension": "price", "item_id": ITEM, "from": 95.0, "to": 82.0, "unit": "m"},
        "ticket_id": "cl-ui-seed-sup",
        "question": "UI 种子演示问题（supplier 侧）：保温层厚度按哪一版附表取值？",
        "answer_text": "按当前版本的附表取值；变更后 3 日内答复（UI 种子演示答复）。",
        "answer_fields": {"unit": "m", "deadline_note": "UI-SEED-DEADLINE-NOTE-SUP"},
        "mail_from": "ui-seed-supplier@example.com",
        "mail_to": ["ui-seed-contractor@example.com"],
        "mail_subject": "[pkg-ui-seed-sup] RFQ notice rev1",
        "mail_body": "UI 种子演示报文（supplier 侧）：本封不会被发出（无 SMTP/IMAP 凭据，D-052）。",
    },
}

EXPECT_REJECT_CODE = "concession-over-limit"


class SeedError(RuntimeError):
    """种子失败（要么环境坏，要么账本里是半成品状态）——一律非 0 退出，不静默跳。"""


# ---------------------------------------------------------------------------
# 服务子类：只覆盖"观测行的写入者标签"（D-054 演员可识别），服务逻辑一行未改
# ---------------------------------------------------------------------------
class SeedFaqService(FaqService):
    """真 FAQ 服务；`actor` 由 `agent:faq` 换成 `agent:ui-seed`（仅此一行差别）。"""

    actor = AGENT


class SeedMailService(MailService):
    """真邮件服务；`actor` 由 `agent:mail` 换成 `agent:ui-seed`（仅此一行差别）。"""

    actor = AGENT


# ---------------------------------------------------------------------------
# 时钟：本进程内把服务里的 utc_now 钉成 --now（时间由参数传入，不读墙钟）
# ---------------------------------------------------------------------------
@contextmanager
def frozen_clock(now: str):
    """把 `quotagent.*` 模块里绑定的 `utc_now` 换成常量（返回被钉住的模块名，退出时还原）。

    为什么要这样钉：`Ledger.append` 的 `ts`、`CostModelService.build` 的 `built_at` 都由服务自己
    调 `utc_now()` —— 服务接口没有"注入时钟"的参数，所以只能在**本进程内**替换这个绑定。
    """
    patched: list[tuple[object, object, str]] = []

    def fixed() -> str:
        return now

    for name, module in sorted(sys.modules.items()):
        if module is None or not (name == "quotagent" or name.startswith("quotagent.")):
            continue
        current = getattr(module, "utc_now", None)
        if callable(current):
            patched.append((module, current, name))
            setattr(module, "utc_now", fixed)
    try:
        yield [name for _module, _fn, name in patched]
    finally:
        for module, current, _name in patched:
            setattr(module, "utc_now", current)


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def _existing_realm(path: Path) -> str | None:
    """账本首行的 realm（同一本账 = 一个 realm）；空文件/不存在返回 None。"""
    if not path.exists():
        return None
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                return None
            return str(row.get("realm") or "") or None
    return None


def _type_counts(ledger: Ledger) -> dict:
    counts: dict = {}
    for row in ledger.read():
        key = str(row.get("type"))
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _rows_of(ledger: Ledger, type_: str) -> list:
    return [row for row in ledger.read(type=type_)]


def _snapshot_view(shared: Path, view: str) -> dict:
    """三域计数取自快照写入器的同一份重建逻辑（`refresh-ui-snapshots._view`）。

    **不在这里另写一套计数**：面板显示什么，本工具就报什么（单一真源）。
    """
    script = ROOT / "src" / "system" / "webui" / "tools" / "refresh-ui-snapshots.py"
    if not script.exists():
        raise SeedError(f"找不到快照写入器 {_display(script)}：无法给出与面板一致的三域计数")
    spec = importlib.util.spec_from_file_location("refresh_ui_snapshots", script)
    if spec is None or spec.loader is None:                       # pragma: no cover - 环境级故障
        raise SeedError(f"无法加载快照写入器 {_display(script)}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return dict(module._view(shared, view))                       # noqa: SLF001  只调它的只读重建


# ---------------------------------------------------------------------------
# 前置栈：真实成本构成 → 真实定价建议 → **人确认**（谈判线程必须挂在已人确认的建议上）
# ---------------------------------------------------------------------------
def build_stack(ledger: Ledger, realm: str, side_root: Path, now: str) -> dict:
    bus = EventBus()
    bus.install_defaults()
    approval = ApprovalService(ledger=ledger, events=bus, actor=AGENT)
    cost = CostModelService(realm=realm, library=CostLibrary(RATES), ledger=ledger, events=bus,
                            store_root=side_root / "private", actor=AGENT)
    pricing = PricingService(cost_service=cost, policy=dict(POLICY["pricing"]), ledger=ledger,
                             events=bus, approval=approval, actor=AGENT)
    cost.build(ITEMS, quote_id=QUOTE)
    proposal = pricing.price(quote_id=QUOTE, item_id=ITEM)
    if not proposal.get("in_band"):
        raise SeedError(f"定价越出授权区间（status={proposal.get('status')}）：种子的边界与策略不自洽")
    pricing.confirm(proposal["proposal_id"], by=HUMAN)            # FR-PRICE-002：最终数字必须由人确认
    nego = NegotiationService(cost_service=cost, pricing=pricing, approval=approval, ledger=ledger,
                              events=bus, policy=dict(POLICY), actor=AGENT)
    return {"bus": bus, "approval": approval, "cost": cost, "pricing": pricing, "nego": nego,
            "proposal_id": proposal["proposal_id"]}


# ---------------------------------------------------------------------------
# 三域
# ---------------------------------------------------------------------------
def seed_negotiate(ledger: Ledger, stack: dict, spec: dict) -> dict:
    """谈判域：开线程 → 人工改限 → 门请求 → 人批准 → 落轮 → 故意越界（被拒）→ 关闭。

    幂等策略（见模块 docstring 第 2 条）：按账本事实检测既存线程 —— 完整则整段跳过，
    只做了一半则从既有事实**续做**缺失的步（绝不重开线程）。
    """
    nego = stack["nego"]
    approval = stack["approval"]
    notes: list[str] = []
    package = spec["package_id"]
    existing = [t for t in nego.threads() if str(t.get("package_id")) == package]
    if existing:
        thread = nego.get_thread(existing[0]["thread_id"])
        notes.append(f"open-thread 跳过：账本已有线程 {thread['thread_id']}（同一批 id 不重复开）")
    else:
        thread = nego.open_thread(package_id=package, rfq_rev=spec["rfq_rev"],
                                  counterparty=spec["counterparty"], role=spec["role"],
                                  quote_id=QUOTE, proposal_id=stack["proposal_id"], item_id=ITEM,
                                  declared_by=HUMAN)
        notes.append(f"open-thread → {thread['thread_id']}（negotiate/bounds-declared + negotiate/opened）")
    thread_id = thread["thread_id"]

    # 人工改限：**只追加**一条新的 bounds-declared（不改旧行、不删旧行）
    declared = [row for row in _rows_of(ledger, BOUNDS_DECLARED_EVENT)
                if str((row.get("body") or {}).get("thread_id")) == thread_id]
    if len(declared) < 2:
        nego.declare_bounds(thread_id, dict(DECLARE_BOUNDS), by=HUMAN, reason=DECLARE_REASON)
        notes.append(f"declare-bounds(by={HUMAN}) → negotiate/bounds-declared"
                     f"（{DECLARE_BOUNDS['max_concession_pct']}% 上限生效）")
    else:
        notes.append("declare-bounds 跳过：账本已有 2 条 bounds-declared")

    rounds = nego.rounds(thread_id)
    landed = [r for r in rounds if r.get("status") == LANDED_ROUND_STATUS]
    rejected = [r for r in rounds if r.get("status") != LANDED_ROUND_STATUS]

    # 第 1 轮：门请求 → 人批准 → 提交（应落 negotiate/round）
    if not landed and nego.get_thread(thread_id)["status"] == "open":
        request = nego.request_concession(thread_id, dict(spec["move_ok"]),
                                          reason="UI 种子：请求人工批准本次价格让步")
        approval.decide(request["approval_id"], by=HUMAN, decision="granted",
                        comment="同意本次让步（UI 种子）")
        nego.submit_round(thread_id, move=dict(spec["move_ok"]),
                          rationale="UI 种子：经人工批准的第 1 轮让步",
                          approval_id=request["approval_id"])
        notes.append(f"request-concession → {request['approval_id']} → decide(granted) → submit-round"
                     f"（落 {ROUND_EVENT}）")
    elif landed:
        notes.append("第 1 轮跳过：账本已有落账轮次")
    else:
        raise SeedError(f"线程 {thread_id} 已关闭但没有落账轮次（半成品账本）："
                        f"请清空该账本后重跑，本工具不猜、不补、不静默跳过")

    # 第 1 轮落账后重新读事实（上面的 `landed` 是提交前的快照，不能拿它判下一步）
    rounds = nego.rounds(thread_id)
    landed = [r for r in rounds if r.get("status") == LANDED_ROUND_STATUS]
    rejected = [r for r in rounds if r.get("status") != LANDED_ROUND_STATUS]

    # 第 2 次尝试：**故意越界**（只捕获这一次；捕获后必须见到 round-rejected，否则报错）
    if not rejected:
        if not landed:
            raise SeedError(f"线程 {thread_id} 还没有落账轮次，越界尝试会占错轮号：请先修好账本状态")
        try:
            nego.submit_round(thread_id, move=dict(spec["move_over_limit"]),
                              rationale="UI 种子：故意越界（演示判定链会拒并留痕）")
            raise SeedError("越界轮本应被拒，却落成了 negotiate/round：判定链失效（不放水掩盖）")
        except NegotiationError as exc:
            notes.append(f"故意越界被拒：{type(exc).__name__}"
                         f"（code={getattr(exc, 'code', '')}）"
                         f"（{getattr(exc, 'code', '')} → 落 {ROUND_REJECTED_EVENT}）")
        rejected = [r for r in nego.rounds(thread_id) if r.get("status") != LANDED_ROUND_STATUS]
        if not rejected:
            raise SeedError(f"越界尝试没有留下 {ROUND_REJECTED_EVENT} 行：拒绝必须留痕")
        last = rejected[-1]
        if str(last.get("code")) != EXPECT_REJECT_CODE:
            raise SeedError(f"被拒轮的 code={last.get('code')!r}，期望 {EXPECT_REJECT_CODE!r}"
                            f"（越界原因与预期不符 → 判定链或边界不同源）")
        if str(DECLARE_BOUNDS["max_concession_pct"]) not in str(last.get("reason")):
            raise SeedError(f"被拒原因里没有人工声明的上限 {DECLARE_BOUNDS['max_concession_pct']}："
                            f"人工改限没有生效（reason={last.get('reason')!r}）")
        notes.append(f"被拒轮 reason 引用了人工声明的上限"
                     f"（{DECLARE_BOUNDS['max_concession_pct']}%）→ 人工改限生效")
    else:
        notes.append("越界尝试跳过：账本已有 round-rejected")

    if nego.get_thread(thread_id)["status"] == "open":
        nego.close(thread_id, outcome="limit-reached", by=HUMAN,
                   comment="UI 种子：让步上限已被触及，关闭线程（不产生任何义务）")
        notes.append(f"close(outcome=limit-reached, by={HUMAN}) → {CLOSED_EVENT}")
    else:
        notes.append("close 跳过：线程已关闭")
    return {"thread_id": thread_id, "notes": notes, "landed": len(landed), "rejected": len(rejected)}


def seed_faq(ledger: Ledger, realm: str, spec: dict) -> dict:
    """FAQ 域：真澄清票单（ask → answer，人工作答）→ `publish(by=human:ui-seed)` → `reuse` 命中。

    幂等：票单 id 是显式给定的（服务接口支持 `ticket_id=`），发布字段也显式给出 →
    同一次运行的内容逐字节一致 → 重复运行只会命中账本去重（不新增事实行）。
    """
    notes: list[str] = []
    bus = EventBus()
    bus.install_defaults()
    clarify = ClarificationService(participant=AGENT, realm=realm, ledger=ledger, events=bus,
                                   package={"package_id": spec["package_id"], "rfq_rev": spec["rfq_rev"]},
                                   registered_bidders=[])
    faq = SeedFaqService(realm=realm, ledger=ledger, events=bus)
    ticket = clarify.ask(package_id=spec["package_id"], rfq_rev=spec["rfq_rev"],
                         refs={"item_ids": [ITEM]}, question=spec["question"],
                         ticket_id=spec["ticket_id"])
    clarify.answer(ticket_id=ticket["ticket_id"], text=spec["answer_text"], by=HUMAN,
                   fields=dict(spec["answer_fields"]))
    entry = faq.publish(package_id=spec["package_id"], rfq_rev=spec["rfq_rev"],
                        ticket_id=ticket["ticket_id"], by=HUMAN, question=spec["question"],
                        fields=dict(spec["answer_fields"]))
    notes.append(f"clarify.ask → answer(by={HUMAN}) → publish(by={HUMAN}) → faq/entry-published"
                 f"（entry_id={entry['entry_id']}）")
    reuse = faq.reuse(package_id=spec["package_id"], rfq_rev=spec["rfq_rev"], question=spec["question"])
    if not reuse.get("hit"):
        raise SeedError(f"FAQ 复用没有命中（reason={reuse.get('reason')}）："
                        f"沉淀成功了却复不到，等于没种")
    notes.append(f"reuse → hit=True（reason={reuse.get('reason')}）→ faq/reuse-served")
    return {"entry_id": entry["entry_id"], "notes": notes}


def seed_mail(ledger: Ledger, realm: str, spec: dict, now: str) -> dict:
    """邮件域：`compose` → `enqueue` → `deliver`（应为 unavailable + 落 `mail/refused`）。

    幂等：报文的幂等键（kind/to/subject/body_hash/package/rev）内容寻址 → 重复运行
    `enqueue` 报 `duplicate=true`、`deliver` 的拒绝行被账本去重（都不新增事实行）。
    """
    notes: list[str] = []
    bus = EventBus()
    bus.install_defaults()
    mail = SeedMailService(realm=realm, ledger=ledger, events=bus)
    message = mail.compose(kind="rfq-notice", package_id=spec["package_id"], rfq_rev=spec["rfq_rev"],
                           sender=spec["mail_from"], to=list(spec["mail_to"]),
                           subject=spec["mail_subject"], body=spec["mail_body"], date=now)
    queued = mail.enqueue(message=message)
    notes.append(f"compose → enqueue（message_id={queued['message_id']}，"
                 f"duplicate={queued['duplicate']}）→ mail/queued")
    delivered = mail.deliver(message_id=queued["message_id"])
    if str(delivered.get("status")) != "unavailable":
        raise SeedError(f"本轮没有发信能力（D-052）：deliver 必须 unavailable，收到 {delivered!r}")
    if not delivered.get("reason") or not delivered.get("next_action"):
        raise SeedError(f"deliver 的可解释失败缺 reason/next_action：{delivered!r}")
    refused = [row for row in _rows_of(ledger, "mail/refused")
               if str((row.get("body") or {}).get("message_id")) == str(queued["message_id"])]
    if not refused:
        raise SeedError(f"deliver 没有落 mail/refused（message_id={queued['message_id']}）")
    notes.append(f"deliver → status=unavailable（reason={delivered['reason']}）→ mail/refused")
    return {"message_id": queued["message_id"], "notes": notes}


# ---------------------------------------------------------------------------
# 单侧
# ---------------------------------------------------------------------------
def run_side(shared: Path, side: str, now: str, spec: dict, *, verify_actors: bool = True) -> dict:
    """在 `<shared>/<side>/ledger.jsonl` 上跑一遍三域流程，返回本侧报告。"""
    side_root = shared / side
    path = side_root / LEDGER_NAME
    realm = _existing_realm(path) or f"{side}:ui-seed"
    notes: list[str] = []

    with frozen_clock(now) as clock_patched:
        ledger = Ledger(path, realm=realm)                        # 真账本：真哈希链、真去重
        if not ledger.healthy:
            report = ledger.open_failure or {}
            raise SeedError(f"账本 {_display(path)} 哈希链校验失败"
                            f"（first_bad_seq={report.get('first_bad_seq')}，{report.get('reason')}）："
                            f"拒绝往坏账本里追加（FR-LEDGER-003）")
        base = ledger.count
        stack = build_stack(ledger, realm, side_root, now)
        notes.append(f"前置栈：成本构成 → 定价建议（{stack['proposal_id']}，人确认）→ {QUOTE}")

        marks = {"prerequisite": ledger.count}
        negotiate = seed_negotiate(ledger, stack, spec)
        marks["negotiate"] = ledger.count
        faq = seed_faq(ledger, realm, spec)
        marks["faq"] = ledger.count
        mail = seed_mail(ledger, realm, spec, now)
        marks["mail"] = ledger.count

        added_by_domain = {
            "prerequisite": marks["prerequisite"] - base,
            "negotiate": marks["negotiate"] - marks["prerequisite"],
            "faq": marks["faq"] - marks["negotiate"],
            "mail": marks["mail"] - marks["faq"],
        }
        new_rows = ledger.read(from_seq=base + 1)
        _verify_new_rows(new_rows, now, verify_actors=verify_actors)
        counts = _snapshot_view(shared, side)

    notes.extend(negotiate["notes"])
    notes.extend(faq["notes"])
    notes.extend(mail["notes"])
    return {
        "side": side,
        "realm": realm,
        "ledger": _display(path),
        "rows_before": base,
        "rows_after": ledger.count,
        "added": ledger.count - base,
        "added_by_domain": added_by_domain,
        "counts": counts,
        "event_types": _type_counts(ledger),
        "added_types": _count_types(new_rows),
        "steps": notes,
        "clock_patched": clock_patched,
        "ledger_sha256": _sha256_of(path),
    }


def _count_types(rows: list) -> dict:
    counts: dict = {}
    for row in rows:
        key = str(row.get("type"))
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _verify_new_rows(rows: list, now: str, *, verify_actors: bool) -> None:
    """本次新增的每一行都要过两条纪律：`ts == --now`、`actor` 是 ui-seed 本人。"""
    bad_time = [(row.get("seq"), row.get("ts")) for row in rows if str(row.get("ts")) != now]
    if bad_time:
        raise SeedError(f"有 {len(bad_time)} 行的 ts 不是 --now（{now}）：{bad_time[:3]}"
                        f" → 时间没有钉住，同一输入不可复现")
    if verify_actors:
        bad_actor = sorted({str(row.get("actor")) for row in rows
                            if not str(row.get("actor", "")).startswith(ACTOR_PREFIXES)})
        if bad_actor:
            raise SeedError(f"有行的 actor 不是 ui-seed 本人：{bad_actor} → "
                            f"演示数据必须自报家门（D-054 第 1 条）")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def _validate_now(value: str) -> str:
    """`--now` 必须是内核 `utc_now()` 的同形 ISO 时间戳（`YYYY-MM-DDTHH:MM:SSZ`）。"""
    text = str(value or "").strip()
    ok = (len(text) == 20 and text[4] == "-" and text[7] == "-" and text[10] == "T"
          and text[13] == ":" and text[16] == ":" and text[19] == "Z"
          and all(ch.isdigit() for index, ch in enumerate(text)
                  if index in (0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18)))
    if not ok:
        raise SeedError(f"--now 形状不对（{text!r}）：需要 `YYYY-MM-DDTHH:MM:SSZ`"
                        f"（与账本行的 ts 同形；时间只能由参数传入，不许读墙钟）")
    return text


def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="ui-seed-pipeline",
        description="用真服务把谈判/FAQ/邮件三域事件种进 UI 账本（只追加、幂等、时间由 --now 传入）")
    parser.add_argument("--shared-dir", default=str(DEFAULT_SHARED),
                        help="共享目录：账本 <shared-dir>/<side>/ledger.jsonl（默认 tmp/ui-shared）")
    parser.add_argument("--now", default=DEFAULT_NOW,
                        help=f"时间戳（ISO8601，默认 {DEFAULT_NOW}）；本工具不读墙钟")
    parser.add_argument("--sides", default=",".join(SIDES),
                        help=f"逗号分隔的侧（默认 {'/'.join(SIDES)}）")
    parser.add_argument("--no-verify-actors", action="store_true",
                        help="关掉 actor 前缀自检（默认开；关掉只用于排障，纪律不该关）")
    args = parser.parse_args(argv)

    sides = [item.strip() for item in str(args.sides).split(",") if item.strip()]
    shared = Path(args.shared_dir).expanduser().resolve()
    try:
        if not sides:
            raise SeedError("--sides 不能为空")
        unknown = [item for item in sides if item not in SIDE_SPEC]
        if unknown:
            raise SeedError(f"未知的侧 {unknown}；已声明: {list(SIDES)}")
        now = _validate_now(args.now)
        shared.mkdir(parents=True, exist_ok=True)
        reports: dict = {}
        for side in sides:
            reports[side] = run_side(shared, side, now, SIDE_SPEC[side],
                                     verify_actors=not args.no_verify_actors)
    except Exception as exc:  # noqa: BLE001 - 失败必须非 0 退出，并把原因摆在 stdout 的 JSON 里
        print(json.dumps({"ok": False, "shared_dir": str(shared), "error": f"{type(exc).__name__}: {exc}"},
                         ensure_ascii=False, sort_keys=True))
        print(f"[ui-seed] 失败（非 0 退出，不静默）：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    payload = {
        "ok": True,
        "shared_dir": str(shared),
        "now": now,
        "added": {side: reports[side]["added"] for side in sides},
        "counts": {side: reports[side]["counts"] for side in sides},
        "sides": reports,
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    for side in sides:
        report = reports[side]
        print(f"[ui-seed] {side}: realm={report['realm']} 新增 {report['added']} 行"
              f"（前置栈 {report['added_by_domain']['prerequisite']} / 谈判 {report['added_by_domain']['negotiate']}"
              f" / FAQ {report['added_by_domain']['faq']} / 邮件 {report['added_by_domain']['mail']}）"
              f"，账本共 {report['rows_after']} 行 {report['ledger_sha256'][:16]}…", file=sys.stderr)
        for step in report["steps"]:
            print(f"[ui-seed] {side}: {step}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - 环境/用法错误也不得当作通过
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False,
                         sort_keys=True))
        print(f"[ui-seed] 环境/用法错误（不得当作通过）：{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
