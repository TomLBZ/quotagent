#!/usr/bin/env python3
"""admin-apply —— 消费宿主侧「待处理提交」并落账（**Python 是唯一写账本的地方**，H1）。

对应需求与验收：FR-ADMIN-005 / AC-ADMIN-005；契约见 `docs/design/21-admin-console-contract.md` §3/§4。

宿主侧提交面（`host/modules/webui.mjs` 的 `POST <prefix>/admin/api/blocks/<id>/resolve`，需会话 + token）
**只**在 `<inbox>/<block_id>.json`（权限 0600、原子写）落一条待处理项，**账本零新增**：

    {"block_id":"blk-…","kind":"credential|plugin-request|other","submitted_at":"<ISO>",
     "submitted_by":"admin-session","fields":{"<名>":"<值>"},
     "payload_sha256":"<sha256(fields 的规范化 JSON)>","bytes":123,"schema":1}

本脚本是把它变成账本事实的**唯一**入口。职责边界（每一句都有对应机检）：

- **输入全部显式传入**：`--inbox` / `--ledger` / `--approval-ref` / `--actor` / `--now` 都必须给；
  本脚本**不读墙钟**（`--now` 是唯一时间源，写进账本行的 `ts`）、不读环境变量决定行为。
- **人工门不可绕过**：`--approval-ref` 必须形如 `ap-NNNN`、`--actor` 必须以 `human:` 开头；
  缺一个、形状不对 → **整次拒绝**（退出码 2、账本零新增、stdout 一行 JSON 说清理由）。
- **权限即门**：待处理项**权限必须恰为 0600**（0644 等一律拒），不猜测、不自动改权限。
- **重算校验**：`payload_sha256` 与 `bytes` 一律用 `fields` 重算比对（不采信文件自述），
  不一致即拒；比对的是**规范化 JSON**（键排序 + 无空格 + 不转义非 ASCII，与宿主
  `JSON.stringify` 同形）。**拒绝理由里不出现任何字段值**。
- **事件正文不含凭据**：`admin/block-pending`（首次见到该 block）与 `admin/block-resolved` 的 body
  **只有** `block_id/kind/resolution_sha256/bytes/approval_ref/actor/schema` —— 没有 `fields` 的**值**，
  **也没有 `fields` 的键名**（凭据正文由人处理，账本只记哈希）。
- **幂等**：同 `(block_id, payload_sha256)` 再次出现 → 账本零新增、stdout 标 `duplicate`；
  账本自身的去重（`(correlation_id, type, body_hash)`）是第二道保险。
- **不删源**：应用成功后把待处理项**移入** `<inbox>/applied/`（原件保留，便于审计）。
  重复项留在收件箱原处（不重复归档、不覆盖上一次的归档）。
- **失败不留部分效果**：CLI 级拒绝在**构造 `Ledger` 之前**返回 —— 账本文件连**空文件都不会被创建**。

用法::

    python3 tools/admin-apply.py --inbox tmp/ui-shared/admin-submissions --ledger tmp/admin/ledger.jsonl \\
        --approval-ref ap-0007 --actor human:zhang --now 2026-09-21T00:00:00Z [--block-id blk-…] [--dry-run]

stdout 严格一行 JSON：`{ok, applied:[{block_id,event}], duplicates:[…], refused:[{file,reason}],
ledger_added, ledger_path}`；逐条说明走 stderr。退出码：0=全部成功、1=有项被拒、2=用法门拒绝。
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/admin-apply.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402  （**唯一**写账本的地方就是这个脚本）
from quotagent.services.admin_blocks import KINDS  # noqa: E402  （kind 取值域单一真源）

EXIT_OK = 0
EXIT_REFUSED = 1
EXIT_USAGE = 2
REALM = "admin"
SCHEMA = 1
EVENT_PENDING = "admin/block-pending"
EVENT_RESOLVED = "admin/block-resolved"
#: 事件 body **唯一**允许的键集（多一个键就是违约：凭据的键名不得进账本）
BODY_KEYS = ("block_id", "kind", "resolution_sha256", "bytes", "approval_ref", "actor", "schema")
#: 批准引用形状：账本侧批准 id（`ap-NNNN`，先例 retention_exec）。别的形状不做修补。
APPROVAL_REF_RE = re.compile(r"^ap-\d{4}$")
#: 人署名：`human:<name>`（agent 不得代签）
ACTOR_RE = re.compile(r"^human:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
#: 待处理项目录里不当作待处理项的名字（归档目录 / 宿主原子写的临时文件）
ARCHIVE_DIR = "applied"


# ---------------------------------------------------------------------------
# 规范化（与宿主 `JSON.stringify(排序后的对象)` 同形：键排序、无空格、非 ASCII 不转义）
# ---------------------------------------------------------------------------
def canonical_fields(fields: dict) -> str:
    return json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_digest(fields: dict) -> str:
    return hashlib.sha256(canonical_fields(fields).encode("utf-8")).hexdigest()


def _iso(text: Any) -> str | None:
    """校验 ISO 时间串（**不读墙钟**）；不合法返回 None。"""
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _stdout(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _note(text: str) -> None:
    print(f"[admin-apply] {text}", file=sys.stderr)


def _refusal(reason: str, file: Any = None) -> dict:
    return {"file": None if file is None else str(file), "reason": reason}


# ---------------------------------------------------------------------------
# 账本侧既有事实（只读；**不创建**账本文件）
# ---------------------------------------------------------------------------
def _read_ledger_facts(path: Path) -> dict:
    """读既有账本行 → 已见 block / 已解决 (block_id, resolution_sha256)。

    账本不存在 = 没有任何既有事实（**不创建空文件**）；有一行不是合法 JSON = 宁可不写（拒绝整次运行）。
    """
    facts: dict[str, Any] = {"pending": set(), "resolved": set(), "lines": 0, "error": None}
    if not path.exists():
        return facts
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        facts["error"] = f"账本读不到：{exc}"
        return facts
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        facts["lines"] += 1
        try:
            record = json.loads(line)
        except ValueError as exc:
            facts["error"] = f"账本第 {lineno} 行不是合法 JSON（{exc}）：宁可不写，先修账本"
            return facts
        if not isinstance(record, dict):
            facts["error"] = f"账本第 {lineno} 行不是记录对象：宁可不写，先修账本"
            return facts
        raw_body = record.get("body")
        body: dict = raw_body if isinstance(raw_body, dict) else {}
        block_id = str(body.get("block_id") or "")
        if not block_id:
            continue
        if record.get("type") == EVENT_PENDING:
            facts["pending"].add(block_id)
        elif record.get("type") == EVENT_RESOLVED:
            digest = str(body.get("resolution_sha256") or "")
            if digest:
                facts["resolved"].add((block_id, digest))
    return facts


def _archived_payloads(inbox: Path) -> set:
    """已归档的待处理项 → `{(block_id, payload_sha256)}`（**只取这两个字段**；坏文件不猜）。"""
    archive = inbox / ARCHIVE_DIR
    if not archive.is_dir():
        return set()
    out = set()
    for path in sorted(archive.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("block_id") and record.get("payload_sha256"):
            out.add((str(record["block_id"]), str(record["payload_sha256"])))
    return out


# ---------------------------------------------------------------------------
# 待处理项：权限门 → 形状门 → 重算校验（理由里不出现任何字段值）
# ---------------------------------------------------------------------------
def _load_item(path: Path) -> tuple[dict | None, str | None]:
    """读一个待处理项；不合法返回 `(None, 理由)`。理由**不含**任何字段名/字段值。"""
    try:
        info = os.stat(path)
    except OSError as exc:
        return None, f"读不到文件：{exc}"
    if not stat.S_ISREG(info.st_mode):
        return None, "不是普通文件（符号链接/目录/设备一律拒）"
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, f"权限不是 600（收到 {oct(mode)}）：待处理项必须由提交面以 0600 落盘，本脚本不改权限"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"读不到文件：{exc}"
    try:
        record = json.loads(raw)
    except ValueError as exc:
        return None, f"不是合法 JSON：{exc}"
    if not isinstance(record, dict):
        return None, "待处理项必须是 JSON 对象"

    block_id = record.get("block_id")
    if not isinstance(block_id, str) or not block_id.strip():
        return None, "缺 block_id（或不是非空字符串）"
    kind = record.get("kind")
    if not isinstance(kind, str) or kind not in KINDS:
        return None, f"kind 不在取值域 {list(KINDS)}（不猜、不默认成 other）"
    fields = record.get("fields")
    if not isinstance(fields, dict) or not fields:
        return None, "fields 必须是非空对象（没有材料就没有可落的解阻塞事实）"
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in fields.items()):
        return None, "fields 必须是「字符串 → 字符串」（不猜测非字符串的形状）"
    digest = record.get("payload_sha256")
    if not isinstance(digest, str) or not HEX64_RE.match(digest):
        return None, "payload_sha256 必须是 64 位小写 hex"
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        return None, "bytes 必须是非负整数"
    if record.get("schema") != SCHEMA:
        return None, f"schema 必须是 {SCHEMA}（未知版本不猜）"
    if not _iso(record.get("submitted_at")):
        return None, "submitted_at 必须是合法 ISO 时间"

    canonical = canonical_fields(fields)
    recomputed = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if recomputed != digest:
        return None, "payload_sha256 与重算结果不符（文件自述不可信；不采信、不落账）"
    actual_bytes = len(canonical.encode("utf-8"))
    if actual_bytes != size:
        return None, f"bytes 与重算结果不符（自述 {size}、重算 {actual_bytes}）"
    return {"block_id": block_id, "kind": kind, "payload_sha256": digest, "bytes": actual_bytes}, None


def _body(block_id: str, kind: str, digest: str, size: int, approval_ref: str, actor: str) -> dict:
    """事件正文：**只有**契约允许的键 —— 凭据的键名与值都不在里面。"""
    body = {"block_id": block_id, "kind": kind, "resolution_sha256": f"sha256:{digest}",
            "bytes": size, "approval_ref": approval_ref, "actor": actor, "schema": SCHEMA}
    if tuple(sorted(body)) != tuple(sorted(BODY_KEYS)):
        raise RuntimeError(f"事件正文键集与契约不符：{sorted(body)} != {sorted(BODY_KEYS)}")
    return body


def _archive(inbox: Path, path: Path, block_id: str) -> Path:
    """把待处理项**移入** `<inbox>/applied/`（不删源：改名 + 移动，原件保留）。"""
    archive = inbox / ARCHIVE_DIR
    archive.mkdir(parents=True, exist_ok=True)
    target = archive / f"{block_id}.json"
    if target.exists():                                  # 同名归档已存在：加后缀，**不覆盖**上一次的件
        index = 1
        while (archive / f"{block_id}.{index}.json").exists():
            index += 1
        target = archive / f"{block_id}.{index}.json"
    shutil.move(str(path), str(target))
    return target


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="admin-apply", add_help=False,
                                     description="消费宿主侧待处理提交并落账（Python 是唯一写账本的地方）")
    parser.add_argument("--inbox")
    parser.add_argument("--ledger")
    parser.add_argument("--approval-ref", dest="approval_ref")
    parser.add_argument("--actor")
    parser.add_argument("--now")
    parser.add_argument("--block-id", dest="block_id")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    parser.add_argument("-h", "--help", action="store_true", dest="help")
    return parser


def _usage_refuse(reason: str, ledger_path: str) -> int:
    _stdout({"ok": False, "applied": [], "duplicates": [],
             "refused": [_refusal(reason)], "ledger_added": 0, "ledger_path": ledger_path})
    _note(f"用法拒绝：{reason}（账本零新增；本脚本在构造 Ledger 之前返回，连空账本文件都不会创建）")
    return EXIT_USAGE


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    ledger_path = str(args.ledger or "")

    if args.help:
        _stdout({"ok": False, "applied": [], "duplicates": [],
                 "refused": [_refusal("--help")], "ledger_added": 0, "ledger_path": ledger_path})
        _note("用法：--inbox <dir> --ledger <path> --approval-ref ap-NNNN --actor human:<名> --now <ISO>"
              " [--block-id <id>] [--dry-run]")
        return EXIT_USAGE

    # --- 用法门：全部在构造 Ledger 之前 -------------------------------------
    if not ledger_path.strip():
        return _usage_refuse("缺 --ledger（账本落点必须显式给）", ledger_path)
    if not str(args.inbox or "").strip():
        return _usage_refuse("缺 --inbox（宿主提交面的待处理目录必须显式给）", ledger_path)
    inbox = Path(str(args.inbox))
    if not inbox.is_dir():
        return _usage_refuse(f"--inbox 不是目录：{inbox}", ledger_path)
    ref = args.approval_ref
    if not isinstance(ref, str) or not ref.strip():
        return _usage_refuse("缺人工批准引用 --approval-ref（ap-NNNN）：人工门不可绕过，引用不是批准",
                             ledger_path)
    if not APPROVAL_REF_RE.match(ref.strip()):
        return _usage_refuse(f"批准引用形状非法（须 ap-NNNN，不做修补）：{ref!r}", ledger_path)
    actor = args.actor
    if not isinstance(actor, str) or not actor.strip():
        return _usage_refuse("缺 --actor（必须是人署名 human:<名>）", ledger_path)
    if not ACTOR_RE.match(actor.strip()):
        return _usage_refuse(f"--actor 必须是 human:<名>（agent 不得代签）：{actor!r}", ledger_path)
    now = _iso(args.now)
    if now is None:
        return _usage_refuse("--now 必填且必须是合法 ISO 时间（本脚本不读墙钟）", ledger_path)
    approval_ref, actor_ref = ref.strip(), actor.strip()

    ledger_file = Path(ledger_path)
    facts = _read_ledger_facts(ledger_file)
    if facts["error"]:
        return _usage_refuse(str(facts["error"]), ledger_path)
    archived = _archived_payloads(inbox)

    # --- 逐项消费 ----------------------------------------------------------
    candidates = [path for path in sorted(inbox.glob("*.json"))
                  if path.is_file() and not path.name.startswith(".")]
    if args.block_id:
        wanted = str(args.block_id).strip()
        candidates = [path for path in candidates if path.stem == wanted]
        if not candidates:
            _note(f"--block-id {wanted}：收件箱里没有匹配的待处理项（可能是已消费并归档；不改任何状态）")

    applied: list[dict] = []
    duplicates: list[dict] = []
    refused: list[dict] = []
    ledger: Ledger | None = None
    ledger_added = 0

    for path in candidates:
        item, reason = _load_item(path)
        if reason is not None:
            refused.append(_refusal(reason, path))
            _note(f"拒绝 {path.name}：{reason}")
            continue
        assert item is not None
        block_id, digest = str(item["block_id"]), str(item["payload_sha256"])
        if args.block_id and block_id != str(args.block_id).strip():
            refused.append(_refusal(f"文件名与 block_id 不符（文件 {path.stem}）", path))
            _note(f"拒绝 {path.name}：文件名与 block_id 不符")
            continue
        key = (block_id, f"sha256:{digest}")
        if key in facts["resolved"] or (block_id, digest) in archived:
            duplicates.append({"block_id": block_id, "status": "duplicate",
                               "reason": "账本/归档里已有同 (block_id, payload_sha256) 的事实（幂等：零新增）",
                               "file": str(path)})
            _note(f"重复（duplicate）{block_id}：账本已有同 (block_id, payload_sha256) 的事实，"
                  f"零新增；原件保留在收件箱 {path.name}（不重复归档）")
            continue

        pending_first = block_id not in facts["pending"]
        events = ([EVENT_PENDING] if pending_first else []) + [EVENT_RESOLVED]
        if args.dry_run:
            applied.append({"block_id": block_id, "event": "+".join(events)})
            _note(f"dry-run {block_id}：将落 {len(events)} 条事件 {events}；未写账本、未移动任何文件")
            continue
        body = _body(block_id, str(item["kind"]), digest, int(item["bytes"]), approval_ref, actor_ref)
        try:
            if ledger is None:
                ledger = Ledger(ledger_file, realm=REALM)          # 首次真要写时才创建（唯一写账本处）
            for event_type in events:
                ref_obj = ledger.append(event_type, body, correlation_id=f"admin:{block_id}",
                                        actor=actor_ref, ts=now)
                if ref_obj.duplicate:                              # 账本自身去重：第二道保险
                    _note(f"{event_type} 命中账本去重（seq {ref_obj.seq}）：不新增行")
                else:
                    ledger_added += 1
        except Exception as exc:  # noqa: BLE001 —— 账本拒绝（冻结/链断）就是拒绝落账，绝不放行
            refused.append(_refusal(f"账本拒绝追加：{type(exc).__name__}: {exc}", path))
            _note(f"拒绝 {path.name}：账本拒绝追加（{type(exc).__name__}）：{exc}")
            continue
        applied.append({"block_id": block_id, "event": "+".join(events)})
        moved = _archive(inbox, path, block_id)
        facts["pending"].add(block_id)
        facts["resolved"].add(key)
        archived.add((block_id, digest))
        _note(f"应用 {block_id} → {len(events)} 条事件 {events}；待处理项移入 {moved.relative_to(inbox)}")

    ok = not refused
    _stdout({"ok": ok, "applied": applied, "duplicates": duplicates, "refused": refused,
             "ledger_added": ledger_added, "ledger_path": str(ledger_file)})
    if refused:
        _note(f"{len(refused)} 项被拒：账本对它们零新增（拒绝不留部分效果）")
        return EXIT_REFUSED
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
