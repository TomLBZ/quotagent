#!/usr/bin/env python3
"""src/system/evidence/tools/evidence-pack-export.py —— **证据包导出的唯一写者**（DEF-029）。

审批与证据面在 APP 内本来**没有导出入口**（只有一份旧 SSR 计数页）：这条补上「导出证据包」。
纪律（与 `gate-actions.py` / `config-apply.py` 同一套）：

  ① 权限门：待办件必须**恰 0600** 的普通文件（`identity.mjs` / `webui.mjs` 落的宿主件）；
  ② 形状门：`schema=quotagent/pending/v1` / `kind=evidence-pack-export` / `action=export`；
  ③ 重算校验：`payload_sha256`（去掉 payload_sha256/bytes/submitted_at 后逐字节重算）与 `bytes`；
  ④ 业务门：**人**发起（`actor` 必须 `human:`）→ 账本**健康**（`assert_healthy()`：冻结的账本不得导出
     对外证据）→ 范围合法（`from_seq ≥ 1`、`to_seq ≥ from_seq`、切片非空）；
  ⑤ 落盘：包写到 `<out-dir>/<package_id>.json`（目录 0700 / 文件 **0600**，原子写）；
  ⑥ 留痕：账本追加**一条既有事件** `evidence/pack-exported`（谁在何时导出了哪一段、包哈希与 Merkle 根）。

拒绝路径**零落盘、账本零新增**，逐条给 `code` + `next_action`；stdout 恰一行 JSON；退出码 0/1/2。
`--now` 必填（本脚本不读墙钟：包的 `generated_at` 就是它）。

用法：
  python3 src/system/evidence/tools/evidence-pack-export.py --request <pending.json> \\
      --ledger-contractor .../contractor/ledger.jsonl --out-dir .../evidence-packs \\
      --now 2026-09-23T10:00:00Z
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.canon import digest as canon_digest  # noqa: E402
from quotagent.kernel.evidence import export as export_pack, verify as verify_pack  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
SCOPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,95}$")

SCHEMA = "quotagent/pending/v1"
KIND = "evidence-pack-export"
ACTION = "export"
MAX_FILE_BYTES = 262144
MAX_SLICE = 20000                      # 有界：一次导出的行数上限（超限如实拒，不悄悄截断成半份证据）
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")
PACK_EXPORTED_EVENT = "evidence/pack-exported"


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def deny(code: str, reason: str, next_action: str, request: str = "") -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "request": request, "refusal": refusal(code, reason, next_action)}, 1)


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def digest_of(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(record: dict) -> str:
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


def read_pending(path: Path) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面点动作会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "待办件必须是宿主落的普通文件")
    if stat.S_IMODE(info.st_mode) != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(stat.S_IMODE(info.st_mode))} 不是 0600",
                             "chmod 600 后再消费")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限", "拆分后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA or record.get("kind") != KIND or record.get("action") != ACTION:
        return None, refusal("pending-schema-unknown",
                             f"schema/kind/action 不匹配：{record.get('schema')!r}/"
                             f"{record.get('kind')!r}/{record.get('action')!r}",
                             "这份待办件不是证据包导出的载荷")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int):
        return None, refusal("pending-tampered", "bytes 不是整数", "让宿主重落待办件")
    return record, None


def archive(inbox: Path, request: Path) -> str:
    applied = inbox / "applied"
    applied.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(applied, 0o700)
    except OSError:
        pass
    target = applied / request.name
    index = 1
    while target.exists():
        target = applied / f"{request.stem}.{index}.json"
        index += 1
    os.rename(request, target)
    return str(target)


def write_pack(out_dir: Path, package_id: str, pack: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(out_dir, 0o700)
    except OSError:
        pass
    target = out_dir / f"{package_id}.json"
    tmp = out_dir / f".{package_id}.{os.getpid()}.tmp"
    text = json.dumps(pack, ensure_ascii=False, sort_keys=True, indent=1) + "\n"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
    return target


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="证据包导出的唯一落盘者（读账本切片 → 落包 + 留痕）")
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费最早一条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="", help="要导出的那一侧账本")
    parser.add_argument("--view", default="contractor")
    parser.add_argument("--out-dir", default="", help="包往哪写（缺省 <ui-shared>/evidence-packs）")
    parser.add_argument("--now", default="", help="生成时刻（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-23T10:00:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "action": ACTION, "event": None, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "pending": 0,
                         "note": "待办件目录空（空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request)
    if deny_reason is not None:
        return emit({"ok": False, "action": ACTION, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0, "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", "证据包导出是人做的（要记名）：actor 必须以 human: 开头",
                    "写 human:<你的名字>（agent 不得代导）", str(request))

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不读坏账本）")
    if not rows:
        return deny("ledger-empty", f"账本读不到任何行：{ledger_path}",
                    "先让事实进账本（空账本导不出证据包）", str(request))
    realm = realm_of(rows, f"{args.view}:gui")

    # ---- 范围（有界；越界一律具名拒）------------------------------------------------------------
    try:
        from_seq = int(record.get("from_seq") or 1)
        to_seq = int(record.get("to_seq") or 0) or int(rows[-1]["seq"])
    except (TypeError, ValueError):
        return deny("range-invalid", f"from_seq/to_seq 不是整数：{record.get('from_seq')!r}/{record.get('to_seq')!r}",
                    "给整数行号（seq）", str(request))
    if from_seq < 1 or to_seq < from_seq:
        return deny("range-invalid", f"范围非法：from_seq={from_seq} to_seq={to_seq}",
                    "from_seq ≥ 1 且 to_seq ≥ from_seq", str(request))
    if to_seq - from_seq + 1 > MAX_SLICE:
        return deny("range-too-large", f"切片 {to_seq - from_seq + 1} 行超过单次上限 {MAX_SLICE}",
                    f"分成若干段（每段 ≤ {MAX_SLICE} 行）各导一个包", str(request))
    scope = str(record.get("scope") or "").strip() or f"ledger:{realm}"
    if not SCOPE_RE.match(scope):
        return deny("scope-malformed", f"scope 形状非法：{scope!r}", "给一个可读的范围名（如 ledger:contractor:g1）",
                    str(request))

    # ---- 幂等：同一份待办件已经归档过 ⇒ already-applied、零落盘零新增 -------------------------------
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "action": ACTION, "event": None, "applied": [], "ledger_added": 0,
                         "duplicates": [{"reason": "already-applied", "key": key}], "refusal": None,
                         "request": str(request),
                         "note": "同一份载荷已经消费过（归档件逐字节一致）：包与账本都零新增（幂等）"}, 0)

    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（冻结的账本不得导出对外证据）")

    dry = {"ok": True, "action": ACTION, "dry_run": True, "from_seq": from_seq, "to_seq": to_seq,
           "scope": scope, "realm": realm, "ledger_added": 0, "refusal": None,
           "note": "干跑：范围/账本健康/署名都过了，包与账本零新增"}
    if args.dry_run:
        return emit(dry, 0)

    pack = export_pack(ledger, scope=scope, from_seq=from_seq, to_seq=to_seq, generated_at=args.now)
    manifest = pack["manifest"]
    manifest["package_id"] = "ep-" + str(manifest["pack_hash"]).split(":")[-1][:12]
    manifest["scope"] = scope
    manifest["exported_by"] = actor
    # `manifest_hash` 覆盖"除自身外的整份清单" ⇒ 加完上面三个键必须**重算**，否则包自校验不过
    manifest["manifest_hash"] = canon_digest({k: v for k, v in manifest.items() if k != "manifest_hash"})

    out_dir = Path(args.out_dir) if args.out_dir else ui_shared / "evidence-packs"
    target = write_pack(out_dir, manifest["package_id"], pack)
    ledger.append(PACK_EXPORTED_EVENT, {
        "package_id": manifest["package_id"], "scope": scope, "count": manifest["count"],
        "pack_hash": manifest["pack_hash"], "merkle_root": pack["merkle_root"],
        "signed_by": pack.get("signed_by"), "from_seq": manifest["from_seq"], "to_seq": manifest["to_seq"],
        "note": "审计包导出留痕（模型可见 ⟺ 账本可见）",
    }, correlation_id=manifest["package_id"], actor=actor, ts=args.now)

    report = verify_pack(pack)
    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    return emit({"ok": True, "action": ACTION, "event": PACK_EXPORTED_EVENT,
                 "applied": [{"event": PACK_EXPORTED_EVENT, "package_id": manifest["package_id"],
                              "scope": scope, "count": manifest["count"],
                              "pack_hash": manifest["pack_hash"], "merkle_root": pack["merkle_root"]}],
                 "duplicates": [], "ledger_added": 1, "refusal": None, "request": str(request),
                 "archived": archived, "view": args.view, "by": actor, "at": args.now,
                 "package_id": manifest["package_id"], "pack_file": str(target),
                 "count": manifest["count"], "from_seq": manifest["from_seq"], "to_seq": manifest["to_seq"],
                 "pack_hash": manifest["pack_hash"], "merkle_root": pack["merkle_root"],
                 "self_check": {"ok": report["ok"], "checks": len(report["checks"]),
                                "first_failure": report["first_failure"]},
                 "next_action_runtime": f"包已落 {target}（0600）并在账本留痕；用「验证一个包」逐项看校验结果",
                 "note": "导出只读账本切片 + 落一个 0600 包文件 + 账本追加一条既有事件 "
                         "evidence/pack-exported（**不新造事件类型**）"}, 0)


def crash_guard(fn, argv):
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次包与账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
