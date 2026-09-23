#!/usr/bin/env python3
"""authority-bands-apply —— 「授权区间」的**变更入口**（身份闸门 + 人工门 + 落盘驱动）。

缺陷原话（P47 §4.2）：主管在界面上答不出「**这笔钱越没越界**」—— 授权区间只能看、界面上没有登记入口；
而受管配置路径又没下传到插件（面板说"我读的是 /workspace/config.yaml"，服务其实用 `--config-file` 换了
另一份）。P49 补上了界内登记入口，但那条路是**自助**的：请求人与批准人是**同一个人**。

本批（P50）把它改成**人工门 + 另一人复核**（与 P48 承诺 / 发 PO 的「人门」同口径，判据同源）：

  · `--step request`  提交变更：身份门 → 白名单/类型门 → 落一份 **0600 暂存件**
                      （`<ui-shared>/authority-bands/pending/<request_id>.json`，**不进 config 收件箱**：
                      唯一落盘者扫收件箱时不可能把一份"还没人批"的变更落进 YAML）→ 落人工门事实
                      `approval/requested`（`scope=config.authority`、`ref=authority-band:<request_id>`、
                      `approvers=[点名的复核人…]`）。**不落盘**（不写 YAML）。
  · `--step apply`    复核通过后落盘：从账本重放门 → **唯一判据** `signoff_verdict`/`select_signoff`
                      （`src/system/approval/code/approval.py`；判据①②③④⑤ 与承诺/发 PO 完全同一份）⇒
                      **批的人必须不是提交的人**；通过后把暂存件物化成 **0600 待办件** 交给**唯一落盘者**
                      `src/system/config/tools/config-apply.py`，回读受管文件 sha256 前后（"真的变了"是读数）。

**唯一的放行开关**（与 `<ui-shared>/commitments/policy.json` 同一形状、同一个纪律）：
`<ui-shared>/authority-bands/policy.json` 的 `{"allow_self_approval": true}` —— **默认关闭**（文件不存在
= 关闭），形状不合法 ⇒ `policy-malformed`（**不当作关闭**：静默忽略一个坏开关等于让人以为开关开着）；
打开时本次批准会**如实**标成「批准人 == 提交人（自签自批：显式开关已开）」。界面上没有开它的按钮。

用法::

    # ① 提交（开单，等另一个人批）
    python3 src/system/config/tools/authority-bands-apply.py --step request \\
        --session-human human:limin --actor human:limin --now 2026-09-23T12:00:00Z \\
        --file <受管 YAML> --inbox <config 收件箱> --ledger <配置账本> --ui-shared <ui_shared> \\
        --role buyer --limit-cents 300000 --approvers human:liwei
    # ② 复核人在「审批队列」点「批准」（gate.grant，落 approval/granted）
    # ③ 回来落盘
    python3 src/system/config/tools/authority-bands-apply.py --step apply ... --role buyer --limit-cents 300000

stdout 恰一行 JSON（**只含键名、角色 id、门号与文件摘要**）；退出码 0 = 已受理/已落盘/幂等，
1 = 唯一落盘者或账本拒绝，2 = 身份/用法/白名单/人工门判据拒绝。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
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
PENDING_SUBDIR = ("authority-bands", "pending")
POLICY_REL = ("authority-bands", "policy.json")
STEPS = ("request", "apply")


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


#: 「自签自批」的唯一开关（**默认关闭**；与承诺/发 PO 那条路（`commitments/policy.json`）同一形状、
#: 同一纪律 —— 坏形状**不当作关闭**）。返回 `(allowed, refusal)`：`refusal is not None` ⇒ 调用方必须拒。
def self_approval_policy(ui_shared: Path) -> tuple[bool, dict | None]:
    path = ui_shared.joinpath(*POLICY_REL)
    if not path.exists():
        return False, None                      # 文件不存在 = 关闭（默认）
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return False, refusal("policy-malformed",
                              f"自签自批开关不是合法 JSON：{path}",
                              f"把 {path} 写成 {{\"allow_self_approval\": true}} 或删掉它（默认关闭）")
    if not isinstance(doc, dict) or not isinstance(doc.get("allow_self_approval"), bool):
        return False, refusal("policy-malformed",
                              f"自签自批开关形状不对（要 {{\"allow_self_approval\": true|false}}）：{path}",
                              "改成布尔值或删掉它（删掉 = 默认关闭；坏形状**不当作关闭**）")
    return bool(doc["allow_self_approval"]), None


def parse_approvers(raw: str) -> list[str]:
    return [item.strip() for item in re.split(r"[,\s]+", str(raw or "")) if item.strip()]


def band_value(module, text: str, key: str):
    """受管 YAML 里这个键的**当前值**（读不出来 ⇒ `None`）。两种写法都认：点分扁平键与嵌套。"""
    try:
        doc = module.parse_yaml(text)
    except Exception:  # noqa: BLE001
        return None
    project = doc.get("project") if isinstance(doc, dict) else None
    if not isinstance(project, dict):
        return None
    if key in project:
        return project[key]
    node = project
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(prog="authority-bands-apply", add_help=False)
    parser.add_argument("--step", default="request", choices=STEPS)
    parser.add_argument("--session-human", dest="session_human", default="")
    parser.add_argument("--actor", default="")
    parser.add_argument("--now", default="")
    parser.add_argument("--role", default="")
    parser.add_argument("--limit-cents", dest="limit_cents", default="")
    parser.add_argument("--approvers", default="")
    parser.add_argument("--file", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ledger", default="")
    parser.add_argument("--ui-shared", dest="ui_shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    args, unknown = parser.parse_known_args(argv)

    step = str(args.step)
    base = {"service": "authority-bands-apply", "scope": SCOPE, "step": step,
            "session_human": str(args.session_human), "actor": str(args.actor), "now": str(args.now),
            "role": str(args.role), "limit_cents": str(args.limit_cents),
            "approvers": str(args.approvers)}

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
    ui_shared = Path(str(args.ui_shared or "")).resolve()
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
    approvers = parse_approvers(args.approvers)

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
        int(hashlib.sha256(f"{SCOPE}:{request_id}".encode("utf-8")).hexdigest(), 16) % 10000)
    keys = sorted(fields)
    ref = f"authority-band:{request_id}"
    pending_dir = ui_shared.joinpath(*PENDING_SUBDIR)
    item_path = pending_dir / f"{request_id}.json"
    allowed_self, policy_refusal = self_approval_policy(ui_shared)
    if policy_refusal is not None:
        return deny(policy_refusal["code"], policy_refusal["reason"], policy_refusal["next_action"])
    record = {"request_id": request_id, "layer": "project", "target": "project", "fields": fields,
              "payload_sha256": digest_hex, "bytes": body_bytes, "schema": SCHEMA, "submitted_at": "",
              "submitted_by": session_human, "scope": SCOPE, "ref": ref, "band_role": role,
              "approvers": approvers, "recorded_at": str(args.now)}
    if args.dry_run:
        return emit({**base, "ok": True, "dry_run": True, "persisted": False, "keys": keys,
                     "band_role": role, "request_id": request_id, "payload_sha256": digest_hex,
                     "bytes": body_bytes, "approval_id": approval_id, "config_file": config_file,
                     "ref": ref, "approvers": approvers, "allow_self_approval": allowed_self,
                     "staged_file": str(item_path), "refusal": None,
                     "note": "干跑：身份/白名单/类型/人工门参数都过了；未落暂存件、未落账本、未改文件"
                             + ("（⚠ 自签自批开关**开着**）" if allowed_self else "")}, 0)

    sys.path.insert(0, str(ROOT / "src"))
    try:
        from quotagent.kernel.ledger import Ledger  # noqa: E402  （唯一写账本的地方就是这个类）
        from quotagent.services.approval import ApprovalService, select_signoff  # noqa: E402
    except Exception as exc:  # noqa: BLE001
        return deny("tool-refused", f"账本内核装载失败：{exc}", "先修 src/quotagent/kernel/ledger.py 路径")
    try:
        ledger = Ledger(Path(ledger_file), realm=_realm_of(Path(ledger_file)))
        approvals = ApprovalService(ledger=ledger, actor=session_human)
    except Exception as exc:  # noqa: BLE001
        return deny("ledger-frozen", f"账本不接受这次读取：{type(exc).__name__} {exc}", "先修账本", 1)

    # ------------------------------------------------------------------ ① 提交（开人工门）
    if step == "request":
        if approvers and (len(approvers) == 1 and approvers[0] == actor) and not allowed_self:
            return deny("self-approval-not-allowed",
                        f"点名的复核人只有你自己（{actor}）：授权区间变更要**另一个人**复核，"
                        f"自提自批不算人工门（与承诺 / 发 PO 同一条判据）",
                        "点名另一人（本侧名册里的同事）；若业务上确实需要本人批准，只能在运营侧显式打开"
                        f"开关 <ui-shared>/authority-bands/policy.json 的 allow_self_approval（**默认关闭**）")
        if not approvers:
            if not allowed_self:
                return deny("no-other-approver",
                            "没有点名任何复核人：授权区间变更要一个**别人**来批（本侧名册里还没有第二个人？）",
                            "先让同事登录一次（登录即登记）或在「人员名册与角色」面板里加一个人，"
                            "再指名让他批；本人批准只能走运营侧显式开关（默认关闭）")
            approvers = [actor]
        # **文件里已经是这个值** ⇒ 不开一条没有意义的门（如实说，账本零新增）。
        try:
            current = band_value(module, Path(config_file).read_text(encoding="utf-8"), key)
        except OSError:
            current = None
        if current == fields[key]:
            return deny("already-in-place",
                        f"受管配置里 {key} 已经是 {fields[key]} —— 这次提交没有任何要改的东西",
                        "先看「授权区间」面板确认现值；要改成别的值就填一个新的限额再提交")
        try:
            # 门号**确定性派生**（同一份提交 ⇒ 同一个 ap-NNNN，可对账）：把服务计数器推到前一号
            approvals._counter = max(int(approval_id[3:]) - 1, 0)     # noqa: SLF001
            row = approvals.request(SCOPE, {"request_id": request_id, "payload_sha256": digest_hex,
                                            "bytes": body_bytes, "keys": keys},
                                    ref=ref, approvers=approvers,
                                    reason=f"授权区间变更（{role}）：提交人 {actor}，等 {', '.join(approvers)} 复核",
                                    timeout_policy="remind", at=str(args.now))
        except Exception as exc:  # noqa: BLE001
            return deny("ledger-frozen", f"账本不接受这次追加：{type(exc).__name__} {exc}",
                        "先修账本（本脚本不往校验不过的账本追加）", 1)
        try:
            pending_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(pending_dir, 0o700)
            tmp = pending_dir / f".{request_id}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=1, sort_keys=True)
                handle.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, item_path)
        except OSError as exc:
            return deny("staging-write-failed", f"暂存件写失败：{exc}", "先修 <ui-shared>/authority-bands/ 权限", 1)
        return emit({**base, "ok": True, "persisted": False, "ledger_added": 1, "keys": keys,
                     "band_role": role, "request_id": request_id, "payload_sha256": digest_hex,
                     "bytes": body_bytes, "approval_id": str(row["approval_id"]), "ref": ref,
                     "approvers": approvers, "allow_self_approval": allowed_self,
                     "staged_file": str(item_path), "staged_mode": "0600", "config_file": config_file,
                     "refusal": None,
                     "note": "已提交：人工门事实已落账本（approval/requested），**受管配置一个字都没改**；"
                             + ("⚠ 自签自批开关**开着**：这次可以由你本人批（如实标记）" if allowed_self
                                else f"等 {', '.join(approvers)} 在「审批队列」里批准（批的人必须不是提交人 "
                                     f"{actor}），然后回来点「把已复核的变更落盘」")}, 0)

    # ------------------------------------------------------------------ ② 落盘（消费另一个人的批准）
    if not item_path.exists():
        staged_done = ui_shared.joinpath(*PENDING_SUBDIR, "applied", f"{request_id}.json")
        return deny("already-applied" if staged_done.exists() else "no-staged-change",
                    f"暂存件不在 pending/：{item_path}",
                    "先在本页提交一次（`--step request` 开人工门），批准之后再落盘" if not staged_done.exists()
                    else "这一份变更已经落过盘（暂存件在 applied/）：账本零新增", 1 if staged_done.exists() else 2)
    try:
        staged = json.loads(item_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return deny("staged-unreadable", f"暂存件读不出来：{exc}", "删掉它重新提交一次", 1)
    if (str(staged.get("payload_sha256")) != digest_hex or int(staged.get("bytes") or -1) != body_bytes
            or staged.get("fields") != fields):
        return deny("staged-tampered", "暂存件与这次的字段/摘要对不上（有人改过它）",
                    "删掉暂存件重新提交一次（本脚本不拿一份对不上的件去落盘）", 1)
    named = [str(who) for who in (staged.get("approvers") or []) if str(who).strip()]
    # **唯一判据**（与承诺 / 发 PO 同一处实现）：批的人必须是别人、必须在开单时点名、必须是人。
    record_gate, refusal_doc = select_signoff(approvals.records(), scope=SCOPE, ref=ref, signer=actor,
                                              allow_self_approval=allowed_self)
    if record_gate is None:
        assert refusal_doc is not None
        code = str(refusal_doc.get("code") or "approval-required")
        next_action = str(refusal_doc.get("next_action") or "")
        if code == "approver-must-differ":
            next_action = ("让**另一个人**在「审批队列」里批准（自提自批不算人门）；若业务上确实需要"
                           f"本人批准，只能在运营侧显式打开开关 "
                           f"<ui-shared>/authority-bands/policy.json 的 allow_self_approval（**默认关闭**）")
        return deny(code, str(refusal_doc.get("reason") or "没有可消费的人工门"), next_action)
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
    name = f"cfg-{request_id}.json"
    config_item = inbox_path / name
    try:
        tmp = inbox_path / f".{name}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=1, sort_keys=True)
            handle.write("\n")
        os.chmod(tmp, 0o600)                    # 待处理项必须**恰为** 0600（唯一落盘者的权限门）
        os.replace(tmp, config_item)
    except OSError as exc:
        return deny("inbox-write-failed", f"待处理项写失败：{exc}", "先修目录权限（0700/0600）", 1)
    before = _sha256_file(Path(config_file))
    inner_args = ["--inbox", str(inbox_path), "--file", config_file, "--ledger", ledger_file,
                  "--approval-ref", str(record_gate["approval_id"]), "--actor", session_human,
                  "--now", str(args.now), "--only", request_id]
    captured = io.StringIO()
    with __import__("contextlib").redirect_stdout(captured):
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
    duplicates = (inner or {}).get("duplicates") or []
    ledger_added = (inner or {}).get("ledger_added")
    persisted = bool(applied) and before != after
    # **唯一落盘者说"这份已经处理过"**（幂等：同一份待办件的摘要已归档过）⇒ 不能报成"写者失败"。
    # 如实分两种：① 受管文件里**已经是这个值** ⇒ `already-in-place`（本次无改动，ok=true）；
    # ② 别的值 ⇒ `writer-no-op`（没落任何东西、也不是你要的值 —— 说明那次落盘被回滚或被别人改过）。
    noop = rc == 0 and not applied and (duplicates or inner is not None)
    in_place = False
    if noop:
        try:
            in_place = band_value(module, Path(config_file).read_text(encoding="utf-8"), key) == fields[key]
        except OSError:
            in_place = False
    # 落过盘就把暂存件移进 applied/（**幂等**：同一份再点一次 ⇒ already-applied、账本零新增）
    try:
        if persisted or applied:
            done_dir = pending_dir / "applied"
            done_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(item_path), str(done_dir / f"{request_id}.json"))
    except OSError:
        pass
    if noop:
        return emit({**base, "ok": in_place, "persisted": False, "keys": keys, "band_role": role,
                     "request_id": request_id, "approval_id": str(record_gate["approval_id"]),
                     "approval_ref_kind": SCOPE, "approved_by": str(record_gate.get("decided_by") or ""),
                     "submitted_by": session_human, "approvers": named, "allow_self_approval": allowed_self,
                     "config_file": config_file, "config_sha256_before": before,
                     "config_sha256_after": after, "ledger_added": 0, "applied": [], "refused": refused,
                     "duplicates": duplicates, "staged_file": str(item_path),
                     "writer": "src/system/config/tools/config-apply.py",
                     "refusal": None if in_place else refusal(
                         "writer-no-op", "唯一落盘者这次没落任何东西（这份变更此前已被消费过）",
                         "看「授权区间」面板确认现值；要改就改成一个**新的**限额重新提交"),
                     "note": ("受管配置里**已经是这个值**：唯一落盘者按幂等跳过，本次**没有改动文件**"
                              "（不是失败，也不是又改了一次）") if in_place else
                             "唯一落盘者这次没有落任何东西：受管文件 sha256 前后一致，现值也**不是**你要的值"}, 0 if in_place else 1)
    return emit({**base, "ok": rc == 0 and bool(applied), "persisted": persisted, "keys": keys,
                 "band_role": role, "request_id": request_id, "item_file": str(config_item),
                 "item_mode": "0600", "approval_id": str(record_gate["approval_id"]),
                 "approval_ref_kind": SCOPE, "approved_by": str(record_gate.get("decided_by") or ""),
                 "submitted_by": session_human, "approvers": named, "allow_self_approval": allowed_self,
                 "self_approved": bool(record_gate.get("decided_by") == session_human),
                 "config_file": config_file, "config_sha256_before": before,
                 "config_sha256_after": after, "ledger_added": (ledger_added or 0),
                 "applied": applied, "refused": refused, "staged_file": str(item_path),
                 "writer": "src/system/config/tools/config-apply.py",
                 "refusal": None if rc == 0 else refusal("writer-refused", "唯一落盘者拒绝（见 refused）",
                                                         "按 refused 的 reason 处理；被拒项会各落一行 config/refused"),
                 "note": "人工门 → 0600 待办件 → 唯一落盘者落受管 YAML；"
                         + (f"**谁批的 {record_gate.get('decided_by')} ≠ 谁提交的 {session_human}**"
                            if record_gate.get("decided_by") != session_human
                            else "⚠ 自签自批：开关已开（批准人 == 提交人，如实标记）")}, rc)


if __name__ == "__main__":
    raise SystemExit(main())
