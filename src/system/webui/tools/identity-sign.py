#!/usr/bin/env python3
"""identity-sign —— 人签「提交报价」的**身份闸门**（DEF-001/DEF-003/DEF-007 的服务端一半）。

为什么单独一个脚本：本仓铁律是「浏览器不得直接签署人工动作」，落账本只能由既有唯一写者
`src/domain/quote-prepare/tools/quote-sign.py` 做（ADR-0013 §3 / 29 §3）。本脚本**不是第二写者**：
它只在唯一写者前面加一道**身份闸门**，然后把请求原样交给它。

它做什么（拒绝时**账本零新增**，连空账本都不创建）：

1. `--session-human` 必须给且形如 `human:<名字>`（**它来自服务端会话**，不是表单）：缺 ⇒ `identity-required`；
2. `--actor`（署名，可来自表单）必须**等于** `--session-human`：不等 ⇒ `signer-mismatch`
   —— 这就是「人签只能本人签」的负控；
3. `--draft-id` 必须真的在本侧账本里有 `quote/drafted`：没有 ⇒ `draft-not-found`；
4. **这份草稿必须是本人备的**（`quote/drafted.prepared_by == --session-human`）：否则 `not-my-draft`
   —— 别人的草稿不能替你签、你也不能替别人签（与 `--actor` 口径合成一条完整规则）；
5. `--now` 必填且为合法 ISO8601（本脚本不读墙钟）。

通过后：`actor` 一律取**会话身份**（丢弃表单里的任何 actor），调用
`quote-sign.py --draft-id … --actor <session-human> --now … [--comment …]`，把它的 stdout 原样带回来
（`ledger_added` / `quote_id` / `approval_id` / `applied` / `refusal`），并附上本闸门的判定。

用法::

    python3 src/system/webui/tools/identity-sign.py \
        --session-human human:chenmin --actor human:chenmin \
        --draft-id qd-supplier-87c9f2b5bdea --now 2026-09-30T00:00:00Z [--comment '一句话'] \
        [--ui-shared tmp/ui-shared] [--ledger-supplier …] [--ledger-contractor …]

stdout 恰一行 JSON；退出码 0 = 已签/幂等，1 = 唯一写者拒绝，2 = 身份/用法门拒绝（账本零新增）。
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
QUOTE_SIGN = ROOT / "src" / "domain" / "quote-prepare" / "tools" / "quote-sign.py"

HUMAN_RE = re.compile(r"^human:[a-z][a-z0-9._-]{0,31}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
DRAFT_RE = re.compile(r"^qd-[A-Za-z0-9-]+-[0-9a-f]{12}$")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def load_module(path: Path, name: str):
    """按路径装载既有唯一写者（**复用**它，不重造它的任何判定）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="identity-sign", add_help=False)
    parser.add_argument("--session-human", dest="session_human", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--draft-id", dest="draft_id", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--comment", default="")
    parser.add_argument("--ui-shared", dest="ui_shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-supplier", dest="ledger_supplier", default="")
    parser.add_argument("--ledger-contractor", dest="ledger_contractor", default="")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    args, unknown = parser.parse_known_args(argv)

    base = {"service": "identity-sign", "scope": "quote.submit",
            "session_human": str(args.session_human), "actor": str(args.actor),
            "draft_id": str(args.draft_id), "now": str(args.now), "ledger_added": 0}

    def deny(code: str, reason: str, next_action: str, exit_code: int = 2) -> int:
        return emit({**base, "ok": False, "refusal": refusal(code, reason, next_action)}, exit_code)

    if unknown:
        return deny("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    # 门①：会话身份（它只能来自服务端会话）
    if not HUMAN_RE.match(str(args.session_human)):
        return deny("identity-required",
                    f"缺会话身份或形状非法：{args.session_human!r}",
                    "先在 WebUI 登录（POST /identity/login），再由服务端把会话身份传进来"
                    "（身份不由表单决定）")
    session_human = str(args.session_human)
    # 门②：署名必须是本人
    actor = str(args.actor)
    if not HUMAN_RE.match(actor):
        return deny("human-required", f"署名形状非法：{actor!r}", "署名写 human:<你的名字>（agent 不得代签）")
    if actor != session_human:
        return deny("signer-mismatch",
                    f"署名 {actor} 与会话身份 {session_human} 不一致",
                    f"人签只能本人签：用 {session_human} 署名，或切换到该身份的会话（本次账本零新增）")
    if not ISO_RE.match(str(args.now)):
        return deny("usage-now", f"--now 缺或不是合法 ISO8601：{args.now!r}",
                    "显式给时间：--now 2026-09-30T00:00:00Z（唯一写者不读墙钟）")
    if not DRAFT_RE.match(str(args.draft_id)):
        return deny("draft-id-malformed", f"--draft-id 缺或形状非法：{args.draft_id!r}",
                    "从 WebUI 的待人签列表里复制（形如 qd-supplier-0123456789ab）")

    quote_sign = load_module(QUOTE_SIGN, "quotagent_quote_sign")
    if quote_sign is None or not hasattr(quote_sign, "main"):
        return deny("tool-refused", f"唯一写者装载失败：{QUOTE_SIGN}", "先修该脚本路径（本脚本不代签）")

    ui_shared = Path(args.ui_shared)
    supplier_ledger = Path(args.ledger_supplier) if args.ledger_supplier \
        else ui_shared / "supplier" / "ledger.jsonl"
    contractor_ledger = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    # 门③/④：草稿必须真的在本侧账本里，且**是本人备的**（复用唯一写者的读取器）
    rows, error = quote_sign.load_rows(supplier_ledger)
    if error is not None or rows is None:
        return deny("ledger-unreadable", str(error), "先修供应商账本（本脚本不往坏账本追加）", 1)
    draft = quote_sign.draft_of(rows, str(args.draft_id))
    if draft is None:
        return deny("draft-not-found",
                    f"供应商账本里没有 quote_draft_id={args.draft_id} 的 quote/drafted 行",
                    "先在 WebUI 备一份草稿并让它落账（本脚本账本零新增）", 1)
    prepared_by = str(draft.get("prepared_by") or "")
    if prepared_by != session_human:
        return deny("not-my-draft",
                    f"这份草稿是 {prepared_by or '（无 prepared_by）'} 备的，不是 {session_human}",
                    f"人签只能本人签：草案要么由本人备（prepared_by={session_human}），"
                    f"要么请 {prepared_by or '本人的'} 自己登录来签（本次账本零新增）")

    inner_args = ["--draft-id", str(args.draft_id), "--actor", session_human, "--now", str(args.now),
                  "--ui-shared", str(ui_shared), "--ledger-supplier", str(supplier_ledger),
                  "--ledger-contractor", str(contractor_ledger)]
    if str(args.comment) != "":
        inner_args += ["--comment", str(args.comment)]
    if args.dry_run:
        inner_args += ["--dry-run"]
    # 唯一写者的 stdout **吞掉再解析**：本脚本只回执**一行** JSON（含它的事实 + 本闸门的判定）
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        rc = quote_sign.main(inner_args)
    inner = None
    for line in reversed(captured.getvalue().splitlines()):
        if not line.strip():
            continue
        try:
            inner = json.loads(line)
        except ValueError:
            inner = None
        break
    return emit({**base, "ok": rc == 0,
                 "actor": session_human,                       # 署名**取自会话**（表单值只用来比对）
                 "quote_id": (inner or {}).get("quote_id"),
                 "approval_id": (inner or {}).get("approval_id"),
                 "event": (inner or {}).get("event"),
                 "ledger_added": (inner or {}).get("ledger_added"),
                 "applied": (inner or {}).get("applied") or [],
                 "duplicates": (inner or {}).get("duplicates") or [],
                 "delegate_rc": rc, "writer": "src/domain/quote-prepare/tools/quote-sign.py",
                 "refusal": (inner or {}).get("refusal") if rc != 0 else None,
                 "dry_run": bool(args.dry_run),
                 "note": "身份闸门通过；判定与落账由既有唯一写者做（本脚本不是第二写者）"}, rc)


if __name__ == "__main__":
    raise SystemExit(main())
