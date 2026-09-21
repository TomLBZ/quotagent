"""AC-AUDIT-003：留存策略引擎（FR-EVIDENCE-004 / NFR-COMP-003）——账本行永不销毁、只读计划、确定性、有界。

本机检覆盖（正控 + 负控 + 静态扫描 + 动态零副作用）：
  1. 正控：手算一致的逐档计数与逐项动作（含 age_days 手算 2455 天）；
  2. **账本行永不销毁**：到期且策略要求 archive/purge-copy 的账本行被判 `keep` + `counts.refused`，
     `guard_destroy()` 抛专门异常 `LedgerRowNotDestroyable`；策略层写 `scope: ledger` 在建策略时即被拒；
  3. 未知事件类型不判销毁（`undecided`，且 `default_days=0` 也不放行）；
  4. NaN / 负数 / 未来时间 / 垃圾输入逐条拒绝且不崩（`counts.rejected`，不回显条目内容）；
  5. 不依赖墙钟：`now` 必须由参数给出（`None`/非法即拒绝）；
  6. 确定性：两次同输入 `render()` 字节一致；
  7. 零残留：静态扫描 `services/retention.py` 源码无 `open()`/write/unlink/os.remove/shutil/时钟调用；
     动态上跑完 `plan()` 后临时目录清单与内容不变，`side_effects` 全 0；
  8. 有界夹取：60 条输入 → 逐项清单夹到 max_items 并标明 omitted，而计数仍覆盖全部；
  9. 需要人工门的动作带出 `approval` 引用（scope/ref/reason/status=pending），`auto_approved == 0`；
 10. 私域字段（INV-008）：名字与值都不出现，只记 `redacted_fields` 个数；
 11. `verify_plan()` 与手算/重算计划逐项核对，篡改计数或某条动作即失败并定位。

【会变红的反例说明（刻意写在注释里，不假装通过）】
  · AC-AUDIT-003 在 `acceptance-criteria.md` 里的文字是「销毁策略生效后目标事件**不可再读**且销毁动作本身
    有账本事件」。本轮交付的是**内核侧只读计划**（只算不执行）：它**不**让任何账本行不可再读，也**不**自己
    落账本事件（执行与留痕属执行方/宿主层，另开任务）。因此把该文字原样写成断言必然变红，例如：
        # Assertion("账本行在 purge 后不可再读", ledger.read(correlation_id="...") == [], "本服务不执行销毁")
    这条**留着不写**，因为写了就是假的；相应地本机检断言的是「账本行**没有被销毁**」
    （`counts.refused` / `ledger_rows_destroyed == 0` / 拒绝理由可读）。
  · 门的负控（已实跑）：把硬约束从副本里拿掉后，本文件的第 1、2、3 条断言确实变红——
        tools/run.sh tmp/mutate-retention.py
        # 变异：`elif ledger_row:` → `elif False:`（账本行照策略执行）
        # 变异体 counts: {'keep': 1, 'archive': 1, ..., 'refused': 0}
        # 变异体 items : [('seq:1', 'archive', False), ...]   ← 账本行被判 archive
        # 机检断言会被判红：第 1 条（首项 keep + refused=1） / 第 3 条（refused=1）
    即：断言不是橡皮图章，谁要真去删/移账本行，这里立刻红。
"""

from __future__ import annotations

import ast
import json
import shutil
from pathlib import Path

from ..paths import new_scratch, repo_root
from ..services.approval import TIMEOUT_POLICIES
from ..services.retention import (ACTIONS, DERIVED_COPY, KEEP, LEDGER_ROW, PURGE_COPY, READ_KEYS,
                                  LedgerRowNotDestroyable, PolicyError, RetentionError, RetentionPolicy)
from .registry import Assertion, register

NOW = "2026-09-21T00:00:00Z"
OLD = "2020-01-01T00:00:00Z"
# 手算：2020-01-01 → 2026-09-21 = 2192（2020..2025 六个整年：366+365+365+365+366+365）
#                              + 263（2026-01-01 → 2026-09-21：31+28+31+30+31+30+31+31+20）= 2455 天
OLD_AGE_DAYS = 2455.0
SECRET = "SUPPLIER-SECRET-999"

POLICY = {
    "quote/submitted": {"retain_days": 365, "after": "archive"},
    "evidence/pack-exported": {"retain_days": 30, "after": PURGE_COPY, "requires_approval": True},
    "rfq/published": {"retain_days": 3650, "after": KEEP},
}
# 手算的动作表（顺序 = 输入顺序）：账本行按策略本应 archive，被硬约束拦下 → keep + refused
HAND_ACTIONS = [
    ("seq:1", KEEP),          # 账本行，到期，策略 after=archive → **拒绝**
    ("id:pack-014", PURGE_COPY),  # 派生副本，到期 → 销毁副本（需人工门）
    ("seq:2", KEEP),          # 账本行，未到期（2455 < 3650）
    ("seq:3", KEEP),          # 账本行，未到期（20 < 365）
    ("id:pack-015", KEEP),    # 派生副本，未到期（1 < 30）
    ("id:copy-x", KEEP),      # 未知类型 → 宁可不判
    ("id:pack-016", "archive"),   # 派生副本，到期 → 归档（策略未要求门）
]
HAND_COUNTS = {"keep": 5, "archive": 1, "purge-copy": 1, "accepted": 7, "rejected": 12, "total": 19,
               "undecided": 1, "refused": 1, "approval_required": 1}

ENTRIES = [
    {"seq": 1, "type": "quote/submitted", "ts": OLD, "entry_hash": "sha256:" + "a" * 64,
     "reserve_price": SECRET, "cost_model": {"element_rates": [1, 2]}, "signature": "sig-x"},
    {"id": "pack-014", "type": "evidence/pack-exported", "ts": OLD},
    {"seq": 2, "type": "rfq/published", "ts": OLD},
    {"seq": 3, "type": "quote/submitted", "ts": "2026-09-01T00:00:00Z"},
    {"id": "pack-015", "type": "evidence/pack-exported", "ts": "2026-09-20T00:00:00Z"},
    {"id": "copy-x", "type": "unknown/type", "ts": OLD},
    {"id": "pack-016", "type": "quote/submitted", "ts": OLD},
]
GARBAGE = [
    {"seq": "x"},                                                  # 0 seq 不是整数
    {"id": "d0", "type": ""},                                      # 1 空 type
    {"id": "d1", "type": "t", "ts": float("nan")},                 # 2 NaN 时间
    None,                                                          # 3 非对象
    42,                                                             # 4 非对象
    {"id": "d2", "type": "t", "ts": "not-a-time"},                 # 5 非法 ISO
    {"id": "d3", "seq": 3, "type": "t", "ts": OLD},                # 6 身份含糊（seq 与 id 同时给）
    {"kind": DERIVED_COPY, "id": "d4", "seq": 4, "type": "t", "ts": OLD},  # 7 派生副本却带 seq
    {"kind": "ghost", "id": "d5", "type": "t", "ts": OLD},         # 8 未知 kind
    {"seq": -1, "type": "t", "ts": OLD},                           # 9 负数 seq
    {"id": "d6", "type": "t", "ts": "2026-10-01T00:00:00Z"},       # 10 未来时间（age 为负）
    {"id": "d7", "type": "t"},                                     # 11 缺时间
]
ALL_ENTRIES = ENTRIES + GARBAGE


def _policy() -> RetentionPolicy:
    return RetentionPolicy(POLICY, default_days=3650, max_items=10)


def _plan() -> tuple:
    policy = _policy()
    return policy, policy.plan(ALL_ENTRIES, NOW)


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


@register("AC-AUDIT-003", "P2", "留存策略引擎（只读计划）：账本行永不销毁、未知类型不判销毁、确定性、无副作用、有界、销毁须人工门",
          "qa ac AC-AUDIT-003")
def check_audit_003() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("audit-003")
    policy, result = _plan()
    items = result["items"]

    # --- 1. 正控：手算计数 ------------------------------------------------
    out.append(Assertion("正控：逐档计数与手算一致（keep=5 / archive=1 / purge-copy=1；accepted=7 / rejected=12 / total=19）",
                         result["counts"] == HAND_COUNTS,
                         f"counts={result['counts']}"))
    out.append(Assertion("正控：逐项动作与手算一致（含 age_days 手算 2455 天：2020-01-01 → 2026-09-21）",
                         [(item["object"], item["action"]) for item in items] == HAND_ACTIONS
                         and items[0]["age_days"] == OLD_AGE_DAYS
                         and items[0]["retain_days"] == 365.0,
                         f"actions={[(i['object'], i['action']) for i in items]} age={items[0]['age_days']}"))

    # --- 2. 账本行永不销毁（正控 + 负控） --------------------------------
    first = items[0]
    out.append(Assertion("**账本行永不销毁**：到期且策略要求 archive 的账本行被判 keep，计入 refused=1，"
                         "理由可读且点名 append-only（FR-LEDGER-001）",
                         first["action"] == KEEP and first["refused"] is True
                         and first["kind"] == LEDGER_ROW and result["counts"]["refused"] == 1
                         and "拒绝" in first["reason"] and "FR-LEDGER-001" in first["reason"]
                         and result["ledger_rows_destroyed"] == 0,
                         f"action={first['action']} refused={first['refused']} reason={first['reason'][:90]}"))
    raised = _attempt(lambda: policy.guard_destroy({"seq": 1, "type": "quote/submitted"}))
    out.append(Assertion("负控：`guard_destroy(账本行)` 抛专门异常 LedgerRowNotDestroyable（不返回 True、不静默）",
                         isinstance(raised, LedgerRowNotDestroyable) and "append-only" in str(raised),
                         f"raised={type(raised).__name__}: {str(raised)[:90]}"))
    probes = {
        "scope=ledger": {"quote/submitted": {"retain_days": 10, "after": "archive", "scope": "ledger"}},
        "after=destroy": {"quote/submitted": {"retain_days": 10, "after": "destroy"}},
        "负留存期": {"quote/submitted": {"retain_days": -1}},
        "NaN 留存期": {"quote/submitted": {"retain_days": float("nan")}},
        "销毁不要人工门": {"quote/submitted": {"retain_days": 10, "after": PURGE_COPY, "requires_approval": False}},
        "未知键（拼错）": {"quote/submitted": {"retain_days": 10, "after": KEEP, "retnetion_days": 1}},
        "非字典规则": {"quote/submitted": 30},
    }
    verdicts = {name: _attempt(lambda rules=rules: RetentionPolicy(rules)) for name, rules in probes.items()}
    bad = {name: type(value).__name__ for name, value in verdicts.items()
           if not isinstance(value, (PolicyError, LedgerRowNotDestroyable))}
    out.append(Assertion("负控：策略层的销毁意图与坏配置在建策略时全拒（scope=ledger / after=destroy / 负天数 / "
                         "NaN / 无人工门的销毁 / 未知键 / 非字典规则，7/7）",
                         not bad, f"未被拒的配置：{bad or '无'}"))

    # --- 3. 未知类型不判销毁 ---------------------------------------------
    zero_default = RetentionPolicy({"quote/submitted": {"retain_days": 1, "after": PURGE_COPY,
                                                       "requires_approval": True}}, default_days=0, max_items=10)
    unknown = zero_default.plan([{"id": "c-1", "type": "brand/new-type", "ts": OLD},
                                 {"seq": 9, "type": "brand/new-type", "ts": OLD}], NOW)
    out.append(Assertion("负控：未知事件类型**不判销毁**（default_days=0 也不放行）——逐条 keep + undecided=2，"
                         "且账本行/副本都不出审批引用",
                         unknown["counts"]["purge-copy"] == 0 and unknown["counts"]["keep"] == 2
                         and unknown["counts"]["undecided"] == 2 and unknown["counts"]["approval_required"] == 0
                         and all("宁可不判" in item["reason"] for item in unknown["items"]),
                         f"counts={unknown['counts']}"))

    # --- 4. 垃圾输入逐条拒绝且不崩 ---------------------------------------
    rejected = result["rejected"]
    reasons_ok = all(row["reason"] for row in rejected) and all("at" in row for row in rejected)
    out.append(Assertion("垃圾输入逐条拒绝且不崩：NaN / 负数 seq / 未来时间 / 非对象 / 身份含糊 / 缺时间等 "
                         f"{len(GARBAGE)} 条全部 rejected（计数 {result['counts']['rejected']}），"
                         f"逐条清单按有界夹取只列前 {len(rejected)} 条并标明 omitted="
                         f"{result['rejected_bounded']['omitted']}，理由逐条可读",
                         result["counts"]["rejected"] == len(GARBAGE) == 12 and len(rejected) == 10
                         and result["rejected_bounded"]["omitted"] == 2 and reasons_ok
                         and result["counts"]["accepted"] == 7,
                         f"rejected={len(rejected)}/{result['counts']['rejected']} "
                         f"reasons={[row['reason'][:34] for row in rejected[:4]]}"))
    leaked = [row["reason"] for row in rejected
              if SECRET in row["reason"] or "reserve_price" in row["reason"] or "cost_model" in row["reason"]]
    out.append(Assertion("拒绝理由不回显条目内容（私域名字与值都不进拒绝清单——理由只报字段名与被拒绝的原因）",
                         not leaked and SECRET not in json.dumps(result["rejected"], ensure_ascii=False),
                         f"leak={leaked[:2]}"))

    # --- 5. 不依赖墙钟 ---------------------------------------------------
    no_clock = _attempt(lambda: policy.plan(ALL_ENTRIES, None))
    bad_now = _attempt(lambda: policy.plan(ALL_ENTRIES, "not-a-time"))
    bad_entries = _attempt(lambda: policy.plan(42, NOW))
    dict_entries = _attempt(lambda: policy.plan({"a": 1}, NOW))
    out.append(Assertion("不依赖墙钟：`now=None` 即拒绝（绝不回退 utc_now），非法 now 与非集合 entries 也拒绝",
                         all(isinstance(value, RetentionError)
                             for value in (no_clock, bad_now, bad_entries, dict_entries))
                         and "不读墙钟" in str(no_clock),
                         f"None→{no_clock} bad_now→{bad_now} entries=42→{bad_entries}"))

    # --- 6. 确定性 -------------------------------------------------------
    again = policy.plan(ALL_ENTRIES, NOW)
    changed = RetentionPolicy({**POLICY, "quote/submitted": {"retain_days": 366, "after": "archive"}},
                             default_days=3650, max_items=10)
    out.append(Assertion("确定性：两次同输入 `render()` **字节一致**，`evaluated_at` 来自参数（非墙钟），"
                         "策略摘要只由配置决定（改一条规则即变）",
                         policy.render(result) == policy.render(again)
                         and policy.render(result) == policy.render(policy.plan(ALL_ENTRIES, NOW))
                         and result["evaluated_at"] == NOW
                         and result["policy_digest"] == policy.rule_digest()
                         and changed.rule_digest() != policy.rule_digest(),
                         f"bytes={len(policy.render(result).encode('utf-8'))} digest={result['policy_digest'][:24]}…"))

    # --- 7. 零残留：静态扫描 + 动态 --------------------------------------
    source = (repo_root() / "src/quotagent/services/retention.py").read_text(encoding="utf-8")
    write_needles = ("open(", "write_text", "write_bytes", "unlink", "os.remove", "shutil", "rmtree",
                     "mkdir", "import os", "import shutil", "os.replace", "truncate(",
                     "from ..kernel.ledger", "self.ledger")
    hits = [needle for needle in write_needles if needle in source]
    out.append(Assertion("零残留（静态·文本）：`services/retention.py` 里没有 open()/write/unlink/os.remove/"
                         "shutil/mkdir/truncate，也没有账本写入口（`from ..kernel.ledger` / `self.ledger`）",
                         not hits, f"命中：{hits or '无'}（已扫描 {len(source)} 字节）"))
    tree = ast.parse(source)
    imports: set[str] = set()
    calls: set[str] = set()
    clock_calls: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level:   # 包内相对导入不算外部依赖
            imports.add((node.module or "").split(".")[0])
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            calls.add(node.func.id)
        elif (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
              and node.func.attr in ("now", "utcnow", "today")):
            clock_calls.add(node.func.attr)
    out.append(Assertion("不依赖墙钟（静态·AST）：外部导入只限 math/datetime/typing/__future__"
                         "（没有 time/os/shutil/pathlib/subprocess 模块），没有 open() 调用，"
                         "也没有 now()/utcnow()/today() 时钟调用",
                         imports <= {"math", "datetime", "typing", "__future__"}
                         and not (imports & {"time", "os", "shutil", "pathlib", "subprocess", "tempfile"})
                         and "open" not in calls and not clock_calls,
                         f"imports={sorted(imports)} clock_calls={sorted(clock_calls)} open_in_calls={'open' in calls}"))
    before = sorted(str(path.relative_to(root)) for path in root.rglob("*"))
    policy.plan(ALL_ENTRIES, NOW)
    after = sorted(str(path.relative_to(root)) for path in root.rglob("*"))
    out.append(Assertion("零残留（动态）：跑完 plan 后临时目录清单不变，`side_effects` 全 0、"
                         "`ledger_rows_destroyed == 0`（只计算不执行）",
                         before == after and set(result["side_effects"].values()) == {0}
                         and result["ledger_rows_destroyed"] == 0,
                         f"files={before} side_effects={result['side_effects']}"))

    # --- 8. 有界夹取 -----------------------------------------------------
    flood = [{"id": f"copy-{index:03d}", "type": "evidence/pack-exported", "ts": OLD} for index in range(60)]
    small = RetentionPolicy({"evidence/pack-exported": {"retain_days": 30, "after": PURGE_COPY,
                                                       "requires_approval": True}}, max_items=10)
    flood_result = small.plan(flood, NOW)
    out.append(Assertion("有界夹取：60 条输入、max_items=10 → 逐项清单夹到 10 并标明 omitted=50/truncated，"
                         "而计数仍覆盖全部 60 条；人工门引用清单同样夹取",
                         len(flood_result["items"]) == 10 and flood_result["bounded"] == {"limit": 10, "listed": 10,
                                                                                          "omitted": 50, "truncated": True}
                         and flood_result["counts"]["purge-copy"] == 60 and flood_result["counts"]["total"] == 60
                         and flood_result["approvals_bounded"] == {"limit": 10, "listed": 10, "omitted": 50,
                                                                   "truncated": True}
                         and len(flood_result["approvals"]) == 10,
                         f"bounded={flood_result['bounded']} approvals={flood_result['approvals_bounded']}"))

    # --- 9. 人工门引用（本服务不批准） -----------------------------------
    gate = items[1]["approval"]
    out.append(Assertion("需要人工门的动作带出「要什么门」：scope/ref/reason/status=pending，`auto_approved == 0`，"
                         "`decided_by` 为空——本服务不批准任何动作",
                         items[1]["approval_required"] is True and isinstance(gate, dict)
                         and gate["scope"] == "evidence.purge-copy" and gate["ref"] == "id:pack-014"
                         and gate["status"] == "pending" and gate["decided_by"] is None
                         and gate["auto_approve"] is False and result["auto_approved"] == 0
                         and all(row["status"] == "pending" for row in result["approvals"]),
                         f"approval={gate}"))
    out.append(Assertion("人工门语义：计划里给出的超时策略只能是 remind/escalate/abort（无「自动批准」选项），"
                         "且 `auto_approved` 恒为 0",
                         {row["timeout_policy"] for row in result["approvals"]} <= set(TIMEOUT_POLICIES)
                         and "granted" not in TIMEOUT_POLICIES and "approve" not in TIMEOUT_POLICIES
                         and result["auto_approved"] == 0,
                         f"timeout_policy={[row['timeout_policy'] for row in result['approvals']]} "
                         f"TIMEOUT_POLICIES={TIMEOUT_POLICIES}"))

    # --- 10. 留痕声明（执行方职责） --------------------------------------
    traces = {row["ref"]: row["type"] for row in result["trace_events"]}
    out.append(Assertion("留痕：归档/销毁动作带出**执行方必须落**的账本事件类型"
                         "（evidence/retention-copy-purged / evidence/retention-archived），而本服务自身零落痕",
                         traces == {"id:pack-014": "evidence/retention-copy-purged",
                                    "id:pack-016": "evidence/retention-archived"}
                         and any(item["trace_event"] is None for item in items if item["action"] == KEEP)
                         and result["side_effects"]["ledger_appends"] == 0,
                         f"trace_events={result['trace_events']}"))

    # --- 11. 私域字段（INV-008） -----------------------------------------
    text = policy.render(items[0])
    out.append(Assertion("私域字段（INV-008）：条目里的 reserve_price/cost_model/signature 不进结果——"
                         "名字与值都不出现，只记 `redacted_fields=3`；白名单外的键不被读取",
                         "reserve_price" not in text and "cost_model" not in text and "signature" not in text
                         and SECRET not in text and items[0]["redacted_fields"] == 3
                         and set(READ_KEYS) == {"seq", "id", "type", "ts", "at", "kind"}
                         and not any(key in text for key in ("element_rates",)),
                         f"redacted={items[0]['redacted_fields']} keys_in_result={sorted(items[0])}"))

    # --- 12. 核对（verify_plan） -----------------------------------------
    ok_report = policy.verify_plan(result, entries=ALL_ENTRIES, now=NOW)
    counts_tampered = json.loads(policy.render(result))
    counts_tampered["counts"]["purge-copy"] = 5
    counts_report = policy.verify_plan(counts_tampered, entries=ALL_ENTRIES, now=NOW)
    action_tampered = json.loads(policy.render(result))
    action_tampered["items"][0]["action"] = PURGE_COPY
    action_report = policy.verify_plan(action_tampered, entries=ALL_ENTRIES, now=NOW)
    out.append(Assertion("核对：`verify_plan` 对原计划 ok（逐项 checked=7）；篡改计数或某条动作即失败**并定位**",
                         ok_report == {"ok": True, "checked": 7, "first_mismatch": None}
                         and counts_report["ok"] is False and "计数不一致" in counts_report["first_mismatch"]
                         and action_report["ok"] is False and "第 1 项" in action_report["first_mismatch"],
                         f"ok={ok_report} counts={counts_report['first_mismatch']} "
                         f"action={action_report['first_mismatch']}"))

    # --- 13. 边界：空输入与身份含糊的条目 --------------------------------
    empty = policy.plan([], NOW)
    out.append(Assertion("边界：空输入不崩（计数全 0、truncated=False）；身份含糊 / 派生副本带 seq / 未知 kind "
                         "被逐条拒绝（分不清身份时宁可不判）",
                         empty["counts"] == {"keep": 0, "archive": 0, "purge-copy": 0, "accepted": 0, "rejected": 0,
                                             "total": 0, "undecided": 0, "refused": 0, "approval_required": 0}
                         and empty["bounded"]["truncated"] is False
                         and all(row["reason"].startswith(("身份含糊", "派生副本不应带 seq", "未知条目种类"))
                                 for row in result["rejected"][6:9]),
                         f"empty={empty['counts']} probes={[row['reason'][:26] for row in result['rejected'][6:9]]}"))

    # --- 14. 服务自洽：动作取值域与幂等 ---------------------------------
    out.append(Assertion("服务自洽：所有动作都在声明的取值域内（keep/archive/purge-copy），派生副本动作不含账本行，"
                         "两次调用逐项一致（幂等）",
                         {item["action"] for item in items} <= set(ACTIONS)
                         and all(item["kind"] == DERIVED_COPY for item in items if item["action"] != KEEP)
                         and [(item["object"], item["action"]) for item in items]
                         == [(item["object"], item["action"]) for item in policy.plan(ALL_ENTRIES, NOW)["items"]],
                         f"actions={sorted({item['action'] for item in items})}"))

    shutil.rmtree(root, ignore_errors=True)
    return out
