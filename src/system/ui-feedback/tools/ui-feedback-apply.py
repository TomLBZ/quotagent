"""tools/ui-feedback-apply.py —— WebUI 反馈闭环的**唯一写账本者**（宿主 zero-ledger-write，H1）。

闭环（用户反馈 → agent 产新版本 → 自动重载 → 页面提示"请刷新"）的 Python 侧一半：

  ① 读 `<inbox>/fb-*.json`（**权限必须恰为 0600**、自述 `text_sha256`/`bytes` 必须与重算一致）；
  ② 找该视图**对应的新版本产出**（`--user-space` 下 `plugin.json` 里 `view` 与反馈视图一致者，
     或 `--artifact <view>=<path>` 显式指定）→ **重算产物哈希**（自述 `sha256` 不符即拒）；
  ③ **原子写**版本状态 `<state>`（tmp + fsync + chmod 0600 + `os.replace`）；
  ④ 落账本 `<ledger>` 一条 `ui/feedback-applied`（body **恰好 8 键、不含反馈正文**）：
     `{view, revision, prev_revision, artifact_sha256, source_prompt_digest, actor, ok, reason}`；
  ⑤ 待办件移入 `<inbox>/applied/`（**不删**：幂等可观察）。

幂等：同一份反馈（同 `view` + 同 `text_sha256`）已经处理过 → `duplicates`、**账本零新增**、`exit=0`。

拒绝路径一律给**具体 `code` + `next_action`**（`artifact-missing` / `hash-mismatch` / `pending-tampered`
/ `pending-insecure-mode` / `view-unknown` …），并且**拒绝时零写账本**（宁可零行，也不写不真的事）。

纪律（与 `admin-apply.py` / `userplugin-record.py` 同规格）：
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

# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/ui-feedback-apply.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
SCHEMA = 1
KIND = "ui-feedback"
EVENT = "ui/feedback-applied"
ACTOR = "agent:ui-feedback"
ARCHIVE_DIR = "applied"
PENDING_RE = re.compile(r"^fb-[A-Za-z0-9-]+-[0-9a-f]{12}\.json$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def text_digest(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def norm_digest(value: object) -> str:
    text = str(value or "")
    return text.split(":", 1)[1] if text.startswith("sha256:") else text


def revision_of(count: int) -> str:
    return f"r{count}"


# ---------------------------------------------------------------------------
# 待办件读取（权限门 → 形状门 → 重算校验；理由里**不出现反馈正文**）
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
                      "next_action": "确认这条文件是不是 ui-feedback 待办件"}
    view = record.get("view")
    if not isinstance(view, str) or view not in views:
        return None, {"code": "view-unknown", "reason": f"view 不在 {views} 内（不猜、不默认）",
                      "next_action": "视图名由页面提交，必须是配置里的视图之一"}
    text = record.get("text")
    if not isinstance(text, str) or text.strip() == "":
        return None, {"code": "empty-feedback", "reason": "正文为空或不是字符串",
                      "next_action": "这条没有内容：删掉它，或让用户重提一次带原话的反馈"}
    digest = record.get("text_sha256")
    if not isinstance(digest, str) or not HEX64_RE.match(norm_digest(digest)):
        return None, {"code": "pending-tampered", "reason": "text_sha256 缺或不是 sha256:<64 位小写 hex>",
                      "next_action": "待办件自述不可信：重提一次（提交面会重新算哈希）"}
    if norm_digest(digest) != norm_digest(text_digest(text)):
        return None, {"code": "pending-tampered", "reason": "text_sha256 与重算结果不符（自述不可信）",
                      "next_action": "文件被改过或不是提交面写的：丢掉它、重新提交"}
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(text.encode("utf-8")):
        return None, {"code": "pending-tampered", "reason": "bytes 与重算的 UTF-8 字节数不符",
                      "next_action": "丢掉它、重新提交（宿主不取墙钟：submitted_at 也必须为空）"}
    if record.get("submitted_at") not in (None, ""):
        return None, {"code": "pending-tampered", "reason": "submitted_at 必须为空（宿主不取墙钟）",
                      "next_action": "时间由 Python 侧按 --now 落账：清空该字段后重提"}
    return {"file": path.name, "path": path, "view": view, "text": text,
            "text_sha256": norm_digest(text_digest(text)),
            "revision_at_submit": str(record.get("revision_at_submit") or "")}, None


# ---------------------------------------------------------------------------
# 产物解析 + 重算哈希（**与宿主/用户空间同一口径**：`plugin.json` 里 `artifact` 指向的那个文件）
# ---------------------------------------------------------------------------
def artifact_of_file(path: Path) -> tuple[str, int, str]:
    """单文件产物：`sha256(字节)`。返回 `(digest, bytes, source)`。"""
    data = path.read_bytes()
    return sha256_bytes(data), len(data), str(path)


def resolve_artifact(view: str, overrides: dict[str, Path], user_space: Path) -> tuple[dict | None, dict | None]:
    """找该视图对应的**新版本产出**；找不到就 `artifact-missing`（不猜、不代替）。"""
    explicit = overrides.get(view)
    if explicit is not None:
        if not explicit.exists():
            return None, {"code": "artifact-missing", "reason": f"--artifact {view}={explicit} 不存在",
                          "next_action": "确认 agent 产出的新版本文件路径，或让它先产出再重跑"}
        if explicit.is_dir():
            return manifest_artifact(explicit)
        digest, size, source = artifact_of_file(explicit)
        return {"sha256": digest, "bytes": size, "source": source, "manifest": ""}, None
    if not user_space.is_dir():
        return None, {"code": "artifact-missing", "reason": f"--user-space 不是目录：{user_space}",
                      "next_action": "给出用户空间根（agent 产出的插件落在这里）"}
    candidates: list[tuple[str, Path]] = []
    for manifest_path in sorted(user_space.glob("*/[!.]*/plugin.json")):
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(manifest, dict):
            continue
        declared = manifest.get("view") or manifest.get("ui_view") or ""
        declared_views = declared if isinstance(declared, list) else [declared]
        if view in [str(item) for item in declared_views if item]:
            candidates.append((manifest_path.parent.name, manifest_path))
    if not candidates:
        return None, {"code": "artifact-missing",
                      "reason": f"用户空间里没有 view={view} 的产出（plugin.json 的 view/ui_view 字段）",
                      "next_action": f"让 agent 为 {view} 产出新版本（或 --artifact {view}=<路径> 显式指定）"}
    name, manifest_path = candidates[0]
    out, refusal = manifest_artifact(manifest_path.parent)
    if refusal is not None:
        return None, refusal
    out["manifest"] = str(manifest_path)
    out["candidates"] = [item[0] for item in candidates]
    return out, None


def manifest_artifact(plugin_dir: Path) -> tuple[dict | None, dict | None]:
    manifest_path = plugin_dir / "plugin.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return None, {"code": "artifact-manifest-invalid", "reason": f"plugin.json 不可读：{type(exc).__name__}",
                      "next_action": "让 agent 修好 manifest（必须是合法 JSON 对象）"}
    if not isinstance(manifest, dict):
        return None, {"code": "artifact-manifest-invalid", "reason": "plugin.json 不是对象",
                      "next_action": "让 agent 修好 manifest"}
    name = manifest.get("artifact") if isinstance(manifest.get("artifact"), str) else "index.mjs"
    file = plugin_dir / (name or "index.mjs")
    if not file.is_file():
        return None, {"code": "artifact-missing", "reason": f"manifest 指向的产物不存在：{file.name}",
                      "next_action": "让 agent 把产物写到 manifest.artifact 指向的文件名"}
    data = file.read_bytes()
    digest = sha256_bytes(data)
    declared = manifest.get("sha256") or manifest.get("artifact_sha256")
    if isinstance(declared, str) and declared.strip() != "" and norm_digest(declared) != norm_digest(digest):
        return None, {"code": "hash-mismatch",
                      "reason": f"manifest 自述 sha256 与重算不符（{file.name}）",
                      "next_action": "产物与 manifest 不同步：让 agent 重算并同步 manifest.sha256"}
    return {"sha256": digest, "bytes": len(data), "source": str(file), "manifest": str(manifest_path)}, None


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


def write_state(path: Path, payload: dict) -> None:
    """版本状态：**原子写**（tmp + fsync + chmod 0600 + replace）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def ledger_facts(path: Path) -> dict:
    """从账本重建事实：每个视图的已应用版本数与最新产物哈希（**账本是唯一真源**）。"""
    facts: dict = {"views": {}, "rows": 0, "error": None, "digests": set()}
    if not path.exists():
        return facts
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            facts["error"] = f"账本第 {lineno} 行不是合法 JSON（{exc}）：宁可不写，先修账本"
            return facts
        if not isinstance(record, dict):
            facts["error"] = f"账本第 {lineno} 行不是记录对象：宁可不写，先修账本"
            return facts
        facts["rows"] += 1
        if str(record.get("type")) != EVENT:
            continue
        body = record.get("body") if isinstance(record.get("body"), dict) else {}
        if body.get("ok") is not True:
            continue
        view = str(body.get("view") or "")
        entry = facts["views"].setdefault(view, {"count": 0, "revision": "r0", "artifact_sha256": "",
                                                 "applied_at": ""})
        entry["count"] += 1
        entry["revision"] = str(body.get("revision") or revision_of(entry["count"]))
        entry["artifact_sha256"] = str(body.get("artifact_sha256") or "")
        entry["applied_at"] = str(record.get("ts") or "")
        facts["digests"].add((view, str(body.get("source_prompt_digest") or ""),
                              str(body.get("artifact_sha256") or "")))
    return facts


def load_applied(inbox: Path) -> set[tuple[str, str]]:
    """已归档待办件的 `(view, text_sha256)`（幂等闸）。"""
    out: set[tuple[str, str]] = set()
    target_dir = inbox / ARCHIVE_DIR
    if not target_dir.is_dir():
        return out
    for path in sorted(target_dir.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("view") and record.get("text_sha256"):
            out.add((str(record["view"]), norm_digest(record["text_sha256"])))
    return out


def state_payload(now: str, views: list[str], facts: dict, history: list[dict], max_applied: int) -> dict:
    out_views: dict[str, dict] = {}
    for view in views:
        entry = facts["views"].get(view)
        out_views[view] = {
            "revision": str(entry["revision"]) if entry else "r0",
            "artifact_sha256": str(entry["artifact_sha256"]) if entry else "",
            "applied_at": str(entry["applied_at"]) if entry else "",
        }
    latest = {"revision": "r0", "view": ""}
    for view, entry in out_views.items():
        number = int(str(entry["revision"])[1:] or 0) if re.match(r"^r\d+$", str(entry["revision"])) else 0
        best = int(str(latest["revision"])[1:] or 0)
        if number > best:
            latest = {"revision": str(entry["revision"]), "view": view}
    return {"schema": SCHEMA, "generated_at": now, "views": out_views, "latest": latest,
            "applied": history[-max_applied:], "counts": {"applied": sum(
                int(entry["count"]) for entry in facts["views"].values())},
            "note": "版本号只由本脚本按**已落账本**的事实递增（宿主只读该文件，从不写它、也不递增版本号）"}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ui-feedback-apply", add_help=False,
                                     description="WebUI 反馈的唯一落账本者（宿主只落 0600 待办件）")
    parser.add_argument("--inbox", default=str(ROOT / "tmp" / "ui-shared" / "ui-feedback"),
                        help="待办件目录（宿主落件处；`applied/` 是它的归档子目录）")
    parser.add_argument("--user-space", default=str(ROOT / "user-space"))
    parser.add_argument("--ledger", default="", help="账本路径（默认 <inbox>/ledger.jsonl）")
    parser.add_argument("--state", default="", help="版本状态路径（默认 <inbox>/versions.json）")
    parser.add_argument("--views", default="contractor,supplier")
    parser.add_argument("--view", default="", help="只处理该视图的待办件")
    parser.add_argument("--artifact", action="append", default=[],
                        help="显式指定产出：`<view>=<路径>`（可重复；不给则按 plugin.json 的 view 自动发现）")
    parser.add_argument("--now", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-applied", type=int, default=5, help="状态文件里保留的最近处理条数（有界）")
    return parser


def main(argv: list[str] | None = None) -> int:
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
    views = [item.strip() for item in str(args.views).split(",") if item.strip()]
    if not views:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-views", "reason": "--views 解析为空",
                                  "next_action": "给出至少一个视图名"}]}, 2)
    if args.max_applied < 1:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "usage-max-applied", "reason": "--max-applied 必须 ≥1",
                                  "next_action": "给一个正数（有界是硬要求）"}]}, 2)

    inbox = Path(args.inbox)
    user_space = Path(args.user_space)
    if not inbox.is_dir():
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "inbox-missing", "reason": f"--inbox 不是目录：{inbox}",
                                  "next_action": "先让宿主落下待办件（用户提交一次反馈），或生成该目录"}]}, 2)
    overrides: dict[str, Path] = {}
    for item in args.artifact or []:
        view, _, raw = str(item).partition("=")
        if not view or not raw:
            return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                         "refused": [{"file": None, "code": "usage-artifact",
                                      "reason": f"--artifact 必须是 `<view>=<路径>`（收到 {item!r}）",
                                      "next_action": "改成 `--artifact contractor=user-space/con-a/x/plugin.json`"}]}, 2)
        overrides[view] = Path(raw)

    # 环境门：账本必须先能读（坏账本宁可不写）
    ledger_path = Path(args.ledger) if args.ledger else inbox / "ledger.jsonl"
    state_path = Path(args.state) if args.state else inbox / "versions.json"
    if not ledger_path.parent.is_dir():
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": [{"file": None, "code": "ledger-dir-missing",
                                  "reason": f"账本目录不存在：{ledger_path.parent}",
                                  "next_action": "先建目录（或用默认 --inbox）"}]}, 2)

    pending = [item for item in sorted(inbox.glob("fb-*.json")) if PENDING_RE.match(item.name)]
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
        # 全是坏件：**不碰账本、不碰状态**（拒绝时零写）
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0,
                     "refused": refused, "pending_seen": len(pending),
                     "state_file": str(state_path)}, 1)

    facts = ledger_facts(ledger_path)
    if facts["error"]:
        return emit({"ok": False, "applied": [], "duplicates": [], "ledger_added": 0, "refused": refused,
                     "refused_ledger": [{"code": "ledger-unreadable", "reason": facts["error"],
                                         "next_action": "先修账本（本脚本不往坏账本追加）"}]}, 2)

    applied: list[dict] = []
    duplicates: list[dict] = []
    history: list[dict] = []
    for record in ledger_path.read_text(encoding="utf-8").splitlines() if ledger_path.exists() else []:
        if not record.strip():
            continue
        try:
            parsed = json.loads(record)
        except ValueError:
            continue
        if isinstance(parsed, dict) and str(parsed.get("type")) == EVENT:
            body = parsed.get("body") if isinstance(parsed.get("body"), dict) else {}
            if body.get("ok") is True:
                history.append({"view": str(body.get("view") or ""), "revision": str(body.get("revision") or ""),
                                "prev_revision": str(body.get("prev_revision") or ""),
                                "artifact_sha256": str(body.get("artifact_sha256") or ""),
                                "source_prompt_digest": str(body.get("source_prompt_digest") or ""),
                                "ok": True, "reason": str(body.get("reason") or ""),
                                "applied_at": str(parsed.get("ts") or "")})
    archived = load_applied(inbox)

    ledger = Ledger(ledger_path, realm="ui-shared")
    ledger_added = 0
    for item in items:
        key = (item["view"], item["text_sha256"])
        artifact, refusal = resolve_artifact(item["view"], overrides, user_space)
        if refusal is not None:
            refusal.update({"file": item["file"], "view": item["view"]})
            refused.append(refusal)
            continue
        if key in archived or (item["view"], item["text_sha256"], artifact["sha256"]) in facts["digests"]:
            duplicates.append({"file": item["file"], "view": item["view"], "artifact_sha256": artifact["sha256"],
                               "text_sha256": item["text_sha256"], "reason": "already-applied",
                               "matched": "applied-archive" if key in archived else "ledger"})
            if not args.dry_run:
                archive(inbox, item["path"])
            continue
        entry = facts["views"].get(item["view"]) or {"count": 0, "revision": "r0"}
        prev_revision = str(entry["revision"])
        revision = revision_of(int(entry["count"]) + 1)
        if revision == prev_revision:
            # 同一版本号不得对应两个不同产物（与用户空间插件同一纪律）
            refused.append({"file": item["file"], "view": item["view"], "code": "revision-not-bumped",
                            "reason": f"重算的版本号 {revision} 与当前一致（账本事实未推进）",
                            "next_action": "先确认账本里的 ui/feedback-applied 行数与产物是否对得上"})
            continue
        body = {"view": item["view"], "revision": revision, "prev_revision": prev_revision,
                "artifact_sha256": artifact["sha256"], "source_prompt_digest": item["text_sha256"],
                "actor": ACTOR, "ok": True, "reason": ""}
        if not args.dry_run:
            ledger.append(EVENT, body, correlation_id=f"uifb-{item['view']}-{revision}", actor=ACTOR, ts=args.now)
            ledger_added += 1
        facts["views"][item["view"]] = {"count": int(entry["count"]) + 1, "revision": revision,
                                        "artifact_sha256": artifact["sha256"], "applied_at": args.now}
        facts["digests"].add((item["view"], item["text_sha256"], artifact["sha256"]))
        history.append({"view": item["view"], "revision": revision, "prev_revision": prev_revision,
                        "artifact_sha256": artifact["sha256"], "source_prompt_digest": item["text_sha256"],
                        "ok": True, "reason": "", "applied_at": args.now})
        applied.append({"file": item["file"], "view": item["view"], "revision": revision,
                        "prev_revision": prev_revision, "artifact_sha256": artifact["sha256"],
                        "artifact_bytes": artifact["bytes"], "artifact_source": artifact["source"],
                        "source_prompt_digest": item["text_sha256"], "text_sha256_matches": True})
        if not args.dry_run:
            archive(inbox, item["path"])

    payload = state_payload(args.now, views, facts, history, args.max_applied)
    if not args.dry_run:
        write_state(state_path, payload)

    out = {"ok": not refused, "event": EVENT, "actor": ACTOR, "applied": applied, "duplicates": duplicates,
           "ledger_added": ledger_added, "refused": refused, "pending_seen": len(pending),
           "ledger": str(ledger_path), "state_file": str(state_path),
           "versions": {view: payload["views"][view]["revision"] for view in views},
           "latest": payload["latest"], "dry_run": bool(args.dry_run)}
    return emit(out, 1 if refused else 0)


if __name__ == "__main__":
    raise SystemExit(main())
