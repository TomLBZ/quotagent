#!/usr/bin/env python3
"""src/domain/negotiation/tools/negotiate-actions.py —— **谈判面写动作的唯一落账本者**（DEF-020）。

谈判在 APP 内本来**一个入口都没有**（旧口径只给计数）。这条补上三步，全部走**既有服务**
`NegotiationService`（语义只有一份，本脚本不另写一套判定）：

  · `--step request-concession`  为一轮价格让步**请求人工批准**：落 `approval/requested`
    （scope 恰 `negotiate.price-concession`，ref 恰 `<thread_id>:a<attempt_no>`，与契约 §2.3 同形）。
    这一步是 `submit_round` 的前置门：**没有批准记录，轮次一定被拒**（INV-005 / FR-NEGO-002）。
  · `--step round`               提交一轮：走 `negotiate/round` 的 **serial 判定链**
    （维度 → 轮次上限 → 让步幅度 → 底线 → 区间 → 人工门）。越界/越限**不落 round**，落
    `negotiate/round-rejected` 留痕并具名拒（`concession-over-limit` / `round-limit-exceeded` / …）。
  · `--step close`               关闭线程：落 `negotiate/closed`（**不产生义务**：无 commitment、无 PO）。

纪律（与 `gate-actions.py` / `evidence-pack-export.py` 同一套）：权限门（恰 0600 普通文件）→ 形状门
（schema/kind/action）→ 重算校验（`payload_sha256`/`bytes`/`submitted_at`）→ 业务前置（线程真的在**本账本**里、
开着；`request-concession`/`close` 要**人**：`actor` 必须 `human:`）→ 落账 → 待办件移入 `applied/`。
**不读墙钟**：落账时刻由 `--now` 给（`service.write_ts = --now`），与 `usage.md` §7.3 同一口径。
拒绝路径**账本零新增**（被拒的 *轮次* 会按契约落一条 `negotiate/round-rejected` —— 那是**判定链自己**的留痕，
不是本脚本"写入了一件成功的事"；回执里 `ok=false` 且 `ledger_added` 如实报 1 条留痕）。

用法：
  python3 src/domain/negotiation/tools/negotiate-actions.py --step close --request <pending.json> \\
      --ledger-supplier .../supplier/ledger.jsonl --now 2026-09-23T12:00:00Z
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

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402
from quotagent.services.approval import ApprovalService  # noqa: E402
from quotagent.services.negotiation import (  # noqa: E402
    CONCESSION_SCOPE, NegotiationError, NegotiationService, OUTCOMES,
)

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
THREAD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")

SCHEMA = "quotagent/pending/v1"
KIND = "negotiate-actions"
STEPS = ("request-concession", "round", "close")
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


def deny(code: str, reason: str, next_action: str, step: str, request: str = "",
         ledger_added: int = 0, event: str | None = None) -> int:
    return emit({"ok": False, "event": event, "applied": [], "duplicates": [],
                 "ledger_added": ledger_added, "step": step, "request": request,
                 "refusal": refusal(code, reason, next_action)}, 1)


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


def read_pending(path: Path, step: str) -> tuple[dict | None, dict | None]:
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
    if record.get("schema") != SCHEMA or record.get("kind") != KIND:
        return None, refusal("pending-schema-unknown",
                             f"schema/kind 不匹配：{record.get('schema')!r}/{record.get('kind')!r}",
                             "这份待办件不是谈判面动作的载荷")
    if record.get("action") != step:
        return None, refusal("action-mismatch", f"action 不是 {step}：{record.get('action')!r}",
                             "用这一动作的待办件（一步一件）")
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


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="谈判面写动作的唯一落账本者（请求让步门 / 提交一轮 / 关闭线程）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="", help="待办件路径（0600 JSON）")
    parser.add_argument("--inbox", default="", help="待办件目录（消费最早一条）")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--view", default="contractor")
    parser.add_argument("--now", default="", help="落账时刻（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    step = args.step
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-23T12:00:00Z")

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
    thread_id = str(record.get("thread_id") or "").strip()
    if not THREAD_RE.match(thread_id):
        return deny("thread-id-malformed", f"thread_id 形状非法：{thread_id!r}",
                    "从「谈判」面板的线程卡片上取真线程 id（nt-…）", step, str(request))
    if step == "close" and not actor.startswith("human:"):
        return deny("human-required", "关闭线程是人做的：actor 必须以 human: 开头",
                    "写 human:<你的名字>（agent 不得代关）", step, str(request))
    if step == "request-concession" and not actor.startswith("human:"):
        return deny("human-required", "价格让步的批准请求是人发起并署名的：actor 必须以 human: 开头",
                    "写 human:<你的名字>", step, str(request))
    if step == "round" and not actor.startswith("human:"):
        return deny("human-required", "提交一轮要有人负责：actor 必须以 human: 开头",
                    "写 human:<你的名字>", step, str(request))

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

    # 服务装配：唯一实现（`NegotiationService`），判定链注册到**本次运行**的事件总线；
    # `cost_service` / `pricing` 只在 `open_thread` 时需要（本题不开放线程），故按 None 传入 ——
    # 轮次/关闭用的边界数字来自**账本里已声明的** `negotiate/bounds-declared`（不读成本模型）。
    bus = EventBus()
    bus.install_defaults()
    approvals = ApprovalService(ledger=ledger, actor=actor)
    service = NegotiationService(cost_service=None, pricing=None, approval=approvals, ledger=ledger,
                                 events=bus, actor=actor)
    service.write_ts = args.now            # 落账时刻由写者给（本脚本不读墙钟）
    service.attach_defaults()

    try:
        thread = service.get_thread(thread_id)
    except Exception as exc:  # noqa: BLE001  UnknownThread：本账本里没有这条线程 ⇒ 具名拒
        return deny("thread-not-found", f"本账本里没有这条谈判线程：{thread_id}（{exc}）",
                    "看「谈判」面板列出的真线程 id（不猜、不凭 URL）", step, str(request))

    before = len(rows)
    applied: list[dict] = []
    out_extra: dict = {}

    # 让步动作的形状（契约 §2.1：`{dimension, item_id, from, to, unit}`；`dimension` 只接受 'price'）——
    # 由**写者**统一补齐，调用方（界面）只给"条目 / 从 / 到"这三样人真正要填的东西。
    def move_of() -> dict:
        return {"dimension": "price",
                "item_id": str(record.get("item_id") or thread.get("item_id") or ""),
                "unit": str(record.get("unit") or "unit-price"),
                "from": float(record.get("from")), "to": float(record.get("to"))}

    try:
        if step == "request-concession":
            gate = service.request_concession(thread_id, move_of(), reason=str(record.get("note") or ""),
                                              timeout_policy=str(record.get("timeout_policy") or "remind"),
                                              timeout_s=float(record.get("timeout_s") or 3600))
            applied.append({"event": "approval/requested", "approval_id": gate["approval_id"],
                            "scope": CONCESSION_SCOPE, "ref": gate["ref"]})
            out_extra = {"approval_id": gate["approval_id"], "scope": CONCESSION_SCOPE,
                         "ref": gate["ref"], "attempt_no": service.rounds_used(thread_id) + 1}
        elif step == "round":
            approval_id = str(record.get("approval_id") or "").strip() or None
            round_view = service.submit_round(thread_id, move=move_of(),
                                              rationale=str(record.get("note") or ""),
                                              approval_id=approval_id)
            applied.append({"event": "negotiate/round", "round_id": round_view["round_id"],
                            "thread_id": thread_id, "attempt_no": round_view["attempt_no"],
                            "status": round_view.get("status"), "delta_pct": round_view.get("delta_pct"),
                            "in_band": round_view.get("in_band")})
            out_extra = {"round_id": round_view["round_id"], "attempt_no": round_view["attempt_no"],
                         "delta_pct": round_view.get("delta_pct"), "in_band": round_view.get("in_band")}
        else:  # close
            outcome = str(record.get("outcome") or "").strip()
            if outcome not in OUTCOMES:
                return deny("outcome-unknown", f"outcome 必须是 {list(OUTCOMES)} 之一：{outcome!r}",
                            "选 accepted / rejected / withdrawn / limit-reached", step, str(request))
            closed = service.close(thread_id, outcome=outcome, by=actor,
                                   comment=str(record.get("note") or ""))
            applied.append({"event": "negotiate/closed", "thread_id": thread_id, "outcome": outcome,
                            "by": actor, "rounds_used": closed.get("rounds_used")})
            out_extra = {"outcome": outcome, "rounds_used": closed.get("rounds_used")}
    except NegotiationError as exc:
        # 判定链的结论（含被拒轮次：契约 §2.2 要求落 `negotiate/round-rejected` 留痕）——
        # 如实报：`ok=false`，`ledger_added` 只数**判定链自己**落的那条留痕（0 或 1）。
        rows_after, _err = load_rows(ledger_path)
        added = (len(rows_after) - before) if rows_after is not None else 0
        rejection = None
        if rows_after:
            for row in reversed(rows_after):
                if str(row.get("type")) == "negotiate/round-rejected":
                    rejection = row
                    break
        return deny("negotiation-refused", f"{type(exc).__name__}: {exc}",
                    "看「谈判」面板的线程卡片（还能让多少 / 还剩几轮）；"
                    + "让步要过人工门（先申请批准，再提交同一轮的 approval_id）",
                    step, str(request), ledger_added=added,
                    event="negotiate/round-rejected" if rejection and added else None)
    except (TypeError, ValueError) as exc:
        return deny("move-invalid", f"让步的数字不对：{exc}",
                    "from/to 都要给正数单价（与线程条目同一 item_id）", step, str(request))

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    hint = {
        "request-concession": f"门 {out_extra.get('approval_id')} 已开：去「审批队列」由点名的审批人"
                              "**批准**（approval/granted）——批准后回来提交同一轮（带上这个 approval_id）",
        "round": "这一轮已落 `negotiate/round`（带边界数字与引用），线程卡片上的「已用轮次 / 还剩几轮」跟着变",
        "close": "线程已关闭：落 `negotiate/closed`（**不产生义务**：无承诺、无 PO、无对外报价）",
    }[step]
    return emit({"ok": True, "step": step, "event": applied[-1]["event"], "applied": applied,
                 "duplicates": [], "ledger_added": len(applied), "refusal": None,
                 "request": str(request), "archived": archived, "view": args.view,
                 "by": actor, "at": args.now, "thread_id": thread_id,
                 "next_action_runtime": hint,
                 "note": "三步都只落已登记的事件：approval/requested（scope=negotiate.price-concession）| "
                         "negotiate/round | negotiate/closed；被拒轮次由判定链落 negotiate/round-rejected",
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
