#!/usr/bin/env python3
"""把 P2 新服务（谈判 / FAQ / 邮件）的运维快照写到 `tmp/ui-shared/pipeline.json`（契约 §2）。

为什么这样分工：判定属于**事实层**（Python，ADR-0012），宿主只做展示聚合
（`pipeline-view` 插件只组合不自算）。本工具**只读账本**（不新增、不修改任何账本行），
计数与"最近事件"一律由三个服务的 `replay()` / 只读访问器重建 —— 判定逻辑不在这里重写。

形状（`docs/design/20-pipeline-snapshot-contract.md` §2，键名即契约）::

    {"generated_at": "<ISO8601>",
     "views": {"<view>": {"negotiate": {"threads", "open", "closed", "rounds", "rejected", "last",
                                        "recent": [{"thread_id", "attempt_no", "status"}]},
                          "faq":       {"entries", "revs", "last",
                                        "recent": [{"entry_id", "rfq_rev"}]},
                          "mail":      {"queued", "refused", "transport": {...}}}}}

`recent` 是**有界的最近列表**（业务双方视角要看的"最近发生了什么"）：`negotiate/*` 取 `negotiate/round`、
`faq/*` 取 `faq/entry-published`，一律**按账本 seq 倒序、至多 `RECENT_LIMIT` 条**，每条**只出**
上面那三个 / 两个键（id / 序号 / 状态），缺失的键写 `null`（**不补默认值**）；空时给 `[]`（字段不少给）。

**缺账本或缺事件时给全零形状**（字段不少给），不猜、不补默认值 —— 也不给"看起来健康的零"
（账本不存在就真的没有事实可报；哈希链校验失败会在 stderr 明说，见下）。

契约 §2 的"禁止"（自查纪律）：
· 只出 id / 序号 / 状态 / 计数：不出正文、主旨、附件内容；不出 `reserve_price` / `cost_model` /
  `signature` / `private:` 这些私域键。
· 除 `generated_at` 外不写任何时间键：账本行的 `ts`（以及 FAQ 条目的 `published_at`）只用来定序，
  **不进快照** —— `recent` 一律按账本 `seq` 倒序（与 `ts` 无关），因此同一账本两次运行定序不变。
· 确定性：同一账本两次运行，除 `generated_at` 外逐字节一致（键全排序、列表定序、不读墙钟除元数据）。

视角 → 账本布局（`--shared-dir`，默认 `tmp/ui-shared`）：按固定顺序找
`<shared>/<view>/ledger.jsonl` → `<shared>/<view>.jsonl` → `<shared>` 下排序后的第一个 `*.jsonl`
（扁平布局：调用方直接指向单个账本所在目录）。**找不到就不建文件**（绝不为了读而创建账本），
按空账本给全零形状。视角 = 账本文件本身，因此不再按行的 `realm` 二次过滤
（否则像 `contractor:con-B` 这样的 realm 会被整本藏掉，快照就成了假的零）。

用法::

    python3 tools/refresh-ui-snapshots.py                       # 两个视角，默认目录
    python3 tools/refresh-ui-snapshots.py --views contractor
    python3 tools/refresh-ui-snapshots.py --views contractor,supplier --shared-dir tmp/ui-shared
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402
from quotagent.services.faq import ENTRY_PUBLISHED_EVENT, FaqService  # noqa: E402
from quotagent.services.mail import MailService  # noqa: E402
from quotagent.services.negotiation import (  # noqa: E402
    BOUNDS_DECLARED_EVENT,
    CLOSED_EVENT,
    OPENED_EVENT,
    ROUND_EVENT,
    ROUND_REJECTED_EVENT,
    NegotiationService,
)

#: 契约 §2 声明的两个视角（顺序固定 → 迭代顺序固定）
VIEWS = ("contractor", "supplier")
#: 默认共享目录 = 仓库内 `tmp/ui-shared`（账本 `<shared>/<view>/ledger.jsonl`，输出 `<shared>/pipeline.json`）
DEFAULT_SHARED = ROOT / "tmp" / "ui-shared"
LEDGER_NAME = "ledger.jsonl"
#: 服务用的 realm 一律留空：视角就是账本文件，读侧不再按 realm 过滤（见模块 docstring）
ALL_REALMS = ""

#: `negotiate/*` → 快照里的 `kind`（只有类别名，不带任何正文/原因/码）
KIND_BY_EVENT = {
    OPENED_EVENT: "opened",
    BOUNDS_DECLARED_EVENT: "bounds-declared",
    ROUND_EVENT: "round",
    ROUND_REJECTED_EVENT: "rejected",
    CLOSED_EVENT: "closed",
}
#: 轮次视图里"已落账的轮次"的状态（`replay()` 里 `negotiate/round` 一律给这个状态）；
#: 其余状态（`awaiting_approval` / `rejected` / `aborted`）都是**没落成事实的尝试**
LANDED_ROUND_STATUS = "conceded"
#: 契约 §2 的"最近列表"上限：**有界**（至多 5 条），只出 id / 序号 / 状态 —— 不出正文
RECENT_LIMIT = 5


class _NoGate:
    """占位门：本工具只调服务的 `replay()`/只读访问器，不提交轮次，因此门永不被询问。

    真实的门属于事实层（`ctx.approval`，只能由 `human:*` 决定）—— 快照写入器既不请求也不判定。
    """

    def require(self, **kwargs):  # pragma: no cover - 正常路径不会走到
        raise RuntimeError("快照写入器不做判定：不调用 approval.require（判定属于事实层）")


# ---------------------------------------------------------------------------
# 账本定位（只读；不存在返回 None，绝不创建）
# ---------------------------------------------------------------------------
def _ledger_path(shared: Path, view: str) -> Path | None:
    for candidate in (shared / view / LEDGER_NAME, shared / f"{view}.jsonl"):
        if candidate.is_file():
            return candidate
    flat = sorted(item for item in shared.glob("*.jsonl") if item.is_file())
    return flat[0] if flat else None


def _open(path: Path | None) -> Ledger | None:
    """打开账本（只读）。哈希链校验失败时在 stderr 明说，但**不假装**没有数据。"""
    if path is None:
        return None
    ledger = Ledger(path, realm="ui-snapshot")
    if not ledger.healthy:
        report = ledger.open_failure or {}
        print(f"refresh-ui-snapshots: 警告：账本 {path} 哈希链校验失败"
              f"（first_bad_seq={report.get('first_bad_seq')}，{report.get('reason')}）"
              f"，计数只覆盖可读行", file=sys.stderr)
    return ledger


# ---------------------------------------------------------------------------
# 小工具（计数/序号一律从服务与账本行来，不做任何自己的判定）
# ---------------------------------------------------------------------------
def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _display(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def _as_text(value) -> str | None:
    """展示用标识：缺失给 `None`（**不补默认值**、不猜），有值就给字符串。"""
    return None if value is None else str(value)


def _body(row: dict) -> dict:
    """账本行的 `body`（畸形/缺失时给空 dict —— 只影响这一条，不猜内容）。"""
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def _recent_rows(rows: list, event: str) -> list:
    """某域按 **seq 倒序**的最近 `RECENT_LIMIT` 条行（有界；`seq` 是账本序号，定序与 `ts`/墙钟无关）。"""
    picked = [row for row in rows if str(row.get("type")) == event]
    picked.sort(key=lambda row: _as_int(row.get("seq")) or 0)
    return list(reversed(picked[-RECENT_LIMIT:]))


# ---------------------------------------------------------------------------
# 三个域
# ---------------------------------------------------------------------------
def _negotiate(ledger: Ledger | None, rows: list) -> dict:
    """谈判：线程/开关/轮次/被拒尝试 + 最近一条 `negotiate/*` 事件 + 最近轮次列表（只出 id/序号/状态）。"""
    service = NegotiationService(cost_service=None,  # type: ignore[arg-type] 只调 replay()：不触碰成本/定价
                                 pricing=None,  # type: ignore[arg-type]
                                 approval=_NoGate(), ledger=ledger, events=None, policy={})
    replayed = service.replay()
    threads = service.threads()
    rounds = 0
    rejected = 0
    for thread_id in replayed.get("order") or []:
        for record in service.rounds(thread_id):
            if str(record.get("status")) == LANDED_ROUND_STATUS:
                rounds += 1
            else:
                rejected += 1
    return {
        "threads": int(replayed.get("replayed") or 0),
        "open": sum(1 for thread in threads if str(thread.get("status")) == "open"),
        "closed": sum(1 for thread in threads if str(thread.get("status")) == "closed"),
        "rounds": rounds,
        "rejected": rejected,
        "last": _negotiate_last(rows),
        "recent": _negotiate_recent(rows),
    }


def _negotiate_recent(rows: list) -> list[dict]:
    """最近 `RECENT_LIMIT` 条 `negotiate/round` 行（**按 seq 倒序**），每条**只出**三个键。

    直接读账本行、不重放判定：`status` 照抄行里的值（缺失写 `null`，**不补** `conceded`）——
    快照只报事实，不替事实层说话。空域给 `[]`（字段不少给）。
    """
    def one(row: dict) -> dict:
        body = _body(row)
        return {"thread_id": _as_text(body.get("thread_id")),
                "attempt_no": _as_int(body.get("attempt_no")),
                "status": _as_text(body.get("status"))}
    return [one(row) for row in _recent_rows(rows, ROUND_EVENT)]


def _negotiate_last(rows: list) -> dict:
    """最近一条 `negotiate/*` 行（按 seq）= 账本里该域的最后一条事实；缺事件时给 `{}`。"""
    picked = None
    for row in rows:
        if str(row.get("type")) in KIND_BY_EVENT:
            picked = row
    if picked is None:
        return {}
    body = picked.get("body") or {}
    out: dict[str, object] = {}
    if body.get("thread_id") is not None:
        out["thread_id"] = str(body.get("thread_id"))
    out["kind"] = KIND_BY_EVENT[str(picked.get("type"))]
    attempt_no = _as_int(body.get("attempt_no"))
    if attempt_no is not None:
        out["attempt_no"] = attempt_no
    return out


def _faq(ledger: Ledger | None, rows: list) -> dict:
    """FAQ：条目数 + 版本号集合（`rfq_rev`）+ 最近发布的条目 id/版本 + 最近条目列表。"""
    service = FaqService(realm=ALL_REALMS, ledger=ledger, events=None)
    replayed = service.replay()
    entries = service.entries()
    revs = sorted({value for value in (_as_int(entry.get("rfq_rev")) for entry in entries)
                   if value is not None})
    return {"entries": int(replayed.get("replayed") or 0), "revs": revs, "last": _faq_last(entries),
            "recent": _faq_recent(rows)}


def _faq_last(entries: list) -> dict:
    """最近发布的条目（按账本行的 `ts`，其次 `entry_id` 定序）；没有条目时给 `{}`。"""
    if not entries:
        return {}
    latest = max(entries, key=lambda entry: (str(entry.get("published_at") or ""),
                                             str(entry.get("entry_id") or "")))
    out = {"entry_id": str(latest.get("entry_id") or "")}
    rev = _as_int(latest.get("rfq_rev"))
    if rev is not None:
        out["rfq_rev"] = rev
    return out


def _faq_recent(rows: list) -> list[dict]:
    """最近 `RECENT_LIMIT` 条 `faq/entry-published` 行（**按 seq 倒序**），每条**只出** entry_id/`rfq_rev`。

    定序用账本 `seq`（不是条目的 `published_at`）：同一次发布两遍写出仍然逐字节一致。
    """
    def one(row: dict) -> dict:
        body = _body(row)
        return {"entry_id": _as_text(body.get("entry_id")), "rfq_rev": _as_int(body.get("rfq_rev"))}
    return [one(row) for row in _recent_rows(rows, ENTRY_PUBLISHED_EVENT)]


def _mail(ledger: Ledger | None) -> dict:
    """邮件：已入队（同 `message_id` 去重）/ 被拒条数 + 传输能力三件（D-052：没有就说没有）。"""
    service = MailService(realm=ALL_REALMS, ledger=ledger, events=None)
    replayed = service.replay()
    status = service.transport_status()
    return {
        "queued": int(replayed.get("replayed") or 0),
        "refused": len(service.refused()),
        "transport": {"available": bool(status.get("available")),
                      "reason": str(status.get("reason") or ""),
                      "next_action": str(status.get("next_action") or "")},
    }


def _view(shared: Path, view: str) -> dict:
    """一个视角的三域快照（账本不存在 → 三域全零形状）。"""
    path = _ledger_path(shared, view)
    ledger = _open(path)
    rows = [] if ledger is None else ledger.read()
    return {"negotiate": _negotiate(ledger, rows), "faq": _faq(ledger, rows), "mail": _mail(ledger)}


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def main(argv: list | None = None) -> int:
    parser = argparse.ArgumentParser(prog="refresh-ui-snapshots",
                                     description="把谈判/FAQ/邮件的运维快照写到 <shared-dir>/pipeline.json")
    parser.add_argument("--views", default=",".join(VIEWS),
                        help=f"逗号分隔的视角（默认 {'/'.join(VIEWS)}）")
    parser.add_argument("--shared-dir", default=str(DEFAULT_SHARED),
                        help="共享目录：账本在 <shared-dir>/<view>/ledger.jsonl，快照写 <shared-dir>/pipeline.json")
    args = parser.parse_args(argv)

    selected = [item.strip() for item in str(args.views).split(",") if item.strip()]
    if not selected:
        print(json.dumps({"ok": False, "error": "没有指定视角：--views 不能为空"}, ensure_ascii=False))
        return 2
    unknown = [item for item in selected if item not in VIEWS]
    if unknown:
        print(json.dumps({"ok": False, "error": f"未知视角 {unknown}；已声明: {list(VIEWS)}"},
                         ensure_ascii=False))
        return 2

    shared = Path(args.shared_dir).expanduser()
    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "views": {view: _view(shared, view) for view in VIEWS if view in selected},
    }
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1)

    target = shared / "pipeline.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".json.tmp")     # 原子写：先 .tmp 再 replace
    tmp.write_text(blob, encoding="utf-8")
    tmp.replace(target)

    summary = {view: {"negotiate": {"threads": body["negotiate"]["threads"],
                                    "open": body["negotiate"]["open"],
                                    "closed": body["negotiate"]["closed"],
                                    "rounds": body["negotiate"]["rounds"],
                                    "rejected": body["negotiate"]["rejected"],
                                    "recent": len(body["negotiate"]["recent"])},
                      "faq": {"entries": body["faq"]["entries"], "revs": body["faq"]["revs"],
                              "recent": len(body["faq"]["recent"])},
                      "mail": {"queued": body["mail"]["queued"], "refused": body["mail"]["refused"],
                               "transport_available": body["mail"]["transport"]["available"]}}
               for view, body in payload["views"].items()}
    print(json.dumps({"ok": True, "out": _display(target), "bytes": len(blob.encode("utf-8")),
                      "views": summary}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
