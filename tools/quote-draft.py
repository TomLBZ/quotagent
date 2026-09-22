#!/usr/bin/env python3
"""tools/quote-draft.py —— 「供应商把报价**准备好**（draft）」的**唯一落账本者**（宿主 zero-ledger-write，H1）。

为什么需要它：`GET /quotagent/supplier/quotes/prepare/` 上那个「提交草稿」按钮，如果由宿主直接落账，
就会多出第二条事实写路径，并且给了浏览器一条能影响「报价状态」的口子。所以闭环拆成两段
（与 `tools/gate-nudge.py` / `tools/rfq-promise.py` / `tools/ui-feedback-apply.py` 同规格）：

  ① 宿主（`host/modules/webui.mjs` + `host/modules/quote-prepare.mjs`）只落**一条 0600 待办件**
     `<inbox>/qd-<view>-<12hex>.json`：含表单内容（行项目、**单价整数分**、交期、发言人、币种、
     **备注原话**）、`lines_sha256`、`note_sha256`、视角 —— **账本零新增**；
  ② 本脚本（**唯一落账本者**）：
     · 权限门（**必须恰为 0600、必须是普通文件**）→ 形状门（schema/kind/view/动作）→ **重算校验**
       （`lines_sha256` / `note_sha256` / `bytes` 必须与重算一致，`submitted_at` 必须为空 ——
       宿主不取墙钟）；
     · **行项目必须真的存在**（在本视角事实行里逐条按键读到过：`items[]` / `items:<n>` 之外不猜 /
       `lines[].item_id` / `item_id` / `item_ids[]`），RFQ 引用同理；**数值必须在范围内**（越界不夹取）；
     · 落一条 `quote/drafted`（**非签名动作**：它只表示「报价已准备好」，不是「报价已提交」），
       body **恰 12 键**（`currency / item_id / lead_time_days / lines_sha256 / note_sha256 / ok /
       prepared_by / quote_draft_id / rfq_id / supplier / unit_price_cents / view`）
       —— **不含备注正文、不含任何凭据**（正文只留在 0600 待办件里）；
     · **两侧登记**（双向可见性）：同一份草稿在**供应商账本**（自己的事实）与**承包商账本**
       （「供应商 X 已准备报价（待签署）」）各落一条，`view` 字段区分是哪一侧的行；
     · 待办件移入 `<inbox>/applied/`（**不删**，幂等可观察）。

幂等：同一份（视角 + 草稿 id + `lines_sha256`）已经处理过（在 `applied/` 归档里，或账本里已有同键的
`quote/drafted` 行）→ 记 `duplicates`、**账本零新增**、`exit 0`。

拒绝路径一律给**具体 `code` + `next_action`**，并且**拒绝时零写账本**：
  `pending-insecure-mode` / `pending-not-regular` / `pending-not-json` / `pending-schema-unknown` /
  `pending-kind-unknown` / `view-unknown` / `action-not-draft` / `rfq-id-malformed` /
  `item-id-malformed` / `pending-tampered`（sha256/bytes/submitted_at 与重算不符）/
  `unit-price-out-of-range` / `lead-time-out-of-range` / `prepared-by-required` /
  `supplier-unknown` / `item-not-found`（本视角事实里没有这个行项目）/
  `rfq-not-found`（本视角事实里没有这个 RFQ 引用）/ `ledger-unreadable`（宁可不写，先修账本）。

纪律（与 `admin-apply.py` / `gate-nudge.py` 同规格）：
  · 用法/环境错误在**构造 Ledger 之前**返回（拒绝时连空账本文件都不创建）；
  · `--now` 必填且为合法 ISO（**不读墙钟**）；
  · stdout 恰一行 JSON；退出码 0 = 无拒绝 / 1 = 有拒绝（逐条给了 code+next_action）/ 2 = 用法或环境错误。
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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")
PENDING_RE = re.compile(r"^qd-[A-Za-z0-9-]+-[0-9a-f]{12}\.json$")

SCHEMA = 1
KIND = "quote-draft"
ACTION = "draft"
EVENT = "quote/drafted"
ACTOR = "agent:quote-draft"
ARCHIVE_DIR = "applied"

# 数值范围（与 `host/modules/quote-prepare.mjs` 的 LIMITS **逐字一致**：改一处必须改两处 + 门）
UNIT_PRICE_MIN = 1
UNIT_PRICE_MAX = 100_000_000
LEAD_TIME_MIN = 1
LEAD_TIME_MAX = 3650
NOTE_BYTES_MAX = 2000

# body 键的**闭合集合**（门逐条比对；备注正文与凭据永远不在里面）
BODY_KEYS = ("currency", "item_id", "lead_time_days", "lines_sha256", "note_sha256", "ok",
             "prepared_by", "quote_draft_id", "rfq_id", "supplier", "unit_price_cents", "view")

# 逐条按键读取行项目 / RFQ 引用（**不是**原样透传：只认这几个键的形状，与插件同一规则）
ITEM_LIST_KEYS = ("items", "item_ids")
ITEM_SCALAR_KEYS = ("item_id",)
RFQ_KEYS = ("package_id", "rfq_id")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def digest_of(value: object) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def canonical_lines(record: dict) -> str:
    """行项目的**规范化 JSON**（宿主与脚本各算一次；键排序 + 无空格 + 不转义非 ASCII）。"""
    lines = {
        "currency": str(record.get("currency") or ""),
        "item_id": str(record.get("item_id") or ""),
        "lead_time_days": record.get("lead_time_days"),
        "rfq_id": str(record.get("rfq_id") or ""),
        "unit_price_cents": record.get("unit_price_cents"),
    }
    return json.dumps(lines, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# 账本读取（**只读**：判定权在账本，「行项目到底存不存在」这件事只认账本里的事实行）
# ---------------------------------------------------------------------------
def load_rows(path: Path) -> tuple[list[dict] | None, str | None]:
    """返回 `(rows, error)`；坏账本 → error（宁可不写，不猜）。"""
    if not path.exists():
        return [], None
    rows: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"账本第 {lineno} 行不是合法 JSON（{exc}）"
        if not isinstance(record, dict):
            return None, f"账本第 {lineno} 行不是记录对象"
        rows.append(record)
    return rows, None


def item_ids_of(body: dict) -> list[str]:
    out: list[str] = []
    for key in ITEM_LIST_KEYS:
        value = body.get(key)
        if isinstance(value, list):
            for entry in value:
                if isinstance(entry, str):
                    candidate = entry.strip()
                elif isinstance(entry, dict):
                    candidate = str(entry.get("item_id") or "").strip()
                else:
                    candidate = ""
                if candidate and candidate not in out:
                    out.append(candidate)
    for key in ITEM_SCALAR_KEYS:
        candidate = str(body.get(key) or "").strip()
        if candidate and candidate not in out:
            out.append(candidate)
    return out


def rfq_ids_of(body: dict) -> list[str]:
    out: list[str] = []
    for key in RFQ_KEYS:
        candidate = str(body.get(key) or "").strip()
        if candidate and candidate not in out:
            out.append(candidate)
    return out


def facts_of(rows: list[dict], prefixes: tuple[str, ...]) -> tuple[list[str], list[str]]:
    """本视角事实里的行项目目录与 RFQ 目录（只读 `rfq/*` 与 `quote/*` 行）。"""
    items: list[str] = []
    rfqs: list[str] = []
    for row in rows:
        kind = str(row.get("type") or "")
        if not kind.startswith(prefixes):
            continue
        raw_body = row.get("body")
        body: dict = raw_body if isinstance(raw_body, dict) else {}
        for candidate in item_ids_of(body):
            if candidate not in items:
                items.append(candidate)
        for candidate in rfq_ids_of(body):
            if candidate not in rfqs:
                rfqs.append(candidate)
    return items, rfqs


def ledger_drafts(rows: list[dict]) -> set[tuple[str, str, str]]:
    """账本里的 `quote/drafted` 幂等键：`(view, quote_draft_id, lines_sha256)`。"""
    out: set[tuple[str, str, str]] = set()
    for row in rows:
        if str(row.get("type")) != EVENT:
            continue
        raw_body = row.get("body")
        body: dict = raw_body if isinstance(raw_body, dict) else {}
        if body.get("ok") is not True:
            continue
        out.add((str(body.get("view") or ""), str(body.get("quote_draft_id") or ""),
                 norm_digest(body.get("lines_sha256"))))
    return out


# ---------------------------------------------------------------------------
# 待办件读取（权限门 → 形状门 → 重算校验；拒绝理由里**不出现备注正文**）
# ---------------------------------------------------------------------------
def load_item(path: Path, views: list[str]) -> tuple[dict | None, dict | None]:
    try:
        info = os.stat(path)
    except OSError as exc:
        return None, {"code": "pending-unreadable", "reason": f"读不到文件：{exc}",
                      "next_action": "确认待办件仍在 inbox（宿主写的是 0600 普通文件）"}
    if not stat.S_ISREG(info.st_mode):
        return None, {"code": "pending-not-regular", "reason": "不是普通文件（符号链接/目录/设备一律拒）",
                      "next_action": "只接受宿主落下的普通文件：先清掉这个非常规条目"}
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, {"code": "pending-insecure-mode", "reason": f"权限不是 600（收到 {oct(mode)}）",
                      "next_action": "待办件必须由提交面以 0600 落盘；本脚本不改权限，请修权限后重提"}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, {"code": "pending-not-json", "reason": f"不是合法 JSON：{exc}",
                      "next_action": "删掉这条坏件、重新提交（坏的待办件不猜）"}
    if not isinstance(record, dict):
        return None, {"code": "pending-not-json", "reason": "待办件必须是 JSON 对象",
                      "next_action": "删掉这条坏件、重新提交"}
    if record.get("schema") != SCHEMA:
        return None, {"code": "pending-schema-unknown", "reason": f"schema 必须是 {SCHEMA}（未知版本不猜）",
                      "next_action": "升级本脚本或不提交该待办件"}
    if record.get("kind") != KIND:
        return None, {"code": "pending-kind-unknown", "reason": f"kind 必须是 {KIND}（不猜）",
                      "next_action": "确认这条文件是不是 quote-prepare 的草稿待办件"}
    if record.get("requested_action") != ACTION:
        return None, {"code": "action-not-draft",
                      "reason": f"requested_action 必须是 {ACTION}；**签名/提交报价**这类动作不在本脚本的能力面里",
                      "next_action": "草稿只有 draft 一种；要把草稿签成报价，在终端由 human:* 跑 tools/quote-sign.py（ADR-0013 §3）"}
    view = record.get("view")
    if not isinstance(view, str) or view not in views:
        return None, {"code": "view-unknown", "reason": f"view 不在 {views} 内（不猜、不默认）",
                      "next_action": "视角名由页面提交，必须是配置里的视图之一"}
    supplier = str(record.get("supplier") or "")
    if supplier != "" and not REALM_RE.match(supplier):
        return None, {"code": "supplier-unknown", "reason": "supplier 形状非法（形如 supplier:<id>）",
                      "next_action": "重提一次：供应商身份由宿主从本视角账本的 realm 读出"}
    prepared_by = record.get("prepared_by")
    if not isinstance(prepared_by, str) or not prepared_by.startswith("human:"):
        return None, {"code": "prepared-by-required", "reason": "prepared_by 缺或不是 human:<人名>（不替谁认领）",
                      "next_action": "重提一次并在页面上填 human:<你的名字>"}
    rfq_id = record.get("rfq_id")
    if not isinstance(rfq_id, str) or not REF_RE.match(rfq_id):
        return None, {"code": "rfq-id-malformed", "reason": "rfq_id 缺或形状非法（只接受字母数字与 . _ : -）",
                      "next_action": "重提一次：RFQ 引用由页面从**本视角事实**里取"}
    item_id = record.get("item_id")
    if not isinstance(item_id, str) or not REF_RE.match(item_id):
        return None, {"code": "item-id-malformed", "reason": "item_id 缺或形状非法（只接受字母数字与 . _ : -）",
                      "next_action": "重提一次：行项目由页面从**本视角行项目目录**里取"}
    currency = record.get("currency")
    if not isinstance(currency, str) or not CURRENCY_RE.match(currency):
        return None, {"code": "currency-malformed", "reason": "currency 必须是三个大写字母",
                      "next_action": "重提一次（页面上留空即 CNY）"}
    price = record.get("unit_price_cents")
    if isinstance(price, bool) or not isinstance(price, int) or not (UNIT_PRICE_MIN <= price <= UNIT_PRICE_MAX):
        return None, {"code": "unit-price-out-of-range",
                      "reason": f"unit_price_cents 必须是 {UNIT_PRICE_MIN}..{UNIT_PRICE_MAX} 的整数分（越界不夹取）",
                      "next_action": "按页面上写的范围改单价后重提"}
    lead = record.get("lead_time_days")
    if isinstance(lead, bool) or not isinstance(lead, int) or not (LEAD_TIME_MIN <= lead <= LEAD_TIME_MAX):
        return None, {"code": "lead-time-out-of-range",
                      "reason": f"lead_time_days 必须是 {LEAD_TIME_MIN}..{LEAD_TIME_MAX} 的整数天（越界不夹取）",
                      "next_action": "按页面上写的范围改交期后重提"}
    note = record.get("note")
    if not isinstance(note, str):
        return None, {"code": "pending-tampered", "reason": "note 必须是字符串（缺失即不可信）",
                      "next_action": "丢掉它、重新提交（提交面会重新算哈希）"}
    if len(note.encode("utf-8")) > NOTE_BYTES_MAX:
        return None, {"code": "note-too-long",
                      "reason": f"备注 {len(note.encode('utf-8'))} 字节超过上限 {NOTE_BYTES_MAX}",
                      "next_action": "本脚本**不截断**（截断会合成另一份正文）：请重提一份更短的"}
    note_digest = record.get("note_sha256")
    if not isinstance(note_digest, str) or not HEX64_RE.match(norm_digest(note_digest)):
        return None, {"code": "pending-tampered", "reason": "note_sha256 缺或不是 sha256:<64 位小写 hex>",
                      "next_action": "待办件自述不可信：重提一次（提交面会重新算哈希）"}
    if norm_digest(note_digest) != digest_of(note):
        return None, {"code": "pending-tampered", "reason": "note_sha256 与重算结果不符（自述不可信）",
                      "next_action": "文件被改过或不是提交面写的：丢掉它、重新提交"}
    lines_digest = record.get("lines_sha256")
    if not isinstance(lines_digest, str) or not HEX64_RE.match(norm_digest(lines_digest)):
        return None, {"code": "pending-tampered", "reason": "lines_sha256 缺或不是 sha256:<64 位小写 hex>",
                      "next_action": "丢掉它、重新提交"}
    if norm_digest(lines_digest) != digest_of(canonical_lines(record)):
        return None, {"code": "pending-tampered",
                      "reason": "lines_sha256 与重算的结构化行不一致（自述不可信：单价/交期/行项目被改过？）",
                      "next_action": "文件被改过或不是提交面写的：丢掉它、重新提交"}
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, {"code": "pending-tampered", "reason": "bytes 与重算的备注 UTF-8 字节数不符",
                      "next_action": "丢掉它、重新提交（宿主不取墙钟：submitted_at 也必须为空）"}
    if record.get("submitted_at") not in (None, ""):
        return None, {"code": "pending-tampered", "reason": "submitted_at 必须为空（宿主不取墙钟）",
                      "next_action": "时间由 Python 侧按 --now 落账：清空该字段后重提"}
    draft_id = record.get("quote_draft_id")
    if not isinstance(draft_id, str) or not REF_RE.match(draft_id):
        return None, {"code": "pending-tampered", "reason": "quote_draft_id 缺或形状非法",
                      "next_action": "丢掉它、重新提交"}
    return {"file": path.name, "path": path, "view": view, "supplier": supplier,
            "prepared_by": prepared_by, "rfq_id": rfq_id, "item_id": item_id,
            "currency": currency, "unit_price_cents": price, "lead_time_days": lead,
            "note": note, "note_sha256": digest_of(note), "quote_draft_id": draft_id,
            "lines_sha256": digest_of(canonical_lines(record))}, None


def archive(inbox: Path, path: Path) -> Path:
    target_dir = inbox / ARCHIVE_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(target_dir, 0o700)
    except OSError:
        pass
    stem = path.name[: -len(".json")]
    target = target_dir / path.name
    index = 1
    while target.exists():
        target = target_dir / f"{stem}.{index}.json"
        index += 1
    shutil.move(str(path), str(target))
    return target


def load_applied(inbox: Path) -> set[tuple[str, str, str]]:
    out: set[tuple[str, str, str]] = set()
    target_dir = inbox / ARCHIVE_DIR
    if not target_dir.is_dir():
        return out
    for path in sorted(target_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("kind") != KIND:
            continue
        if record.get("view") and record.get("quote_draft_id") and record.get("lines_sha256"):
            out.add((str(record["view"]), str(record["quote_draft_id"]), norm_digest(record["lines_sha256"])))
    return out


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="quote-draft", add_help=False,
                                     description="报价草稿待办件的唯一落账本者（宿主只落 0600 待办件）")
    parser.add_argument("--inbox", default="", help="待办件目录（默认 <ui-shared>/quote-drafts）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--views", default="supplier")
    parser.add_argument("--view", default="", help="只处理该视角的待办件")
    parser.add_argument("--ledger-supplier", default="", help="供应商账本（默认 <ui-shared>/supplier/ledger.jsonl）")
    parser.add_argument("--ledger-contractor", default="", help="承包商账本（默认 <ui-shared>/contractor/ledger.jsonl）")
    parser.add_argument("--actor", default=ACTOR, help="落账 actor（默认 agent:quote-draft）")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = _parser()
    try:
        args, unknown = parser.parse_known_args(argv)
    except SystemExit:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage", "next_action": "见 --help"}]}, 2)
    if unknown:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-unknown-flag", "reason": str(unknown),
                                  "next_action": "去掉不认识的参数"}]}, 2)
    if not args.now or not ISO_RE.match(args.now):
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-now", "reason": "缺 --now 或不是合法 ISO8601",
                                  "next_action": "显式给时间：--now 2026-09-21T15:00:00Z（本脚本不读墙钟）"}]}, 2)
    if not str(args.actor).startswith("agent:") and not str(args.actor).startswith("human:"):
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-actor", "reason": "actor 必须以 agent:/human: 开头",
                                  "next_action": "落账者写 agent:quote-draft（本脚本**不签名**，签名是人做的事）"}]}, 2)
    views = [entry.strip() for entry in str(args.views).split(",") if entry.strip()]
    if not views:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-views", "reason": "--views 解析为空",
                                  "next_action": "给出至少一个视图名"}]}, 2)

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / "quote-drafts"
    supplier_ledger = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    contractor_ledger = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    if not inbox.is_dir():
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "inbox-missing", "reason": f"--inbox 不是目录：{inbox}",
                                  "next_action": "先让宿主落下待办件（页面点一次「提交草稿」），或生成该目录"}]}, 2)

    pending = [item for item in sorted(inbox.glob("qd-*.json")) if PENDING_RE.match(item.name)]
    refused: list[dict] = []
    items: list[dict] = []
    for path in pending:
        item, refusal = load_item(path, views)
        if refusal is not None:
            refusal.update({"file": path.name, "view": ""})
            refused.append(refusal)
            continue
        if args.view and item["view"] != args.view:
            continue
        items.append(item)

    if refused and not items:
        # 全是坏件：**不碰账本**（拒绝时零写）
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": refused, "pending_seen": len(pending), "inbox": str(inbox)}, 1)

    # 环境门：要写的账本先必须可读（坏账本宁可不写）
    supplier_rows, supplier_error = load_rows(supplier_ledger)
    contractor_rows, contractor_error = load_rows(contractor_ledger)
    if supplier_error is not None or contractor_error is not None:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0, "refused": refused,
                     "refused_ledger": [
                         {"view": "supplier", "code": "ledger-unreadable", "reason": supplier_error,
                          "next_action": "先修账本（本脚本不往坏账本追加）"},
                         {"view": "contractor", "code": "ledger-unreadable", "reason": contractor_error,
                          "next_action": "先修账本（本脚本不往坏账本追加）"}]}, 2)
    assert supplier_rows is not None and contractor_rows is not None
    supplier_realm = str(supplier_rows[0].get("realm") or "") if supplier_rows else ""
    contractor_realm = str(contractor_rows[0].get("realm") or "") if contractor_rows else ""
    item_catalogue, rfq_catalogue = facts_of(supplier_rows, ("rfq/", "quote/"))

    applied: list[dict] = []
    duplicates: list[dict] = []
    ledger_added = 0
    archived = load_applied(inbox)
    supplier_live = ledger_drafts(supplier_rows)
    contractor_live = ledger_drafts(contractor_rows)
    supplier_handles: dict[str, Ledger] = {}
    added_supplier = dict.fromkeys(supplier_live, True)
    for item in items:
        view = item["view"]
        key = (view, item["quote_draft_id"], item["lines_sha256"])
        # 行项目必须真的存在（本视角事实里读到过）
        if item_catalogue and item["item_id"] not in item_catalogue:
            refused.append({"file": item["file"], "view": view, "code": "item-not-found",
                            "reason": f"行项目 {item['item_id']} 不在本视角事实里（已读到 {len(item_catalogue)} 个）",
                            "next_action": "看 /quotagent/supplier/quotes/prepare/ 的「行项目目录」后重提（账本零新增）"})
            continue
        if rfq_catalogue and item["rfq_id"] not in rfq_catalogue:
            refused.append({"file": item["file"], "view": view, "code": "rfq-not-found",
                            "reason": f"RFQ {item['rfq_id']} 不在本视角事实里（已读到 {len(rfq_catalogue)} 个）",
                            "next_action": "看 /quotagent/supplier/quotes/prepare/ 的「RFQ 引用」后重提（账本零新增）"})
            continue
        supplier_id = item["supplier"] or supplier_realm
        if not REALM_RE.match(supplier_id):
            refused.append({"file": item["file"], "view": view, "code": "supplier-unknown",
                            "reason": "供应商身份既不在待办件里、也无法从账本 realm 读出（不猜）",
                            "next_action": "先把一条事实行落进供应商账本（realm 由账本给出），再重提"})
            continue
        if key in archived or key in supplier_live or key in contractor_live:
            duplicates.append({"file": item["file"], "view": view, "quote_draft_id": item["quote_draft_id"],
                               "lines_sha256": item["lines_sha256"], "reason": "already-drafted",
                               "matched": "applied-archive" if key in archived else "ledger"})
            if not args.dry_run:
                archive(inbox, item["path"])
            continue
        base = {"currency": item["currency"], "item_id": item["item_id"],
                "lead_time_days": item["lead_time_days"], "lines_sha256": item["lines_sha256"],
                "note_sha256": item["note_sha256"], "ok": True, "prepared_by": item["prepared_by"],
                "quote_draft_id": item["quote_draft_id"], "rfq_id": item["rfq_id"],
                "supplier": supplier_id, "unit_price_cents": item["unit_price_cents"]}
        if not args.dry_run:
            ledger = supplier_handles.get(view) or Ledger(supplier_ledger, realm=supplier_realm or f"{view}:quote-draft")
            supplier_handles[view] = ledger
            try:
                # 两侧登记：供应商账本（本方事实）+ 承包商账本（「供应商 X 已准备报价（待签署）」）
                ledger.append(EVENT, {**base, "view": view}, correlation_id=item["quote_draft_id"],
                              actor=str(args.actor), ts=args.now)
                Ledger(contractor_ledger, realm=contractor_realm or "contractor:quote-draft").append(
                    EVENT, {**base, "view": "contractor"}, correlation_id=item["quote_draft_id"],
                    actor=str(args.actor), ts=args.now)
            except LedgerError as exc:
                # 账本自检不过（哈希链断/冻结）→ **宁可不写**：如实报，并把这件事本身当成环境错误
                return emit({"ok": False, "applied": applied, "duplicates": duplicates,
                             "ledger_added": ledger_added, "refused": refused + [
                                 {"file": item["file"], "view": view, "code": "ledger-frozen",
                                  "reason": str(exc)[0:200],
                                  "next_action": "先修账本（本脚本不往校验不过的账本追加任何行）"}]}, 2)
            ledger_added += 2
        supplier_live.add(key)
        contractor_live.add(key)
        added_supplier[key] = True
        applied.append({"file": item["file"], "view": view, "quote_draft_id": item["quote_draft_id"],
                        "rfq_id": item["rfq_id"], "item_id": item["item_id"],
                        "unit_price_cents": item["unit_price_cents"],
                        "body_keys": sorted(BODY_KEYS), "ledger": str(supplier_ledger),
                        "notified": "contractor"})
        if not args.dry_run:
            archive(inbox, item["path"])

    out = {"ok": not refused, "event": EVENT, "actor": str(args.actor), "now": args.now,
           "applied": applied, "duplicates": duplicates, "ledger_added": ledger_added,
           "refused": refused, "pending_seen": len(pending), "inbox": str(inbox),
           "ledger_supplier": str(supplier_ledger), "ledger_contractor": str(contractor_ledger),
           "supplier": supplier_realm, "contractor": contractor_realm,
           "catalogue": {"items": item_catalogue, "rfqs": rfq_catalogue},
           "counts": {"supplier_drafts": sum(1 for entry in supplier_live if entry[0] == "supplier"),
                      "contractor_drafts": sum(1 for entry in contractor_live if entry[0] == "contractor")},
           "dry_run": bool(args.dry_run),
           "note": "本脚本**不签名**：它只落 quote/drafted（body 恰 12 键、不含备注正文与凭据）；"
                   "把草稿签成报价是人工动作，见 tools/quote-sign.py"
                   f"（body 键：{'/'.join(BODY_KEYS)}）"}
    return emit(out, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
