"""账本同步 AC（T-203 / FR-QEP-007）：AC-SYNC-001 —— 三方协调、字段权威方、承诺字段挂起转人工。"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.sync import CONTRACTOR, SUPPLIER, SyncService
from .registry import Assertion, register


def _stack(tmp_name: str, role: str = CONTRACTOR):
    root = new_scratch(tmp_name)
    bus = EventBus()
    bus.install_defaults()
    service = SyncService(participant="con-B" if role == CONTRACTOR else "sup-A", role=role,
                          realm=f"{role}:x", ledger=Ledger(root / f"{role}.jsonl", realm=f"{role}:x"),
                          events=bus)
    return root, service


@register("AC-SYNC-001", "P1", "双方改同一非承诺字段→按权威方合并；改承诺字段→挂起转人工；两种情况均留痕",
          "qa ac AC-SYNC-001", evidence_refs=("EV-044",))
def ac_sync_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, con = _stack("sync-001")

    base = {"unit_price": 88.5, "package.items": ["L-001"], "payment.terms": "net30", "status": "open"}
    mine = {"unit_price": 90.0, "package.items": ["L-001"], "payment.terms": "net45", "status": "open"}
    theirs = {"unit_price": 85.0, "package.items": ["L-001", "L-002"], "payment.terms": "net60", "status": "open"}
    result = con.reconcile(entry_id="q-0007", base=base, mine=mine, theirs=theirs)
    merged = result["merged"]

    # --- 三值判定：一致 / 单侧改 / 冲突 ---
    out.append(Assertion("一致字段确认（m==t）：status 取共识值且不产生冲突",
                         merged.get("status") == "open"
                         and all(item["field"] != "status" for item in result["conflicts"]),
                         f"status={merged.get('status')}"))
    out.append(Assertion("单侧修改直接采纳（m==b → 取对方值）：package.items 采用对方清单",
                         merged.get("package.items") == ["L-001", "L-002"],
                         f"items={merged.get('package.items')}"))

    # --- 权威方矩阵：单价归供应商、付款条款归承包商 ---
    conflicts = {item["field"]: item for item in result["conflicts"]}
    out.append(Assertion("冲突按权威方合并：单价冲突 → 供应商胜出（mine=90 vs theirs=85 取 85）",
                         merged.get("unit_price") == 85.0
                         and conflicts["unit_price"]["authority"] == SUPPLIER
                         and conflicts["unit_price"]["auto_resolution"] == f"{SUPPLIER}-wins",
                         f"unit_price={merged.get('unit_price')} conflict={conflicts.get('unit_price')}"))
    out.append(Assertion("冲突按权威方合并：付款条款冲突 → 承包商胜出（mine=net45 vs theirs=net60 取 net45）",
                         merged.get("payment.terms") == "net45"
                         and conflicts["payment.terms"]["authority"] == CONTRACTOR
                         and conflicts["payment.terms"]["auto_resolution"] == f"{CONTRACTOR}-wins",
                         f"terms={merged.get('payment.terms')} conflict={conflicts.get('payment.terms')}"))
    out.append(Assertion("冲突留痕 kernel 事件：sync/conflict 含 mine/theirs/base/authority，sync/merged 含胜出值",
                         len(con.ledger.read(type="sync/conflict")) >= 2
                         and len(con.ledger.read(type="sync/merged")) >= 2
                         and all(key in con.ledger.read(type="sync/conflict")[0]["body"]
                                 for key in ("mine", "theirs", "base", "authority", "auto_resolution")),
                         f"conflict={len(con.ledger.read(type='sync/conflict'))} "
                         f"merged={len(con.ledger.read(type='sync/merged'))}"))
    out.append(Assertion("产出新的 base（revision 向量）且与合并结果一致（双方各存一份）",
                         result["base_next"] == merged and con.base == merged
                         and json.loads(json.dumps(result["base_next"])) == merged,
                         f"base_next={json.dumps(result['base_next'], ensure_ascii=False)[:160]}"))

    # --- 承诺字段冲突：不自动合并 → 挂起待人工 ---
    commit = con.reconcile(entry_id="q-0008", base={"delivery.date": "2026-10-01"},
                           mine={"delivery.date": "2026-10-05"}, theirs={"delivery.date": "2026-10-10"},
                           classes={"delivery.date": "commitment"})
    out.append(Assertion("承诺字段冲突**不自动合并**（merged 保持 base）且 resolution=pending_human",
                         commit["merged"]["delivery.date"] == "2026-10-01"
                         and commit["pending_human"][0]["auto_resolution"] == "pending_human"
                         and commit["pending_human"][0]["reason"] == "commitment-field",
                         f"merged={commit['merged']} pending={commit['pending_human'][0]['auto_resolution']}"))
    out.append(Assertion("条目被挂起并可查（sync/suspended 留痕，含需要的裁决）",
                         commit["suspended"] == 1 and len(con.suspended_entries()) == 1
                         and len(con.ledger.read(type="sync/suspended")) == 1,
                         f"suspended={con.suspended_entries()}"))
    uncovered = con.reconcile(entry_id="q-0009", base={"custom.thing": 1},
                              mine={"custom.thing": 2}, theirs={"custom.thing": 3})
    out.append(Assertion("矩阵未覆盖字段 → pending_human（reason=no-authority-rule，merged 保持 base）",
                         uncovered["pending_human"][0]["reason"] == "no-authority-rule"
                         and uncovered["merged"]["custom.thing"] == 1
                         and uncovered["pending_human"][0]["authority"] is None,
                         f"pending={uncovered['pending_human'][0]}"))

    # --- 人工裁决：需双方各一次 human 批准 ---
    one_side = con.resolve_human(entry_id="q-0008", field="delivery.date", value="2026-10-05",
                                local_approval={"by": "human:zhang", "scope": "delivery", "at": "t1"},
                                peer_approval=None)
    out.append(Assertion("单侧人类批准**不算成立**（仍挂起，避免单边伪造）",
                         one_side["resolved"] is False and one_side["reason"] == "need-both-sides"
                         and len(con.suspended_entries()) == 2,
                         f"result={one_side}"))
    agent_side = con.resolve_human(entry_id="q-0008", field="delivery.date", value="2026-10-05",
                                   local_approval={"by": "human:zhang", "scope": "delivery", "at": "t1"},
                                   peer_approval={"by": "agent:bot", "scope": "delivery", "at": "t2"})
    out.append(Assertion("对方「批准」来自 agent 时同样不算（代签禁止，FR-APPROVE-001）",
                         agent_side["resolved"] is False and agent_side["approvals_seen"] == 1,
                         f"result={agent_side}"))
    both = con.resolve_human(entry_id="q-0008", field="delivery.date", value="2026-10-05",
                             local_approval={"by": "human:zhang", "scope": "delivery", "at": "t1"},
                             peer_approval={"by": "human:li", "scope": "delivery", "at": "t2"})
    out.append(Assertion("双方各一次 human:* 批准 → 裁决成立并解除挂起（sync/merged 标 auto=false）",
                         both["resolved"] is True and both["suspended"] == 1
                         and con.base["delivery.date"]["value"] == "2026-10-05"
                         and any(entry["body"].get("by") == "human-both-sides"
                                 for entry in con.ledger.read(type="sync/merged")),
                         f"result={json.dumps(both, ensure_ascii=False)[:200]}"))

    # --- 非权威字段的本地修改不外发，改为建议 ---
    suggestion = con.suggest(entry_id="q-0007", field="unit_price", value=91.0, reason="成本上升")
    out.append(Assertion("对非权威字段的本地修改 → 产出建议 intent/suggestion（不外发、不进 base）",
                         suggestion["type"] == "intent/suggestion" and suggestion["class"] == "intent"
                         and suggestion["authority"] == SUPPLIER
                         and con.base.get("unit_price") != 91.0
                         and len(con.ledger.read(type="sync/suggestion-raised")) == 1,
                         f"suggestion={json.dumps(suggestion, ensure_ascii=False)[:180]}"))
    try:
        con.suggest(entry_id="q-0007", field="package.items", value=[], reason="本方权威字段")
        refused = False
    except Exception as err:  # noqa: BLE001
        refused = "权威方" in str(err)
    out.append(Assertion("对**本方权威字段**直接改即可，不需要建议（suggest 拒绝）", refused,
                         f"refused={refused}"))

    # --- 供应商视角对称：同一冲突在对方按同一矩阵解出同一结果 ---
    _, sup = _stack("sync-001-sup", role=SUPPLIER)
    mirror = sup.reconcile(entry_id="q-0007", base=base,
                           mine=theirs, theirs=mine)
    out.append(Assertion("视角对调后同一冲突解出**同一结果**（矩阵是双方共识，不偏袒本地）",
                         mirror["merged"]["unit_price"] == 85.0
                         and mirror["merged"]["payment.terms"] == "net45",
                         f"mirror={json.dumps(mirror['merged'], ensure_ascii=False)}"))
    return out
