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
        # 归一化再比对：宿主与 Python 两侧对"前缀"的写法可能不同（`sha256:<hex>` vs `<hex>`），
        # 比对的是**同一个摘要**，不是同一个字面量。
        def norm(v: object) -> str:
            s = str(v or "").strip().lower()
            return s.split(":", 1)[1] if s.startswith("sha256:") else s
        if data.get("description_sha256") and norm(data["description_sha256"]) != norm(digest):
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
    ap.add_argument("--rollback", default="", help="回滚目标：`<ns>/<plugin>`（须与 --to-version 同时给）")
    ap.add_argument("--to-version", default="", help="回滚到的版本号（必须在该插件的历史里出现过）")
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

    if bool(args.rollback) != bool(args.to_version):
        return emit({"ok": False, "refused": [{"file": None, "reason": "--rollback 与 --to-version 必须同时给"}],
                     "ledger_added": 0, "applied": [], "duplicates": []}, 2)

    items, refused = ([], []) if args.rollback else read_requests(requests_dir, args.ns or None)
    ledger_path = Path(args.ledger)
    ledger = Ledger(ledger_path, realm="user-space")
    seen = set()          # 已记录的 (ns, plugin, artifact_sha256)：幂等闸
    history: dict[tuple[str, str], list[dict]] = {}   # (ns, plugin) → 版本历史（按 seq 升序）
    for row in ledger.read():
        typ = str(row.get("type"))
        if typ not in ("userplugin/created", "userplugin/upgraded", "userplugin/rolled-back"):
            continue
        body = row.get("body") or {}
        key = (str(body.get("ns")), str(body.get("plugin")))
        seen.add((key[0], key[1], str(body.get("artifact_sha256"))))
        history.setdefault(key, []).append({"seq": int(row.get("seq") or 0), "type": typ,
                                            "version": str(body.get("version") or ""),
                                            "artifact_sha256": str(body.get("artifact_sha256") or "")})

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
            prev = history.get((item["ns"], name)) or []
            prev_hash = prev[-1]["artifact_sha256"] if prev else ""
            if prev and prev[-1]["version"] == version:
                # **同一个版本号不能对应两个不同产物**：要么递增版本号，要么内容没变（那就是 duplicates）
                refused.append({"file": item["file"], "reason": f"版本号未递增（{version} 已存在且产物不同）："
                                "请先递增 plugin.json 的 version"})
                if not args.dry_run:
                    ledger.append("userplugin/refused", {"ns": item["ns"], "plugin": name,
                                                          "code": "version-not-bumped", "schema": 1},
                                  correlation_id=f"up-refuse-{item['ns']}-{name}-version-not-bumped")
                continue
            if prev:
                # **迭代**：同一插件换了一版（哈希不同）→ upgraded，并留下 prev 引用
                body = {"ns": item["ns"], "plugin": name, "version": version,
                        "prev_artifact_sha256": prev_hash, "artifact_sha256": ahash,
                        "source_prompt_digest": item["digest"], "bytes": nbytes, "schema": 1}
                event = "userplugin/upgraded"
                correlation = f"up-upgraded-{item['ns']}-{name}-{ahash.split(':')[-1][:12]}"
            else:
                body = {"ns": item["ns"], "plugin": name, "version": version,
                        "source_prompt_digest": item["digest"], "artifact_sha256": ahash, "bytes": nbytes, "schema": 1}
                event = "userplugin/created"
                correlation = f"up-created-{item['ns']}-{name}"
            if not args.dry_run:
                ledger.append(event, body, correlation_id=correlation)
                seen.add(key)
                history.setdefault((item["ns"], name), []).append(
                    {"seq": 0, "type": event, "version": version, "artifact_sha256": ahash})
            applied.append({"ns": item["ns"], "plugin": name, "event": event, "artifact_sha256": ahash,
                            "prev_artifact_sha256": prev_hash})


    # ---- 回滚（--rollback ns/plugin --to-version V）----
    # 铁律：**只有当磁盘内容的哈希等于目标版本的哈希**时才登记 `rolled-back`（账本不记不真的事）。
    rollback_result: dict | None = None
    if args.rollback:
        ns_name, _, plugin_name = args.rollback.partition("/")
        pdir = user_space / ns_name / plugin_name
        cur_hash, cur_bytes = artifact_hash(pdir) if pdir.is_dir() else ("", 0)
        hist = history.get((ns_name, plugin_name)) or []
        latest_hash = hist[-1]["artifact_sha256"] if hist else ""
        target = next((h for h in reversed(hist) if h["version"] == args.to_version), None)
        if not hist or not target:
            have = sorted({h["version"] for h in hist})
            rollback_result = {"ok": False, "code": "rollback-target-unknown",
                               "next_action": f"历史版本里没有 {args.to_version}（有：{have}）"}
        elif cur_hash == target["artifact_sha256"] and latest_hash == target["artifact_sha256"]:
            rollback_result = {"ok": False, "code": "rollback-noop", "next_action": "当前已经是目标版本"}
        elif cur_hash != target["artifact_sha256"] and cur_hash == latest_hash:
            rollback_result = {"ok": False, "code": "rollback-content-not-restored",
                               "next_action": f"先把 {args.to_version} 的产物写回目录（或让宿主从版本快照还原），再登记回滚"}
        elif cur_hash != target["artifact_sha256"]:
            rollback_result = {"ok": False, "code": "rollback-refused-modified",
                               "next_action": "当前内容与最近记录、目标版本都不一致（绕过版本管理改过？）——先弄清改了什么"}
        else:
            body = {"ns": ns_name, "plugin": plugin_name, "version": args.to_version,
                    "from_artifact_sha256": latest_hash, "artifact_sha256": cur_hash,
                    "bytes": cur_bytes, "schema": 1}
            if not args.dry_run:
                ledger.append("userplugin/rolled-back", body,
                              correlation_id=f"up-rollback-{ns_name}-{plugin_name}-{args.to_version}")
            rollback_result = {"ok": True, "event": "userplugin/rolled-back", "to_version": args.to_version,
                               "artifact_sha256": cur_hash}
        if rollback_result and not rollback_result.get("ok") and not args.dry_run:
            ledger.append("userplugin/refused", {"ns": ns_name, "plugin": plugin_name,
                                                 "code": rollback_result["code"], "schema": 1},
                          correlation_id=f"up-refuse-{ns_name}-{plugin_name}-{rollback_result['code']}")

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

    rollback_added = 1 if (rollback_result and rollback_result.get("ok") and not args.dry_run) else 0
    if args.rollback:
        ok = bool(rollback_result and rollback_result.get("ok"))
    else:
        ok = bool(applied) or bool(duplicates) or (not refused and not items)
    return emit({"ok": ok, "applied": applied,
                 "duplicates": duplicates, "refused": refused, "rollback": rollback_result,
                 "ledger_added": (0 if args.dry_run else len(applied) + rollback_added),
                 "ledger_path": str(ledger_path), "dry_run": bool(args.dry_run)},
                0 if ok else 1)


if __name__ == "__main__":
    raise SystemExit(main())
