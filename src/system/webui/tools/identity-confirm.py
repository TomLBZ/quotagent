#!/usr/bin/env python3
"""identity-confirm —— 人签「确认中标」的**身份闸门**（DEF-022 的供应商侧那一半 + DEF-001/003 的口径）。

与 `identity-sign.py` 同一规格：本脚本**不是第二写者**，它只做三件事 ——
① 身份闸门、② 落一条 0600 待办件（授标链的载荷形状，**逐字节复用** `commitment-apply.py` 的规范化器）、
③ 把请求交给既有唯一写者 `src/domain/commitments/tools/commitment-apply.py --step confirm`。

闸门（每条都**在构造 Ledger 之前**返回，拒绝时账本零新增）：

1. `--session-human` 必须给且形如 `human:<名字>`（**来自服务端会话**）：缺 ⇒ `identity-required`；
2. `--actor`（署名，可来自表单）必须等于会话身份：否则 ⇒ `signer-mismatch`（人签只能本人签）；
3. 意向必须真的在**承包商账本**里（`award/intent-proposed`）：否则 ⇒ `intent-not-found`；
4. 本侧账本里必须有该意向引用报价的 `quote/submitted`（不能替别人确认）：否则 ⇒ `quote-not-mine`；
5. **只能确认自己签过的报价**：那份报价登记带 `approved_by` 且不等于会话身份 ⇒ `not-my-quote`
   （seed/走查数据缺 `approved_by` 时不冒充：放行但如实记 `approved_by_missing`）。
6. `--now` 必填且为合法 ISO8601（本脚本不读墙钟）。

待办件**不含 `actor` 键**（唯一的署名只能来自 `--actor`＝会话身份；载荷里放 `actor` 会成为伪造入口）。

用法::

    python3 src/system/webui/tools/identity-confirm.py \
        --session-human human:chenmin --actor human:chenmin \
        --intent-id awin-0001 --now 2026-09-30T00:00:00Z [--note '能否按期'] \
        [--ui-shared tmp/ui-shared] [--ledger-supplier …] [--ledger-contractor …]

stdout 恰一行 JSON；退出码 0 = 已确认/幂等，1 = 唯一写者拒绝，2 = 身份/用法门拒绝（账本零新增）。
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
COMMITMENT_APPLY = ROOT / "src" / "domain" / "commitments" / "tools" / "commitment-apply.py"

HUMAN_RE = re.compile(r"^human:[a-z][a-z0-9._-]{0,31}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="identity-confirm", add_help=False)
    parser.add_argument("--session-human", dest="session_human", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--intent-id", dest="intent_id", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--note", default="")
    parser.add_argument("--ui-shared", dest="ui_shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-supplier", dest="ledger_supplier", default="")
    parser.add_argument("--ledger-contractor", dest="ledger_contractor", default="")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    args, unknown = parser.parse_known_args(argv)

    base = {"service": "identity-confirm", "scope": "award.confirm",
            "session_human": str(args.session_human), "actor": str(args.actor),
            "intent_id": str(args.intent_id), "now": str(args.now), "ledger_added": 0}

    def deny(code: str, reason: str, next_action: str, exit_code: int = 2) -> int:
        return emit({**base, "ok": False, "refusal": refusal(code, reason, next_action)}, exit_code)

    if unknown:
        return deny("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not HUMAN_RE.match(str(args.session_human)):
        return deny("identity-required", f"缺会话身份或形状非法：{args.session_human!r}",
                    "先在 WebUI 登录，再由服务端把会话身份传进来")
    session_human = str(args.session_human)
    actor = str(args.actor)
    if not HUMAN_RE.match(actor):
        return deny("human-required", f"署名形状非法：{actor!r}", "署名写 human:<你的名字>")
    if actor != session_human:
        return deny("signer-mismatch", f"署名 {actor} 与会话身份 {session_human} 不一致",
                    f"人签只能本人签：用 {session_human} 署名（本次账本零新增）")
    if not ISO_RE.match(str(args.now)):
        return deny("usage-now", f"--now 缺或不是合法 ISO8601：{args.now!r}", "显式给 --now <ISO8601>")
    if not ID_RE.match(str(args.intent_id)):
        return deny("intent-id-malformed", f"--intent-id 缺或形状非法：{args.intent_id!r}",
                    "从 WebUI 的「待我处理」里复制 intent_id")
    if args.dry_run:
        return emit({**base, "ok": True, "dry_run": True, "refusal": None,
                     "note": "干跑：身份闸门通过；未落待办件、未落账本"}, 0)

    module = load_module(COMMITMENT_APPLY, "quotagent_commitment_apply")
    if module is None or not hasattr(module, "main"):
        return deny("tool-refused", f"唯一写者装载失败：{COMMITMENT_APPLY}", "先修该脚本路径")

    ui_shared = Path(args.ui_shared)
    supplier_ledger = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    contractor_ledger = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"

    c_rows, error = module.rows_of(contractor_ledger)
    if error is not None or c_rows is None:
        return deny("ledger-unreadable", str(error), "先修承包商账本", 1)
    s_rows, error = module.rows_of(supplier_ledger)
    if error is not None or s_rows is None:
        return deny("ledger-unreadable", str(error), "先修供应商账本", 1)

    intent = None
    for row in c_rows:
        body = module.body_of(row)
        if str(row.get("type")) == "award/intent-proposed" and str(body.get("intent_id") or "") == str(args.intent_id):
            intent = body
    if intent is None:
        return deny("intent-not-found", f"承包商账本里没有 intent_id={args.intent_id} 的授标意向",
                    "先让承包商提授标意向（APP 的「提意向」），再让供应商确认", 1)
    quote_id = str(intent.get("quote_id") or "")
    mine = None
    for row in s_rows:
        body = module.body_of(row)
        if str(row.get("type")) == "quote/submitted" and str(body.get("quote_id") or "") == quote_id:
            mine = body
    if mine is None:
        return deny("quote-not-mine", f"本侧账本里没有 quote_id={quote_id} 的报价（不能替别人确认）",
                    "只确认自己提交过的报价对应的意向（本次账本零新增）", 1)
    approved_by = str(mine.get("approved_by") or "")
    approved_by_missing = approved_by == ""
    if approved_by != "" and approved_by != session_human:
        return deny("not-my-quote", f"这份报价是 {approved_by} 签的，不是 {session_human}",
                    f"人签只能本人签：请 {approved_by} 自己登录确认（本次账本零新增）")

    # 待办件：**逐字节复用**唯一写者的规范化器（canonical / digest_of），0600、原子写、名字可核
    record = {"schema": module.SCHEMA, "kind": module.KIND, "action": "confirm",
              "intent_id": str(args.intent_id), "quote_id": quote_id, "note": str(args.note),
              "submitted_at": ""}
    record["bytes"] = len(str(record["note"]).encode("utf-8"))
    record["payload_sha256"] = module.digest_of(module.canonical(record))
    inbox = ui_shared / "commitment-apply"
    inbox.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(inbox, 0o700)
    except OSError:
        pass
    name = f"confirm-{record['payload_sha256'].split(':')[-1][:12]}.json"
    request_path = inbox / name
    try:
        tmp = inbox / f".{name}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp, 0o600)                       # 待办件必须**恰为** 0600（唯一写者的权限门）
        os.replace(tmp, request_path)
    except OSError as exc:
        return deny("pending-write-failed", f"待办件写失败：{exc}", "先修 <ui-shared>/commitment-apply 目录权限")

    inner_args = ["--step", "confirm", "--request", str(request_path),
                  "--ledger-contractor", str(contractor_ledger), "--ledger-supplier", str(supplier_ledger),
                  "--ui-shared", str(ui_shared), "--actor", session_human, "--now", str(args.now)]
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        rc = module.main(inner_args)
    inner = None
    for line in reversed(captured.getvalue().splitlines()):
        if not line.strip():
            continue
        try:
            inner = json.loads(line)
        except ValueError:
            inner = None
        break
    applied = (inner or {}).get("applied") or []
    event = None
    if isinstance(applied, list):
        for item in applied:
            if isinstance(item, dict) and item.get("event"):
                event = str(item["event"])
    return emit({**base, "ok": rc == 0, "actor": session_human, "event": event,
                 "ledger_added": (inner or {}).get("ledger_added"),
                 "applied": applied, "duplicates": (inner or {}).get("duplicates") or [],
                 "delegate_rc": rc, "request_file": str(request_path),
                 "request_mode": oct(stat.S_IMODE(os.stat(request_path).st_mode)),
                 "approved_by": approved_by, "approved_by_missing": approved_by_missing,
                 "writer": "src/domain/commitments/tools/commitment-apply.py",
                 "refusal": (inner or {}).get("refusal") if rc != 0 else None,
                 "note": "身份闸门通过；落账由既有唯一写者做（本脚本不是第二写者）"}, rc)


if __name__ == "__main__":
    raise SystemExit(main())
