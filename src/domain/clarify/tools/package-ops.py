#!/usr/bin/env python3
"""src/domain/clarify/tools/package-ops.py —— 「供应商侧对**本包**的两句回话」的**唯一落账本者**：

  · `ack`     —— 「我已收到 @revN」（DEF-016：这句话必须真落账，承包商侧的"谁没回"名单据此变化）；
  · `promise` —— 「我要晚点回：<时限>」（DEF-024：**同一个包，首页看得见、承诺却说不存在**的 404 不一致）。

为什么放在 clarify 插件下（口径说明）：本插件在 GUI 里承担「供应商侧与承包商的**往来**」这一块
（提问澄清 / 认收 / 回文承诺）；`domain/rfq`、`domain/rfq-deadline` 由其它批次在改，硬约束不允许本批改动它们，
所以这两个写者落在本插件的 `tools/` 下，用**既有服务**（`RfqService` 的口径）+ 本插件自己的落账实现。
与 `tools/rfq-promise.py`（`domain/rfq-deadline`）**同一个事件形状**（`rfq/promised`，body 恰 6 键），
承包商侧任何读 `rfq/promised` 的看板（`due_ts`）不需要改一行就能看到本写者落的行。

闭环拆成两段（与 `quote-draft.py` / `rfq-publish.py` 同规格）：

  ① 宿主（`src/system/webui/code/app-shell.mjs` 的动作总线）只落**一条 0600 待办件**
     `<ui-shared>/package-ops/<kind>-<12hex>.json`：含 `action`（ack/promise）、`view`、包 id、版本、
     发言人（`human:*`）、可选原话 —— **账本零新增**、不发信；
  ② 本脚本（**唯一落账本者**）：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action/view）→
     **重算校验**（`payload_sha256` / `bytes` / `submitted_at` 与重算一致）→ 业务前置
     （**包必须真的在本视角可见**，见下面的"统一口径"）→ 落账 → 待办件移入 `applied/`（不删）。

**统一口径（DEF-024 的修法）**：一个包"在本视角可见"= 满足任意一条：

  · 本人账本里有 `rfq/published` / `rfq/distributed` / `rfq/amended` 事实（`package_id` 对上）；
  · **投递信封**（`--delivery` 指向的文件或目录，即首页"我收到的包"用的那份）的
    `spec.package_id` 对上，且 `delivered_to` 含本视角 realm（或名单为空 = 广播）。

⇒ 「首页看得见、承诺说不存在」这类 404 不一致在本写者这里**不可能发生**：两者的判定源一致。
拒绝时**零写账本**，逐条给 `code` + `next_action`（含 `rfq-not-found` 时列出"我按哪些口径找过"）。

幂等：同一 `(view, package_id, seen_rev)`（ack）或 `(view, rfq_id, 原话哈希)`（promise）已经落过 →
`duplicates`、**账本零新增**、`exit 0`。

用法：
  python3 src/domain/clarify/tools/package-ops.py --request <pending.json> --now 2026-09-22T10:00:00Z \\
      --ui-shared tmp/run-shared --ledger-supplier tmp/run-shared/supplier/ledger.jsonl \\
      --ledger-contractor tmp/run-shared/contractor/ledger.jsonl --delivery tmp/run-shared/contractor/01-package.json
退出码：0 = 已落或幂等；1 = 有拒绝；2 = 用法/环境错误（**构造 Ledger 之前**返回，拒绝时连空账本都不创建）。
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

from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
PAK_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
ACTOR_RE = re.compile(r"^(human|agent):[A-Za-z0-9._:-]{1,64}$")
HUMAN_RE = re.compile(r"^human:[A-Za-z0-9._:-]{1,64}$")
MAX_FILE_BYTES = 262144

SCHEMA = "quotagent/pending/v1"
KIND = "package-ops"
ACTIONS = ("ack", "promise")
ACK_ACTION = "ack"
PROMISE_ACTION = "promise"
ACK_EVENT = "rfq/acknowledged"
PROMISE_EVENT = "rfq/promised"
ACK_BODY_KEYS = ("acknowledged_at", "acknowledged_by", "ok", "package_id", "seen_rev", "supplier", "view")
PROMISE_BODY_KEYS = ("actor", "due_at", "ok", "promise_sha256", "rfq_id", "view")
ARCHIVE_DIR = "applied"
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
PACKAGE_EVENTS = ("rfq/published", "rfq/distributed", "rfq/amended")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def all_refused(refused: list[dict], extra: dict | None = None) -> int:
    payload = {"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
               "refused": refused}
    payload.update(extra or {})
    return emit(payload, 1)


def digest_of(text: object) -> str:
    return "sha256:" + hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def hex_of(text: object) -> str:
    return hashlib.sha256(str(text or "").encode("utf-8")).hexdigest()


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def canonical(record: dict) -> str:
    """待办件的规范化 JSON（与宿主 `app-shell.mjs` 逐字节一致：键排序 + 无空格 + 不转义非 ASCII）。"""
    payload = {key: value for key, value in record.items() if key not in IGNORED_KEYS}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_rows(path: Path) -> tuple[list[dict] | None, str | None]:
    if not path.exists():
        return [], None
    rows: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"{path}:{lineno} 不是合法 JSON：{exc}"
        if not isinstance(record, dict):
            return None, f"{path}:{lineno} 不是对象"
        rows.append(record)
    return rows, None


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if value:
            return value
    return fallback


# ---------------------------------------------------------------------------
# 权限门 + 形状门 + 重算校验
# ---------------------------------------------------------------------------
def read_pending(path: Path) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}",
                             "让宿主先落待办件（页面上的「我已收到」「我要晚点回」会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}",
                             "待办件必须是宿主落的普通文件（符号链接/管道一律拒）")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600",
                             "chmod 600 待办件再消费（宿主落盘时就是 0600）")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限 {MAX_FILE_BYTES}",
                             "把内容拆小后重提（上限是为了拒绝体量失控的载荷）")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA:
        return None, refusal("pending-schema-unknown", f"schema 不是 {SCHEMA}：{record.get('schema')!r}",
                             "让宿主按 schema 重落待办件")
    if record.get("kind") != KIND:
        return None, refusal("pending-kind-unknown", f"kind 不是 {KIND}：{record.get('kind')!r}",
                             "这份待办件不是「包往来」的载荷")
    if str(record.get("action") or "") not in ACTIONS:
        return None, refusal("action-not-supported",
                             f"action 必须是 {'/'.join(ACTIONS)} 之一：{record.get('action')!r}",
                             "认收用 ack、回文承诺用 promise（签名/提交这类动作不在本脚本的能力面里）")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟，时间由 --now 给）",
                             "让宿主重落待办件（submitted_at 留空）")
    expected = digest_of(canonical(record))
    if str(record.get("payload_sha256") or "") != expected:
        return None, refusal("pending-tampered",
                             f"payload_sha256 与重算不一致（给出 {record.get('payload_sha256')!r}）",
                             "让宿主重落待办件（改了载荷就要重算哈希）")
    note = str(record.get("note") or "")
    note_digest = str(record.get("note_sha256") or "")
    if not HEX64_RE.match(norm_digest(note_digest)):
        return None, refusal("pending-tampered", "note_sha256 缺或不是 64 位十六进制",
                             "让宿主重落待办件（提交面会重新算原话哈希）")
    if norm_digest(note_digest) != hex_of(note):
        return None, refusal("pending-tampered", "note_sha256 与重算的原话哈希不一致（自述不可信）",
                             "文件被改过或不是提交面写的：丢掉它、重新提交")
    size = record.get("bytes")
    if not isinstance(size, int) or isinstance(size, bool) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与备注正文长度不一致", "让宿主重落待办件")
    return record, None


# ---------------------------------------------------------------------------
# 视角可见包的**统一口径**（DEF-024）：本人账本事实 ∪ 投递信封
# ---------------------------------------------------------------------------
def package_index(rows: list[dict]) -> dict[str, dict]:
    """本人账本里的包索引：`package_id → {revs, items, sources}`（只认 rfq/* 的三类事实）。"""
    index: dict[str, dict] = {}
    for row in rows:
        kind = str(row.get("type") or "")
        if kind not in PACKAGE_EVENTS:
            continue
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        refs = row.get("refs") if isinstance(row.get("refs"), dict) else {}
        package_id = str(body.get("package_id") or refs.get("package_id") or row.get("correlation_id") or "")
        if not PAK_RE.match(package_id):
            continue
        entry = index.setdefault(package_id, {"revs": set(), "items": {}, "sources": []})
        rev = body.get("rev", refs.get("rfq_rev"))
        if isinstance(rev, int):
            entry["revs"].add(rev)
        for item in body.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
        spec = body.get("spec") if isinstance(body.get("spec"), dict) else {}
        for item in spec.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
        entry["sources"].append(kind)
    return index


def read_envelopes(target: str) -> list[dict]:
    """读投递信封（文件或目录；**只读**，坏文件如实跳过并记在 `errors` 里）。"""
    if not str(target or "").strip():
        return []
    path = Path(target)
    files: list[Path] = []
    if path.is_dir():
        files = sorted(item for item in path.glob("*.json"))
    elif path.is_file():
        files = [path]
    out: list[dict] = []
    for file in files:
        try:
            record = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict):
            record["_source"] = str(file)
            out.append(record)
    return out


def envelope_index(envelopes: list[dict], realm: str) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for envelope in envelopes:
        spec = envelope.get("spec") if isinstance(envelope.get("spec"), dict) else {}
        package_id = str(spec.get("package_id") or "").strip()
        if not PAK_RE.match(package_id):
            continue
        delivered_to = [str(item) for item in (envelope.get("delivered_to") or [])]
        if delivered_to and realm and realm not in delivered_to:
            # 投递名单里没有我：不算"我的包"（结构性隔离），但把事实留在 index 里便于诊断
            index.setdefault(package_id, {"revs": set(), "items": {}, "sources": [],
                                          "delivered_to": delivered_to, "addressed": False})
            entry = index[package_id]
            entry["delivered_to"] = delivered_to
            continue
        entry = index.setdefault(package_id, {"revs": set(), "items": {}, "sources": []})
        rev = envelope.get("rev")
        if isinstance(rev, int):
            entry["revs"].add(rev)
        for item in spec.get("items") or []:
            if isinstance(item, dict) and str(item.get("item_id") or ""):
                entry["items"][str(item["item_id"])] = item
        entry["delivered_to"] = delivered_to
        entry["addressed"] = True
        entry["sources"].append("delivery-envelope")
    return index


def resolve_package(package_id: str, rows: list[dict], envelopes: list[dict], realm: str,
                    delivery_target: str) -> tuple[dict | None, dict | None]:
    """包是否"在本视角可见"：本人账本事实 ∪ 投递信封（口径唯一，DEF-024）。"""
    merged: dict[str, dict] = {}
    for source in (package_index(rows), envelope_index(envelopes, realm)):
        for key, entry in source.items():
            target = merged.setdefault(key, {"revs": set(), "items": {}, "sources": []})
            target["revs"] |= set(entry.get("revs") or set())
            target["items"].update(entry.get("items") or {})
            for item in entry.get("sources") or []:
                if item not in target["sources"]:
                    target["sources"].append(item)
            if entry.get("delivered_to") is not None:
                target["delivered_to"] = entry.get("delivered_to")
                target["addressed"] = entry.get("addressed", True)
    entry = merged.get(package_id)
    if entry is None:
        seen = sorted(merged)[:8]
        return None, refusal(
            "rfq-not-found",
            f"包 {package_id} 不在本视角可见范围里（按两种口径都找过：本人账本的 rfq/* 事实、投递信封"
            f"{delivery_target or '（未配置）'}）；已读到的包：{seen or '（无）'}",
            "点页面上的「刷新」重读；若对方刚发布新版，等投递信封落地（本写者两种口径都认，不再出现"
            "『首页看得见、承诺说不存在』）")
    if entry.get("addressed") is False:
        others = [who for who in (entry.get("delivered_to") or []) if who != realm]
        return None, refusal(
            "not-addressed-to-me",
            f"包 {package_id} 的投递名单是 {others or entry.get('delivered_to')}，不含 {realm or '（未识别身份）'}",
            "只出自己的那份：确认本侧 realm 与邀请名单；别人的包不出、也不给你回话")
    return entry, None


def revs_text(entry: dict) -> list[int]:
    return sorted(int(rev) for rev in (entry.get("revs") or set()) if isinstance(rev, int))


# ---------------------------------------------------------------------------
# 归档 / 幂等键
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


def load_applied(inbox: Path) -> list[dict]:
    out: list[dict] = []
    target_dir = inbox / ARCHIVE_DIR
    if not target_dir.is_dir():
        return out
    for path in sorted(target_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("kind") == KIND:
            out.append(record)
    return out


def ledger_keys(rows: list[dict]) -> dict[str, set]:
    ack: set = set()
    promise: set = set()
    for row in rows:
        kind = str(row.get("type") or "")
        body = row.get("body") if isinstance(row.get("body"), dict) else {}
        if body.get("ok") is not True:
            continue
        view = str(body.get("view") or "")
        if kind == ACK_EVENT:
            ack.add((view, str(body.get("package_id") or ""), body.get("seen_rev")))
        if kind == PROMISE_EVENT:
            promise.add((view, str(body.get("rfq_id") or ""), norm_digest(body.get("promise_sha256"))))
    return {"ack": ack, "promise": promise}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="package-ops", add_help=False,
                                     description="认收 / 回文承诺待办件的唯一落账本者（宿主只落 0600 待办件）")
    parser.add_argument("--request", default="", help="单条待办件路径（也可以给 --inbox 目录）")
    parser.add_argument("--inbox", default="", help="待办件目录（默认 <ui-shared>/package-ops）")
    parser.add_argument("--action", default="", help="只处理该动作的待办件（ack|promise）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--view", default="supplier")
    parser.add_argument("--ledger-supplier", default="")
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--delivery", default="", help="投递信封（文件或目录；与首页同一个源）")
    parser.add_argument("--mirror", default="contractor", help="镜像登记到哪个视角的账本（默认 contractor）")
    parser.add_argument("--now", default="")
    parser.add_argument("--actor", default="", help="落账 actor（默认沿用待办件里的发言人）")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = _parser()
    try:
        args, unknown = parser.parse_known_args(argv)
    except SystemExit:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [refusal("usage", "参数无法解析", "见 --help")]}, 2)
    if unknown:
        return usage_error("usage-unknown-flag", f"不认识的参数：{unknown}", "去掉不认识的参数后重试")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601",
                           "显式给时间：--now 2026-09-22T10:00:00Z（本脚本不读墙钟）")
    if args.action and args.action not in ACTIONS:
        return usage_error("usage-action", f"--action 只能是 {'/'.join(ACTIONS)}：{args.action}",
                           "认收用 ack、回文承诺用 promise")
    if not args.request and not args.inbox:
        return usage_error("usage-request", "既没有 --request 也没有 --inbox",
                           "给一条待办件路径（--request）或一个待办件目录（--inbox）")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.request).parent if args.request else Path(args.inbox)
    if not args.request and not inbox.is_dir():
        return usage_error("inbox-missing", f"待办件目录不存在：{inbox}",
                           "先在页面上点一次（宿主会落 0600 待办件），或确认 --inbox 路径")
    ledger_supplier = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    ledger_contractor = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"

    supplier_rows, supplier_error = load_rows(ledger_supplier)
    contractor_rows, contractor_error = load_rows(ledger_contractor)
    if supplier_error is not None or contractor_error is not None:
        return usage_error("ledger-unreadable", supplier_error or contractor_error,
                           "先修账本（本脚本不往坏账本追加）")
    assert supplier_rows is not None and contractor_rows is not None
    realm = realm_of(supplier_rows, args.view + ":unknown")
    envelopes = read_envelopes(args.delivery)
    keys = ledger_keys(supplier_rows)
    keys_mirror = ledger_keys(contractor_rows)
    archived = load_applied(inbox)
    for record in archived:
        if record.get("action") == ACK_ACTION:
            keys["ack"].add((str(record.get("view") or ""), str(record.get("package_id") or ""),
                             record.get("seen_rev")))
        if record.get("action") == PROMISE_ACTION:
            keys["promise"].add((str(record.get("view") or ""), str(record.get("rfq_id") or ""),
                                 norm_digest(record.get("note_sha256"))))

    pending: list[Path] = []
    if args.request:
        pending = [Path(args.request)]
    else:
        pending = [item for item in sorted(inbox.glob("*.json")) if item.is_file()]

    refused: list[dict] = []
    applied: list[dict] = []
    duplicates: list[dict] = []
    ledger_added = 0
    for path in pending:
        record, problem = read_pending(path)
        if problem is not None:
            problem.update({"file": path.name})
            refused.append(problem)
            continue
        assert record is not None
        action = str(record.get("action") or "")
        if args.action and action != args.action:
            continue
        view = str(record.get("view") or "")
        if view != args.view:
            refused.append(refusal("view-unknown", f"待办件 view={view!r} 不是本视角 {args.view!r}",
                                   "重提一次（视角名由页面提交，必须是配置里的视图之一）") | {"file": path.name})
            continue
        package_id = str(record.get("package_id") or record.get("rfq_id") or "").strip()
        if not PAK_RE.match(package_id):
            refused.append(refusal("package-id-malformed", f"包 id 缺或形状非法：{package_id!r}",
                                   "重提一次：包 id 由页面从**本视角可见的包**里取") | {"file": path.name})
            continue
        entry, problem = resolve_package(package_id, supplier_rows, envelopes, realm, args.delivery)
        if problem is not None:
            problem.update({"file": path.name, "package_id": package_id})
            refused.append(problem)
            continue
        assert entry is not None
        speaker = str(record.get("actor") or args.actor or "").strip()
        if not ACTOR_RE.match(speaker):
            refused.append(refusal("actor-malformed", f"发言人必须是 human:<人名> 或 agent:<组件>：{speaker!r}",
                                   "重提一次并写明发言人（谁说的这句话必须可追）") | {"file": path.name})
            continue

        if action == ACK_ACTION:
            seen_rev = record.get("seen_rev")
            revs = revs_text(entry)
            if isinstance(seen_rev, bool) or not isinstance(seen_rev, int):
                refused.append(refusal("seen-rev-malformed", f"seen_rev 必须是整数：{seen_rev!r}",
                                       "重提一次（版本号由页面从本视角可见的包里取）") | {"file": path.name})
                continue
            if revs and seen_rev not in revs:
                refused.append(refusal("rev-out-of-range",
                                       f"seen_rev={seen_rev} 不在本视角已知版本 {revs} 里（不猜、不夹取）",
                                       f"按页面上的版本号重填（当前已知：{revs}）") | {"file": path.name})
                continue
            key = (args.view, package_id, seen_rev)
            if key in keys["ack"] or key in keys_mirror["ack"]:
                duplicates.append({"file": path.name, "action": action, "key": list(key),
                                   "reason": "already-acknowledged"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            body = {"package_id": package_id, "seen_rev": seen_rev, "supplier": realm,
                    "acknowledged_by": speaker, "acknowledged_at": args.now, "ok": True, "view": args.view}
            assert tuple(sorted(body)) == ACK_BODY_KEYS
            if not args.dry_run:
                try:
                    Ledger(ledger_supplier, realm=realm).append(
                        ACK_EVENT, body, correlation_id=package_id, actor=speaker, ts=args.now,
                        event_class="fact", refs={"package_id": package_id, "rfq_rev": seen_rev})
                    Ledger(ledger_contractor, realm=realm_of(contractor_rows, "contractor:package-ops")).append(
                        ACK_EVENT, {**body, "view": args.mirror}, correlation_id=package_id, actor=speaker,
                        ts=args.now, event_class="fact", refs={"package_id": package_id, "rfq_rev": seen_rev})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200],
                                       "先修账本（本脚本不往校验不过的账本追加任何行）")
                ledger_added += 2
            keys["ack"].add(key)
            applied.append({"file": path.name, "action": action, "event": ACK_EVENT, "package_id": package_id,
                            "seen_rev": seen_rev, "body_keys": list(ACK_BODY_KEYS), "notified": args.mirror})
        else:
            due_at = str(record.get("due_at") or "").strip()
            if not ISO_RE.match(due_at):
                refused.append(refusal("due-at-malformed",
                                       f"due_at 必须是 ISO8601 UTC（形如 2026-09-26T00:00:00Z）：{due_at!r}",
                                       "重提一次（不做时区换算）") | {"file": path.name})
                continue
            note = str(record.get("note") or "")
            if note.strip() == "":
                refused.append(refusal("empty-note", "原话为空",
                                       "让用户重提一次带原话的承诺（「我要晚点回」必须说清为什么）")
                              | {"file": path.name})
                continue
            promise_sha = hex_of(package_id + "|" + args.now)
            note_sha = hex_of(note)
            key = (args.view, package_id, promise_sha)
            key_note = (args.view, package_id, note_sha)
            if key in keys["promise"] or key in keys_mirror["promise"] \
                    or key_note in keys["promise"] or key_note in keys_mirror["promise"]:
                duplicates.append({"file": path.name, "action": action, "key": list(key),
                                   "reason": "already-promised"})
                if not args.dry_run:
                    archive(inbox, path)
                continue
            body = {"rfq_id": package_id, "view": args.view, "actor": speaker, "due_at": due_at,
                    "promise_sha256": "sha256:" + promise_sha, "ok": True}
            assert tuple(sorted(body)) == PROMISE_BODY_KEYS
            if not args.dry_run:
                try:
                    Ledger(ledger_supplier, realm=realm).append(
                        PROMISE_EVENT, body, correlation_id=package_id, actor=speaker, ts=args.now,
                        event_class="fact", refs={"package_id": package_id})
                    Ledger(ledger_contractor, realm=realm_of(contractor_rows, "contractor:package-ops")).append(
                        PROMISE_EVENT, {**body, "view": args.mirror}, correlation_id=package_id, actor=speaker,
                        ts=args.now, event_class="fact", refs={"package_id": package_id})
                except LedgerError as exc:
                    return usage_error("ledger-frozen", str(exc)[0:200],
                                       "先修账本（本脚本不往校验不过的账本追加任何行）")
                ledger_added += 2
            keys["promise"].add(key)
            applied.append({"file": path.name, "action": action, "event": PROMISE_EVENT, "rfq_id": package_id,
                            "due_at": due_at, "body_keys": list(PROMISE_BODY_KEYS), "notified": args.mirror})
            # 原话只留在 0600 待办件里：这里只把哈希写进归档键（便于幂等判定），不写账本
        if not args.dry_run:
            archive(inbox, path)

    if not applied and not duplicates and not refused:
        return usage_error("nothing-to-do", f"{inbox} 里没有可消费的待办件",
                           "先在页面上点一次动作（宿主会落 0600 待办件）")
    if refused and not applied and not duplicates:
        return all_refused(refused, {"inbox": str(inbox), "view": args.view, "realm": realm})
    return emit({"ok": not refused, "event": "package-ops", "view": args.view, "realm": realm,
                 "now": args.now, "applied": applied, "duplicates": duplicates,
                 "ledger_added": ledger_added, "refused": refused, "inbox": str(inbox),
                 "ledger_supplier": str(ledger_supplier), "ledger_contractor": str(ledger_contractor),
                 "delivery": args.delivery, "dry_run": bool(args.dry_run),
                 "note": "认收落 rfq/acknowledged、回文承诺落 rfq/promised（body 恰 6 键，与 "
                         "domain/rfq-deadline 的同名事件同形）；两侧各一条，承包商侧据此更新『谁没回』与 due_ts",
                 }, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
