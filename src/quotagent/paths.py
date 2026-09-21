"""路径解析：仓库根、证据目录、临时目录。

不写仓库外的文件：临时目录默认落在仓库内 `tmp/`（`.gitignore` 已忽略），
仅在仓库不可写时退回系统临时目录。
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

_MARKERS = (("tools", "verify.sh"), ("docs", "work"))


def repo_root(start: Path | None = None) -> Path:
    """仓库根：$QUOTAGENT_ROOT → 从本文件上溯找到 tools/verify.sh + docs/work → 当前工作目录。"""
    env = os.environ.get("QUOTAGENT_ROOT")
    if env:
        candidate = Path(env).expanduser()
        if _is_repo(candidate):
            return candidate.resolve()
    origin = (start or Path(__file__)).resolve()
    for parent in [origin] + list(origin.parents):
        if _is_repo(parent):
            return parent
    return Path.cwd().resolve()


def _is_repo(path: Path) -> bool:
    for parts in _MARKERS:
        candidate = path
        for part in parts:
            candidate = candidate / part
        if not candidate.exists():
            return False
    return True


def evidence_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / "docs" / "work" / "evidence"


def src_dir(root: Path | None = None) -> Path:
    return (root or repo_root()) / "src"


def scratch_root(root: Path | None = None) -> Path:
    base = Path(os.environ.get("QUOTAGENT_TMP") or ((root or repo_root()) / "tmp"))
    try:
        base.mkdir(parents=True, exist_ok=True)
        probe = base / ".write-probe"
        probe.write_text("", encoding="utf-8")
        probe.unlink()
        return base
    except OSError:
        return Path(tempfile.mkdtemp(prefix="quotagent-"))


def new_scratch(prefix: str, root: Path | None = None) -> Path:
    """新建一个一次性目录（AC 执行用，绝对路径）。

    创建出来的目录会被登记，AC 运行结束由 `qa.registry` 统一清理（AGENTS.md：临时产物
    只能落 `tmp/` 且**用完自己清理**）。D-072 起文档门**不扫** `tmp/`（临时副本不是契约文档，
    见 `tools/check-docs.py` 的 SCAN_EXCLUDE_DIRS），所以这里不再需要靠清理来保住门的确定性；
    清理仍是纪律：一次性树不该留给别的门/轮次。
    """
    base = scratch_root(root) / "ac"
    base.mkdir(parents=True, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=str(base)))
    _SCRATCH_DIRS.add(path)
    return path


_SCRATCH_DIRS: set[Path] = set()


def cleanup_scratch() -> list[Path]:
    """删除本次进程创建的所有一次性目录（幂等；返回实际删掉的路径）。"""
    removed: list[Path] = []
    for path in sorted(_SCRATCH_DIRS, key=lambda item: len(str(item)), reverse=True):
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path)
        _SCRATCH_DIRS.discard(path)
    return removed
