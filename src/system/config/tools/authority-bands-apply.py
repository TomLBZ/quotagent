#!/usr/bin/env python3
"""authority-bands-apply —— 「授权区间」的**界内登记入口**（身份闸门 + 落盘驱动）。

缺陷原话（P47 第二次终局验收 §4.2）：主管在界面上答不出「**这笔钱越没越界**」——
授权区间只能看，界面上**没有任何地方能登记/修改** `authority.bands.<角色>`；而受管配置路径又没下传到
插件（面板写"我读的是 /workspace/config.yaml"，而服务其实用 `--config-file` 换了另一份）。

所以本脚本做四件事，**没有一件是新的写路径**（与 `src/system/webui/tools/identity-mail-apply.py`
同一套做法、同一套纪律）：

1. **身份闸门**：`--session-human`（来自服务端会话）必须给；`--actor`（署名）必须等于它
   —— 否则 `signer-mismatch`，立刻返回、零落盘零账本；
2. 只收**授权区间白名单键**（`authority.bands.<角色>`）：其余键一律 `unknown-band-key`（仍走提权后的
   `/admin/api/config/**`），角色是否登记过由 `config-keys.mjs` 那张**唯一登记表**判（不在这里造第二份）；
3. 落一条 **0600 待处理项**（形状与 `config-view` 的提交面**逐字节同源**：`payload_sha256` / `bytes`
   用 `config-apply.py` 自己的 `payload_digest` / `canonical` 重算），并先落**人工门事实**
   （`approval/requested` → `approval/granted`，`scope=config.authority`、`actor=human:<会话身份>`，
   时间用 `--now`，**不读墙钟**）拿到 `ap-NNNN` 引用 —— 这两行**调 `ApprovalService`**（不是自己拼 body）：
   键集与队列/门对象页同源 ⇒ 由这条路开的门在队列里读得出「卡在谁 / 超时剩余」；
4. 调既有唯一落盘者 `src/system/config/tools/config-apply.py`（`--approval-ref ap-NNNN --actor human:…`）
   把待处理项消费成 **YAML 事实 + 账本事实**，并回读**受管文件**写前/写后的 sha256（"真的变了"是读数，
   不是形容词；没变就如实报 `persisted: false`）。

**这个门是"谁改的"的证据，不是双人复核**：请求人与批准人是同一个（运维/主管本人在场自助），
与邮件配置那条路（`identity-mail-apply.py`）**同一口径**。界面上把这句话原样写出来（不夸大它的效力）。

用法::

    python3 src/system/config/tools/authority-bands-apply.py \\
        --session-human human:limin --actor human:limin --now 2026-09-23T12:00:00Z \\
        --file <受管 YAML> --inbox <config-submissions> --ledger <配置账本> \\
        --role lead --limit-cents 9000000   [--dry-run]

stdout 恰一行 JSON（**只含键名、角色 id 与文件摘要**）；退出码 0 = 已落盘/幂等，1 = 唯一落盘者拒绝，
2 = 身份/用法/白名单门拒绝。
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
ROLE_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
SCHEMA = 1
SCOPE = "config.authority"
BAND_PREFIX = "authority.bands."


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


def _sha256_file(path: Path) -> str:
    try:
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return ""


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


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="authority-bands-apply", add_help=False)
    parser.add_argument("--session-human", dest="session_human", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--role", default="")
    parser.add_argument("--limit-cents", dest="limit_cents", default="")
    parser.add_argument("--file", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ledger", default="")
    parser.add_argument("--ui-shared", dest="ui_shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    args, unknown = parser.parse_known_args(argv)

    base = {"service": "authority-bands-apply", "scope": SCOPE, "session_human": str(args.session_human),
            "actor": str(args.actor), "now": str(args.now), "role": str(args.role),
            "limit_cents": str(args.limit_cents)}

    def deny(code: str, reason: str, next_action: str, exit_code: int = 2) -> int:
        return emit({**base, "ok": False, "persisted": False, "ledger_added": 0,
                     "refusal": refusal(code, reason, next_action)}, exit_code)

    if unknown:
        return deny("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    # 门①：会话身份（服务端把会话身份传进来；表单改不动它）
    if not HUMAN_RE.match(str(args.session_human)):
        return deny("identity-required", f"缺会话身份或形状非法：{args.session_human!r}",
                    "先在 WebUI 登录，再由服务端把会话身份传进来（界面不代签）")
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
                    "让服务端把 configView 的 config_file 传进来（它随 host.config.config_file 下传到插件）")
    ledger_file = str(args.ledger or "").strip()
    if ledger_file == "":
        return deny("config-ledger-unconfigured", "缺 --ledger（账本落点必须显式给）",
                    "让服务端把 configView 的 config_ledger 传进来")
    # 门③：白名单（只收授权区间那一段；角色是否登记由 config-keys.mjs 那张唯一登记表判）
    role = str(args.role or "").strip()
    if not ROLE_RE.match(role):
        return deny("unknown-band-key", f"角色 id 形状非法：{role!r}",
                    "角色写小写字母/数字/连字符（如 buyer / lead / director）")
    key = f"{BAND_PREFIX}{role}"
    raw_limit = str(args.limit_cents or "").strip()
    if not re.fullmatch(r"-?\d+", raw_limit):
        return deny("limit-not-integer", f"限额必须是**整数分**（收到 {args.limit_cents!r}）",
                    "把限额写成整数分：500000 = 5000.00 元（不折算、不四舍五入）")
    fields = {key: int(raw_limit)}

    module = load_module(CONFIG_APPLY, "quotagent_config_apply")
    if module is None or not hasattr(module, "main"):
        return deny("tool-refused", f"唯一落盘者装载失败：{CONFIG_APPLY}", "先修该脚本路径")

    # 登记表核对（**不造第二份白名单**）：键必须真登记过，类型必须与登记表一致
    try:
        registry, _creds = module._registry()          # noqa: SLF001 —— 复用唯一登记表
    except Exception as exc:  # noqa: BLE001
        return deny("registry-unreadable", f"配置键登记表读不到：{type(exc).__name__} {exc}",
                    "先修 src/system/config/code/config-keys.mjs（登记表是白名单的一部分）")
    declared = (registry.get(key) or {}).get("type")
    if key not in registry:
        return deny("unknown-band-key", f"这个键没登记过：{key}",
                    f"登记过的授权区间键：{', '.join(sorted(k for k in registry if k.startswith(BAND_PREFIX))) or '（一个都没有）'}")
    if declared != "integer":
        return deny("type-mismatch", f"{key} 在登记表里的类型是 {declared!r}（本页只写整数分）",
                    "先修登记表（类型权威在那里）")

    fields = {key: fields[key]}
    digest_hex = module.payload_digest(fields)
    body_bytes = len(module.canonical(fields).encode("utf-8"))
    request_id = hashlib.sha256(json.dumps(fields, ensure_ascii=False, sort_keys=True,
                                           separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
    approval_id = "ap-%04d" % (
        int(hashlib.sha256(f"config.authority:{request_id}".encode("utf-8")).hexdigest(), 16) % 10000)
    keys = sorted(fields)
    if args.dry_run:
        return emit({**base, "ok": True, "dry_run": True, "persisted": False, "keys": keys,
                     "band_role": role, "request_id": request_id, "payload_sha256": digest_hex,
                     "bytes": body_bytes, "approval_id": approval_id, "config_file": config_file,
                     "refusal": None,
                     "note": "干跑：身份/白名单/类型都过了；未落待办件、未落账本、未改文件"}, 0)

    # 门④：人工门事实（approval/requested → approval/granted）——**本人在场**，与邮件配置同一口径：
    # 这两行是"谁改的"的证据；请求人与批准人是同一人（不假装它是双人复核）。
    sys.path.insert(0, str(ROOT / "src"))
    try:
        from quotagent.kernel.ledger import Ledger  # noqa: E402  （唯一写账本的地方就是这个类）
        from quotagent.services.approval import ApprovalService  # noqa: E402
    except Exception as exc:  # noqa: BLE001
        return deny("tool-refused", f"账本内核装载失败：{exc}", "先修 src/quotagent/kernel/ledger.py 路径")
    ref = f"authority-band:{request_id}"
    try:
        ledger = Ledger(Path(ledger_file), realm=_realm_of(Path(ledger_file)))
        approvals = ApprovalService(ledger=ledger, actor=session_human)
        # 门号**确定性派生**（同一份提交 ⇒ 同一个 ap-NNNN，`--approval-ref` 可对账）：把服务计数器推到前一号
        approvals._counter = max(int(approval_id[3:]) - 1, 0)     # noqa: SLF001
        row = approvals.request(SCOPE, {"request_id": request_id, "payload_sha256": digest_hex,
                                        "bytes": body_bytes, "keys": keys},
                               ref=ref, approvers=[session_human],
                               reason=f"授权区间登记（{role}）：本人在场自助",
                               timeout_policy="remind", at=str(args.now))
        approval_id = str(row["approval_id"])       # 以账本里那一行为准（不假设上面算出的号）
        approvals.decide(approval_id, by=session_human, decision="granted",
                         comment="运维/主管本人在场（界内自助登记；这一条不是双人复核）",
                         at=str(args.now))
    except Exception as exc:  # noqa: BLE001
        return deny("ledger-frozen", f"账本不接受这次追加：{type(exc).__name__} {exc}",
                    "先修账本（本脚本不往校验不过的账本追加）", 1)

    # 门⑤：0600 待处理项（形状与提交面同源；唯一落盘者据此落 YAML）
    inbox = str(args.inbox or "").strip()
    if inbox == "":
        return deny("inbox-unconfigured", "缺 --inbox（待处理项目录必须显式给）",
                    "让服务端把 configView 的 config_inbox 传进来（宿主侧未挂时本页不假装成功）")
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
    return emit({**base, "ok": rc == 0 and bool(applied), "persisted": persisted, "keys": keys,
                 "band_role": role, "request_id": request_id, "item_file": str(item_path),
                 "item_mode": "0600", "approval_id": approval_id, "approval_ref_kind": SCOPE,
                 "config_file": config_file, "config_sha256_before": before,
                 "config_sha256_after": after,
                 "ledger_added": (ledger_added or 0) + 2,     # + 2 = 本脚本先落的人工门事实
                 "applied": applied, "refused": refused,
                 "writer": "src/system/config/tools/config-apply.py",
                 "refusal": None if rc == 0 else refusal("writer-refused", "唯一落盘者拒绝（见 refused）",
                                                         "按 refused 的 reason 处理；被拒项会各落一行 config/refused"),
                 "note": "界内登记：人工门事实 → 0600 待办件 → 唯一落盘者落受管 YAML；"
                         "面板/队列下一次读就按新限额算（同一个文件、同一份口径）"}, rc)


if __name__ == "__main__":
    raise SystemExit(main())
