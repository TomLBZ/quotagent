#!/usr/bin/env python3
"""tools/commitment-apply.py —— 授标链（意向 → 供应商确认 → 承诺 → 发 PO）的**唯一落账本者**。

为什么需要它：WebUI 是**完整 GUI 应用**（`docs/design/29-webui-gui-app.md`），双方要能**只用界面**走完
全部业务流程（含写操作）；但 `AGENTS.md` 规则 1/3 与 29 §3 同时要求：**GUI 不是第二条事实写路径**，
对外承诺（授标、发 PO）必须过人工门、且落账本只能由 Python 侧的唯一写者做。所以每个写动作拆两段：

  ① 宿主（Node）只落**一条 0600 待办件**（`<ui-shared>/commitment-apply/<step>-<12hex>.json`）：账本零新增；
  ② 本脚本消费它：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ **重算校验**
     （`payload_sha256` / `bytes` / `submitted_at`）→ 用**真服务**（`ApprovalService` + `CommitmentGate`，
     `src/system/approval/code/approval.py` / `src/domain/commitments/code/commitments.py`）落账本。

四个步骤（`--step`），每步的门都在下面逐条写明；**门槛不降级、拒绝时账本零新增**：

  · `propose`（承包商侧，意向：**不产生义务**，可撤回）
      门：`quote/submitted` 行必须真的在本侧账本里（意向不得挂在虚构的报价上）；行项目逐条给量/单价（整数分）。
      落：`award/intent-proposed`（`CommitmentGate.intent()`，**不产生义务**）。
  · `confirm`（供应商侧，**人签**：`--actor` 必须 `human:`）
      门：意向必须真的在**承包商账本**里，且该 `quote_id` 在本侧账本里有自己的 `quote/submitted`（只确认自己那份）。
      落：自己账本 `award/confirmed` + 承包商账本一条同名登记（与 `quote-sign.py` 的双向登记同一模式）。
  · `commit`（承包商侧，**人签**：`--actor` 必须 `human:`）
      门①：意向存在且仍 `proposed`；门②：**有供应商确认**（`award/confirmed`，FR-AWARD-002）；门③：人工门
      （`approval/requested` → `approval/granted`，`scope=award.commit`，签发人 `human:`）——三样齐备才落
      `award/committed`（承诺类事件）。
  · `po`（承包商侧，**人签**：`--actor` 必须 `human:`）
      门①：**PO 只能由承诺派生**（`award/committed` 的 `award_id` 必须存在）；门②：逐行引用中标条目、不得改价
      （既有 `CommitmentGate.issue_po` 的 `po-line-not-derived` / `po-line-price-mismatch`）；门③：人工门
      （`scope=po.issue`）；门④：**投递**——收件人（供应商侧 realm）与中标报价的提交者必须对得上
      （`po-recipient-*`，账本零新增）。
      落：`po/issued`（带 `po → award → intent → quote` 的追溯链）+ **投递两条登记**
      （承包商账本 `po/distributed`（谁在何时收到哪个 `po_id`，与 `rfq/distributed` 同形）+
      供应商账本 `po/distributed`（收件人侧那条：本侧收到的采购单与逐行）+ 共享交换目录的**投递信封**）。
  · `acknowledge`（供应商侧，**人签**：`--actor` 必须 `human:`）
      门①：这条 PO 必须真的**投递到了本侧**（本侧账本里有 `po/distributed` 且 `po_id` 对上）——
      只确认投递给自己的那份；门②：承包商账本里该 `po_id` 的 `po/issued` 必须在（两侧对得上，不凭空回签）。
      落：自己账本 `po/acknowledged` + 承包商账本一条同名登记（与 `award/confirmed` 的双向登记同一模式）。

纪律（与 `quote-draft.py` / `quote-sign.py` / `rfq-publish.py` 同规格）：
  · 用法/环境错误在**构造 Ledger 之前**返回（拒绝时连空账本文件都不创建）；
  · `--now` 必填且为合法 ISO8601（判定不读墙钟）；
  · 幂等：同一 (step, 业务键) 已经落过 ⇒ `duplicates` + **账本零新增** + `exit 0`；
  · 待办件移入 `<inbox>/applied/`（**不删**：幂等可观察）；
  · stdout 恰一行 JSON；退出码 0 = 已落或幂等、1 = 有拒绝、2 = 用法/环境错误。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.services.approval import ApprovalService  # noqa: E402
from quotagent.services.commitments import CommitmentGate  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "commitment-apply"
STEPS = ("propose", "confirm", "commit", "po", "acknowledge")
HUMAN_STEPS = ("confirm", "commit", "po", "acknowledge")
MAX_LINES = 64
MAX_FILE_BYTES = 262144
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
EVENT_CONFIRMED = "award/confirmed"
EVENT_PO_DISTRIBUTED = "po/distributed"
EVENT_PO_ACKNOWLEDGED = "po/acknowledged"
SCOPE_AWARD = "award.commit"
SCOPE_PO = "po.issue"


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "step": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def deny(code: str, reason: str, next_action: str, step: str, request: str = "") -> int:
    return emit({"ok": False, "step": step, "applied": [], "duplicates": [], "ledger_added": 0,
                 "request": request, "refusal": refusal(code, reason, next_action)}, 1)


def digest_of(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(record: dict) -> str:
    payload = {key: value for key, value in record.items() if key not in IGNORED_KEYS}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def bump_counter(approvals: ApprovalService, rows: list[dict]) -> int:
    """把批准序号推到**账本里已用过的最大序号之后**（同一判据见 `change-apply.py` / `quote-review.py` /
    `gate-actions.py` 里的同名函数）。

    为什么需要：`ApprovalService.__init__` 在 `replay()` 之后无条件 `self._counter = 0`
    （`src/system/approval/code/approval.py`）⇒ **每个新进程都从 `ap-0001` 起**，同一账本上会出现重号的
    批准记录（P44 实测：本文件开的门拿到 `ap-0001`，而同一份账本里已经有另一个 `ap-0001`；门对象页按
    `approval_id` 归并行 ⇒ 两扇门会串在一起）。这里不改服务（那是它的语义），只把计数器推到安全位置。
    """
    highest = 0
    for row in rows:
        if not str(row.get("type") or "").startswith("approval/"):
            continue
        suffix = str(body_of(row).get("approval_id") or "").rsplit("-", 1)[-1]
        if suffix.isdigit():
            highest = max(highest, int(suffix))
    approvals._counter = highest                      # noqa: SLF001 —— 下一个 request 得到 ap-(highest+1)
    return highest


def rows_of(path: Path) -> tuple[list[dict] | None, str | None]:
    if not path.exists():
        return [], None
    out: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"{path}:{lineno} 不是合法 JSON：{exc}"
        if not isinstance(record, dict):
            return None, f"{path}:{lineno} 不是对象"
        out.append(record)
    return out, None


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if REALM_RE.match(value):
            return value
    return fallback


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def read_pending(path: Path, step: str) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（APP 的动作会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "待办件必须是普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600", "chmod 600 后再消费")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"{info.st_size} 字节超过上限 {MAX_FILE_BYTES}", "拆分载荷后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落")
    if record.get("schema") != SCHEMA:
        return None, refusal("pending-schema-unknown", f"schema 不是 {SCHEMA}", "让宿主按 schema 重落")
    if record.get("kind") != KIND:
        return None, refusal("pending-kind-unknown", f"kind 不是 {KIND}：{record.get('kind')!r}", "用授标链的载荷")
    if str(record.get("action") or "") != step:
        return None, refusal("action-mismatch", f"action 不是 {step}：{record.get('action')!r}",
                             f"用 --step {step} 对应的载荷")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（时间由 --now 给）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件（改载荷要重算哈希）")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与备注正文长度不一致", "让宿主重落待办件")
    return record, None


def lines_of(record: dict) -> tuple[list[dict] | None, dict | None]:
    raw = record.get("lines")
    if raw is None or raw == []:
        return [], None
    if not isinstance(raw, list):
        return None, refusal("lines-not-a-list", "lines 必须是数组", "行项目给数组（或省略）")
    if len(raw) > MAX_LINES:
        return None, refusal("lines-too-many", f"行 {len(raw)} 条超过上限 {MAX_LINES}", "拆小后重提")
    out: list[dict] = []
    for index, line in enumerate(raw):
        if not isinstance(line, dict):
            return None, refusal("line-not-an-object", f"lines[{index}] 不是对象", "改这一条行")
        item_id = str(line.get("item_id") or line.get("ref_line") or "").strip()
        if not ID_RE.match(item_id):
            return None, refusal("line-item-malformed", f"lines[{index}].item_id 形状非法：{item_id!r}",
                                 "行项目 id 用字母数字开头、只含 [A-Za-z0-9._-]")
        try:
            qty = float(line.get("qty"))
        except (TypeError, ValueError):
            return None, refusal("line-qty-invalid", f"行 {item_id} 的 qty 不是数：{line.get('qty')!r}", "qty 给数")
        if qty <= 0:
            return None, refusal("line-qty-invalid", f"行 {item_id} 的 qty 必须为正：{qty}", "数量必须为正")
        cents = line.get("unit_price_cents")
        if cents is None:
            price = line.get("unit_price")
            if price is None:
                return None, refusal("line-price-missing", f"行 {item_id} 既没有 unit_price_cents 也没有 unit_price",
                                     "给整数分单价（unit_price_cents）")
            cents = round(float(price) * 100)
        try:
            cents = int(cents)
        except (TypeError, ValueError):
            return None, refusal("line-price-invalid", f"行 {item_id} 的单价不是整数分：{cents!r}",
                                 "单价用整数分（8600 = 86.00）")
        if cents <= 0:
            return None, refusal("line-price-invalid", f"行 {item_id} 的单价必须为正整数分：{cents}", "给正整数分")
        out.append({"item_id": item_id, "qty": qty, "unit_price_cents": cents,
                    "unit_price": round(cents / 100.0, 6)})
    return out, None


def archive(inbox: Path, request: Path) -> str:
    applied = inbox / "applied"
    applied.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(applied, 0o700)
    except OSError:
        pass
    target = applied / request.name
    shutil.move(str(request), str(target))
    return str(target)


def open_ledger(path: Path, rows: list[dict], fallback_realm: str) -> tuple[Ledger | None, dict | None]:
    try:
        return Ledger(path, realm=realm_of(rows, fallback_realm)), None
    except LedgerError as exc:
        return None, refusal("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")


def seed_gate(gate: CommitmentGate, rows: list[dict]) -> dict:
    """把 `CommitmentGate` 的**内存登记**从账本行重建（账本是唯一事实源；重启后同样成立）。

    为什么要重建：`commit_award` / `issue_po` 的序号（`aw-000N` / `po-000N`）与"派生前置"都靠服务自己的
    内存登记。跨进程动作（GUI 的动作一次一进程）必须先把登记从账本重放出来，否则序号会重号、
    "PO 只能由承诺派生"这条门会把已成立的承诺判成不存在。
    """
    intents: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "award/intent-proposed":
            continue
        body = body_of(row)
        intent_id = str(body.get("intent_id") or "")
        if intent_id:
            intents[intent_id] = dict(body)
    awards: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "award/committed":
            continue
        body = body_of(row)
        award_id = str(body.get("award_id") or "")
        if not award_id:
            continue
        awards[award_id] = dict(body)
        intent = intents.get(str(body.get("intent_id") or ""))
        if intent is not None:
            intent.update({"status": "committed", "award_id": award_id})
    quotes: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "quote/submitted":
            continue
        body = body_of(row)
        quote_id = str(body.get("quote_id") or "")
        if not quote_id:
            continue
        lines = body.get("lines")
        if isinstance(lines, list) and lines:
            quotes.setdefault(quote_id, {"quote_id": quote_id, "lines": [dict(item) for item in lines]})
        else:
            item_id = str(body.get("item_id") or "")
            cents = body.get("unit_price_cents")
            if item_id and isinstance(cents, (int, float)):
                entry = quotes.setdefault(quote_id, {"quote_id": quote_id, "lines": []})
                entry["lines"].append({"item_id": item_id, "unit_price": float(cents) / 100.0})
    gate._intents = intents           # noqa: SLF001 —— 内存登记从账本重建（服务本身的职责由账本重放承担）
    gate._awards = awards             # noqa: SLF001
    gate._quotes = quotes             # noqa: SLF001
    return {"intents": len(intents), "awards": len(awards), "quotes": len(quotes)}


def confirmed_in(rows: list[dict], intent_id: str) -> dict | None:
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == EVENT_CONFIRMED and str(body.get("intent_id") or "") == intent_id:
            return body
    return None


def committed_in(rows: list[dict], intent_id: str) -> dict | None:
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == "award/committed" and str(body.get("intent_id") or "") == intent_id:
            return body
    return None


def issued_in(rows: list[dict], award_id: str) -> dict | None:
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == "po/issued" and str(body.get("award_id") or "") == award_id:
            return body
    return None


def issued_po_in(rows: list[dict], po_id: str) -> dict | None:
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == "po/issued" and str(body.get("po_id") or "") == po_id:
            return body
    return None


def delivered_in(rows: list[dict], po_id: str) -> dict | None:
    """本侧（收件人或发件人）账本里这条 PO 的投递登记（`po/distributed`）。"""
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == EVENT_PO_DISTRIBUTED and str(body.get("po_id") or "") == po_id:
            return body
    return None


def acknowledged_in(rows: list[dict], po_id: str) -> dict | None:
    for row in rows:
        body = body_of(row)
        if str(row.get("type")) == EVENT_PO_ACKNOWLEDGED and str(body.get("po_id") or "") == po_id:
            return body
    return None


def bidder_realm(s_rows: list[dict], quote_id: str) -> str:
    """提交了 `quote_id` 的那一家的 realm（**只能从被投递方自己的账本读**，不猜、不从信封读）。"""
    for row in s_rows:
        body = body_of(row)
        if str(row.get("type")) == "quote/submitted" and str(body.get("quote_id") or "") == quote_id:
            return realm_of(s_rows, "")
    return ""


def clip(value: object, limit: int = 120) -> str:
    """人工自由输入的一行字（交期窗口/送货地址）：去控制字符、压空白、有界——**不改语义、只防脏**。"""
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(value or "")).replace("\n", " ").strip()[:limit]


def write_delivery_envelope(target: Path, entry: dict) -> str:
    """投递信封（交换面，与 `exchange/award-intents.json` 同一份纪律）：按 `po_id` 合并，原子写。"""
    try:
        existing = json.loads(target.read_text(encoding="utf-8")) if target.exists() else []
        existing = existing if isinstance(existing, list) else []
    except ValueError:
        existing = []
    merged = [item for item in existing if str(item.get("po_id")) != str(entry.get("po_id"))] + [entry]
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    return str(target)


def deliver_po(*, po_body: dict, led_contractor: Path, c_rows: list[dict], led_supplier: Path,
               s_rows: list[dict], delivery_out: str, now: str, actor: str,
               premises: dict | None = None) -> tuple[dict | None, dict | None]:
    """把**已签发**的 PO 投递给中标供应商：① 收件人 = 中标报价的提交者；② 两侧账本各一条 `po/distributed`；
    ③ 共享交换目录的投递信封。任何一条判据不成立 ⇒ **不写任何东西**（账本与信封都零新增），返回拒绝。

    `po/issued` 只落承包商账本（承包商的事实）；收件人侧必须有自己的那条**投递登记**，否则
    「供应商看不到 PO」——那不是收件人的错，而是投递没有留痕（与 `rfq-publish.py` 的收件人登记同因）。
    """
    po_id = str(po_body.get("po_id") or "")
    quote_id = str(po_body.get("quote_id") or "")
    s_realm = realm_of(s_rows, "")
    if s_realm == "":
        return None, refusal("po-recipient-unknown",
                             "被投递方账本里读不出 realm：投递给谁不猜（PO 投递必须有收件人）",
                             "让被投递方先在本侧产生一条带 realm 的事实（登录 + 一次动作即产生）")
    bidder = bidder_realm(s_rows, quote_id)
    if bidder == "":
        return None, refusal("po-recipient-not-the-bidder",
                             f"被投递方账本里没有中标报价 {quote_id} 的提交记录：PO 只投给提交这份报价的那一家",
                             "先让中标供应商把报价送到本侧（APP 供应商道「提交报价」），或核对 award 的 quote_id")
    envelope = {"po_id": po_id, "award_id": str(po_body.get("award_id") or ""),
                "intent_id": str(po_body.get("intent_id") or ""), "quote_id": quote_id,
                "package_id": str(po_body.get("package_id") or ""),
                "lines": [dict(line) for line in (po_body.get("lines") or [])],
                "total_amount": po_body.get("total_amount"), "chain": str(po_body.get("chain") or ""),
                "trace_mode": str(po_body.get("trace_mode") or ""),
                "approved_by": str(po_body.get("approved_by") or ""),
                "issued_at": str(po_body.get("issued_at") or ""),
                "delivered_to": [s_realm], "delivered_at": now, "channel": "relay"}
    # 执行前提（发 PO 的人给的）：**只出非空值**——空着就如实缺（界面照实显示"对方没给"，不编）。
    for key in ("delivery_window", "ship_to"):
        value = clip((premises or {}).get(key))
        if value:
            envelope[key] = value
    out: list[dict] = []
    try:
        c_ledger = Ledger(led_contractor, realm=realm_of(c_rows, "contractor:gui"))
        c_ledger.append(EVENT_PO_DISTRIBUTED,
                        {"po_id": po_id, "award_id": envelope["award_id"], "quote_id": quote_id,
                         "package_id": envelope["package_id"], "channel": "relay", "recipients": [s_realm],
                         "sent_at": now, "line_count": len(envelope["lines"]),
                         "envelope": envelope, "view": "contractor",
                         "note": "分发记录：这张 PO 在此时投给了谁（收件人侧另有一条同名的投递登记）"},
                        correlation_id=po_id, actor=actor, ts=now, event_class="fact",
                        refs={"po_id": po_id, "package_id": envelope["package_id"]})
        s_ledger = Ledger(led_supplier, realm=s_realm)
        s_ledger.append(EVENT_PO_DISTRIBUTED,
                        {**envelope, "view": "recipient", "recipients": [s_realm], "sent_at": now,
                         "note": "投递登记：本侧收到的采购单（逐行 + 追溯链）——由签发方的唯一写者写，"
                                 "回签（po/acknowledged）据此成立"},
                        correlation_id=po_id, actor=actor, ts=now, event_class="fact",
                        refs={"po_id": po_id, "package_id": envelope["package_id"]})
    except LedgerError as exc:
        return None, refusal("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往坏账本追加）")
    out.append({"event": EVENT_PO_DISTRIBUTED, "view": "contractor", "recipients": [s_realm],
                "po_id": po_id, "sent_at": now})
    out.append({"event": EVENT_PO_DISTRIBUTED, "view": "recipient", "recipients": [s_realm],
                "po_id": po_id, "ledger": str(led_supplier), "lines": len(envelope["lines"])})
    envelope_path = ""
    if delivery_out:
        try:
            envelope_path = write_delivery_envelope(Path(delivery_out), envelope)
        except OSError as exc:            # 交换面写不出来**不改事实**：账本两条已落，如实报路径没写成
            envelope_path = f"（信封未写成：{exc}）"
    return {"applied": out, "envelope": envelope_path, "recipient": s_realm, "ledger_added": 2,
            "premises": {key: envelope[key] for key in ("delivery_window", "ship_to") if key in envelope}}, None


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="授标链的唯一落账本者（GUI 动作的服务端一半）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费文件名最小的那条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--intent-out", dest="intent_out", default="",
                        help="意向投递信封（propose 用；默认 <ui-shared>/exchange/award-intents.json）")
    parser.add_argument("--delivery-out", dest="delivery_out", default="",
                        help="PO 投递信封（po 用；默认 <ui-shared>/exchange/po-deliveries.json）")
    parser.add_argument("--actor", default="", help="署名（confirm/commit/po 三步**必须** human:<人名>）")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    step = args.step
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "--now 2026-09-24T09:00:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "step": step, "applied": [], "duplicates": [], "ledger_added": 0,
                         "refusal": None, "inbox": str(inbox), "pending": 0,
                         "note": "待办件目录里没有待消费的载荷（空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny_ = read_pending(request, step)
    if deny_ is not None:
        return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
    assert record is not None

    led_contractor = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    led_supplier = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    c_rows, error = rows_of(led_contractor)
    if error is not None or c_rows is None:
        return usage_error("ledger-unreadable", str(error), "先修承包商账本（不往坏账本追加）")
    s_rows, error = rows_of(led_supplier)
    if error is not None or s_rows is None:
        return usage_error("ledger-unreadable", str(error), "先修供应商账本（不往坏账本追加）")
    actor = str(record.get("actor") or args.actor).strip() or args.actor
    if step in HUMAN_STEPS and not actor.startswith("human:"):
        return usage_error("human-required", f"--step {step} 的署名必须是 human:（收到 {actor!r}）",
                           "人工门不接受 agent 代签：给 --actor human:<人名>")
    lines, deny_ = lines_of(record)
    if deny_ is not None:
        return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
    assert lines is not None

    # ------------------------------------------------------------------ propose
    if step == "propose":
        quote_id = str(record.get("quote_id") or "").strip()
        package_id = str(record.get("package_id") or "").strip()
        if not ID_RE.match(quote_id) or not ID_RE.match(package_id):
            return deny("quote-id-malformed", f"quote_id/package_id 形状非法：{quote_id!r}/{package_id!r}",
                        "用账本里的真 quote_id/package_id", step, str(request))
        if not lines:
            return deny("lines-required", "意向必须给行项目（量 + 整数分单价）",
                        "在 APP 的比价表里选中报价后重提", step, str(request))
        source = None
        for row in c_rows:
            body = body_of(row)
            if str(row.get("type")) == "quote/submitted" and str(body.get("quote_id") or "") == quote_id:
                source = body
        if source is None:
            return deny("quote-not-found", f"本侧账本里没有 quote/submitted（quote_id={quote_id}）",
                        "先让对方把报价送达本侧（APP 的「提交报价」会写这条登记）", step, str(request))
        intent_body = {"package_id": package_id, "quote_id": quote_id, "lines": lines,
                       "reason": str(record.get("reason") or ""), "view": "contractor"}
        supplier_id = str(record.get("supplier") or source.get("supplier") or "").strip()
        if args.intent_out and not supplier_id:
            return deny("supplier-unknown", f"报价 {quote_id} 的行里读不出供应商（不猜）",
                        "报价登记行必须带 supplier（quote-sign.py 落的通知行带它）", step, str(request))
        key = digest_of(json.dumps(intent_body, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        for row in c_rows:
            body = body_of(row)
            if str(row.get("type")) != "award/intent-proposed":
                continue
            same = {"package_id": body.get("package_id"), "quote_id": body.get("quote_id"),
                    "lines": body.get("lines"), "reason": body.get("reason"), "view": "contractor"}
            if digest_of(json.dumps(same, ensure_ascii=False, sort_keys=True, separators=(",", ":"))) == key:
                return emit({"ok": True, "step": step, "applied": [], "request": str(request),
                             "duplicates": [{"intent_id": body.get("intent_id"), "reason": "already-proposed"}],
                             "ledger_added": 0, "refusal": None,
                             "note": "同一份意向已经提过：账本零新增（意向可撤回，重提要先撤回）"}, 0)
        ledger, deny_ = open_ledger(led_contractor, c_rows, "contractor:gui")
        if ledger is None:
            return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
        assert ledger is not None
        # `actor` 必须传进来：`ApprovalService.request()` 把 `self.actor` 写成
        # `approval/requested` 那一行的 `requested_by`（`_append` 的 `record["decided_by"] or self.actor`），
        # 不传 ⇒ 请求人被记成服务默认值 `agent:approval`（P43 实测登记的真缺陷；真实面同样如此，
        # 不是只有沙盘）。`actor` 在本文件上面已从待办件/`--actor` 解析出来。
        approvals = ApprovalService(ledger=ledger, actor=actor)
        bump_counter(approvals, c_rows)
        gate = CommitmentGate(approval=approvals, ledger=ledger, actor=actor)
        seeded = seed_gate(gate, c_rows)
        if args.dry_run:
            return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "seeded": seeded,
                         "note": "干跑：校验通过、账本零新增"}, 0)
        intent = gate.intent(package_id=package_id, quote_id=quote_id, lines=lines,
                            reason=str(record.get("reason") or ""))
        # 意向要能被**对方**看到：写一份投递给供应商的信封（与 RFQ 投递信封同一模式：发送方写共享交换目录，
        # 收件人按 `delivered_to` 过滤只出自己的那份；账本的 realm 隔离不因此被削薄）。
        envelope_written = ""
        if args.intent_out:
            target = Path(args.intent_out)
            try:
                existing = json.loads(target.read_text(encoding="utf-8")) if target.exists() else []
                existing = existing if isinstance(existing, list) else []
            except ValueError:
                existing = []
            entry = {"intent_id": intent["intent_id"], "package_id": package_id, "quote_id": quote_id,
                     "lines": lines, "reason": str(record.get("reason") or ""),
                     "supplier": supplier_id, "proposed_at": args.now,
                     "delivered_to": [supplier_id]}
            merged = [item for item in existing if item.get("intent_id") != intent["intent_id"]] + [entry]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                              encoding="utf-8")
            envelope_written = str(target)
        archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
        return emit({"ok": True, "step": step, "applied": [
            {"event": "award/intent-proposed", "intent_id": intent["intent_id"], "quote_id": quote_id,
             "package_id": package_id, "lines": len(lines), "obligation": None}],
            "duplicates": [], "ledger_added": 1, "refusal": None, "request": str(request),
            "archived": archived, "intent_id": intent["intent_id"], "seeded": seeded,
            "envelope": envelope_written,
            "next_action": "把意向交给供应商确认（APP 供应商道「确认授标」→ 本脚本 --step confirm）；"
                           "确认 + 人工批准齐备后才能承诺",
            "note": "意向**不产生义务**（可撤回）：账本里没有 award/committed 就没有承诺"}, 0)

    # ------------------------------------------------------------------ confirm
    if step == "confirm":
        intent_id = str(record.get("intent_id") or "").strip()
        if not ID_RE.match(intent_id):
            return deny("intent-id-malformed", f"intent_id 形状非法：{intent_id!r}", "用账本里的真 intent_id",
                        step, str(request))
        intent = None
        for row in c_rows:
            body = body_of(row)
            if str(row.get("type")) == "award/intent-proposed" and str(body.get("intent_id") or "") == intent_id:
                intent = body
        if intent is None:
            return deny("intent-not-found", f"承包商账本里没有 intent_id={intent_id} 的意向",
                        "先让承包商在 APP 里提出授标意向（本侧账本零新增）", step, str(request))
        quote_id = str(intent.get("quote_id") or "")
        mine = any(str(row.get("type")) == "quote/submitted" and str(body_of(row).get("quote_id") or "") == quote_id
                   for row in s_rows)
        if not mine:
            return deny("quote-not-mine", f"本侧账本里没有 quote_id={quote_id} 的报价（不能替别人确认）",
                        "只确认自己提交过的报价对应的意向", step, str(request))
        previous = confirmed_in(s_rows, intent_id)
        if previous is not None and str(previous.get("confirmed_by") or "") == actor:
            return emit({"ok": True, "step": step, "applied": [], "request": str(request),
                         "duplicates": [{"intent_id": intent_id, "reason": "already-confirmed"}],
                         "ledger_added": 0, "refusal": None,
                         "note": "这份意向已经由同一人确认过：账本零新增（确认是幂等动作）"}, 0)
        body = {"intent_id": intent_id, "package_id": intent.get("package_id"), "quote_id": quote_id,
                "supplier": realm_of(s_rows, "supplier:gui"), "confirmed_by": actor, "confirmed_at": args.now,
                "note": str(record.get("note") or ""), "source": "webui-gui"}
        contractor_note = {**body, "view": "contractor"}
        if args.dry_run:
            return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None,
                         "note": "干跑：意向与本侧报价都核过了，账本零新增"}, 0)
        try:
            s_ledger = Ledger(led_supplier, realm=realm_of(s_rows, "supplier:gui"))
            s_ledger.append(EVENT_CONFIRMED, body, correlation_id=intent_id, actor=actor, ts=args.now)
            c_ledger = Ledger(led_contractor, realm=realm_of(c_rows, "contractor:gui"))
            c_ledger.append(EVENT_CONFIRMED, contractor_note, correlation_id=intent_id, actor=actor, ts=args.now)
        except LedgerError as exc:
            return deny("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往坏账本追加）", step, str(request))
        archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
        return emit({"ok": True, "step": step, "applied": [
            {"view": "supplier", "event": EVENT_CONFIRMED, "intent_id": intent_id, "quote_id": quote_id},
            {"view": "contractor", "event": EVENT_CONFIRMED, "intent_id": intent_id, "quote_id": quote_id}],
            "duplicates": [], "ledger_added": 2, "refusal": None, "request": str(request),
            "archived": archived, "intent_id": intent_id, "confirmed_by": actor,
            "next_action": "回到承包商侧：人工签名的「授标承诺」现在可以提交了（承诺仍要过人工门）",
            "note": "确认是**供应商自己**的动作（只确认自己那份报价对应的意向）；确认不等于承诺"}, 0)

    # ------------------------------------------------------------------ commit
    if step == "commit":
        intent_id = str(record.get("intent_id") or "").strip()
        if not ID_RE.match(intent_id):
            return deny("intent-id-malformed", f"intent_id 形状非法：{intent_id!r}", "用账本里的真 intent_id",
                        step, str(request))
        already = committed_in(c_rows, intent_id)
        if already is not None:
            return emit({"ok": True, "step": step, "applied": [], "request": str(request),
                         "duplicates": [{"intent_id": intent_id, "reason": "already-committed",
                                         "award_id": already.get("award_id")}],
                         "ledger_added": 0, "refusal": None,
                         "note": "这份意向已经成承诺：账本零新增（承诺不是幂等地可重复的事实）",
                         "award_id": already.get("award_id")}, 0)
        intent = None
        for row in c_rows:
            body = body_of(row)
            if str(row.get("type")) == "award/intent-proposed" and str(body.get("intent_id") or "") == intent_id:
                intent = body
        if intent is None:
            return deny("intent-not-found", f"承包商账本里没有 intent_id={intent_id} 的意向",
                        "先在 APP 里提出授标意向", step, str(request))
        confirmation = None
        for row in c_rows:
            body = body_of(row)
            if str(row.get("type")) == EVENT_CONFIRMED and str(body.get("intent_id") or "") == intent_id:
                confirmation = body
        if confirmation is None:
            return deny("supplier-confirmation-required",
                        f"意向 {intent_id} 还没有供应商确认（{EVENT_CONFIRMED}）",
                        "让供应商在 APP 里「确认授标」（FR-AWARD-002：承诺不可凭空产生）", step, str(request))
        ledger, deny_ = open_ledger(led_contractor, c_rows, "contractor:gui")
        if ledger is None:
            return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
        assert ledger is not None
        approvals = ApprovalService(ledger=ledger, actor=actor)   # `actor`：请求人不得被记成 agent:approval
        bump_counter(approvals, c_rows)                           # 门号不与账本里已有的重号
        gate = CommitmentGate(approval=approvals, ledger=ledger, actor=actor)
        seeded = seed_gate(gate, c_rows)
        if args.dry_run:
            # 干跑用**内存影子栈**（`ledger=None`）：把三样门都走一遍，但一个字节都不落盘
            shadow = CommitmentGate(approval=ApprovalService(ledger=None, actor=actor),
                                    ledger=None, actor=actor)
            seed_gate(shadow, c_rows)
            shadow_request = shadow.approval.request(SCOPE_AWARD, {"intent_id": intent_id}, ref=intent_id,
                                                     approvers=[actor], reason=str(record.get("reason") or ""))
            shadow.approval.decide(shadow_request["approval_id"], by=actor, decision="granted",
                                   comment=str(record.get("comment") or ""))
            committed = shadow.commit_award(intent, supplier_confirmed=True,
                                            approval_id=shadow_request["approval_id"])
            return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "seeded": seeded,
                         "award_id": committed["award_id"],
                         "note": "干跑：三样门（意向 / 供应商确认 / 人工批准）都过，账本零新增"}, 0)
        try:
            request_row = approvals.request(SCOPE_AWARD, {"intent_id": intent_id}, ref=intent_id,
                                            approvers=[actor], reason=str(record.get("reason") or "APP 人工门"))
            approvals.decide(request_row["approval_id"], by=actor, decision="granted",
                             comment=str(record.get("comment") or ""))
            committed = gate.commit_award(intent, supplier_confirmed=True,
                                          approval_id=request_row["approval_id"])
        except LedgerError as exc:
            return deny("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往坏账本追加）", step, str(request))
        except Exception as exc:  # noqa: BLE001 —— 服务的门就是门：拒就如实报，不兜底落账
            return deny("commitment-refused", f"{type(exc).__name__}: {exc}",
                        "按上面的原因补齐（人工批准 / 供应商确认），再重提", step, str(request))
        archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
        return emit({"ok": True, "step": step, "applied": [
            {"event": "approval/requested", "approval_id": request_row["approval_id"], "scope": SCOPE_AWARD},
            {"event": "approval/granted", "approval_id": request_row["approval_id"], "decided_by": actor},
            {"event": "award/committed", "award_id": committed["award_id"], "intent_id": intent_id,
             "quote_id": intent.get("quote_id"), "approved_by": actor}],
            "duplicates": [], "ledger_added": 3, "refusal": None, "request": str(request),
            "archived": archived, "intent_id": intent_id, "award_id": committed["award_id"],
            "approval_id": request_row["approval_id"], "seeded": seeded,
            "next_action": f"发 PO：APP 承包商道「发 PO」（award_id={committed['award_id']}，另一次人签）",
            "note": "承诺已成立（承诺类事件）：award/committed 只由本脚本落，且必须有人工批准记录"}, 0)

    # ------------------------------------------------------------------ acknowledge（供应商侧回签）
    # 这一段必须在**发 PO 那一段之前**：发 PO 的代码假定 `record` 里有 `award_id`（回签请求里没有）。
    if step == "acknowledge":
        po_id = str(record.get("po_id") or "").strip()
        if not ID_RE.match(po_id):
            return deny("po-id-malformed", f"po_id 形状非法：{po_id!r}", "用账本里的真 po_id（po-…）",
                        step, str(request))
        delivered = delivered_in(s_rows, po_id)
        if delivered is None:
            return deny("po-not-delivered-to-you",
                        f"本侧账本里没有 po_id={po_id} 的投递登记（po/distributed）：只能确认投递给自己的采购单",
                        "等承包商在 APP 里发 PO（投递会在本侧留一条登记），或核对 po_id", step, str(request))
        issued = issued_po_in(c_rows, po_id)
        if issued is None:
            return deny("po-not-found-in-contractor",
                        f"承包商账本里没有 po_id={po_id} 的 po/issued：两侧对不上，不回签",
                        "核对 po_id；本侧不凭空回签一张承包商没有的采购单", step, str(request))
        previous = acknowledged_in(s_rows, po_id)
        if previous is not None and str(previous.get("acknowledged_by") or "") == actor:
            return emit({"ok": True, "step": step, "applied": [], "request": str(request),
                         "duplicates": [{"po_id": po_id, "reason": "already-acknowledged",
                                         "acknowledged_by": actor}],
                         "ledger_added": 0, "refusal": None, "po_id": po_id,
                         "note": "这张 PO 已经由同一人回签过：账本零新增（回签是幂等动作）"}, 0)
        body = {"po_id": po_id, "award_id": str(issued.get("award_id") or delivered.get("award_id") or ""),
                "quote_id": str(issued.get("quote_id") or delivered.get("quote_id") or ""),
                "package_id": str(issued.get("package_id") or delivered.get("package_id") or ""),
                "chain": str(issued.get("chain") or delivered.get("chain") or ""),
                "line_count": len(issued.get("lines") or delivered.get("lines") or []),
                "total_amount": issued.get("total_amount"),
                "supplier": realm_of(s_rows, ""), "acknowledged_by": actor, "acknowledged_at": args.now,
                "note": str(record.get("note") or ""), "source": "webui-gui"}
        if args.dry_run:
            return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "po_id": po_id, "acknowledged_by": actor,
                         "note": "干跑：本侧投递登记与承包商 po/issued 都核过了，账本零新增"}, 0)
        contractor_note = {**body, "view": "contractor"}
        try:
            s_ledger = Ledger(led_supplier, realm=realm_of(s_rows, "supplier:gui"))
            s_ledger.append(EVENT_PO_ACKNOWLEDGED, body, correlation_id=po_id, actor=actor, ts=args.now)
            c_ledger = Ledger(led_contractor, realm=realm_of(c_rows, "contractor:gui"))
            c_ledger.append(EVENT_PO_ACKNOWLEDGED, contractor_note, correlation_id=po_id, actor=actor,
                            ts=args.now)
        except LedgerError as exc:
            return deny("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往坏账本追加）", step,
                        str(request))
        archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
        return emit({"ok": True, "step": step, "applied": [
            {"view": "supplier", "event": EVENT_PO_ACKNOWLEDGED, "po_id": po_id, "acknowledged_by": actor},
            {"view": "contractor", "event": EVENT_PO_ACKNOWLEDGED, "po_id": po_id, "acknowledged_by": actor}],
            "duplicates": [], "ledger_added": 2, "refusal": None, "request": str(request),
            "archived": archived, "po_id": po_id, "acknowledged_by": actor,
            "next_action": "回承包商侧：「采购单（PO）」与授标链上这张 PO 的「对方确认」列会显示回签人与时刻；"
                           "回签件由对方挂在这张 PO 的附件面板里",
            "note": "回签是**供应商自己的**动作（只确认投递给本侧的那张 PO）；它不是承诺、也不改 PO 的任何行与价"}, 0)

    # ------------------------------------------------------------------ po
    # 走到这里 ⇒ step == "po"（其余步骤在上面都 return 了）。
    award_id = str(record.get("award_id") or "").strip()
    if not ID_RE.match(award_id):
        return deny("award-id-malformed", f"award_id 形状非法：{award_id!r}", "用账本里的真 award_id",
                    step, str(request))
    already = issued_in(c_rows, award_id)
    if already is not None:
        # 幂等：这份承诺已经发过 PO。但「已签发」不等于「已投递」——投递登记缺失时**补齐投递**
        # （同一个唯一写者、同一个形状），否则这张 PO 在收件人侧永远不存在（这正是本批要消除的缺口）。
        po_id = str(already.get("po_id") or "")
        if po_id and delivered_in(s_rows, po_id) is None:
            repaired, deny_ = deliver_po(po_body=already, led_contractor=led_contractor, c_rows=c_rows,
                                         led_supplier=led_supplier, s_rows=s_rows,
                                         delivery_out=args.delivery_out or str(
                                             ui_shared / "exchange" / "po-deliveries.json"),
                                         now=args.now, actor=actor, premises=record)
            if deny_ is not None:
                return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
            assert repaired is not None
            return emit({"ok": True, "step": step, "applied": repaired["applied"], "request": str(request),
                         "duplicates": [{"award_id": award_id, "reason": "already-issued", "po_id": po_id},
                                        {"po_id": po_id, "reason": "delivery-completed-now"}],
                         "ledger_added": repaired["ledger_added"], "refusal": None, "po_id": po_id,
                         "award_id": award_id, "delivered_to": [repaired["recipient"]],
                         "delivery": repaired["envelope"],
                         "note": "这张 PO 此前只签发了、没有投递登记：本次补上投递（两侧各一条 po/distributed）"}, 0)
        return emit({"ok": True, "step": step, "applied": [], "request": str(request),
                     "duplicates": [{"award_id": award_id, "reason": "already-issued", "po_id": po_id},
                                    {"po_id": po_id, "reason": "already-delivered"}],
                     "ledger_added": 0, "refusal": None, "po_id": po_id,
                     "note": "这份承诺已经发过 PO、也已投递：账本零新增"}, 0)
    award = None
    for row in c_rows:
        body = body_of(row)
        if str(row.get("type")) == "award/committed" and str(body.get("award_id") or "") == award_id:
            award = body
    if award is None:
        return deny("po-not-derived", f"PO 只能由承诺派生：{award_id} 不是本侧已成立的承诺",
                    "先在 APP 里把意向承诺掉（人签），再发 PO", step, str(request))
    # 投递的收件人判据跑在**任何写动作之前**（拒绝时账本零新增）：PO 只投给提交中标报价的那一家。
    # 这里只做**预检**（真正写投递的是 `deliver_po`，判据同一处、不重抄）。
    delivery_out = args.delivery_out or str(ui_shared / "exchange" / "po-deliveries.json")
    s_realm = realm_of(s_rows, "")
    if s_realm == "":
        return deny("po-recipient-unknown", "被投递方账本里读不出 realm：投递给谁不猜（PO 投递必须有收件人）",
                    "让被投递方先在本侧产生一条带 realm 的事实（登录 + 一次动作即产生）", step, str(request))
    if bidder_realm(s_rows, str(award.get("quote_id") or "")) == "":
        return deny("po-recipient-not-the-bidder",
                    f"被投递方账本里没有中标报价 {award.get('quote_id')} 的提交记录：PO 只投给提交这份报价的那一家",
                    "先让中标供应商把报价送到本侧（APP 供应商道「提交报价」），或核对 award 的 quote_id",
                    step, str(request))
    po_lines = lines or [{**line, "unit_price_cents": round(float(line.get("unit_price") or 0) * 100)}
                         for line in (award.get("lines") or [])]
    if not po_lines:
        return deny("lines-required", "承诺里没有行项目、请求也没给：无法派生 PO 行", "在 APP 里补行项目", step,
                    str(request))
    ledger, deny_ = open_ledger(led_contractor, c_rows, "contractor:gui")
    if ledger is None:
        return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
    assert ledger is not None
    approvals = ApprovalService(ledger=ledger, actor=actor)   # `actor`：请求人不得被记成 agent:approval
    bump_counter(approvals, c_rows)                           # 门号不与账本里已有的重号
    gate = CommitmentGate(approval=approvals, ledger=ledger, actor=actor)
    seeded = seed_gate(gate, c_rows)
    po_input = [{"ref_line": line["item_id"], "qty": line["qty"], "unit_price": line["unit_price"]}
                for line in po_lines]
    if args.dry_run:
        shadow = CommitmentGate(approval=ApprovalService(ledger=None, actor=actor), ledger=None, actor=actor)
        seed_gate(shadow, c_rows)
        shadow_request = shadow.approval.request(SCOPE_PO, {"award_id": award_id}, ref=award_id,
                                                approvers=[actor], reason=str(record.get("reason") or ""))
        shadow.approval.decide(shadow_request["approval_id"], by=actor, decision="granted",
                               comment=str(record.get("comment") or ""))
        shadow_po = shadow.issue_po(award_id, po_input, approval_id=shadow_request["approval_id"])
        return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                     "ledger_added": 0, "refusal": None, "seeded": seeded,
                     "approval_id": shadow_request["approval_id"], "lines": len(po_lines),
                     "trace_mode": shadow_po["trace_mode"], "delivered_to": [s_realm],
                     "note": "干跑：派生依据、人工门与投递收件人都过，账本零新增（信封也未写）"}, 0)
    try:
        request_row = approvals.request(SCOPE_PO, {"award_id": award_id}, ref=award_id, approvers=[actor],
                                        reason=str(record.get("reason") or "APP 人工门"))
        approvals.decide(request_row["approval_id"], by=actor, decision="granted",
                         comment=str(record.get("comment") or ""))
        issued = gate.issue_po(award_id, po_input, approval_id=request_row["approval_id"])
    except LedgerError as exc:
        return deny("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往坏账本追加）", step, str(request))
    except Exception as exc:  # noqa: BLE001
        return deny("po-refused", f"{type(exc).__name__}: {exc}",
                    "PO 行必须引用中标条目、且不得改价（改价要走变更单 + 人工门）", step, str(request))
    # 投递：**签发之后立刻投给中标供应商**（两侧账本各一条 `po/distributed` + 交换面的投递信封）。
    # 判据已在上面预检过（同一处判据、`deliver_po` 里再跑一遍）；这里失败只会是账本写不进去。
    po_body = issued_po_in(c_rows, str(issued["po_id"])) or {
        "po_id": issued["po_id"], "award_id": award_id, "intent_id": issued.get("intent_id"),
        "quote_id": issued.get("quote_id"), "package_id": issued.get("package_id"),
        "lines": issued.get("lines") or [], "total_amount": issued.get("total_amount"),
        "chain": issued.get("chain"), "trace_mode": issued.get("trace_mode"),
        "approved_by": actor, "issued_at": issued.get("issued_at")}
    delivery, deny_ = deliver_po(po_body=po_body, led_contractor=led_contractor, c_rows=c_rows,
                                led_supplier=led_supplier, s_rows=s_rows, delivery_out=delivery_out,
                                now=args.now, actor=actor, premises=record)
    if deny_ is not None:
        return deny(deny_["code"], deny_["reason"], deny_["next_action"], step, str(request))
    assert delivery is not None
    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    return emit({"ok": True, "step": step, "applied": [
        {"event": "approval/requested", "approval_id": request_row["approval_id"], "scope": SCOPE_PO},
        {"event": "approval/granted", "approval_id": request_row["approval_id"], "decided_by": actor},
        {"event": "po/issued", "po_id": issued["po_id"], "award_id": award_id,
         "trace_mode": issued["trace_mode"], "total_amount": issued["total_amount"],
         "chain": issued["chain"]}] + delivery["applied"],
        "duplicates": [], "ledger_added": 3 + delivery["ledger_added"], "refusal": None,
        "request": str(request),
        "archived": archived, "po_id": issued["po_id"], "award_id": award_id,
        "approval_id": request_row["approval_id"], "seeded": seeded,
        "trace_mode": issued["trace_mode"], "total_amount": issued["total_amount"],
        "chain": issued["chain"], "delivered_to": [delivery["recipient"]],
        "delivery": delivery["envelope"], "premises": delivery["premises"],
        "next_action": "PO 已投给中标供应商（对方侧「发给我的采购单」里逐行、含追溯链；可下载/打印/挂回签件）；"
                       "等对方在 APP 供应商道「确认收到采购单（人签）」回签",
        "note": "PO 逐行可追溯（ref_line → 中标条目 → 报价）：行与价都由承诺派生，不由界面自由输入；"
                "投递是**账本事实**（两侧各一条 po/distributed），不是界面副作用"}, 0)






def crash_guard(fn, argv):
    """意外异常也必须是**一行 JSON**：宿主（GUI 的动作服务端一半）据此如实报错、不假装成功。"""
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 —— 兜底只报错，不落任何东西
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed",
                                      "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
