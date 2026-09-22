"""文件投递绑定（FR-INTEG-001 / ADR-0008）：命名约定 + 原子写（临时文件 + rename）。

- 命名：`<seq:06d>-<msg_id>.qep.json`，落在 `<root>/<participant>/inbox/`。
- 原子写：先写 `<最终名>.tmp` 并 fsync，再 `os.replace()` 到最终名——**半写文件永远不会以最终名出现**，
  因此读取方只需忽略 `*.tmp` 即不会读到半成品。
- 坏文件不静默丢弃：解析失败的文件被移入 `<root>/<participant>/rejected/` 并留下 `*.reason`。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from .canon import canonical_bytes

NAME_RE = re.compile(r"^(?P<seq>\d{6})-(?P<msg_id>[0-9A-Z]{26})\.qep\.json$")
TMP_SUFFIX = ".tmp"
REJECTED_SUFFIX = ".rejected"
REASON_SUFFIX = ".reason"


class DeliveryError(RuntimeError):
    """投递层错误。"""


class FileTransport:
    def __init__(self, root: str | os.PathLike, *, fsync: bool = True) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.fsync = fsync

    # --- 目录 -------------------------------------------------------------
    def inbox_dir(self, participant: str) -> Path:
        path = self.root / participant / "inbox"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def rejected_dir(self, participant: str) -> Path:
        path = self.root / participant / "rejected"
        path.mkdir(parents=True, exist_ok=True)
        return path

    # --- 命名 -------------------------------------------------------------
    def name_for(self, envelope: dict) -> str:
        return f"{int(envelope['seq']):06d}-{envelope['msg_id']}.qep.json"

    def final_path(self, envelope: dict, to: str) -> Path:
        return self.inbox_dir(to) / self.name_for(envelope)

    def final_exists(self, envelope: dict, to: str) -> bool:
        return self.final_path(envelope, to).exists()

    # --- 写入（原子） -----------------------------------------------------
    def stage(self, envelope: dict, *, to: str) -> Path:
        final = self.final_path(envelope, to)
        tmp = final.with_name(final.name + TMP_SUFFIX)
        data = canonical_bytes(envelope)
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            if self.fsync:
                os.fsync(fh.fileno())
        return tmp

    def commit(self, staged: str | os.PathLike, envelope: dict, *, to: str) -> Path:
        staged_path = Path(staged)
        if not staged_path.exists():
            raise DeliveryError(f"待提交的临时文件不存在: {staged_path}")
        final = self.final_path(envelope, to)
        os.replace(staged_path, final)
        if self.fsync:
            try:
                fd = os.open(final.parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            except OSError:
                pass
        return final

    def write(self, envelope: dict, *, to: str) -> Path:
        return self.commit(self.stage(envelope, to=to), envelope, to=to)

    # --- 读取 -------------------------------------------------------------
    def pending_paths(self, participant: str) -> list[Path]:
        """只认最终名（`*.qep.json`）；`*.tmp` 等半成品一律不进入候选。"""
        return sorted(p for p in self.inbox_dir(participant).glob("*.qep.json") if NAME_RE.match(p.name))

    def pending(self, participant: str) -> list[dict]:
        entries: list[dict] = []
        for path in self.pending_paths(participant):
            raw = path.read_bytes()
            try:
                envelope = json.loads(raw)
            except Exception as exc:  # noqa: BLE001 - 坏文件必须隔离并留原因
                self.quarantine(path, f"JSON 解析失败: {type(exc).__name__}: {exc}")
                continue
            match = NAME_RE.match(path.name)
            entries.append({
                "name": path.name,
                "path": path,
                "raw": raw,
                "envelope": envelope,
                "msg_id": envelope.get("msg_id") or (match.group("msg_id") if match else None),
                "seq": envelope.get("seq"),
            })
        return entries

    def quarantine(self, path: str | os.PathLike, reason: str) -> Path:
        src = Path(path)
        participant = src.parent.parent.name
        target_dir = self.rejected_dir(participant)
        target = target_dir / (src.name + REJECTED_SUFFIX)
        os.replace(src, target)
        (target_dir / (src.name + REASON_SUFFIX)).write_text(reason + "\n", encoding="utf-8")
        return target

    def rejected(self, participant: str) -> list[dict]:
        entries = []
        for reason_file in sorted(self.rejected_dir(participant).glob(f"*{REASON_SUFFIX}")):
            name = reason_file.name[: -len(REASON_SUFFIX)]
            entries.append({
                "name": name,
                "reason": reason_file.read_text(encoding="utf-8").strip(),
                "path": reason_file.parent / (name + REJECTED_SUFFIX),
            })
        return entries
