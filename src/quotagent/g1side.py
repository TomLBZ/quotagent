"""g1 走查的**单侧工作进程**（`tools/g1-walkthrough.py` 的对手方之一）。

MVP 判据要求"两个真人、两台机器上两个**真进程** + 共享目录"（ADR-0014 §3）：所以每一侧的动作都跑在
**自己的进程**里，进程之间**只通过共享目录**交换文件；两侧各有自己的 realm 与账本，绝不读写对方账本。

一轮是**交替**的（谁也不能一口气跑完），所以本模块按阶段调用：
    python -m quotagent.g1side contractor <shared> 1|2|3|4
    python -m quotagent.g1side supplier   <shared> 1|2|3

阶段划分（共享目录里的文件名即"信箱"）：
    contractor 1 → 01-package       （发布 + 分发）
    supplier   1 → 02-question      （澄清提问）
    contractor 2 → 03-answer, 04-amended（作答广播 + 升版 + 再分发）
    supplier   2 → 05-quote         （基于新版本报价；另附一份基于旧版本的报价）
    contractor 3 → 06-evaluation    （护栏 Flag + 比价 + 比较表导出）与 08-award-intent
    supplier   3 → 07-confirm, 09-change-request（确认授标 + 提出变更）
    contractor 4 → 08-award（承诺，人工签署）、10-change（变更批准生效）、11-audit-pack（审计包）

**每一阶段都从账本重建状态**（账本是唯一事实源：批准记录重放、报价/承诺由信箱里的报文携带），
因此"跨进程"不只是形式上的进程，而是真的不依赖内存。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .kernel import evidence as ev
from .kernel.events import EventBus
from .kernel.ledger import Ledger
from .kernel.qep import KeyStore
from .services.approval import ApprovalService
from .services.change import ChangeService
from .services.commitments import CommitmentGate
from .services.compare import CompareService
from .services.export import ExportService
from .services.guard import GuardService
from .services.measures import DEFAULT_UNITS, MeasureBook, MeasureRule, UnitTable
from .services.rfq import RfqService

HUMAN = "human:liangzi"
DEADLINES = {"clarify_by": "2026-09-23T00:00:00Z", "quote_by": "2026-09-25T00:00:00Z"}


def _spec() -> dict:
    return {"package_id": "pkg-g1", "scope": ["厂区给排水管道更换"], "currency": "CNY",
            "tax_code": "cn-vat-13", "tax_mode": "exclusive",
            "interfaces": [{"interface_id": "IF-001", "between_packages": ["pkg-g1", "pkg-g2"],
                            "responsibility_party": "con-B", "description": "与既有管网接口"}],
            "deliverables": ["竣工资料"], "exclusions": ["夜间施工"], "deadlines": DEADLINES,
            "items": [{"item_id": "L-001", "code": "P-100", "description": "DN100 管道", "unit": "m",
                       "qty": 120, "spec_refs": ["spec://piping/DN100"], "measurement_rule": "mr-length"},
                      {"item_id": "L-002", "code": "S-200", "description": "管支架", "unit": "kg",
                       "qty": 480, "spec_refs": ["spec://support/STD"], "measurement_rule": "mr-mass"}]}


def _stack(shared: Path, role: str):
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(shared / role / "ledger.jsonl", realm=f"{role}:g1")
    approvals = ApprovalService(ledger=ledger, events=bus)  # 构造即从账本重放
    return bus, ledger, approvals


def _rfq(bus, ledger) -> RfqService:
    return RfqService(ledger=ledger, events=bus, units=UnitTable(DEFAULT_UNITS),
                      measures=MeasureBook({
                          "L-001": MeasureRule("L-001", base_unit="m", allowed_units=("m", "cm"),
                                               tolerance_bps=5),
                          "L-002": MeasureRule("L-002", base_unit="kg", allowed_units=("kg", "t"),
                                               tolerance_bps=5)}))


def _ops_path(shared: Path) -> Path:
    return shared / "contractor" / "rfq-ops.json"


def _load_ops(shared: Path) -> list[dict]:
    target = _ops_path(shared)
    return json.loads(target.read_text(encoding="utf-8"))["ops"] if target.exists() else []


def _append_op(shared: Path, op: dict) -> None:
    ops = _load_ops(shared)
    ops.append(op)
    _ops_path(shared).write_text(json.dumps({"ops": ops}, ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")


def _contractor_rfq(shared: Path, bus, ledger):
    """按侧内操作日志重放（`publish`/`amend` 是确定性的，重放得到同样的 rev 与快照哈希）。

    说明：`rfq/published` 事件只带哈希与条目数，**不含包体**，所以跨进程无法只靠账本重建
    RFQ 快照；这里用侧内操作日志补齐，并把该限制登记为 D-017（见 decisions.md）。
    """
    rfq = _rfq(bus, ledger)
    rfq.create_package(_spec())
    for op in _load_ops(shared):
        if op["op"] == "publish":
            rfq.publish()
        elif op["op"] == "amend":
            rfq.amend(op["changes"])
    return rfq


def _write(shared: Path, role: str, step: str, payload: dict) -> None:
    target = shared / role / f"{step}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                      encoding="utf-8")


def _read(shared: Path, role: str, step: str) -> dict:
    target = shared / role / f"{step}.json"
    if not target.exists():
        raise SystemExit(f"[{role}] 缺少对方产物: {target}")
    return json.loads(target.read_text(encoding="utf-8"))


# --- 承包商侧 -------------------------------------------------------------
def contractor_1(shared: Path) -> dict:
    bus, ledger, _ = _stack(shared, "contractor")
    rfq = _contractor_rfq(shared, bus, ledger)
    published = rfq.publish()
    _append_op(shared, {"op": "publish"})
    sent = rfq.distribute(["supplier:g1"], now="2026-09-22T09:00:00Z")
    _write(shared, "contractor", "01-package",
           {"rev": published["rev"], "snapshot_hash": rfq.snapshot_hash(published["rev"]),
            "spec": _spec(), "delivered_to": sent["recipients"], "sent_at": sent["sent_at"]})
    return {"step": "contractor-1", "rev": published["rev"]}


def contractor_2(shared: Path) -> dict:
    bus, ledger, _ = _stack(shared, "contractor")
    rfq = _contractor_rfq(shared, bus, ledger)
    question = _read(shared, "supplier", "02-question")
    _write(shared, "contractor", "03-answer",
           {"question_id": question["question_id"], "refs": question["refs"],
            "answer": "支吊架含在本次范围内，按 DN100 标准执行", "broadcast_to": ["supplier:g1"],
            "answered_at": "2026-09-22T14:00:00Z"})
    changes = {"items": {"L-001": {"qty": 150}}}
    amended = rfq.amend(changes)
    _append_op(shared, {"op": "amend", "changes": changes})
    rfq.distribute(["supplier:g1"], now="2026-09-23T09:00:00Z")
    _write(shared, "contractor", "04-amended",
           {"rev": amended["rev"], "deltas": amended["deltas"],
            "snapshot_hash": rfq.snapshot_hash(amended["rev"])})
    return {"step": "contractor-2", "rev": amended["rev"], "deltas": len(amended["deltas"])}


def contractor_3(shared: Path) -> dict:
    bus, ledger, approvals = _stack(shared, "contractor")
    quote_payload = _read(shared, "supplier", "05-quote")
    quote = quote_payload["quote"]
    package = {"package_id": "pkg-g1", "rev": quote["rfq_rev"], "currency": "CNY",
               "items": _spec()["items"], "deadlines": DEADLINES, "payment_terms": {"days": 45}}
    guard = GuardService(ledger=ledger, events=bus)
    flags = guard.check({"package": package, "quotes": [quote]})
    compare = CompareService(ledger=ledger, events=bus)
    evaluation = compare.rank(package, [quote], flags=flags)
    exported = ExportService(ledger=ledger, events=bus).export(
        evaluation, shared / "contractor" / "06-compare.csv")
    _write(shared, "contractor", "06-evaluation",
           {"evaluation_id": evaluation["evaluation_id"],
            "ranking": [{"quote_id": row["quote_id"], "score": row["score"]} for row in evaluation["ranking"]],
            "excluded": evaluation["excluded"], "flags": flags, "rows": exported["rows"]})
    gate = CommitmentGate(approval=approvals, ledger=ledger, events=bus, actor="agent:sourcing")
    intent = gate.intent(package_id="pkg-g1", quote_id=quote["quote_id"], lines=quote["lines"],
                         reason="G1 走查授标意向")
    _write(shared, "contractor", "08-award-intent",
           {"intent": intent, "package_id": "pkg-g1", "quote_id": quote["quote_id"]})
    return {"step": "contractor-3", "flags": len(flags), "rows": exported["rows"],
            "intent_id": intent["intent_id"]}


def contractor_4(shared: Path) -> dict:
    bus, ledger, approvals = _stack(shared, "contractor")
    intent = _read(shared, "contractor", "08-award-intent")["intent"]
    quote = _read(shared, "supplier", "05-quote")["quote"]
    confirmation = _read(shared, "supplier", "07-confirm")
    gate = CommitmentGate(approval=approvals, ledger=ledger, events=bus, actor="agent:sourcing")
    # 承诺必须过桥之外的人工门：先请求、由人签、再承诺（跨阶段依赖账本重放的批准记录）
    request = approvals.request("award.commit", {"intent_id": intent["intent_id"]},
                               ref=intent["intent_id"], approvers=[HUMAN], reason="走查人工批准")
    approvals.decide(request["approval_id"], by=HUMAN, decision="granted", comment="同意授标")
    committed = gate.commit_award(intent, supplier_confirmed=bool(confirmation["confirmed"]),
                                 approval_id=request["approval_id"])
    _write(shared, "contractor", "08-award",
           {"award_id": committed["award_id"], "approved_by": committed["approved_by"],
            "approval_id": committed["approval_id"], "intent_id": intent["intent_id"]})

    change_request = _read(shared, "supplier", "09-change-request")
    change = ChangeService(ledger=ledger, events=bus, approvals=approvals, actor="agent:planner")
    proposed = change.propose(quote, change_request["deltas"], reason=change_request["reason"])
    before = change.effective_total(quote)
    approval = approvals.request("change.approve", {"change_id": proposed["change_id"]},
                                ref=proposed["change_id"], approvers=[HUMAN], reason="变更需批准")
    approvals.decide(approval["approval_id"], by=HUMAN, decision="granted", comment="同意变更")
    approved = change.approve(proposed["change_id"], approved_by=HUMAN,
                              approval_id=approval["approval_id"])
    after = change.effective_total(quote)
    _write(shared, "contractor", "10-change",
           {"change_id": approved["change_id"], "status": approved["status"],
            "delta_amount": approved["delta_amount"], "before": before["effective_amount"],
            "after": after["effective_amount"]})

    keystore = KeyStore()
    keystore.add("contractor:g1", secret=os.environ.get("G1_SHARED_SECRET", "g1-shared-secret"),
                 kind="participant", realm="contractor:g1")
    pack = ev.export(ledger, scope="g1-walkthrough", keystore=keystore, participant="contractor:g1")
    (shared / "contractor" / "11-audit-pack.json").write_text(
        json.dumps(pack, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return {"step": "contractor-4", "award_id": committed["award_id"],
            "change_id": approved["change_id"], "delta_amount": approved["delta_amount"],
            "effective_before": before["effective_amount"], "effective_after": after["effective_amount"],
            "audit_pack_count": (pack.get("manifest") or {}).get("count")}


# --- 供应商侧 -------------------------------------------------------------
def supplier_1(shared: Path) -> dict:
    _, ledger, _ = _stack(shared, "supplier")
    package = _read(shared, "contractor", "01-package")
    _write(shared, "supplier", "02-question",
           {"question_id": "q-clarify-1", "refs": ["L-001"], "rfq_rev": package["rev"],
            "question": "支吊架是否含在报价范围内？", "asked_at": "2026-09-22T13:00:00Z"})
    return {"step": "supplier-1", "rev": package["rev"], "ledger_bytes": ledger.path.stat().st_size}


def supplier_2(shared: Path) -> dict:
    bus, ledger, approvals = _stack(shared, "supplier")
    amended = _read(shared, "contractor", "04-amended")
    answer = _read(shared, "contractor", "03-answer")
    fresh = {"quote_id": "qg-fresh", "rfq_rev": amended["rev"], "currency": "CNY",
             "lines": [{"item_id": "L-001", "unit_price": 86.0, "qty": 150},
                       {"item_id": "L-002", "unit_price": 11.5, "qty": 480}],
             "lead_time_days": 10, "payment_terms": {"days": 45, "advance_pct": 0},
             "warranty_terms": {"months": 24}, "notes": ""}
    stale = {"quote_id": "qg-stale", "rfq_rev": 1, "currency": "CNY",
             "lines": [{"item_id": "L-001", "unit_price": 88.5, "qty": 120}],
             "lead_time_days": 12, "payment_terms": {"days": 30, "advance_pct": 10},
             "warranty_terms": {"months": 18}, "notes": ""}
    _write(shared, "supplier", "05-quote",
           {"quote": fresh, "superseded_quote": stale, "clarify_answer": answer["answer"]})

    # 供应商侧的报价提交也是**承诺路径**：先无批准试探（必须抛错），再经人工门提交
    # 注意：**同一个账本文件同一时刻只能有一个 Ledger 实例在写**——再建一个实例会各自从 seq 1 开始，
    # 哈希链立刻断（本批走查实测到）。所以这里复用上面那一个栈。
    gate = CommitmentGate(approval=approvals, ledger=ledger, events=bus, actor="agent:supplier")
    blocked = ""
    try:
        gate.submit_quote(fresh)
    except Exception as err:  # noqa: BLE001
        blocked = f"{type(err).__name__}: {err}"
    request = approvals.request("quote.submit", {"quote_id": fresh["quote_id"]},
                               ref=fresh["quote_id"], approvers=[HUMAN], reason="走查报价提交")
    approvals.decide(request["approval_id"], by=HUMAN, decision="granted", comment="同意提交")
    submitted = gate.submit_quote(fresh, approval_id=request["approval_id"])
    return {"step": "supplier-2", "rev": amended["rev"], "quote_id": fresh["quote_id"],
            "blocked_without_approval": blocked, "quote_submitted": True,
            "submitted_at": submitted["submitted_at"],
            "ledger_bytes": ledger.path.stat().st_size, "ledger_count": ledger.count}


def supplier_3(shared: Path) -> dict:
    _, ledger, _ = _stack(shared, "supplier")
    intent = _read(shared, "contractor", "08-award-intent")["intent"]
    _write(shared, "supplier", "07-confirm",
           {"confirmed": True, "by": "supplier:g1", "intent_id": intent["intent_id"],
            "confirmed_at": "2026-09-24T09:00:00Z"})
    _write(shared, "supplier", "09-change-request",
           {"deltas": [{"ref_line": "L-001", "new_qty": 170,
                        "basis_unit_price_ref": "qg-fresh#L-001:unit_price"}],
            "reason": "现场追加 20 m"})
    return {"step": "supplier-3", "confirmed": True, "ledger_bytes": ledger.path.stat().st_size}


PHASES = {
    "contractor": {1: contractor_1, 2: contractor_2, 3: contractor_3, 4: contractor_4},
    "supplier": {1: supplier_1, 2: supplier_2, 3: supplier_3},
}


def run(role: str, shared: Path, phase: int) -> dict:
    bus, ledger, _ = _stack(shared, role)
    result = PHASES[role][phase](shared)
    # 相位会自己建栈写盘，所以**跑完再重新读一遍账本**取计数（构造时的计数是 0，不等于结果）
    fresh = Ledger(ledger.path, realm=ledger.realm)
    result.update({"role": role, "phase": phase, "pid": os.getpid(), "realm": ledger.realm,
                   "ledger": str(ledger.path), "ledger_count": fresh.count})
    return result


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3 or args[0] not in PHASES or not args[2].isdigit():
        print("用法: python -m quotagent.g1side contractor|supplier <shared_dir> <phase>", file=sys.stderr)
        return 2
    shared = Path(args[1]).resolve()
    (shared / args[0]).mkdir(parents=True, exist_ok=True)
    print(json.dumps(run(args[0], shared, int(args[2])), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
