#!/usr/bin/env python3
"""src/system/approval/tools/gate-actions.py —— 「审批队列」写动作的**唯一落账本者**
（DEF-023：可等 / 可催 / 可升级 / 可终止 / 可委托；DEF-008：**可批准 / 可驳回**；
催办走既有唯一写者 `gate-nudge.py`）。

六个步（都只落**已登记**的事件类型；新增事件类型属账本格式变更，须先有 ADR ⇒ 本轮不新造）：

  · `--step request`   开一个**待批门**：`approval/requested`（`ApprovalService.request`）。
    用途：把某件事提给人批（越界金额、要变更、加轮次……）。超时策略只能是
    `remind` / `escalate` / `abort` —— **不存在"超时自动批准"**（服务的门）。
  · `--step grant`     **批准**：`approval/granted`（`ApprovalService.decide(decision='granted')`）——
    这是审批队列存在的理由（DEF-008）。判定顺序：门必须真的在**本账本**里、**还没被决定**、
    署名的人**就是这条门点名的审批人**（`approvers`，ADR-0022 的开单派分事实）⇒ 才落账。
  · `--step deny`      **驳回**：`approval/denied`（同一条判定顺序）；**必须留理由**
    （逐字落 `approval/denied.comment`，好让被拒的人知道为什么）。
  · `--step escalate`  升级：`approval/escalated`（与 `ApprovalService.sweep` 的 escalate 分支**同形**），
    `approvers` 改为目标人，`escalated_to` 记名。
  · `--step delegate`  委托：同上，`action='delegate'`（把门委托给另一个人继续等，不是批准）。
  · `--step abort`     终止：`approval/aborted`（`status='aborted'`，**必须留理由** —— 理由正文**逐字**落
    本行 `comment`（ADR-0023，与 `approval/denied.comment` 同口径），同时保留 `reason_sha256` 作为那份
    0600 待办件的完整性锚点：否则「为什么作废」只能答"哈希在账本里、正文在待办件里"）。

为什么不用 `ApprovalService.sweep()` 做升级/终止：`sweep()` 只处理**已超时**的门，而这里的动作是
"人现在就决定这么做"，且落账时间必须由 `--now` 给（本脚本不读墙钟）。落账 body 与 sweep 的分支**同形**，
状态由 `ApprovalService.replay()` 从账本重放得到 ⇒ 页面上看到的状态与账本一致。
批准/驳回走的是**同一个** `ApprovalService.decide`（语义只有一份），只是把 `at=--now` 显式传进去，
好让"写者不读墙钟"这条在 UI 路径上也成立。

纪律：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ 重算校验（`payload_sha256`/`bytes`/
`submitted_at`）→ 业务前置（门必须真的在本账本里、且**还没被决定** —— 已 granted/denied/aborted 的门
不允许再催/再升级/再终止/再批准：`gate-already-decided`；批准/驳回还要**署名的人就是点名的审批人**：
`approver-not-named`）→ 落账 → 待办件移入 `applied/`。
拒绝路径**账本零新增**，逐条给 `code` + `next_action`；stdout 恰一行 JSON；退出码 0/1/2。

幂等：同一份待办件（逐字节一致）已经归档过 ⇒ `already-applied`、账本零新增（见下面 `archived_before`）。

用法：
  python3 src/system/approval/tools/gate-actions.py --step grant --request <pending.json> \\
      --ledger-contractor .../contractor/ledger.jsonl --now 2026-09-22T16:00:00Z
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.services.approval import TIMEOUT_POLICIES, ApprovalService  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
GATE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:#-]{0,95}$")
SCOPE_RE = re.compile(r"^[a-z][a-z0-9._-]{2,63}$")

SCHEMA = "quotagent/pending/v1"
KIND = "gate-actions"
STEPS = ("request", "grant", "deny", "escalate", "delegate", "abort")
RESOLVED = ("approval/granted", "approval/denied", "approval/aborted")
MAX_FILE_BYTES = 262144
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def deny(code: str, reason: str, next_action: str, step: str, request: str = "") -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "step": step, "request": request, "refusal": refusal(code, reason, next_action)}, 1)


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


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if value:
            return value
    return fallback


def read_pending(path: Path, step: str) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面点动作会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "待办件必须是宿主落的普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600", "chmod 600 后再消费")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限", "拆分后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA or record.get("kind") != KIND:
        return None, refusal("pending-schema-unknown",
                             f"schema/kind 不匹配：{record.get('schema')!r}/{record.get('kind')!r}",
                             "这份待办件不是审批队列动作的载荷")
    if record.get("action") != step:
        return None, refusal("action-mismatch", f"action 不是 {step}：{record.get('action')!r}",
                             "用这一动作的待办件（一步一件）")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与理由正文长度不一致", "让宿主重落待办件")
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
    shutil.move(str(request), str(target))
    return str(target)


def gate_state(rows: list[dict], gate_id: str) -> tuple[str, dict]:
    """该门在账本里的状态：`missing` / `pending` / `decided`（+ 最后一次写入的 body）。"""
    seen = [row for row in rows if str(row.get("type") or "").startswith("approval/")
            and str(body_of(row).get("approval_id") or "") == gate_id]
    if not seen:
        return "missing", {}
    last = seen[-1]
    return ("decided" if str(last.get("type")) in RESOLVED else "pending"), body_of(last)


def bump_counter(approvals: ApprovalService, rows: list[dict]) -> int:
    """把批准序号推到账本里已用过的最大序号之后（`ApprovalService` 每次新进程都从 ap-0001 起）。"""
    highest = 0
    for row in rows:
        suffix = str(body_of(row).get("approval_id") or "").rsplit("-", 1)[-1]
        if str(row.get("type") or "").startswith("approval/") and suffix.isdigit():
            highest = max(highest, int(suffix))
    approvals._counter = highest                      # noqa: SLF001
    return highest


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="审批队列写动作的唯一落账本者（开/升级/委托/终止）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费最早一条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--view", default="contractor")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    step = args.step
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-22T16:00:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "pending": 0,
                         "note": "待办件目录空（空跑，不是失败）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request, step)
    if deny_reason is not None:
        return emit({"ok": False, "step": step, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0, "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", "审批队列的动作是人做的：actor 必须以 human: 开头",
                    "写 human:<你的名字>（agent 不得代催/代升级/代终止）", step, str(request))
    reason = str(record.get("note") or "")
    if step == "abort" and reason.strip() == "":
        return deny("reason-required", "终止一个门必须留理由（事后要能回答\"为什么作废\"）",
                    "在「理由」里写清楚为什么终止", step, str(request))

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    realm = realm_of(rows, f"{args.view}:gui")
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "ledger_added": 0,
                         "duplicates": [{"reason": "already-applied", "key": key}], "refusal": None,
                         "request": str(request),
                         "note": "同一份载荷已经消费过（归档件逐字节一致）：账本零新增（幂等）"}, 0)
    if args.dry_run:
        return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                     "ledger_added": 0, "refusal": None, "note": "干跑：校验通过、账本零新增"}, 0)

    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")

    applied: list[dict] = []
    ledger_added = 0
    out_extra: dict = {}

    if step == "request":
        scope = str(record.get("scope") or "").strip()
        ref = str(record.get("ref") or "").strip()
        if not SCOPE_RE.match(scope):
            return deny("scope-malformed", f"scope 形状非法：{scope!r}",
                        "写 `域名.动作` 形状（如 quote.submit / award.commit）", step, str(request))
        if not REF_RE.match(ref):
            return deny("ref-malformed", f"ref 形状非法：{ref!r}",
                        "写被批对象的 id（如 q-… / aw-… / chg-…）", step, str(request))
        policy = str(record.get("timeout_policy") or "remind").strip()
        if policy not in TIMEOUT_POLICIES:
            return deny("timeout-policy-unknown", f"超时策略必须是 {TIMEOUT_POLICIES}：{policy!r}",
                        "选 remind / escalate / abort（没有「超时自动批准」）", step, str(request))
        try:
            timeout_s = float(record.get("timeout_s") or 3600)
        except (TypeError, ValueError):
            return deny("timeout-s-invalid", f"timeout_s 不是数：{record.get('timeout_s')!r}",
                        "给秒数（如 86400）", step, str(request))
        if timeout_s <= 0 or timeout_s > 90 * 24 * 3600:
            return deny("timeout-s-out-of-range", f"timeout_s 越界：{timeout_s}",
                        "给 (0, 7776000] 内的秒数", step, str(request))
        escalate_to = str(record.get("escalate_to") or "").strip()
        if policy == "escalate" and not escalate_to.startswith("human:"):
            return deny("escalate-to-required", "policy=escalate 必须给人类上级（escalate_to 以 human: 开头）",
                        "写 human:<上级名字>", step, str(request))
        approvers = [str(who).strip() for who in (record.get("approvers") or []) if str(who).strip()]
        if not approvers:
            approvers = [actor]
        bad = [who for who in approvers if not str(who).startswith("human:")]
        if bad:
            return deny("approver-not-human", f"审批人必须是人：{bad}",
                        "审批人写 human:<名字>（agent 不得代批）", step, str(request))
        approvals = ApprovalService(ledger=ledger, actor=actor)
        bump_counter(approvals, rows)
        request_row = approvals.request(scope, {"ref": ref, "reason_sha256": digest_of(reason)},
                                        ref=ref, approvers=approvers, reason=reason,
                                        timeout_policy=policy, timeout_s=timeout_s,
                                        escalate_to=escalate_to or None,
                                        summary=str(record.get("summary") or "")[:120] or None)
        applied.append({"event": "approval/requested", "approval_id": request_row["approval_id"],
                        "scope": scope, "ref": ref, "timeout_policy": policy, "timeout_s": timeout_s,
                        "approvers": approvers, "escalate_to": escalate_to or None})
        ledger_added += 1
        out_extra = {"approval_id": request_row["approval_id"], "scope": scope, "ref": ref,
                     "timeout_policy": policy, "timeout_s": timeout_s, "approvers": approvers}
    else:
        gate_id = str(record.get("gate_id") or "").strip()
        if not GATE_ID_RE.match(gate_id):
            return deny("gate-id-malformed", f"gate_id 形状非法：{gate_id!r}",
                        "从审批队列卡片上取真门 id（形如 ap-0007）", step, str(request))
        state, last_body = gate_state(rows, gate_id)
        if state == "missing":
            return deny("gate-not-found", f"本账本里没有这个门：{gate_id}",
                        "看审批队列列出的真门 id（不猜、不凭 URL）", step, str(request))
        if state == "decided":
            return deny("gate-already-decided",
                        f"门 {gate_id} 已经被决定过（状态 {last_body.get('status')}）："
                        "催办/升级/终止都不能绕过判定",
                        "已决定的门不再出现在队列里；要重新发起就再开一个门（--step request）", step, str(request))
        if step in ("grant", "deny"):
            # ---- **批准 / 驳回**（DEF-008）：审批队列存在的唯一理由 ------------------------------
            # 判定顺序（全部在写之前；任一不通过 ⇒ 账本零新增）：
            #   ① 门真的在**本账本**里（上面 `gate-not-found`）② 还没被决定（上面 `gate-already-decided`）
            #   ③ 署名的人**就是这条门点名的审批人**（`approvers`；开单时随 `approval/requested` 落进账本，
            #      ADR-0022）。没点名审批人的旧门（`approvers` 为空）按缺省放行 —— 不知道给谁就是谁都能决定，
            #      不凭空编一个审批人，也不因此把旧门锁死。
            if step == "deny" and reason.strip() == "":
                return deny("reason-required", "驳回必须留理由（要把\"为什么不行\"逐字落进账本给被拒的人看）",
                            "在「驳回理由」里写清楚；理由会进 `approval/denied.comment`", step, str(request))
            named = [str(who).strip() for who in (last_body.get("approvers") or []) if str(who).strip()]
            if named and actor not in named:
                return deny("approver-not-named",
                            f"{actor} 不是门 {gate_id} 点名的审批人（点名：{'、'.join(named)}）："
                            "审批权在开单时就定了，别的人批不了这一条",
                            "让点名的审批人本人签（署名==会话身份）；要换人先把门升级/委托给他"
                            "（--step escalate / --step delegate），或重新开一个门", step, str(request))
            approvals = ApprovalService(ledger=ledger, actor=actor)
            try:
                decided = approvals.decide(gate_id, by=actor,
                                           decision="granted" if step == "grant" else "denied",
                                           comment=reason, at=args.now)
            except Exception as exc:  # noqa: BLE001  服务的判定就是判定：原样报出来（不吞、不假设成功）
                return deny("decide-refused", f"{type(exc).__name__}: {exc}",
                            "看这条门在账本里的状态（队列卡片上「卡在谁/已决定」）；本动作账本零新增",
                            step, str(request))
            applied.append({"event": "approval/granted" if step == "grant" else "approval/denied",
                            "approval_id": gate_id, "scope": decided.get("scope"),
                            "ref": decided.get("ref"), "by": actor,
                            "decided_at": decided.get("decided_at"),
                            "comment_sha256": digest_of(reason)})
            ledger_added += 1
            out_extra = {"approval_id": gate_id, "scope": decided.get("scope"), "ref": decided.get("ref"),
                         "status": decided.get("status"), "decided_by": actor,
                         "comment": reason, "decided_at": decided.get("decided_at")}
        elif step in ("escalate", "delegate"):
            target = str(record.get("escalate_to") or "").strip()
            if not target.startswith("human:"):
                return deny("escalate-to-required", f"{step} 必须给目标人（escalate_to 以 human: 开头）：{target!r}",
                            "写 human:<接手的人>（推荐用「授权区间」页给出的下一角色）", step, str(request))
            body = {**last_body, "action": step, "policy": "escalate", "escalated_to": target,
                    "escalated_by": actor, "escalated_at": args.now, "approvers": [target],
                    "last_action_at": args.now,
                    "note": ("转上级继续等待人类决定（仍不批准）" if step == "escalate"
                             else "委托给另一个人继续等待人类决定（仍不批准）"),
                    "reason_sha256": digest_of(reason)}
            ledger.append("approval/escalated", body, correlation_id=last_body.get("ref") or gate_id,
                          actor=actor, ts=args.now,
                          refs={"approval_id": gate_id, "scope": last_body.get("scope") or ""})
            applied.append({"event": "approval/escalated", "approval_id": gate_id, "action": step,
                            "escalated_to": target, "by": actor})
            ledger_added += 1
            out_extra = {"approval_id": gate_id, "escalated_to": target, "scope": last_body.get("scope")}
        else:  # abort
            body = {**last_body, "action": "abort", "status": "aborted", "aborted_by": actor,
                    "aborted_at": args.now, "last_action_at": args.now, "reason_sha256": digest_of(reason),
                    # **终止的理由正文逐字进账本**（与 `approval/denied.comment` 同口径）：ADR-0023。
                    # 为什么必须进：审计型产品的底线是「一屏答出谁、何时、**为什么**、依据哪一行」，而
                    # 修前只有 `reason_sha256` ⇒ 理由正文只活在 0600 待办件里 ⇒ 「为什么作废」永远答不出。
                    # 追加型：**新行**多这一个键；旧行一个字节不动（读侧缺 `comment` 时按缺省显示哈希）。
                    # `reason_sha256` 仍保留：它是那份 0600 待办件的完整性锚点（正文与哈希可互证）。
                    "comment": reason,
                    "note": "作废本次意图（需重新发起）；不得解释为批准或拒绝"}
            ledger.append("approval/aborted", body, correlation_id=last_body.get("ref") or gate_id,
                          actor=actor, ts=args.now,
                          refs={"approval_id": gate_id, "scope": last_body.get("scope") or ""})
            applied.append({"event": "approval/aborted", "approval_id": gate_id, "by": actor,
                            "reason_sha256": body["reason_sha256"]})
            ledger_added += 1
            out_extra = {"approval_id": gate_id, "scope": last_body.get("scope")}

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    hint = {
        "request": "门已开：它会出现在审批队列里（可等）；等待时长与超时策略由队列页按事实时刻算。",
        "grant": "已批准：落 `approval/granted`（带署名与意见）；这条门不再出现在待批里，"
                 "下游承诺动作现在能过 INV-005 的批准门了。",
        "deny": "已驳回：落 `approval/denied`（理由逐字进账本 `comment`）；要重来就再开一个门"
                "（原门不会被\"再批一次\"翻案）。",
        "escalate": "已升级：队列里的「卡在谁」与已催/已升级历史都会跟着变；升级**不是批准**。",
        "delegate": "已委托：门转给目标人继续等（仍不批准）。",
        "abort": "已终止：本次意图作废（需重新发起）；理由正文逐字进了 `approval/aborted.comment`"
                 "（同时留 `reason_sha256` 作完整性锚点）⇒ 「为什么作废」现在能从账本回读到，不必去找待办件。",
    }[step]
    return emit({"ok": True, "step": step, "event": applied[-1]["event"] if applied else None,
                 "applied": applied, "duplicates": [], "ledger_added": ledger_added, "refusal": None,
                 "request": str(request), "archived": archived, "view": args.view,
                 "by": actor, "at": args.now, "next_action_runtime": hint,
                 "note": "六个步都只落已登记的事件：approval/requested | approval/granted | approval/denied | "
                         "approval/escalated | approval/aborted；"
                         "催办（gate/nudged）走既有唯一写者 src/domain/gate-timeline/tools/gate-nudge.py",
                 **out_extra}, 0)


def crash_guard(fn, argv):
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
