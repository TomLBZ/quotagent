#!/usr/bin/env python3
"""tools/rfq-promise.py —— 「承诺回文时限」的**唯一写账本者**（宿主 zero-ledger-write，H1）。

为什么需要它：`GET /quotagent/<view>/deadlines/` 上那句「登记承诺」如果由宿主直接落账，就会多出第二条
事实写路径，而且会让\"谁承诺了什么\"变成浏览器能任意写的东西。所以闭环拆成两段（与 `tools/gate-nudge.py`
/ `tools/ui-feedback-apply.py` 同规格，H1 的宿主零写面由此成立）：

  ① 宿主（`host/modules/webui.mjs` + `host/modules/rfq-deadline.mjs`）只落**一条 0600 待办件**
     `<inbox>/rp-<view>-<12hex>.json`：含**发言人**（`promised_by`）、**承诺回文时限**（`due_at`）、
     `rfq_id`、`view`、用户原话（`note`）与 `note_sha256` —— **账本零新增、不发信**；
  ② 本脚本（**唯一落账本者**）：
     · 权限门（**必须恰为 0600、必须是普通文件**）→ 形状门（schema/kind/view/动作）→ **重算校验**
       （`note_sha256` 与 `bytes` 必须与重算一致，`submitted_at` 必须为空 —— 宿主不取墙钟）；
     · **目标包必须真的在本视图的投影里**（该视图账本里存在 `rfq/published` 行且包 id 对得上），
       否则 `rfq-not-found`（不猜你想给哪个包承诺）；
     · 落一条 `rfq/promised`，body **恰好 6 键**：`{rfq_id, view, actor, due_at, promise_sha256, ok}`
       —— **不含正文、不含任何凭据**（正文只留在 0600 待办件里）；`actor` = 发言人（`human:*`/`agent:*`）；
     · 待办件移入 `<inbox>/applied/`（**不删**，幂等可观察）。

幂等：同一份（视图 + 包 + 原话）或（视图 + 包 + 承诺时限）已经处理过（在 `applied/` 归档里，或账本里
已有同键的 `rfq/promised` 行）→ 记 `duplicates`、**账本零新增**、`exit 0`。

拒绝路径一律给**具体 `code` + `next_action`**，并且**拒绝时零写账本**：
  `pending-insecure-mode` / `pending-not-regular` / `pending-not-json` / `pending-schema-unknown` /
  `pending-kind-unknown` / `view-unknown` / `rfq-id-malformed` / `action-not-promise` / `actor-malformed` /
  `due-at-malformed` / `empty-note` / `pending-tampered`（sha256/bytes/submitted_at 与重算不符）/
  `rfq-not-found`（本视图投影里没有这个包）/ `ledger-unreadable`（宁可不写，先修账本）。

纪律（与 `admin-apply.py` / `ui-feedback-apply.py` 同规格）：
  · 用法/环境错误在**构造 Ledger 之前**返回（拒绝时连空账本文件都不创建）；
  · `--now` 必填且为合法 ISO（**不读墙钟**）；
  · stdout 恰一行 JSON；退出码 0 = 无拒绝 / 1 = 有拒绝（逐条给了 code+next_action）/ 2 = 用法或环境错误；
  · **不发信**：本脚本只往账本追加一条\"承诺\"事实，不碰任何邮件通道（登记承诺 ≠ 已通知）。
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

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/rfq-promise.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
RFQ_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
ACTOR_RE = re.compile(r"^(human|agent):[A-Za-z0-9._-]{1,48}$")
PENDING_RE = re.compile(r"^rp-[A-Za-z0-9-]+-[0-9a-f]{12}\.json$")
SCHEMA = 1
KIND = "rfq-promise"
ACTION = "promise"
EVENT = "rfq/promised"
ACTOR_PREFIX = "agent:"
ARCHIVE_DIR = "applied"


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def note_digest(note: str) -> str:
    return hashlib.sha256(note.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 投影读取（**只读**：判定权在账本，「包是否发布过」这件事只认账本里的 rfq/published 行）
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


def published_packages(rows: list[dict]) -> set[str]:
    """本视图投影里**发布过**的包 id 集合（只认 `rfq/published` 事实：不猜、不从别的事件推）。"""
    out: set[str] = set()
    for row in rows:
        if str(row.get("type")) != "rfq/published":
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        for value in (body.get("package_id"), body.get("rfq_id"), row.get("correlation_id")):
            if isinstance(value, str) and value.strip():
                out.add(value.strip())
                break
    return out


# ---------------------------------------------------------------------------
# 待办件读取（权限门 → 形状门 → 重算校验；拒绝理由里**不出现原话正文**）
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
                      "next_action": "确认这条文件是不是 rfq-deadline 的登记承诺待办件"}
    if record.get("requested_action") != ACTION:
        return None, {"code": "action-not-promise",
                      "reason": f"requested_action 必须是 {ACTION}；发信/批准/提交这类动作**不在本脚本的能力面里**",
                      "next_action": "登记承诺只有 promise 一种；要发信走已登记的邮件路由（本脚本只落账本）"}
    view = record.get("view")
    if not isinstance(view, str) or view not in views:
        return None, {"code": "view-unknown", "reason": f"view 不在 {views} 内（不猜、不默认）",
                      "next_action": "视图名由页面提交，必须是配置里的视图之一"}
    rfq_id = record.get("rfq_id")
    if not isinstance(rfq_id, str) or not RFQ_ID_RE.match(rfq_id):
        return None, {"code": "rfq-id-malformed", "reason": "rfq_id 缺或形状非法（只接受字母数字与 . _ : -）",
                      "next_action": "重提一次：目标包 id 由页面从**本视角投影**里取（形如 pkg-g1）"}
    promised_by = record.get("promised_by")
    if not isinstance(promised_by, str) or not ACTOR_RE.match(promised_by):
        return None, {"code": "actor-malformed",
                      "reason": "promised_by（发言人）必须是 human:<人名> 或 agent:<组件>（不许匿名）",
                      "next_action": "重提一次并写明发言人：谁承诺的回文时限必须可追"}
    due_at = record.get("due_at")
    if not isinstance(due_at, str) or not ISO_RE.match(due_at):
        return None, {"code": "due-at-malformed", "reason": "due_at 必须是 ISO8601 UTC（形如 2026-09-26T00:00:00Z）",
                      "next_action": "重提一次：承诺回文时限必须是可解析的事实格式（不做时区换算）"}
    note = record.get("note")
    if not isinstance(note, str) or note.strip() == "":
        return None, {"code": "empty-note", "reason": "原话为空或不是字符串",
                      "next_action": "这条没有内容：删掉它，或让用户重提一次带原话的承诺"}
    digest = record.get("note_sha256")
    if not isinstance(digest, str) or not HEX64_RE.match(norm_digest(digest)):
        return None, {"code": "pending-tampered", "reason": "note_sha256 缺或不是 sha256:<64 位小写 hex>",
                      "next_action": "待办件自述不可信：重提一次（提交面会重新算哈希）"}
    if norm_digest(digest) != note_digest(note):
        return None, {"code": "pending-tampered", "reason": "note_sha256 与重算结果不符（自述不可信）",
                      "next_action": "文件被改过或不是提交面写的：丢掉它、重新提交"}
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, {"code": "pending-tampered", "reason": "bytes 与重算的 UTF-8 字节数不符",
                      "next_action": "丢掉它、重新提交（宿主不取墙钟：submitted_at 也必须为空）"}
    if record.get("submitted_at") not in (None, ""):
        return None, {"code": "pending-tampered", "reason": "submitted_at 必须为空（宿主不取墙钟）",
                      "next_action": "时间由 Python 侧按 --now 落账：清空该字段后重提"}
    return {"file": path.name, "path": path, "view": view, "rfq_id": rfq_id, "promised_by": promised_by,
            "due_at": due_at, "note": note, "note_sha256": note_digest(note)}, None


# ---------------------------------------------------------------------------
# 归档（不删；同名冲突时加序号 —— 幂等可观察）
# ---------------------------------------------------------------------------
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
    """已归档待办件的 `(view, rfq_id, note_sha256)`（幂等闸之一）。"""
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
        if record.get("view") and record.get("rfq_id") and record.get("note_sha256"):
            out.add((str(record["view"]), str(record["rfq_id"]), norm_digest(record["note_sha256"])))
    return out


def ledger_promises(path: Path) -> tuple[set[tuple[str, str, str]] | None, set[tuple[str, str, str]] | None,
                                         int, str | None]:
    """账本里的 `rfq/promised` 键（幂等闸之二）+ 行数 + 读错误（坏账本 → 报错而不是猜）。

    返回两套键：按原话哈希、按（包 + 承诺时限）—— 两种重复都算 duplicates（同一份承诺重复登记）。
    """
    rows, error = load_rows(path)
    if error is not None:
        return None, None, 0, error
    assert rows is not None
    by_note: set[tuple[str, str, str]] = set()
    by_due: set[tuple[str, str, str]] = set()
    for row in rows:
        if str(row.get("type")) != EVENT:
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if body.get("ok") is not True:
            continue
        view = str(body.get("view") or "")
        rfq_id = str(body.get("rfq_id") or "")
        by_note.add((view, rfq_id, norm_digest(body.get("promise_sha256"))))
        by_due.add((view, rfq_id, str(body.get("due_at") or "")))
    return by_note, by_due, len(rows), None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rfq-promise", add_help=False,
                                     description="「承诺回文时限」待办件的唯一落账本者（宿主只落 0600 待办件）")
    parser.add_argument("--inbox", default="", help="待办件目录（默认 <ui-shared>/rfq-promises）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--views", default="contractor,supplier")
    parser.add_argument("--view", default="", help="只处理该视图的待办件")
    parser.add_argument("--ledger-contractor", default="", help="承包商账本路径（默认 <ui-shared>/contractor/ledger.jsonl）")
    parser.add_argument("--ledger-supplier", default="", help="供应商账本路径（默认 <ui-shared>/supplier/ledger.jsonl）")
    parser.add_argument("--actor", default="", help="落账 actor（默认沿用待办件里的发言人 promised_by）")
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
    if args.actor and not ACTOR_RE.match(str(args.actor)):
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-actor", "reason": "actor 必须以 human:/agent: 开头",
                                  "next_action": "留空则沿用待办件里的发言人；显式给时必须写 human:<人名>"}]}, 2)
    views = [item.strip() for item in str(args.views).split(",") if item.strip()]
    if not views:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-views", "reason": "--views 解析为空",
                                  "next_action": "给出至少一个视图名"}]}, 2)

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / "rfq-promises"
    ledgers = {
        "contractor": Path(args.ledger_contractor) if args.ledger_contractor
        else ui_shared / "contractor" / "ledger.jsonl",
        "supplier": Path(args.ledger_supplier) if args.ledger_supplier
        else ui_shared / "supplier" / "ledger.jsonl",
    }
    missing_ledgers = [view for view in views if view not in ledgers]
    if missing_ledgers:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-ledger",
                                  "reason": f"视图 {missing_ledgers} 没有对应的账本路径",
                                  "next_action": "给 --ledger-<view> 或调整 --views"}]}, 2)
    if not inbox.is_dir():
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "inbox-missing", "reason": f"--inbox 不是目录：{inbox}",
                                  "next_action": "先让宿主落下待办件（页面点一次登记承诺），或生成该目录"}]}, 2)

    pending = [item for item in sorted(inbox.glob("rp-*.json")) if PENDING_RE.match(item.name)]
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
    facts: dict[str, dict] = {}
    for view in views:
        path = ledgers[view]
        rows, error = load_rows(path)
        by_note, by_due, count, read_error = ledger_promises(path)
        if error is not None or by_note is None or by_due is None or read_error is not None:
            return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0, "refused": refused,
                         "refused_ledger": [{"view": view, "code": "ledger-unreadable",
                                             "reason": error or read_error,
                                             "next_action": "先修账本（本脚本不往坏账本追加）"}]}, 2)
        realm = ""
        if rows:
            realm = str(rows[0].get("realm") or "")
        facts[view] = {"rows": rows or [], "by_note": by_note, "by_due": by_due, "count": count,
                       "packages": published_packages(rows or []), "realm": realm or f"{view}:rfq-promise"}

    applied: list[dict] = []
    duplicates: list[dict] = []
    ledger_added = 0
    archived = load_applied(inbox)
    handles: dict[str, Ledger] = {}
    for item in items:
        view, rfq_id = item["view"], item["rfq_id"]
        fact = facts[view]
        key_note = (view, rfq_id, item["note_sha256"])
        key_due = (view, rfq_id, item["due_at"])
        actor = str(args.actor) if args.actor else item["promised_by"]
        if rfq_id not in fact["packages"]:
            refusal = {"file": item["file"], "view": view, "rfq_id": rfq_id, "code": "rfq-not-found",
                       "reason": "该视图的投影里没有这个**发布过的包**（rfq/published 里没有它）",
                       "next_action": f"看 /quotagent/{view}/deadlines/ 列出的真包 id 后重提"
                         "（不改任何状态，账本零新增）"}
            refused.append(refusal)
            continue
        if key_note in archived or key_note in fact["by_note"] or key_due in fact["by_due"]:
            duplicates.append({"file": item["file"], "view": view, "rfq_id": rfq_id,
                               "due_at": item["due_at"], "note_sha256": item["note_sha256"],
                               "reason": "already-promised",
                               "matched": "applied-archive" if key_note in archived
                               else ("ledger-note" if key_note in fact["by_note"] else "ledger-due")})
            if not args.dry_run:
                archive(inbox, item["path"])
            continue
        body = {"rfq_id": rfq_id, "view": view, "actor": actor, "due_at": item["due_at"],
                "promise_sha256": item["note_sha256"], "ok": True}
        if not args.dry_run:
            ledger = handles.get(view) or Ledger(ledgers[view], realm=str(fact["realm"]))
            handles[view] = ledger
            try:
                ledger.append(EVENT, body, correlation_id=rfq_id, actor=actor, ts=args.now)
            except LedgerError as exc:
                # 账本自检不过（哈希链断/冻结）→ **宁可不写**：如实报，并把这件事本身当成环境错误
                detail = str(exc)[:200]
                return emit({"ok": False, "applied": applied, "duplicates": duplicates,
                             "ledger_added": ledger_added, "refused": refused + [
                                 {"file": item["file"], "view": view, "rfq_id": rfq_id,
                                  "code": "ledger-frozen", "reason": detail,
                                  "next_action": "先修账本（本脚本不往校验不过的账本追加任何行）"}]}, 2)
            ledger_added += 1
        fact["by_note"].add(key_note)
        fact["by_due"].add(key_due)
        fact["count"] += 1
        applied.append({"file": item["file"], "view": view, "rfq_id": rfq_id, "actor": actor,
                        "due_at": item["due_at"], "promise_sha256": item["note_sha256"],
                        "body_keys": sorted(body), "ledger": str(ledgers[view])})
        if not args.dry_run:
            archive(inbox, item["path"])

    out = {"ok": not refused, "event": EVENT, "now": args.now,
           "applied": applied, "duplicates": duplicates, "ledger_added": ledger_added,
           "refused": refused, "pending_seen": len(pending), "inbox": str(inbox),
           "ledgers": {view: str(ledgers[view]) for view in views},
           "counts": {view: facts[view]["count"] for view in views},
           "dry_run": bool(args.dry_run),
           "note": "登记承诺**不是发信**：本脚本只落 rfq/promised（body 恰 6 键、不含原话正文与凭据），"
                   "不碰任何邮件通道；它也不改任何判定状态"}
    return emit(out, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
