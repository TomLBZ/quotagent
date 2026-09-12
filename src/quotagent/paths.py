"""路径解析：仓库根、证据目录、临时目录。

不写仓库外的文件：临时目录默认落在仓库内 `tmp/`（`.gitignore` 已忽略），
仅在仓库不可写时退回系统临时目录。
"""

from __future__ import annotations

import os
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
    """新建一个一次性目录（AC 执行用，绝对路径，调用方负责清理）。"""
    base = scratch_root(root) / "ac"
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=f"{prefix}-", dir=str(base)))
