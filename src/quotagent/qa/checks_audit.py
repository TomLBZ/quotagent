"""账本 AC（T-102）：AC-AUDIT-001（篡改可检出）、AC-AUDIT-002（模型输入可重建）。"""

from __future__ import annotations

import json
import random

from ..kernel import evidence
from ..kernel.ledger import Ledger, LedgerFrozenError
from ..kernel.modelgate import DeterministicModelProvider, ModelGateway
from ..paths import new_scratch
from .registry import Assertion, register

SAMPLE_SIZE = 20
TOTAL_CALLS = 30
SNAPSHOT_AT = 12
DEFAULT_SEED = 20260912


def _seed_ledger(path, realm: str, n: int = 12) -> Ledger:
    ledger = Ledger(path, realm=realm)
    for i in range(1, n + 1):
        ledger.append(
            "rfq/published" if i == 1 else "quote/submitted",
            {"package_id": "pkg-014", "rfq_rev": 1, "line": i, "amount": 1000 + i},
            correlation_id=f"corr-{i:02d}",
            actor="agent:sourcing",
        )
    return ledger


@register("AC-AUDIT-001", "P0", "篡改历史事件后 verify_chain() 为假；审计包独立验证失败",
          "qa ac AC-AUDIT-001", evidence_refs=("EV-005",))
def ac_audit_001() -> list[Assertion]:
    out: list[Assertion] = []
    tmp = new_scratch("audit-001")
    path = tmp / "ledger.jsonl"
    ledger = _seed_ledger(path, "contractor:con-B")

    out.append(Assertion("append-only：事件已追加", ledger.count == 12, f"count={ledger.count}"))
    out.append(Assertion("追加后哈希链完整（FR-LEDGER-001/003）", ledger.verify_chain(),
                         f"head={ledger.head_hash}"))

    dup = ledger.append("quote/submitted", {"package_id": "pkg-014", "rfq_rev": 1, "line": 5, "amount": 1005},
                        correlation_id="corr-05", actor="agent:sourcing")
    out.append(Assertion("同 (correlation_id,type,body_hash) 不产生第二条事实（FR-LEDGER-004）",
                         dup.duplicate is True and ledger.count == 12,
                         f"duplicate={dup.duplicate} count={ledger.count}"))

    reopened = Ledger(path, realm="contractor:con-B")
    out.append(Assertion("重开后账本健康且 head_hash 一致（持久化 + 启动校验）",
                         reopened.healthy and reopened.verify_chain() and reopened.head_hash == ledger.head_hash,
                         f"head={reopened.head_hash}"))

    pack = evidence.export(ledger, scope="pkg-014")
    ok_pack = evidence.verify(pack)
    out.append(Assertion("审计包独立验证通过（未篡改）", ok_pack["ok"],
                         json.dumps(ok_pack["checks"][:2], ensure_ascii=False)))

    tampered_pack = json.loads(json.dumps(pack))
    tampered_pack["events"][3]["body"]["amount"] = 1
    bad_pack = evidence.verify(tampered_pack)
    out.append(Assertion("包内任一事件被篡改 → 独立验证失败", bad_pack["ok"] is False,
                         bad_pack["first_failure"]))

    lines = path.read_text(encoding="utf-8").splitlines()
    record = json.loads(lines[6])
    record["body"]["amount"] = 1
    lines[6] = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    tampered = Ledger(path, realm="contractor:con-B")
    report = tampered.verify_report()
    out.append(Assertion("篡改历史事件后 verify_chain() 返回假", tampered.verify_chain() is False,
                         f"ok={report['ok']} reason={report['reason']}"))
    out.append(Assertion("校验报告定位到被篡改的 seq（第 7 条）", report["first_bad_seq"] == 7,
                         f"first_bad_seq={report['first_bad_seq']} reason={report['reason']}"))
    out.append(Assertion("启动校验失败即标记不健康（停发前置条件）", tampered.healthy is False,
                         f"frozen={tampered.frozen}"))

    refused = False
    try:
        tampered.append("kernel/test", {"x": 1}, correlation_id="corr-frozen")
    except LedgerFrozenError as exc:
        refused = "拒绝追加" in str(exc)
    out.append(Assertion("冻结后拒绝继续追加（FR-LEDGER-003 停发）", refused))
    return out


@register("AC-AUDIT-002", "P0", "随机抽样 20 次模型调用的重建输入与观测输入全等",
          "qa ac AC-AUDIT-002", evidence_refs=("EV-006",))
def ac_audit_002() -> list[Assertion]:
    out: list[Assertion] = []
    tmp = new_scratch("audit-002")
    ledger = Ledger(tmp / "ledger.jsonl", realm="supplier:sup-A")
    gateway = ModelGateway(ledger, DeterministicModelProvider())

    replies = []
    snapshots: dict[str, dict] = {}
    snapshot_seq = 0
    for i in range(TOTAL_CALLS):
        replies.append(gateway.call(
            step=f"intake-{i:03d}",
            messages=[{"role": "system", "content": "你是供应商读包 agent"},
                      {"role": "user", "content": f"抽取第 {i} 条清单条目的规格引用"}],
            params={"temperature": 0},
            agent_id="agent:intake",
            correlation_id=f"corr-{i:03d}",
        ))
        if i + 1 == SNAPSHOT_AT:
            for view in ("index", "types"):
                snapshots[view] = ledger.incremental(view)
            snapshot_seq = ledger.count

    call_seqs = gateway.model_call_seqs()
    out.append(Assertion("每次模型调用都已落账（模型可见 ⟺ 账本可见）",
                         len(call_seqs) == TOTAL_CALLS, f"kernel/model-call={len(call_seqs)}"))
    out.append(Assertion(f"时点快照已采集（seq={snapshot_seq}）",
                         snapshot_seq > 0 and {"index", "types"} <= set(snapshots),
                         f"snapshot_seq={snapshot_seq} views={sorted(snapshots)}"))

    rnd = random.Random(DEFAULT_SEED)
    sample = rnd.sample(replies, SAMPLE_SIZE)
    diffs = [gateway.rebuild_matches(reply.call_id) for reply in sample]
    bad = [d for d in diffs if not d["equal"]]
    out.append(Assertion(f"抽样 {SAMPLE_SIZE} 次：rebuild(inputs) == observed_inputs 全部相等",
                         len(sample) == SAMPLE_SIZE and not bad,
                         f"不一致 {len(bad)} 条: {json.dumps(bad[:2], ensure_ascii=False)}"))

    negative_gateway = ModelGateway(Ledger(tmp / "ledger-negative.jsonl", realm="supplier:sup-A"),
                                    DeterministicModelProvider(), inject_unlogged=True)
    negative_reply = negative_gateway.call(step="inject-001", messages=[{"role": "user", "content": "正常内容"}],
                                           agent_id="agent:intake", correlation_id="corr-inject")
    negative = negative_gateway.rebuild_matches(negative_reply.call_id)
    out.append(Assertion("负控：未落账却进入模型的输入被检出（比对非空转）",
                         negative["equal"] is False, json.dumps(negative, ensure_ascii=False)))

    for view in ("index", "types"):
        full = ledger.project(view)
        incremental = ledger.incremental(view)
        out.append(Assertion(f"投影 {view}: 全量重建 == 增量维护（FR-LEDGER-002）",
                             full == incremental, f"full={full} incremental={incremental}"))
        point = ledger.project(view, from_seq=1, to_seq=snapshot_seq)
        out.append(Assertion(f"投影 {view}: 时点重建（seq<={snapshot_seq}）== 该时点快照",
                             point == snapshots[view], f"point={point} snapshot={snapshots[view]}"))

    out.append(Assertion("投影全量重建可重复（同输入两次结果一致）",
                         ledger.project("index") == ledger.project("index")))
    return out
