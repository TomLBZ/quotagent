#!/usr/bin/env python3
"""tools/gate-nudge.py —— 「催办 / 转交」的**唯一写账本者**（宿主 zero-ledger-write，H1）。

为什么需要它：`GET /quotagent/<view>/gates/` 上那句「催办」如果由宿主直接落账，就会多出第二条事实写路径，
并且给了浏览器一条能影响"审批状态"的口子。所以闭环拆成两段（与 `ui-feedback-apply.py` 同规格）：

  ① 宿主（`host/modules/webui.mjs` + `host/modules/gate-timeline.mjs`）只落**一条 0600 待办件**
     `<inbox>/gn-<view>-<12hex>.json`：含**用户原话**（`reason`）、目标门 id（`gate_id`）、
     `reason_sha256`、视图名、`requested_action: "nudge"` —— **账本零新增**；
  ② 本脚本（**唯一落账本者**）：
     · 权限门（**必须恰为 0600、必须是普通文件**）→ 形状门（schema/kind/view/动作）→ **重算校验**
       （`reason_sha256` 与 `bytes` 必须与重算一致，`submitted_at` 必须为空 —— 宿主不取墙钟）；
     · **目标门必须真的在本视图的投影里**（该视图账本里存在 `approval/<id>` 行），
       且**还没有被决定**（granted/denied/aborted 之后不允许再催：催办不能绕过判定）；
     · 落一条 `gate/nudged`，body **恰好 5 键**：`{gate_id, view, actor, reason_sha256, ok}`
       —— **不含理由正文、不含任何凭据**（正文只留在 0600 待办件里）；
     · 待办件移入 `<inbox>/applied/`（**不删**，幂等可观察）。

幂等：同一份（视图 + 门 + 理由）的 `(view, gate_id, reason_sha256)` 已经处理过（在 `applied/` 归档里，
或账本里已有同键的 `gate/nudged` 行）→ 记 `duplicates`、**账本零新增**、`exit 0`。

拒绝路径一律给**具体 `code` + `next_action`**，并且**拒绝时零写账本**：
  `pending-insecure-mode` / `pending-not-regular` / `pending-not-json` / `pending-schema-unknown` /
  `pending-kind-unknown` / `view-unknown` / `gate-id-malformed` / `action-not-nudge` / `empty-reason` /
  `pending-tampered`（sha256/bytes/submitted_at 与重算不符）/ `gate-not-found`（投影里没有这个门）/
  `gate-already-decided`（已经批了/拒了/作废了）/ `ledger-unreadable`（宁可不写，先修账本）。

纪律（与 `admin-apply.py` / `ui-feedback-apply.py` 同规格）：
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
GATE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
PENDING_RE = re.compile(r"^gn-[A-Za-z0-9-]+-[0-9a-f]{12}\.json$")
SCHEMA = 1
KIND = "gate-nudge"
ACTION = "nudge"
EVENT = "gate/nudged"
ACTOR = "agent:gate-nudge"
ARCHIVE_DIR = "applied"
RESOLVED_APPROVAL_EVENTS = ("approval/granted", "approval/denied", "approval/aborted")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def reason_digest(reason: str) -> str:
    return hashlib.sha256(reason.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 投影读取（**只读**：判定权在账本，「门是否存在」这件事只认账本里的 approval/* 行）
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


def approval_state(rows: list[dict], gate_id: str) -> str:
    """该门在投影里的状态：`missing`（不存在）/`pending`/`decided`（已 granted|denied|aborted）。"""
    seen = [row for row in rows
            if str(row.get("type", "")).startswith("approval/")
            and isinstance(row.get("body"), dict)
            and str(row["body"].get("approval_id") or "") == gate_id]
    if not seen:
        return "missing"
    last = seen[-1]
    return "decided" if str(last.get("type")) in RESOLVED_APPROVAL_EVENTS else "pending"


# ---------------------------------------------------------------------------
# 待办件读取（权限门 → 形状门 → 重算校验；拒绝理由里**不出现理由正文**）
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
                      "next_action": "确认这条文件是不是 gate-timeline 的催办待办件"}
    if record.get("requested_action") != ACTION:
        return None, {"code": "action-not-nudge",
                      "reason": f"requested_action 必须是 {ACTION}；批准/提交/签收这类动作**不在本脚本的能力面里**",
                      "next_action": "催办只有 nudge 一种；要批准请在终端由 human:* 签署（ADR-0013 §3）"}
    view = record.get("view")
    if not isinstance(view, str) or view not in views:
        return None, {"code": "view-unknown", "reason": f"view 不在 {views} 内（不猜、不默认）",
                      "next_action": "视图名由页面提交，必须是配置里的视图之一"}
    gate_id = record.get("gate_id")
    if not isinstance(gate_id, str) or not GATE_ID_RE.match(gate_id):
        return None, {"code": "gate-id-malformed", "reason": "gate_id 缺或形状非法（只接受字母数字与 . _ : -）",
                      "next_action": "重提一次：目标门 id 由页面从**本视角投影**里取（形如 ap-0007）"}
    reason = record.get("reason")
    if not isinstance(reason, str) or reason.strip() == "":
        return None, {"code": "empty-reason", "reason": "理由为空或不是字符串",
                      "next_action": "这条没有内容：删掉它，或让用户重提一次带原话的催办"}
    digest = record.get("reason_sha256")
    if not isinstance(digest, str) or not HEX64_RE.match(norm_digest(digest)):
        return None, {"code": "pending-tampered", "reason": "reason_sha256 缺或不是 sha256:<64 位小写 hex>",
                      "next_action": "待办件自述不可信：重提一次（提交面会重新算哈希）"}
    if norm_digest(digest) != reason_digest(reason):
        return None, {"code": "pending-tampered", "reason": "reason_sha256 与重算结果不符（自述不可信）",
                      "next_action": "文件被改过或不是提交面写的：丢掉它、重新提交"}
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(reason.encode("utf-8")):
        return None, {"code": "pending-tampered", "reason": "bytes 与重算的 UTF-8 字节数不符",
                      "next_action": "丢掉它、重新提交（宿主不取墙钟：submitted_at 也必须为空）"}
    if record.get("submitted_at") not in (None, ""):
        return None, {"code": "pending-tampered", "reason": "submitted_at 必须为空（宿主不取墙钟）",
                      "next_action": "时间由 Python 侧按 --now 落账：清空该字段后重提"}
    return {"file": path.name, "path": path, "view": view, "gate_id": gate_id, "reason": reason,
            "reason_sha256": reason_digest(reason)}, None


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
    """已归档待办件的 `(view, gate_id, reason_sha256)`（幂等闸之一）。"""
    out: set[tuple[str, str, str]] = set()
    target_dir = inbox / ARCHIVE_DIR
    if not target_dir.is_dir():
        return out
    for path in sorted(target_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        if record.get("kind") != KIND:
            continue
        if record.get("view") and record.get("gate_id") and record.get("reason_sha256"):
            out.add((str(record["view"]), str(record["gate_id"]), norm_digest(record["reason_sha256"])))
    return out


def ledger_nudges(path: Path) -> tuple[set[tuple[str, str, str]] | None, int, str | None]:
    """账本里的 `gate/nudged` 键（幂等闸之二）+ 行数 + 读错误（坏账本 → 报错而不是猜）。"""
    rows, error = load_rows(path)
    if error is not None:
        return None, 0, error
    assert rows is not None
    out: set[tuple[str, str, str]] = set()
    for row in rows:
        if str(row.get("type")) != EVENT:
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if body.get("ok") is not True:
            continue
        out.add((str(body.get("view") or ""), str(body.get("gate_id") or ""),
                 norm_digest(body.get("reason_sha256"))))
    return out, len(rows), None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="gate-nudge", add_help=False,
                                     description="催办待办件的唯一落账本者（宿主只落 0600 待办件）")
    parser.add_argument("--inbox", default="", help="待办件目录（默认 <ui-shared>/gate-nudges）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--views", default="contractor,supplier")
    parser.add_argument("--view", default="", help="只处理该视图的待办件")
    parser.add_argument("--ledger-contractor", default="", help="承包商账本路径（默认 <ui-shared>/contractor/ledger.jsonl）")
    parser.add_argument("--ledger-supplier", default="", help="供应商账本路径（默认 <ui-shared>/supplier/ledger.jsonl）")
    parser.add_argument("--actor", default=ACTOR, help="落账 actor（默认 agent:gate-nudge）")
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
                                  "next_action": "催办者是人就写 human:<人名>，是自动流程就写 agent:<组件>"}]}, 2)
    views = [item.strip() for item in str(args.views).split(",") if item.strip()]
    if not views:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-views", "reason": "--views 解析为空",
                                  "next_action": "给出至少一个视图名"}]}, 2)

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / "gate-nudges"
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
                                  "next_action": "先让宿主落下待办件（页面点一次催办），或生成该目录"}]}, 2)

    pending = [item for item in sorted(inbox.glob("gn-*.json")) if PENDING_RE.match(item.name)]
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
                     "refused": refused, "pending_seen": len(pending),
                     "inbox": str(inbox)}, 1)

    # 环境门：要写的账本先必须可读（坏账本宁可不写）
    facts: dict[str, dict] = {}
    for view in views:
        path = ledgers[view]
        rows, error = load_rows(path)
        nudges, count, realm_error = ledger_nudges(path)
        if error is not None or nudges is None or realm_error is not None:
            return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0, "refused": refused,
                         "refused_ledger": [{"view": view, "code": "ledger-unreadable",
                                             "reason": error or realm_error,
                                             "next_action": "先修账本（本脚本不往坏账本追加）"}]}, 2)
        realm = ""
        if rows:
            realm = str(rows[0].get("realm") or "")
        facts[view] = {"rows": rows or [], "nudges": nudges, "count": count,
                       "realm": realm or f"{view}:gate-nudge"}

    applied: list[dict] = []
    duplicates: list[dict] = []
    ledger_added = 0
    archived = load_applied(inbox)
    handles: dict[str, Ledger] = {}
    for item in items:
        view, gate_id = item["view"], item["gate_id"]
        fact = facts[view]
        key = (view, gate_id, item["reason_sha256"])
        state = approval_state(fact["rows"], gate_id)
        if state == "missing":
            refusal = {"file": item["file"], "view": view, "gate_id": gate_id, "code": "gate-not-found",
                       "reason": "该视图的投影里没有这个 approval_id（可能被写错、或不属于本视图）",
                       "next_action": f"看 /quotagent/{view}/gates/ 列出的真门 id 后重提（不改任何状态，账本零新增）"}
            refused.append(refusal)
            continue
        if state == "decided":
            refusal = {"file": item["file"], "view": view, "gate_id": gate_id, "code": "gate-already-decided",
                       "reason": "这个门已经被决定过（granted/denied/aborted）：催办不能绕过判定",
                       "next_action": "页面上已不列这条门；要改判定只能在终端由 human:* 重新发起（ADR-0013 §3）"}
            refused.append(refusal)
            continue
        if key in archived or key in fact["nudges"]:
            duplicates.append({"file": item["file"], "view": view, "gate_id": gate_id,
                               "reason_sha256": item["reason_sha256"], "reason": "already-nudged",
                               "matched": "applied-archive" if key in archived else "ledger"})
            if not args.dry_run:
                archive(inbox, item["path"])
            continue
        body = {"gate_id": gate_id, "view": view, "actor": str(args.actor),
                "reason_sha256": item["reason_sha256"], "ok": True}
        if not args.dry_run:
            ledger = handles.get(view) or Ledger(ledgers[view], realm=str(fact["realm"]))
            handles[view] = ledger
            try:
                ledger.append(EVENT, body, correlation_id=gate_id, actor=str(args.actor), ts=args.now)
            except LedgerError as exc:
                # 账本自检不过（哈希链断/冻结）→ **宁可不写**：如实报，并把这件事本身当成环境错误
                return emit({"ok": False, "applied": applied, "duplicates": duplicates,
                             "ledger_added": ledger_added, "refused": refused + [
                                 {"file": item["file"], "view": view, "gate_id": gate_id,
                                  "code": "ledger-frozen", "reason": str(exc).slice(0, 200),
                                  "next_action": "先修账本（本脚本不往校验不过的账本追加任何行）"}]}, 2)
            ledger_added += 1
        fact["nudges"].add(key)
        fact["count"] += 1
        applied.append({"file": item["file"], "view": view, "gate_id": gate_id,
                        "reason_sha256": item["reason_sha256"], "body_keys": sorted(body),
                        "ledger": str(ledgers[view])})
        if not args.dry_run:
            archive(inbox, item["path"])

    out = {"ok": not refused, "event": EVENT, "actor": str(args.actor), "now": args.now,
           "applied": applied, "duplicates": duplicates, "ledger_added": ledger_added,
           "refused": refused, "pending_seen": len(pending),
           "inbox": str(inbox), "ledgers": {view: str(ledgers[view]) for view in views},
           "counts": {view: facts[view]["count"] for view in views},
           "dry_run": bool(args.dry_run),
           "note": "催办**不改门的判定状态**：本脚本只落 gate/nudged（body 恰 5 键、不含理由正文与凭据）"}
    return emit(out, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
