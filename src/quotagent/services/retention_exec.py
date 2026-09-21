"""services/retention_exec.py —— 留存**执行侧**（T-253 / FR-EVIDENCE-004 / AC-AUDIT-003）。

本文件是本项目**第一段能删东西的代码**，所以判据的顺序是「安全 > 功能」：宁可拒绝，不可越界。

规则集（`docs/design/adr/0018-retention-and-destruction-boundary.md`，逐条落地）：

- **账本行永不销毁**：执行器只处理派生副本；计划项若自称账本行（`ledger_row` 为真或
  `kind=ledger-row`），即使计划判了 `purge-copy` 也一律拒绝（`reason=ledger-row`）。
  判定器已拦一层，这里是第二层（执行侧不因为「上游已经判过」就少查一遍）。
- **只动 root 内的东西**：`root` 必须由调用方**显式**传入（没有默认值，不允许默认当前目录），
  目标经 `Path.resolve()` 后必须严格落在 root 之内：`../`、绝对路径逃逸、符号链接逃逸一律拒绝
  （`reason=path-outside-root`）。越界与缺批准**不抛异常**，而是逐条计入 `refused`
  （计划里的坏项不该让整批停摆），异常只用于「用错 API」（`resolve_within_root` / `require_approval` /
  `assert_readable`）。
- **不可重建物必须过人工门**：计划项带 `approval_required` 时，`approved_refs` 给出的引用必须是
  **能在账本（或 `approvals`）里核出的**、由 `human:` 决定、scope 适用、ref 绑定的 `granted` 记录。
  引用本身不是批准（agent 不得代签；没有超时自动批准）。
  scope 取值域同时接受 ADR-0018 的 `retention.destroy` 与判定器 `retention.py` 给出的
  `evidence.purge-copy` / `evidence.archive`——两侧词汇表都认，但**别的 scope 一律不认**。
- **留痕只出计数与哈希**：`evidence/retention-copy-purged` 的 body **只有** `{target, sha256, bytes}`，
  不含被销毁内容（ADR-0018 §1.5：留痕不得复活被销毁数据）。
- **归档一次成型**：归档写 `root/archive/<name>.tar`（仅标准库 `tarfile`；mtime/uid/gid/uname 归零，
  内容对同一输入决定性）。已存在的归档包**永不重写**：内容一致 → 计 `skipped`（`already-archived`），
  内容不一致 → 拒绝（`archive-conflict`）。
  **归档不删源**：删除只由计划里的 `purge-copy` 项触发；目录、符号链接、非常规文件一律不删也不归档。
- **读侧封存**：`is_sealed()` / `assert_readable()` 从账本重建「已销毁」集合——销毁过的目标不可再读
  （`TargetSealed`），且不因文件被后来重建而复活。
- **不读墙钟、不用随机**：`render()` 走 canonical JSON，同输入两次字节一致；结果里没有时间戳、
  没有自增序号。（账本行自己的 `ts` 由 `Ledger.append` 写，那是账本的责任。）
- **root 不是仓库根**：`root` 指向仓库根或仓库的 `src/` `docs/` `tools/` `host/` `.git/` `.agents/`
  一律构造失败——执行器只允许在仓库 `tmp/` 下或仓库外的独立根上动作（`AGENTS.md`：不写仓库根/不动 `src/`）。

调用约定（判定器只算不执行，路径得由调用方给）：

- 计划项按 `path` / `target_path` / `target` / `file` / `copy` 取目标；都没有时退回用 `id`
  作为 **root 下的相对名**定位派生副本（判定器的 items 里只有 `object`/`id`，没有路径——
  执行器不猜目录，只认「root 下的这个名字」）。
- 宿主也可以先把判定器的 items 与真实路径对应好再交给执行器：
  `[{**item, "path": paths[item["id"]]} for item in plan["items"]]`——两种都支持，
  但「哪个 id 对应哪个文件」永远由调用方决定，不由执行器推断。
- `execute()` 接受 `retention.plan()` 的结果（读其中的 `items`，`keep` 一律跳过），
  也接受逐项清单（`list`）。

已知窗口（如实登记，不假装没有）：

- 顺序是**先删后记**（契约如此：成功销毁后才落 `purge` 事件）。删除与 `append` 之间进程被杀，
  会出现「文件没了、账本没有那一行」。缓解：每个不可逆动作前先 `assert_healthy()` 前置检查账本可写，
  且 `append` 失败时把该目标计入结果的 `untraced`（可见，而非静默）。
- `Ledger.append` 对 `(correlation_id, type, body_hash)` 去重（FR-LEDGER-004）：同一路径、同一内容
  再次销毁**不会新增行**；该情形在结果里标 `ledger_duplicate`，`events_written` 只数真正新增的行。
- `dry_run=True` 时 `purged`/`archived` 列出的是「**会**被销毁/归档」的项（`applied=False`），
  `counts.purged`/`counts.archived` 只数**真正执行**的，另有 `counts.would_purge` / `counts.would_archive`。
"""

from __future__ import annotations

import hashlib
import os
import re
import tarfile
from pathlib import Path

from ..kernel.canon import HASH_PREFIX, canonical_json
from .retention import ARCHIVE, KEEP, LEDGER_ROW, PURGE_COPY

# 唯一允许落的两条留痕事件（`kernel/events.py` 已声明为 emit/fact；写错名字即门红）
PURGE_EVENT = "evidence/retention-copy-purged"
ARCHIVE_EVENT = "evidence/retention-archived"
EVENTS = (PURGE_EVENT, ARCHIVE_EVENT)
# 计划里会真正动文件的两个动作（keep 一律跳过）
ACTIONABLE = (PURGE_COPY, ARCHIVE)
# 人工门 scope 取值域（两侧词汇表都认；别的 scope 不认）
APPROVAL_SCOPES = {
    PURGE_COPY: ("retention.destroy", "evidence.purge-copy"),
    ARCHIVE: ("retention.destroy", "evidence.archive"),
}
APPROVAL_REF_RE = re.compile(r"^ap-\d{4,}$")
HUMAN_PREFIX = "human:"
APPROVAL_EVENT_PREFIX = "approval/"
# 计划项里可能出现的「目标路径」键（判定器不读它们，执行侧才认）
PATH_KEYS = ("path", "target_path", "target", "file", "copy")
ARCHIVE_DIRNAME = "archive"
CHUNK = 65536
ACTOR = "agent:retention-exec"

# 拒绝/跳过原因（原因码是规格的一部分：写死成常量，别让调用方去猜字符串）
R_PATH_OUTSIDE = "path-outside-root"
R_APPROVAL_MISSING = "approval-missing"
R_LEDGER_ROW = "ledger-row"
R_SYMLINK = "symlink-refused"
R_NOT_REGULAR = "not-a-regular-file"
R_MISSING_TARGET = "missing-target"
R_UNKNOWN_ACTION = "unknown-action"
R_INVALID_ITEM = "invalid-item"
R_ARCHIVE_CONFLICT = "archive-conflict"
R_ARCHIVE_FAILED = "archive-write-failed"
R_DELETE_FAILED = "delete-failed"
R_LEDGER_UNAVAILABLE = "ledger-unavailable"
S_ALREADY_ABSENT = "already-absent"
S_ALREADY_ARCHIVED = "already-archived"

NOTE = ("执行侧：只动 root 内、只删派生副本（账本行永不销毁）、只在 root/archive/ 下写归档包、"
        "删前先查人工门与账本可写；留痕只出计数与哈希；不读墙钟、不产生批准（无超时自动批准）")

_REPO_MARKERS = (("tools", "verify.sh"), ("docs", "work"))
# 这些目录在仓库内属于「不是执行器该动的地方」（tmp/ 与仓库外的独立根才是允许的）
_FORBIDDEN_UNDER_REPO = ("src", "docs", "tools", "host", ".git", ".agents")


class RetentionExecutionError(Exception):
    """执行侧错误基类（用错 API / 环境不满足前置条件）。"""


class PathOutsideRoot(RetentionExecutionError):
    """目标解析后落在 root 之外（`../`、绝对路径逃逸、符号链接逃逸）：拒绝。"""


class ApprovalMissing(RetentionExecutionError):
    """不可重建物的销毁/归档缺有效人工门：拒绝。"""


class TargetSealed(RetentionExecutionError):
    """目标已封存（账本里有销毁留痕）：不可再读。"""


class RetentionExecutor:
    """留存执行器：删派生副本 + 归档 + 读侧封存 + 账本落痕，**严格限根**。

    构造：
        RetentionExecutor(ledger, root=..., approved_refs={"id:pack-014": "ap-0001"},
                          approvals=None, dry_run=False)

    - `ledger`：必须有 `append()`（唯一写入口）与 `read()`（重建批准与封存集合）；
    - `root`：唯一允许操作的根，**必须显式传入**（关键字参数，无默认值）；
    - `approved_refs`：条目 id/seq/object → 人工门引用 `ap-NNNN`（引用**不是**批准，须能核出 granted 记录）；
    - `approvals`：可选的批准记录来源（`{ap-NNNN: record}` 或带 `get()` 的对象，如 `ApprovalService`）；
      不给则只信账本重放；
    - `dry_run=True`：只报告不动作（不删、不归档、不建目录、不写账本）。
    """

    def __init__(self, ledger, *, root, approved_refs=None, approvals=None, dry_run=False) -> None:
        if ledger is None:
            raise RetentionExecutionError("必须显式传入账本：没有留痕就不执行销毁（FR-EVIDENCE-004）")
        for name in ("append", "read"):
            if not callable(getattr(ledger, name, None)):
                raise RetentionExecutionError(
                    f"账本必须提供 {name}()：append 是唯一写入口，read 用于重建批准记录与封存集合")
        if root is None:
            raise RetentionExecutionError("必须显式传入 root：不允许默认当前目录（那是把整棵工作区交出去）")
        if isinstance(root, bool) or not isinstance(root, (str, os.PathLike)):
            raise RetentionExecutionError(f"root 必须是路径（Path/str），收到 {type(root).__name__}")
        given = os.fspath(root)
        if not str(given).strip():
            raise RetentionExecutionError("root 不能是空字符串")
        self.root = Path(given).expanduser().resolve()
        if self.root.exists() and not self.root.is_dir():
            raise RetentionExecutionError(f"root 必须是目录，收到 {self.root}")
        _forbid_repository_root(self.root)

        self.ledger = ledger
        self.approved_refs = dict(approved_refs or {})
        self.approvals = approvals
        self.dry_run = bool(dry_run)

    # --- 路径（唯一放行口） ------------------------------------------------
    def resolve_within_root(self, target, *, label: str = "target") -> Path:
        """把目标解析成 root 内的绝对路径；任何逃逸抛 `PathOutsideRoot`。

        判据顺序（每一条都要过）：非空、无 `..` 分量、解析后**严格**位于 root 之内。
        `resolve()` 会跟随符号链接，所以「链接指向 root 外」和「绝对路径跳出 root」都被这一条拦下。
        """
        text = _as_text(target, label)
        if not text:
            raise PathOutsideRoot(f"{label} 为空：拒绝（空路径会被解析成 root/当前目录）")
        candidate = Path(text).expanduser()
        if ".." in candidate.parts:
            raise PathOutsideRoot(f"{label} 含 `..` 分量（{text!r}）：拒绝（相对跳转是逃逸的常见形式）")
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            resolved = candidate.resolve()
        except OSError as exc:  # 符号链接环等
            raise PathOutsideRoot(f"{label} 无法解析（{text!r}）：{exc}") from exc
        if self.root not in resolved.parents:
            raise PathOutsideRoot(
                f"{label} 解析后落在 root 之外：{resolved} 不在 {self.root} 之内"
                f"（绝对路径/符号链接/`..` 都不能把操作带出唯一允许的根）")
        return resolved

    def is_inside_root(self, target) -> bool:
        try:
            self.resolve_within_root(target)
            return True
        except RetentionExecutionError:
            return False

    # --- 读侧封存（从账本重建） -------------------------------------------
    def sealed_entries(self) -> list:
        """账本里的销毁留痕（逐条 `{target, sha256, bytes}`）；账本是唯一事实源，重启后照样重建。"""
        rows = []
        for record in self._ledger_rows():
            if record.get("type") != PURGE_EVENT:
                continue
            body = record.get("body") or {}
            target = body.get("target")
            if not isinstance(target, str) or not target:
                continue
            rows.append({"target": target, "sha256": body.get("sha256"), "bytes": body.get("bytes")})
        return rows

    def sealed_targets(self) -> list:
        """已封存目标的规范化清单（排序，便于机检/展示）。"""
        return sorted(self._sealed_keys())

    def is_sealed(self, target) -> bool:
        """目标是否已被销毁（销毁过的目标不可再读；文件被重建也不复活）。"""
        keys = self._sealed_keys()
        if not keys:
            return False
        return bool(self._input_keys(target) & keys)

    def assert_readable(self, target) -> None:
        """读侧前置检查：越界抛 `PathOutsideRoot`，已封存抛 `TargetSealed`，否则静默返回。"""
        resolved = self.resolve_within_root(target, label="要读的目标")
        if self.is_sealed(target) or self.is_sealed(resolved):
            raise TargetSealed(
                f"目标已封存（账本里有 {PURGE_EVENT} 留痕，可复核哈希）：不可再读 {resolved}")
        return None

    # --- 人工门（引用不是批准） -------------------------------------------
    def require_approval(self, item) -> dict:
        """计划项的人工门校验：有效则返回 `{approval_id, detail}`，否则抛 `ApprovalMissing`。"""
        if not isinstance(item, dict):
            raise RetentionExecutionError(f"计划项必须是对象，收到 {type(item).__name__}")
        action = item.get("action")
        if action not in ACTIONABLE:
            raise RetentionExecutionError(f"人工门只适用于 {list(ACTIONABLE)}，收到 action={action!r}")
        ok, ref, detail = self._approval_state(item, action)
        if not ok:
            raise ApprovalMissing(
                f"动作 {action!r}（对象 {item.get('object')!r}）缺有效人工门：{detail}；"
                f"不可重建物的销毁/归档必须由人批准（ADR-0018 §1.3，scope=retention.destroy），"
                f"本执行器不产生批准、也没有超时自动批准")
        return {"approval_id": ref, "detail": detail}

    # --- 执行（唯一的动作入口） -------------------------------------------
    def execute(self, plan) -> dict:
        """按计划执行：只处理 `action=purge-copy/archive` 的项，`keep` 一律跳过。

        返回 `{purged, archived, skipped, refused, events_written, counts, dry_run, note, ...}`；
        `purged`/`archived`/`skipped`/`refused` 是**逐项明细**（含 target 与原因），`counts` 是计数。
        越界、缺批准、账本行、非常规文件都不抛异常而是逐条拒绝；异常留给「用错 API」。
        """
        items = _plan_items(plan)
        purged, archived, skipped, refused, events, untraced = [], [], [], [], [], []
        events_written = 0
        keep = 0
        for index, raw in enumerate(items):
            if not isinstance(raw, dict):
                refused.append(self._row(index, None, None, R_INVALID_ITEM,
                                         f"计划项必须是对象，收到 {type(raw).__name__}"))
                continue
            action = raw.get("action")
            if action == KEEP or action is None:
                keep += 1
                continue
            if action not in ACTIONABLE:
                refused.append(self._row(index, raw, None, R_UNKNOWN_ACTION,
                                         f"执行侧只处理 {list(ACTIONABLE)}，收到 action={action!r}"))
                continue
            if _is_ledger_row(raw):
                refused.append(self._row(index, raw, None, R_LEDGER_ROW,
                                         "账本行永不销毁/不移出账本（FR-LEDGER-001，ADR-0018 §1.1）："
                                         "执行侧第二次拦截"))
                continue
            text = self._target_of(raw)
            if text is None:
                refused.append(self._row(index, raw, None, R_MISSING_TARGET,
                                         "计划项没给可定位的目标（path/… 或 id）：宁可不动"))
                continue
            try:
                resolved = self.resolve_within_root(text)
            except PathOutsideRoot as exc:
                refused.append(self._row(index, raw, text, R_PATH_OUTSIDE, str(exc)))
                continue
            if self._raw_candidate(text).is_symlink():
                refused.append(self._row(index, raw, text, R_SYMLINK,
                                         "目标是符号链接：不删不移（删除链接与删除目标不是一回事）"))
                continue
            approval_id = None
            if raw.get("approval_required"):
                ok, ref, detail = self._approval_state(raw, action)
                if not ok:
                    refused.append(self._row(index, raw, text, R_APPROVAL_MISSING, detail))
                    continue
                approval_id = ref
            if not self.dry_run:
                try:
                    self._ledger_ready()
                except RetentionExecutionError as exc:
                    refused.append(self._row(index, raw, text, R_LEDGER_UNAVAILABLE, str(exc)))
                    continue
            row = self._row(index, raw, text, None, None, resolved=resolved, approval_id=approval_id)
            if action == PURGE_COPY:
                written = self._purge(row, resolved, raw, approval_id, purged, skipped, refused,
                                      events, untraced)
            else:
                written = self._archive(row, resolved, raw, approval_id, archived, skipped, refused,
                                        events, untraced)
            events_written += written
        counts = {
            "considered": len(items),
            "keep": keep,
            PURGE_COPY: sum(1 for row in purged if row.get("action") == PURGE_COPY)
                        + sum(1 for row in skipped + refused if row.get("action") == PURGE_COPY),
            ARCHIVE: sum(1 for row in archived if row.get("action") == ARCHIVE)
                     + sum(1 for row in skipped + refused if row.get("action") == ARCHIVE),
            "purged": sum(1 for row in purged if row.get("applied")),
            "archived": sum(1 for row in archived if row.get("applied")),
            "would_purge": len(purged),
            "would_archive": len(archived),
            "skipped": len(skipped),
            "refused": len(refused),
            "events_written": events_written,
            "untraced": len(untraced),
            "skipped_reasons": _tally(row.get("reason") for row in skipped),
            "refused_reasons": _tally(row.get("reason") for row in refused),
        }
        return {
            "root": str(self.root),
            "dry_run": self.dry_run,
            "counts": counts,
            "purged": purged,
            "archived": archived,
            "skipped": skipped,
            "refused": refused,
            "events": events,
            "events_written": events_written,
            "untraced": untraced,
            "ledger_rows_destroyed": 0,
            "note": NOTE,
        }

    def render(self, result) -> str:
        """确定性序列化（canonical JSON）：同一输入两次**字节一致**（没有时间戳、没有自增序号）。"""
        return canonical_json(result)

    # --- 动作 -------------------------------------------------------------
    def _purge(self, row, resolved, item, approval_id, purged, skipped, refused, events, untraced) -> int:
        if not resolved.exists():
            skipped.append({**row, "reason": S_ALREADY_ABSENT, "detail": "目标不存在：幂等跳过，不报错"})
            return 0
        if not resolved.is_file():
            refused.append({**row, "reason": R_NOT_REGULAR,
                            "detail": f"不是常规文件（{_kind_of(resolved)}）：执行器不递归删目录、不动特殊文件"})
            return 0
        sha, size = _hash_file(resolved)
        if self.dry_run:
            purged.append({**row, "applied": False, "sha256": sha, "bytes": size,
                           "reason": "dry-run：只报告，不动作"})
            return 0
        try:
            resolved.unlink()
        except OSError as exc:
            refused.append({**row, "reason": R_DELETE_FAILED, "sha256": sha, "bytes": size,
                            "detail": f"删除失败：{type(exc).__name__}: {exc}"})
            return 0
        body = {"target": str(resolved), "sha256": sha, "bytes": size}
        try:
            ref = self._append(PURGE_EVENT, body, item=item, approval_ref=approval_id)
        except Exception as exc:  # noqa: BLE001 —— 删已发生、痕没落：必须可见，绝不静默
            untraced.append({"target": str(resolved), "sha256": sha, "bytes": size, "event": PURGE_EVENT,
                             "detail": f"销毁已发生但留痕失败：{type(exc).__name__}: {exc}"})
            return 0
        duplicate = bool(getattr(ref, "duplicate", False))
        events.append({"type": PURGE_EVENT, "target": str(resolved), "duplicate": duplicate})
        purged.append({**row, "applied": True, "sha256": sha, "bytes": size, "ledger_duplicate": duplicate,
                       "reason": "已销毁派生副本并留痕（留痕只出计数与哈希）"})
        return 0 if duplicate else 1

    def _archive(self, row, resolved, item, approval_id, archived, skipped, refused, events, untraced) -> int:
        if not resolved.exists():
            skipped.append({**row, "reason": S_ALREADY_ABSENT, "detail": "目标不存在：幂等跳过，不报错"})
            return 0
        if not resolved.is_file():
            refused.append({**row, "reason": R_NOT_REGULAR,
                            "detail": f"不是常规文件（{_kind_of(resolved)}）：不归档目录/特殊文件"})
            return 0
        sha, size = _hash_file(resolved)
        archive_path = self.root / ARCHIVE_DIRNAME / (resolved.name + ".tar")
        if archive_path.exists():
            state = _archive_state(archive_path, sha, size)
            if state == "same":
                skipped.append({**row, "reason": S_ALREADY_ARCHIVED, "archive": str(archive_path),
                                "detail": "归档包已存在且内容一致：一次成型，永不重写"})
            else:
                refused.append({**row, "reason": R_ARCHIVE_CONFLICT, "archive": str(archive_path),
                                "detail": f"归档包已存在但内容不一致（{state}）：拒绝覆盖（ADR-0018 §1.6）"})
            return 0
        if self.dry_run:
            archived.append({**row, "applied": False, "sha256": sha, "bytes": size,
                             "archive": str(archive_path), "reason": "dry-run：只报告，不动作"})
            return 0
        try:
            _write_tar(archive_path, resolved, sha, size)
        except (OSError, tarfile.TarError, ValueError) as exc:
            refused.append({**row, "reason": R_ARCHIVE_FAILED, "archive": str(archive_path),
                            "detail": f"写归档包失败：{type(exc).__name__}: {exc}"})
            return 0
        body = {"target": str(resolved), "sha256": sha, "bytes": size}
        try:
            ref = self._append(ARCHIVE_EVENT, body, item=item, approval_ref=approval_id,
                               extra_refs={"archive": str(archive_path)})
        except Exception as exc:  # noqa: BLE001 —— 包已写、痕没落：必须可见
            untraced.append({"target": str(resolved), "sha256": sha, "bytes": size, "event": ARCHIVE_EVENT,
                             "archive": str(archive_path),
                             "detail": f"归档已落盘但留痕失败：{type(exc).__name__}: {exc}"})
            return 0
        duplicate = bool(getattr(ref, "duplicate", False))
        events.append({"type": ARCHIVE_EVENT, "target": str(resolved), "duplicate": duplicate})
        archived.append({**row, "applied": True, "sha256": sha, "bytes": size, "archive": str(archive_path),
                         "ledger_duplicate": duplicate,
                         "reason": "已封进 root/archive/ 的归档包并留痕（不删源：删除只由 purge-copy 触发）"})
        return 0 if duplicate else 1

    # --- 人工门内部 -------------------------------------------------------
    def _approval_state(self, item, action) -> tuple:
        """返回 (ok, ref, detail)：引用 → 是否能在账本/approvals 里核出「人批准的、scope 适用的」记录。"""
        keys = self._alias_keys(item)
        raw = None
        for key in keys:
            if key in self.approved_refs:
                raw = self.approved_refs[key]
                break
        if raw is None:
            return False, None, "approved_refs 里没有这一条目的批准引用（无引用＝无门）"
        if not isinstance(raw, str) or not APPROVAL_REF_RE.match(raw.strip()):
            return False, None, f"批准引用格式非法（须 ap-NNNN 形，不做修补）：{raw!r}"
        ref = raw.strip()
        record = self._approval_record(ref)
        if record is None:
            return False, ref, f"账本/approvals 里核不出 {ref} 的记录——引用不是批准，不认"
        status = record.get("status")
        if status != "granted":
            return False, ref, f"{ref} 当前状态 {status!r}（未批准；不存在超时自动批准）"
        by = str(record.get("decided_by") or "")
        if not by.startswith(HUMAN_PREFIX):
            return False, ref, f"{ref} 的决定人 {by!r} 不是 human:（agent 不得代签）"
        scope = record.get("scope")
        if scope not in APPROVAL_SCOPES[action]:
            return False, ref, (f"{ref} 的 scope={scope!r} 不适用于 {action!r}"
                                f"（需 {list(APPROVAL_SCOPES[action])}）；批准不可跨动作复用")
        bound = record.get("ref")
        if bound is not None and str(bound) not in keys:
            return False, ref, f"{ref} 绑定 ref={bound!r}，与条目 {item.get('object')!r} 不匹配"
        return True, ref, f"ok（{ref}，scope={scope!r}，decided_by={by!r}）"

    def _approval_record(self, ref: str):
        if self.approvals is not None:
            getter = getattr(self.approvals, "get", None)
            if callable(getter):
                try:
                    found = getter(ref)
                except Exception:  # noqa: BLE001 —— ApprovalService.get 对未知 id 抛错，按「核不出」处理
                    found = None
                if isinstance(found, dict):
                    return dict(found)
        records: dict = {}
        for row in self._ledger_rows():
            if not str(row.get("type") or "").startswith(APPROVAL_EVENT_PREFIX):
                continue
            body = row.get("body") or {}
            approval_id = body.get("approval_id")
            if not approval_id:
                continue
            record = dict(body)
            record.setdefault("status", "pending")
            records[approval_id] = record      # 账本顺序即事实顺序，后者覆盖前者
        return records.get(ref)

    def _alias_keys(self, item) -> tuple:
        """条目的可寻址键（object 优先，其次裸 id / seq 的两种写法）。"""
        out = []
        for key in (item.get("object"), item.get("id"), item.get("seq")):
            if key is None:
                continue
            text = str(key)
            out.append(text)
            if text != f"id:{text}":
                out.append(f"id:{text}")
            if text.isdigit():
                out.append(f"seq:{text}")
        seen = []
        for text in out:
            if text not in seen:
                seen.append(text)
        return tuple(seen)

    # --- 内部 -------------------------------------------------------------
    def _target_of(self, item):
        for key in PATH_KEYS:
            value = item.get(key)
            if isinstance(value, (str, os.PathLike)) and str(value).strip():
                return str(value)
        ident = item.get("id")
        if isinstance(ident, str) and ident.strip():
            return ident.strip()        # 计划项只有 id 时，按 root 下的相对名定位派生副本
        return None

    def _raw_candidate(self, text: str) -> Path:
        candidate = Path(text).expanduser()
        return candidate if candidate.is_absolute() else self.root / candidate

    def _row(self, index, item, target, reason, detail, *, resolved=None, approval_id=None) -> dict:
        item = item or {}
        return {
            "index": index,
            "action": item.get("action"),
            "object": item.get("object"),
            "kind": item.get("kind"),
            "target": target,
            "resolved": None if resolved is None else str(resolved),
            "approval_required": bool(item.get("approval_required")),
            "approval_id": approval_id,
            "reason": reason,
            "detail": detail,
        }

    def _ledger_rows(self) -> list:
        rows = self.ledger.read()
        if not isinstance(rows, list):
            raise RetentionExecutionError(f"账本 read() 必须返回事件列表，收到 {type(rows).__name__}")
        return rows

    def _sealed_keys(self) -> set:
        keys = set()
        for row in self.sealed_entries():
            keys |= self._input_keys(row["target"])
        return keys

    def _input_keys(self, target) -> set:
        try:
            text = _as_text(target, "要查的目标")
        except RetentionExecutionError:
            return set()
        keys = {text}
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            candidate = self.root / candidate
        try:
            keys.add(str(candidate.resolve()))
        except OSError:
            pass
        return keys

    def _ledger_ready(self) -> None:
        """不可逆动作前的账本前置检查（冻结/损坏的账本不得发起销毁：否则销毁会没有留痕）。"""
        assert_healthy = getattr(self.ledger, "assert_healthy", None)
        if callable(assert_healthy):
            try:
                assert_healthy()
            except Exception as exc:  # noqa: BLE001
                raise RetentionExecutionError(
                    f"账本不可写（{type(exc).__name__}: {exc}）：拒绝发起销毁（销毁必须有留痕）") from exc
            return
        if getattr(self.ledger, "healthy", True) is False or getattr(self.ledger, "frozen", False) is True:
            raise RetentionExecutionError("账本处于冻结状态：拒绝发起销毁（销毁必须有留痕）")

    def _append(self, event: str, body: dict, *, item: dict, approval_ref, extra_refs=None):
        if event not in EVENTS:
            raise RetentionExecutionError(f"未知留痕事件 {event!r}；只允许 {list(EVENTS)}")
        refs = {"object": item.get("object") or "", "kind": item.get("kind") or "", "action": item.get("action")}
        if approval_ref:
            refs["approval_id"] = approval_ref
        if extra_refs:
            refs.update({key: value for key, value in extra_refs.items() if value is not None})
        correlation = str(item.get("object") or body.get("target"))
        return self.ledger.append(event, body, correlation_id=correlation, event_class="fact",
                                  actor=ACTOR, refs=refs)


# --- 模块级工具 -----------------------------------------------------------
def _as_text(value, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, os.PathLike)):
        raise RetentionExecutionError(f"{label} 必须是路径字符串，收到 {type(value).__name__}")
    return os.fspath(value).strip()


def _is_ledger_row(item: dict) -> bool:
    kind = item.get("kind")
    return item.get("ledger_row") is True or kind == LEDGER_ROW


def _plan_items(plan) -> list:
    if isinstance(plan, dict):
        items = plan.get("items")
        if items is None:
            raise RetentionExecutionError(
                "plan 里没有 items：请把 retention.plan() 的结果（或逐项清单）交给执行器，不要递空计划")
        if not isinstance(items, list):
            raise RetentionExecutionError(f"plan['items'] 必须是列表，收到 {type(items).__name__}")
        return items
    if isinstance(plan, (list, tuple)):
        return list(plan)
    raise RetentionExecutionError(
        f"plan 必须是 retention.plan() 的结果（dict）或逐项清单（list），收到 {type(plan).__name__}")


def _hash_file(path: Path) -> tuple:
    """文件内容哈希（`sha256:<hex>`）与字节数；分块读，不整文件进内存。"""
    engine = hashlib.sha256()
    total = 0
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK), b""):
            engine.update(chunk)
            total += len(chunk)
    return HASH_PREFIX + engine.hexdigest(), total


def _write_tar(archive_path: Path, source: Path, sha: str, size: int) -> None:
    """一次成型地写归档包：先写同目录临时件，再 `os.replace`（不留半截的包）。

    归档条目只带内容与文件名；mtime/uid/gid/uname 归零，让同一输入的包内容决定性
    （内容哈希就是账本里的 `sha256`，用于事后核对）。
    """
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = archive_path.parent / (archive_path.name + ".part")
    info = tarfile.TarInfo(name=source.name)
    info.size = size
    info.mtime = 0
    info.mode = 0o644
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    try:
        with open(source, "rb") as handle, tarfile.open(tmp, "w") as tar:
            tar.addfile(info, handle)
        if _archive_state(tmp, sha, size) != "same":
            raise ValueError("归档包内容与源字节不一致（拒绝把不一致的包留下来）")
        os.replace(tmp, archive_path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _archive_state(archive_path: Path, sha: str, size: int) -> str:
    """归档包与预期内容的关系：same / different / shape / unreadable（不看时间、只比字节）。"""
    try:
        with tarfile.open(archive_path, "r") as tar:
            members = tar.getmembers()
            if len(members) != 1 or not members[0].isfile():
                return "shape"
            handle = tar.extractfile(members[0])
            if handle is None:
                return "unreadable"
            engine = hashlib.sha256()
            total = 0
            for chunk in iter(lambda: handle.read(CHUNK), b""):
                engine.update(chunk)
                total += len(chunk)
    except (tarfile.TarError, OSError, EOFError):
        return "unreadable"
    if total != size or HASH_PREFIX + engine.hexdigest() != sha:
        return "different"
    return "same"


def _kind_of(path: Path) -> str:
    if path.is_symlink():
        return "符号链接"
    if path.is_dir():
        return "目录"
    return "非常规文件"


def _tally(reasons) -> dict:
    out: dict = {}
    for reason in reasons:
        key = str(reason)
        out[key] = out.get(key, 0) + 1
    return {key: out[key] for key in sorted(out)}


def _repository_root(start: Path) -> Path | None:
    for parent in [start] + list(start.parents):
        if all((parent / Path(*parts)).exists() for parts in _REPO_MARKERS):
            return parent
    return None


def _forbid_repository_root(root: Path) -> None:
    repo = _repository_root(Path(__file__).resolve().parent)
    if repo is None:
        return
    if root == repo:
        raise RetentionExecutionError(
            f"root 不得是仓库根（{root}）：执行器只允许在仓库 tmp/ 下或仓库外的独立根上动作"
            f"（AGENTS.md：不在仓库根写文件）")
    for name in _FORBIDDEN_UNDER_REPO:
        forbidden = repo / name
        if root == forbidden or forbidden in root.parents:
            raise RetentionExecutionError(
                f"root 不得指向仓库的 {name}/（{root}）：执行器只允许在仓库 tmp/ 下或仓库外的独立根上动作")


__all__ = ["RetentionExecutor", "RetentionExecutionError", "PathOutsideRoot", "ApprovalMissing",
           "TargetSealed", "PURGE_EVENT", "ARCHIVE_EVENT", "EVENTS", "ACTIONABLE", "APPROVAL_SCOPES",
           "APPROVAL_REF_RE", "PATH_KEYS", "NOTE", "R_PATH_OUTSIDE", "R_APPROVAL_MISSING", "R_LEDGER_ROW",
           "R_SYMLINK", "R_NOT_REGULAR", "R_MISSING_TARGET", "R_UNKNOWN_ACTION", "R_INVALID_ITEM",
           "R_ARCHIVE_CONFLICT", "R_ARCHIVE_FAILED", "R_DELETE_FAILED", "R_LEDGER_UNAVAILABLE",
           "S_ALREADY_ABSENT", "S_ALREADY_ARCHIVED"]
