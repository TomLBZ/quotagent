"""tools/userplugin-record.py —— 用户空间插件的**唯一写账本者**（宿主不写账本 H1）。

干什么：消费 agent panel 提需求留下的待办件 + 用户空间里**已产出**的插件目录，落一条
`userplugin/created`（body 只出 ns/plugin/version/source_prompt_digest/artifact_sha256/bytes/schema，
**不含需求正文**）。幂等：同一 `(ns, plugin, artifact_sha256)` 只落一次。
产出不合法（manifest 缺失/非法 JSON/缺 name/version）→ 落 `userplugin/refused`（带 code + next_action）。

用法：
  python3 tools/userplugin-record.py --requests tmp/ui-shared/user-plugin-requests \\
      --user-space user-space --ledger tmp/ui-shared/user-plugin/ledger.jsonl \\
      --now 2026-09-21T15:00:00Z [--ns con-a] [--dry-run]

纪律（与 admin-apply.py 同规格）：用法错误在**构造 Ledger 之前**返回（拒绝时连空账本都不创建）；
`--now` 必填且为合法 ISO（不读墙钟）；stdout 恰一行 JSON；退出码 0/1/2。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def sha256_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def artifact_hash(plugin_dir: Path) -> tuple[str, int]:
    """产物哈希 = 目录下 (plugin.json, index.mjs) 逐文件 sha256 的规范化拼接（确定性、与 mtime 无关）。"""
    parts, total = [], 0
    for name in ("plugin.json", "index.mjs"):
        p = plugin_dir / name
        if p.exists():
            data = p.read_bytes()
            total += len(data)
            parts.append(f"{name}:{hashlib.sha256(data).hexdigest()}")
    return "sha256:" + hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest(), total


def read_requests(requests: Path, ns_filter: str | None) -> tuple[list[dict], list[dict]]:
    """读待办件；**同时读 `applied/`**：已消费过的条目要能被认出来（否则重跑只会报告"没东西"，
    看不出幂等 —— 幂等必须是可观察的事实，不是默认假设）。"""
    items, refused = [], []
    if not requests.exists():
        return items, refused
    candidates = [(p, False) for p in sorted(requests.glob("*.json"))]
    candidates += [(p, True) for p in sorted((requests / "applied").glob("*.json"))]
    for p, consumed in candidates:
        if not p.is_file():
            continue
        try:
            if re.search(r"[^0-7]", oct(p.stat().st_mode)[-3:]) and (p.stat().st_mode & 0o077):
                refused.append({"file": p.name, "reason": "权限不是 0600（待办件必须是私密件）"})
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            refused.append({"file": p.name, "reason": f"待办件不可读：{type(exc).__name__}"})
            continue
        if not isinstance(data, dict) or data.get("kind") != "plugin-request":
            refused.append({"file": p.name, "reason": "不是 plugin-request"})
            continue
        ns = str(data.get("ns") or "")
        if ns_filter and ns != ns_filter:
            continue
        digest = sha256_text(str(data.get("description") or ""))
        if data.get("description_sha256") and data["description_sha256"] != digest:
            refused.append({"file": p.name, "reason": "需求正文与其 sha256 不一致（自述不可信）"})
            continue
        items.append({"file": p.name, "path": p, "ns": ns, "digest": digest, "consumed": consumed})
    return items, refused


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="消费用户空间插件需求待办件，落 userplugin/created（唯一写账本者）")
    ap.add_argument("--requests", required=True)
    ap.add_argument("--user-space", required=True)
    ap.add_argument("--ledger", required=True)
    ap.add_argument("--now", required=True)
    ap.add_argument("--ns", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not args.now or not ISO_RE.match(args.now):
        return emit({"ok": False, "refused": [{"file": None, "reason": "用法拒绝：--now 必填且为合法 ISO8601"}],
                     "ledger_added": 0, "applied": [], "duplicates": []}, 2)
    requests_dir, user_space = Path(args.requests), Path(args.user_space)
    if not requests_dir.is_dir():
        return emit({"ok": False, "refused": [{"file": None, "reason": f"--requests 不是目录：{requests_dir}"}],
                     "ledger_added": 0, "applied": [], "duplicates": []}, 2)
    if not user_space.is_dir():
        return emit({"ok": False, "refused": [{"file": None, "reason": f"--user-space 不是目录：{user_space}"}],
                     "ledger_added": 0, "applied": [], "duplicates": []}, 2)

    items, refused = read_requests(requests_dir, args.ns or None)
    ledger_path = Path(args.ledger)
    ledger = Ledger(ledger_path, realm="user-space")
    seen = set()
    for row in ledger.read(type="userplugin/created"):
        body = row.get("body") or {}
        seen.add((str(body.get("ns")), str(body.get("plugin")), str(body.get("artifact_sha256"))))

    applied, duplicates = [], []
    for item in items:
        ns_dir = user_space / item["ns"]
        plugins = sorted((p.parent.name, p) for p in ns_dir.glob("*/plugin.json")) if ns_dir.is_dir() else []
        if not plugins:
            refused.append({"file": item["file"], "reason": f"没有产出：{ns_dir}/*/plugin.json 不存在"})
            continue
        for name, manifest_path in plugins:
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                payload = {"ns": item["ns"], "plugin": name, "code": "manifest-invalid", "schema": 1}
                if not args.dry_run:
                    ledger.append("userplugin/refused", payload, correlation_id=f"up-refuse-{item['ns']}-{name}")
                refused.append({"file": item["file"], "reason": f"{name}: manifest-invalid"})
                continue
            version = str(manifest.get("version") or "")
            if not manifest.get("name") or not version:
                if not args.dry_run:
                    ledger.append("userplugin/refused", {"ns": item["ns"], "plugin": name,
                                                         "code": "manifest-invalid", "schema": 1},
                                  correlation_id=f"up-refuse-{item['ns']}-{name}")
                refused.append({"file": item["file"], "reason": f"{name}: 缺 name/version"})
                continue
            ahash, nbytes = artifact_hash(manifest_path.parent)
            key = (item["ns"], name, ahash)
            if key in seen:
                duplicates.append({"ns": item["ns"], "plugin": name, "artifact_sha256": ahash})
                continue
            body = {"ns": item["ns"], "plugin": name, "version": version,
                    "source_prompt_digest": item["digest"], "artifact_sha256": ahash, "bytes": nbytes, "schema": 1}
            if not args.dry_run:
                ledger.append("userplugin/created", body, correlation_id=f"up-created-{item['ns']}-{name}")
                seen.add(key)
            applied.append({"ns": item["ns"], "plugin": name, "event": "userplugin/created", "artifact_sha256": ahash})

    if not args.dry_run and applied:
        applied_dir = requests_dir / "applied"
        applied_dir.mkdir(parents=True, exist_ok=True)
        for item in items:
            if item.get("consumed"):
                continue
            try:
                item["path"].rename(applied_dir / item["path"].name)
            except OSError:
                pass

    return emit({"ok": not refused or bool(applied), "applied": applied, "duplicates": duplicates,
                 "refused": refused, "ledger_added": 0 if args.dry_run else len(applied),
                 "ledger_path": str(ledger_path), "dry_run": bool(args.dry_run)}, 0 if applied or duplicates else 1)


if __name__ == "__main__":
    raise SystemExit(main())
