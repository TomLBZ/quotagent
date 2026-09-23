#!/usr/bin/env python3
"""identity-mail-apply —— 邮件/SMTP 配置的**身份闸门 + 落盘驱动**（DEF-025 的服务端一半）。

缺陷原话（`docs/work/plans/webui-ui-defects.md` DEF-025）：运维在邮件通道不可用时**当场修好**，
而不是「改配置要跳到提权后的 admin 道」；期望的做法是 ——「走 admin 道的既有写面 `config-apply.py`，
仍是『干跑 → 0600 待处理项 → Python 侧落盘』」，且**凭据永不回显**。

所以本脚本做四件事，**没有一件是新的写路径**：

1. **身份闸门**：`--session-human`（来自服务端会话）必须给；`--actor`（署名）必须等于它
   —— 否则 `signer-mismatch`，立刻返回、零落盘零账本；
2. 只收**邮件白名单键**（`mail.smtp.*` / `mail.imap.*` / `mail.timeout_seconds` / `mail.max_messages`）：
   其余键一律 `unknown-mail-key`（那些键仍走提权后的 `/admin/api/config/**`）；
3. 落一条 **0600 待处理项**（形状与 `config-view` 的提交面**逐字节同源**：`payload_sha256` / `bytes`
   用 `config-apply.py` 自己的 `payload_digest` / `canonical` 重算），并先落**人工门事实**
   （`approval/requested` → `approval/granted`，`scope=config.mail`、`actor=human:<会话身份>`，
   时间用 `--now`，**不读墙钟**）拿到 `ap-NNNN` 引用 —— 这两行**调 `ApprovalService`**（不是自己拼
   body）：键集与队列/门对象页同源，派分事实（`approvers`/`timeout_policy`/`timeout_s`/`requested_at`）
   一个不少 ⇒ 由这条路开的门在队列里读得出「卡在谁 / 超时剩余」；
4. 调既有唯一落盘者 `src/system/config/tools/config-apply.py`（`--approval-ref ap-NNNN --actor human:…`）
   把待处理项消费成 **YAML 事实 + 账本事实**。

**凭据永不回显**：stdout 只有键名、状态码与文件摘要；值只落进 0600 待处理项与该 YAML 文件，
既不进 stdout/stderr，也不进账本（账本只记键名与摘要）。

用法::

    python3 src/system/webui/tools/identity-mail-apply.py \\
        --session-human human:ops1 --actor human:ops1 --now 2026-09-30T00:00:00Z \\
        --file /workspace/config.yaml --inbox <config-submissions> --ledger <config-ledger> \\
        (--key mail.smtp.host --value smtp.example.com)*  [--yaml 'project:\\n  mail.timeout_seconds: 5']

stdout 恰一行 JSON；退出码 0 = 已落盘/幂等，1 = 唯一落盘者拒绝，2 = 身份/用法/白名单门拒绝。
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
CONFIG_APPLY = ROOT / "src" / "system" / "config" / "tools" / "config-apply.py"

HUMAN_RE = re.compile(r"^human:[a-z][a-z0-9._-]{0,31}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
MAIL_PREFIXES = ("mail.smtp.", "mail.imap.")
MAIL_EXACT = ("mail.timeout_seconds", "mail.max_messages")
SCHEMA = 1
SCOPE = "config.mail"


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def mail_key_allowed(key: str) -> bool:
    return key in MAIL_EXACT or any(key.startswith(prefix) and len(key) > len(prefix) for prefix in MAIL_PREFIXES)


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="identity-mail-apply", add_help=False)
    parser.add_argument("--session-human", dest="session_human", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--key", action="append", default=[])
    parser.add_argument("--value", action="append", default=[])
    parser.add_argument("--yaml", default="")
    parser.add_argument("--file", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ledger", default="")
    parser.add_argument("--ui-shared", dest="ui_shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    args, unknown = parser.parse_known_args(argv)

    base = {"service": "identity-mail-apply", "scope": SCOPE, "session_human": str(args.session_human),
            "actor": str(args.actor), "now": str(args.now)}

    def deny(code: str, reason: str, next_action: str, exit_code: int = 2) -> int:
        return emit({**base, "ok": False, "persisted": False, "ledger_added": 0,
                     "refusal": refusal(code, reason, next_action)}, exit_code)

    if unknown:
        return deny("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    # 门①：会话身份
    if not HUMAN_RE.match(str(args.session_human)):
        return deny("identity-required", f"缺会话身份或形状非法：{args.session_human!r}",
                    "先在 WebUI 登录（有权限的页面：side=ops），再由服务端把会话身份传进来")
    session_human = str(args.session_human)
    # 门②：署名必须是本人
    actor = str(args.actor)
    if not HUMAN_RE.match(actor):
        return deny("human-required", f"署名形状非法：{actor!r}", "署名写 human:<你的名字>")
    if actor != session_human:
        return deny("signer-mismatch", f"署名 {actor} 与会话身份 {session_human} 不一致",
                    f"只能本人签：用 {session_human} 署名（本次零落盘零账本）")
    if not ISO_RE.match(str(args.now)):
        return deny("usage-now", f"--now 缺或不是合法 ISO8601：{args.now!r}", "显式给 --now <ISO8601>")
    config_file = str(args.file or "").strip()
    if config_file == "":
        return deny("config-file-unconfigured", "缺 --file（受管配置文件路径必须显式给）",
                    "让服务端把 configView 的 config_file 传进来")
    ledger_file = str(args.ledger or "").strip()
    if ledger_file == "":
        return deny("config-ledger-unconfigured", "缺 --ledger（账本落点必须显式给）",
                    "让服务端把 configView 的 config_ledger 传进来")

    module = load_module(CONFIG_APPLY, "quotagent_config_apply")
    if module is None or not hasattr(module, "main"):
        return deny("tool-refused", f"唯一落盘者装载失败：{CONFIG_APPLY}", "先修该脚本路径")

    # 收集字段：YAML 片段（先） + 显式键值（后，覆盖同键）
    fields: dict = {}
    yaml_text = str(args.yaml or "")
    if yaml_text.strip() != "":
        try:
            parsed = module.read_managed_sections(yaml_text if yaml_text.endswith("\n") else yaml_text + "\n")
        except Exception as exc:  # noqa: BLE001 —— YAML 子集解析失败一律有名拒
            return deny("yaml-refused", f"YAML 片段不被支持：{type(exc).__name__} {exc}",
                        "本子集只支持顶层/嵌套映射、标量、简单列表、内联 {}/[]："
                        "锚点/别名、多文档、块标量、制表符缩进会被拒")
        for key, value in (parsed.get("project") or {}).items():
            fields[str(key)] = value
    if len(args.key) != len(args.value):
        return deny("usage-key-value", f"--key 与 --value 个数不一致（{len(args.key)} vs {len(args.value)}）",
                    "一个键一个值成对给")
    for key, value in zip(args.key, args.value):
        fields[str(key)] = value
    if not fields:
        return deny("no-fields", "没有提交任何邮件键（既没有键值对，也没有 YAML 片段）",
                    "至少给一个 mail.smtp.* / mail.imap.* 键")
    for key in sorted(fields):
        if not mail_key_allowed(key):
            return deny("unknown-mail-key", f"本页不允许改这个键：{key}",
                        f"本页只改 mail.smtp.* / mail.imap.* / {' / '.join(MAIL_EXACT)}；"
                        "其余键走提权后的 /admin/api/config/**")

    fields = {key: fields[key] for key in sorted(fields)}
    # 表单只会给字符串；**按登记表声明的类型**强转（类型权威仍是 `config-keys.mjs`，经 config-apply 读出来）
    try:
        registry, _creds = module._registry()          # noqa: SLF001 —— 复用唯一登记表，不造第二份类型表
    except Exception:  # noqa: BLE001
        registry = {}
    for key in list(fields):
        declared = (registry.get(key) or {}).get("type")
        value = fields[key]
        if not isinstance(value, str):
            continue
        raw = value.strip()
        if declared == "integer" and re.fullmatch(r"-?\d+", raw):
            fields[key] = int(raw)
        elif declared == "number" and re.fullmatch(r"-?\d+(\.\d+)?", raw):
            fields[key] = float(raw)
        elif declared == "boolean" and raw in ("true", "false"):
            fields[key] = raw == "true"
    digest_hex = module.payload_digest(fields)               # 复用唯一落盘者的规范化器（不重造）
    body_bytes = len(module.canonical(fields).encode("utf-8"))
    request_id = hashlib.sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
    approval_id = "ap-%04d" % (int(hashlib.sha256(f"config.mail:{request_id}".encode("utf-8")).hexdigest(), 16) % 10000)
    keys = sorted(fields)
    if args.dry_run:
        return emit({**base, "ok": True, "dry_run": True, "persisted": False, "keys": keys,
                     "request_id": request_id, "payload_sha256": digest_hex, "bytes": body_bytes,
                     "approval_id": approval_id, "config_file": config_file,
                     "refusal": None, "note": "干跑：白名单与形状都过了；未落待办件、未落账本、未改文件"}, 0)

    # 门③：人工门事实（approval/requested → approval/granted）——**先本人在场，再落盘**
    # **不由本脚本自己拼 body**：调 `ApprovalService.request()/decide()`（`src/system/approval/code/approval.py`）
    # —— 键集（基底 7 键 + 派分事实 `approvers`/`timeout_policy`/`timeout_s`/`escalate_to`/`requested_at`）
    # 与队列/门对象页/`gate-actions.py` **完全同源**。修前这里自己拼 8 键的小 body ⇒ 由这条路开的门
    # 在队列里**读不出「卡在谁 / 超时剩余」**（P42/P43 实测登记的真缺陷）。
    sys.path.insert(0, str(ROOT / "src"))
    try:
        from quotagent.kernel.ledger import Ledger  # noqa: E402  （唯一写账本的地方就是这个类）
        from quotagent.services.approval import ApprovalService  # noqa: E402  （唯一写 approval/* 的服务）
    except Exception as exc:  # noqa: BLE001
        return deny("tool-refused", f"账本内核装载失败：{exc}", "先修 src/quotagent/kernel/ledger.py 路径")
    ref = f"mail-config:{request_id}"
    try:
        ledger = Ledger(Path(ledger_file), realm=_realm_of(Path(ledger_file)))
        approvals = ApprovalService(ledger=ledger, actor=session_human)
        # 门号仍是**确定性派生**（同一份配置提交 ⇒ 同一个 `ap-NNNN`，`--approval-ref` 可对账）：
        # 把服务的计数器推到该号的前一号 ⇒ 服务生成的号与上面算出来的逐字节相同（不重造 id 生成器）。
        approvals._counter = max(int(approval_id[3:]) - 1, 0)     # noqa: SLF001
        request_row = approvals.request(SCOPE, {"request_id": request_id, "payload_sha256": digest_hex,
                                                "bytes": body_bytes, "keys": keys},
                                        ref=ref, approvers=[session_human],
                                        reason="邮件配置变更（运维本人在场）",
                                        timeout_policy="remind", at=str(args.now))
        approval_id = str(request_row["approval_id"])      # 以账本里那一行为准（不假设上面算出的号）
        approvals.decide(approval_id, by=session_human, decision="granted",
                         comment="站点自助页签名", at=str(args.now))
    except Exception as exc:  # noqa: BLE001
        return deny("ledger-frozen", f"账本不接受这次追加：{type(exc).__name__} {exc}",
                    "先修账本（本脚本不往校验不过的账本追加）", 1)

    # 门④：0600 待处理项（形状与提交面同源；值只落在这里与该 YAML 文件，永不回显）
    inbox = str(args.inbox or "").strip()
    if inbox == "":
        return deny("inbox-unconfigured", "缺 --inbox（待处理项目录必须显式给）",
                    "让服务端把 configView 的 config_inbox 传进来（宿主侧配置未挂时本页不假装成功）")
    inbox_path = Path(inbox)
    try:
        inbox_path.mkdir(parents=True, exist_ok=True)
        os.chmod(inbox_path, 0o700)
    except OSError as exc:
        return deny("inbox-write-failed", f"待处理目录不可用：{exc}", "先修目录权限（0700）")
    record = {"request_id": request_id, "layer": "project", "target": "project", "fields": fields,
              "payload_sha256": digest_hex, "bytes": body_bytes, "schema": SCHEMA, "submitted_at": "",
              "submitted_by": session_human}
    name = f"cfg-{request_id}.json"
    item_path = inbox_path / name
    try:
        tmp = inbox_path / f".{name}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp, 0o600)                    # 待处理项必须**恰为** 0600（唯一落盘者的权限门）
        os.replace(tmp, item_path)
    except OSError as exc:
        return deny("inbox-write-failed", f"待处理项写失败：{exc}", "先修目录权限（0700/0600）", 1)

    before = _sha256_file(Path(config_file))
    inner_args = ["--inbox", str(inbox_path), "--file", config_file, "--ledger", ledger_file,
                  "--approval-ref", approval_id, "--actor", session_human, "--now", str(args.now),
                  "--only", request_id]
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
    after = _sha256_file(Path(config_file))
    applied = (inner or {}).get("applied") or []
    refused = (inner or {}).get("refused") or []
    ledger_added = (inner or {}).get("ledger_added")
    persisted = bool(applied) and before != after
    out = {**base, "ok": rc == 0 and bool(applied), "persisted": persisted, "keys": keys,
           "request_id": request_id, "item_file": str(item_path), "item_mode": "0600",
           "approval_id": approval_id, "approval_ref_kind": "config.mail",
           "config_file": config_file, "config_sha256_before": before, "config_sha256_after": after,
           "ledger_added": (ledger_added or 0) + 2,     # + 2 = 本脚本先落的人工门事实
           "applied": applied, "refused": refused,
           "writer": "src/system/config/tools/config-apply.py",
           "refusal": None if rc == 0 else refusal("writer-refused", "唯一落盘者拒绝（见 refused）",
                                                   "按 refused 的 reason 处理；被拒项会各落一行 config/refused"),
           "note": "身份闸门通过：人工门事实 → 0600 待处理项 → 唯一落盘者落 YAML；"
                   "stdout 只给键名与摘要（凭据永不回显）"}
    return emit(out, rc)


def _realm_of(path: Path) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if isinstance(row, dict) and isinstance(row.get("realm"), str) and row["realm"]:
                return str(row["realm"])
            break
    except Exception:  # noqa: BLE001
        pass
    return "config"


def _sha256_file(path: Path) -> str:
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


if __name__ == "__main__":
    raise SystemExit(main())
