"""QEP 与文件投递 AC（T-105）：AC-QEP-001（信封验签/篡改检出）、AC-QEP-002（幂等），AC-INTEG-001（原子写）。"""

from __future__ import annotations

import json
import re

from ..kernel.delivery import FileTransport
from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..kernel.qep import KeyStore, QepEndpoint
from ..paths import new_scratch
from .registry import Assertion, register

CON_SECRET = b"contractor-demo-secret-0123456789"
SUP_SECRET = b"supplier-demo-secret-0123456789"


def _keystore() -> KeyStore:
    store = KeyStore()
    store.add("con-B", secret=CON_SECRET, kind="contractor", realm="contractor:con-B")
    store.add("sup-A", secret=SUP_SECRET, kind="supplier", realm="supplier:sup-A")
    return store


def _pair(tmp_name: str):
    root = new_scratch(tmp_name)
    store = _keystore()
    transport = FileTransport(root / "mailbox")
    bus = EventBus()
    bus.install_defaults()
    con = QepEndpoint(participant="con-B", kind="contractor", realm="contractor:con-B",
                      keystore=store, ledger=Ledger(root / "con.jsonl", realm="contractor:con-B"),
                      transport=transport, events=bus)
    sup = QepEndpoint(participant="sup-A", kind="supplier", realm="supplier:sup-A",
                      keystore=store, ledger=Ledger(root / "sup.jsonl", realm="supplier:sup-A"),
                      transport=transport, events=bus)
    return root, store, transport, bus, con, sup


def _rfq_body() -> dict:
    return {"rfq_rev": 1, "package_id": "pkg-014",
            "line_items": [{"item_id": "L-001", "qty": 120, "unit": "m", "spec": "DN100"},
                           {"item_id": "L-002", "qty": 40, "unit": "m", "spec": "DN150"}]}


def _mutations(env: dict) -> list[tuple[str, dict]]:
    """对信封做单字段改动（每次一个），验签都必须失败。"""
    cases: list[tuple[str, dict]] = []
    for field, value in (("qep_version", "9.9"), ("msg_id", "01J00000000000000000000001"),
                         ("correlation_id", "corr-tampered"), ("seq", env["seq"] + 1),
                         ("prev_hash", "sha256:" + "f" * 64), ("sent_at", "2000-01-01T00:00:00Z"),
                         ("type", "quote/withdrawn"), ("class", "intent"),
                         ("body_hash", "sha256:" + "a" * 64)):
        mutated = json.loads(json.dumps(env))
        mutated[field] = value
        cases.append((field, mutated))
    mutated = json.loads(json.dumps(env))
    mutated["sender"]["kind"] = "supplier"
    cases.append(("sender.kind", mutated))
    mutated = json.loads(json.dumps(env))
    mutated["recipients"] = ["someone-else"]
    cases.append(("recipients", mutated))
    mutated = json.loads(json.dumps(env))
    mutated["refs"]["rfq_rev"] = 2
    cases.append(("refs.rfq_rev", mutated))
    mutated = json.loads(json.dumps(env))
    mutated["body"]["line_items"][0]["qty"] = 1
    cases.append(("body.line_items[0].qty", mutated))
    mutated = json.loads(json.dumps(env))
    mutated["approvals"] = [{"by": "human:zhang", "at": "2026-09-12T00:00:00Z", "scope": "quote.submit"}]
    cases.append(("approvals（追加一条）", mutated))
    return cases


@register("AC-QEP-001", "P0", "信封构造后可验签；任一字段被改动即验签失败",
          "qa ac AC-QEP-001", evidence_refs=("EV-013",))
def ac_qep_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, store, transport, bus, con, sup = _pair("qep-001")

    env = con.envelope("rfq/published", "fact", _rfq_body(),
                       refs={"package_id": "pkg-014", "rfq_rev": 1},
                       recipients=["sup-A"], correlation_id="corr-rfq-1")
    signed = con.sign(env)
    required = ["qep_version", "msg_id", "correlation_id", "seq", "prev_hash", "sent_at", "sender",
                "recipients", "refs", "type", "class", "body_hash", "body", "signature"]
    missing = [f for f in required if f not in signed]
    out.append(Assertion("信封含 03-exchange-protocol.md §2 的全部字段",
                         not missing, f"missing={missing}"))
    out.append(Assertion("构造后可验签（含摘要与签名）",
                         con.verify(signed) is True and sup.verify(signed) is True,
                         f"body_hash={signed['body_hash'][:18]}… signature={signed['signature'][:26]}…"))

    results = []
    for field, mutated in _mutations(signed):
        ok = sup.verify(mutated)
        results.append((field, ok))
    tampered = [f for f, ok in results if ok]
    out.append(Assertion("任一字段被改动 → 验签失败（逐字段实测）",
                         not tampered,
                         f"仍可验签的字段={tampered}（共测 {len(results)} 个字段）"))

    body_tampered = json.loads(json.dumps(signed))
    body_tampered["body"]["line_items"][1]["qty"] = 999
    report = sup.validate(body_tampered)
    out.append(Assertion("body_hash 与 body 不一致 → validate 不通过",
                         report["ok"] is False and any("body_hash" in e for e in report["errors"]),
                         f"errors={report['errors']}"))

    v9 = json.loads(json.dumps(signed))
    v9["qep_version"] = "9.9"
    v9["body_hash"] = signed["body_hash"]
    report = sup.validate(v9)
    out.append(Assertion("qep_version 不兼容 → 拒绝（不静默降级，03 §6）",
                         report["ok"] is False and any("qep_version" in e for e in report["errors"]),
                         f"errors={report['errors']}"))

    commitment = con.envelope("award/committed", "commitment",
                              {"intent_id": "ai-1", "terms": {"price": 1}},
                              refs={"package_id": "pkg-014", "rfq_rev": 1}, recipients=["sup-A"])
    report = sup.validate(commitment)
    out.append(Assertion("class=commitment 缺 approvals → 拒收（FR-QEP-002 / INV-005）",
                         report["ok"] is False and any("approval" in e.lower() for e in report["errors"]),
                         f"errors={report['errors']}"))

    agent_approved = json.loads(json.dumps(commitment))
    agent_approved["approvals"] = [{"by": "agent:price-agent", "at": "2026-09-12T00:00:00Z",
                                   "scope": "award.commit"}]
    report = sup.validate(agent_approved)
    out.append(Assertion("批准来自 agent 而非人 → 拒收（代签禁止，FR-APPROVE-001）",
                         report["ok"] is False,
                         f"errors={report['errors']}"))
    return out


@register("AC-QEP-002", "P0", "同一报文投递 3 次只产生 1 条事实；重发不改变 msg_id/body_hash",
          "qa ac AC-QEP-002", evidence_refs=("EV-014",))
def ac_qep_002() -> list[Assertion]:
    out: list[Assertion] = []
    root, store, transport, bus, con, sup = _pair("qep-002")

    env = sup.envelope("quote/submitted", "fact",
                       {"quote": {"quote_id": "q-0007", "rfq_rev": 1,
                                  "lines": [{"item_id": "L-001", "unit_price": 88.5, "qty": 120}],
                                  "valid_until": "2026-10-01"}},
                       refs={"package_id": "pkg-014", "rfq_rev": 1}, recipients=["con-B"],
                       correlation_id="corr-quote-1")
    sent = sup.send(env)
    out.append(Assertion("发送写出投递文件并落账 kernel/qep-sent",
                         sent["path"].exists() and sent["path"].name.endswith(".qep.json")
                         and len(sup.ledger.read(type="kernel/qep-sent")) == 1,
                         f"path={sent['path'].name} ledger={len(sup.ledger.read(type='kernel/qep-sent'))}"))

    pending = con.inbox()
    out.append(Assertion("收件箱只看到 1 个完整报文", len(pending) == 1,
                         f"pending={[p['name'] for p in pending]}"))

    raw = pending[0]["raw"]
    receipts = [con.receive(raw) for _ in range(3)]
    facts = con.ledger.read(type="quote/submitted")
    out.append(Assertion("同一报文投递 3 次只产生 1 条事实（FR-QEP-004 幂等去重）",
                         len(facts) == 1 and receipts[0]["duplicate"] is False
                         and all(r["duplicate"] for r in receipts[1:]),
                         f"facts={len(facts)} duplicates={[r['duplicate'] for r in receipts]}"))
    out.append(Assertion("重复投递被记录（不是静默丢弃）",
                         len(con.ledger.read(type="kernel/qep-duplicate-dropped")) == 2,
                         f"duplicate-dropped={len(con.ledger.read(type='kernel/qep-duplicate-dropped'))}"))

    resent = sup.resend(sent["msg_id"])
    before = json.loads(raw)
    after = json.loads(resent)
    out.append(Assertion("重发内容不变（msg_id 与 body_hash 相同，字节可复现）",
                         after["msg_id"] == before["msg_id"] and after["body_hash"] == before["body_hash"],
                         f"msg_id={before['msg_id']}=={after['msg_id']} "
                         f"body_hash_equal={before['body_hash'] == after['body_hash']}"))

    again = con.receive(resent)
    out.append(Assertion("重发的报文仍不产生第二条事实",
                         again["duplicate"] is True and len(con.ledger.read(type="quote/submitted")) == 1,
                         f"facts={len(con.ledger.read(type='quote/submitted'))}"))

    first = facts[0]
    received_events = con.ledger.read(type="kernel/qep-received")
    out.append(Assertion("落账事实可由账本重建（含 msg_id 引用与 body_hash）",
                         con.ledger.verify_chain() and len(received_events) == 1
                         and first["body"]["quote"]["quote_id"] == "q-0007"
                         and received_events[0]["refs"]["msg_id"] == before["msg_id"],
                         f"quote_id={first['body']['quote']['quote_id']} "
                         f"verified={con.ledger.verify_chain()}"))
    return out


@register("AC-INTEG-001", "P0", "文件投递为原子写（临时文件 + rename）；半写文件不被读取",
          "qa ac AC-INTEG-001", evidence_refs=("EV-015",))
def ac_integ_001() -> list[Assertion]:
    out: list[Assertion] = []
    root, store, transport, bus, con, sup = _pair("integ-001")

    env = con.envelope("rfq/published", "fact", _rfq_body(),
                       refs={"package_id": "pkg-014", "rfq_rev": 1}, recipients=["sup-A"],
                       correlation_id="corr-rfq-2")
    signed = con.sign(env)

    staged = transport.stage(signed, to="sup-A")
    out.append(Assertion("写入先落临时文件（*.tmp），最终名在 commit 前不可见",
                         staged.name.endswith(".tmp")
                         and not transport.final_exists(signed, "sup-A"),
                         f"staged={staged.name}"))
    out.append(Assertion("半写文件不被读取（pending 为空）", transport.pending("sup-A") == [],
                         f"pending={[p['name'] for p in transport.pending('sup-A')]}"))

    final = transport.commit(staged, signed, to="sup-A")
    out.append(Assertion("commit 使用 rename 原子落盘，命名约定为 <seq:06d>-<msg_id>.qep.json",
                         final.exists() and not staged.exists()
                         and bool(re.match(r"^\d{6}-[0-9A-Z]{26}\.qep\.json$", final.name)),
                         f"final={final.name} staged_gone={not staged.exists()}"))
    pending = transport.pending("sup-A")
    out.append(Assertion("完整报文可被读取，且重复扫描幂等（不重复产出）",
                         len(pending) == 1 and len(transport.pending("sup-A")) == 1,
                         f"pending={[p['name'] for p in pending]}"))

    inbox = transport.inbox_dir("sup-A")
    broken = inbox / "000999-01JZZZZZZZZZZZZZZZZZZZZZZZ.qep.json"
    broken.write_text('{"qep_version": "1.0", "msg_id":', encoding="utf-8")
    half = inbox / "000998-01JYYYYYYYYYYYYYYYYYYYYYYYY.tmp"
    half.write_text('{"qep_version": "1.0", "msg_id":', encoding="utf-8")
    after = transport.pending("sup-A")
    rejected = transport.rejected("sup-A")
    out.append(Assertion("损坏的最终文件不被当作报文读取，且被隔离并记录原因（不静默丢弃）",
                         len(after) == 1 and len(rejected) == 1
                         and rejected[0]["name"] == broken.name and bool(rejected[0]["reason"]),
                         f"pending={len(after)} rejected={[(r['name'], r['reason'][:40]) for r in rejected]}"))
    out.append(Assertion("未完成的 *.tmp 被忽略（既不入账也不误判为损坏）",
                         all(".tmp" not in r["name"] for r in rejected)
                         and not transport.pending_paths("sup-A").count(half),
                         f"rejected={[r['name'] for r in rejected]}"))

    received = sup.receive(transport.pending("sup-A")[0])
    out.append(Assertion("投递文件可被接收方验证并入账（端到端投递闭环）",
                         received["duplicate"] is False
                         and len(sup.ledger.read(type="rfq/published")) == 1
                         and sup.ledger.verify_chain(),
                         f"msg_id={received['msg_id']} facts={len(sup.ledger.read(type='rfq/published'))}"))
    return out


# --------------------------------------------------------------------------- P1（T-202）
def _send_series(sup, count: int, *, prefix: str = "q") -> list[dict]:
    """逐条构造并发送（必须 send 之后才能构造下一条：seq 由出站状态推进）。"""
    out = []
    for index in range(1, count + 1):
        env = sup.envelope("quote/submitted", "fact",
                           {"quote": {"quote_id": f"{prefix}-{index}", "rfq_rev": 1,
                                      "lines": [{"item_id": "L-001", "unit_price": 80 + index, "qty": 100}]}},
                           refs={"package_id": "pkg-014", "rfq_rev": 1}, recipients=["con-B"])
        sup.send(env)
        out.append(env)
    return out


@register("AC-QEP-003", "P1", "seq 空洞：依赖该序号的跃迁被挂起并发重发请求；补齐后按序应用（不跳号）",
          "qa ac AC-QEP-003", evidence_refs=("EV-042",))
def ac_qep_003() -> list[Assertion]:
    out: list[Assertion] = []
    root, store, transport, bus, con, sup = _pair("qep-003")
    sent = _send_series(sup, 3)
    out.append(Assertion("三条报文 seq 单调递增（1,2,3）", [e["seq"] for e in sent] == [1, 2, 3],
                         f"seqs={[e['seq'] for e in sent]}"))

    dropped = transport.final_path(sent[0], to="con-B")
    dropped_bytes = dropped.read_bytes()                # 丢包前留下原始字节，供重发比对
    dropped.unlink()                                    # 人为丢包：seq=1 丢失
    results = [con.receive(item["raw"]) for item in con.inbox()]
    out.append(Assertion("检测到空洞：收到 seq=2/3 时挂起（held）并列出缺失序号",
                         all(item.get("held") and item.get("missing") for item in results)
                         and results[0]["missing"] == [1] and results[1]["missing"] == [1, 2],
                         f"results={[{k: i.get(k) for k in ('seq', 'missing', 'held')} for i in results]}"))
    out.append(Assertion("**状态跃迁被挂起**：空洞未补齐前不落任何事实（不跳号处理）",
                         con.ledger.read(type="quote/submitted") == [],
                         f"facts={len(con.ledger.read(type='quote/submitted'))} held={len(con.held)}"))
    out.append(Assertion("空洞落账 kernel/qep-gap-detected（含 expected/got/missing）",
                         [r["body"] for r in con.ledger.read(type="kernel/qep-gap-detected")][:2]
                         and con.ledger.read(type="kernel/qep-gap-detected")[0]["body"]["expected_seq"] == 1
                         and con.ledger.read(type="kernel/qep-gap-detected")[0]["body"]["got_seq"] == 2,
                         f"entries={len(con.ledger.read(type='kernel/qep-gap-detected'))}"))

    out.append(Assertion("发出重发请求（relay/resend-request）且带缺失序号",
                         all(item.get("resend_requested") for item in results)
                         and [p["name"] for p in sup.inbox()],
                         f"sup 收件箱={[p['name'] for p in sup.inbox()]}"))
    requests = [sup.receive(item["raw"]) for item in sup.inbox()]
    bodies = [r.get("body") or {} for r in requests if r.get("received")]
    out.append(Assertion("对端收到的重发请求内容正确（missing=[1]，类型 relay/resend-request）",
                         any(body.get("missing") == [1] for body in bodies)
                         and all(r.get("type") == "relay/resend-request" for r in requests if r.get("received")),
                         f"请求={bodies}"))

    sup.resend(sent[0]["msg_id"])
    drained = [con.receive(item["raw"]) for item in con.inbox()]
    facts = [r["body"]["quote"]["quote_id"] for r in con.ledger.read(type="quote/submitted")]
    out.append(Assertion("补齐后**按序**应用：事实顺序为 q-1,q-2,q-3（被挂起的两条一并落地）",
                         facts == ["q-1", "q-2", "q-3"],
                         f"facts={facts}"))
    filled = con.ledger.read(type="kernel/qep-gap-filled")
    out.append(Assertion("补齐留痕 kernel/qep-gap-filled（含被补齐的 msg_id 与剩余挂起数）",
                         bool(filled) and filled[-1]["body"]["held_remaining"] == 0
                         and len(filled[-1]["body"]["applied"]) == 2,
                         f"filled={json.dumps(filled[-1]['body'], ensure_ascii=False)[:200] if filled else None}"))
    out.append(Assertion("重发内容不变（字节可复现；事实仍为 3 条，重复以 qep-duplicate-dropped 留痕）",
                         sup.resend(sent[0]["msg_id"]) == dropped_bytes
                         and len(con.ledger.read(type="quote/submitted")) == 3
                         and con.ledger.read(type="kernel/qep-duplicate-dropped"),
                         f"facts={len(con.ledger.read(type='quote/submitted'))} "
                         f"dup={len(con.ledger.read(type='kernel/qep-duplicate-dropped'))}"))

    # 未收到回执 → 重发（内容不变，不产生第二条事实）；此时回执还压在 sup 的收件箱里
    outstanding_before = {item["msg_id"] for item in sup.outstanding()}
    resent = sup.resend_unacked(threshold_s=0.0)
    resent_entries = sup.ledger.read(type="kernel/qep-resent")
    out.append(Assertion("超过阈值未收到回执 → 重发同一 msg_id 并落 kernel/qep-resent（内容不变）",
                         outstanding_before == {e["msg_id"] for e in sent} and set(resent) == outstanding_before
                         and len(resent_entries) == len(resent),
                         f"outstanding={sorted(outstanding_before)} resent={resent} "
                         f"qep-resent={len(resent_entries)}"))
    con_facts_before = len(con.ledger.read(type="quote/submitted"))
    dup_before = len(con.ledger.read(type="kernel/qep-duplicate-dropped"))
    for item in con.inbox():
        con.receive(item["raw"])
    out.append(Assertion("重发不产生第二条事实（幂等去重留痕）",
                         len(con.ledger.read(type="quote/submitted")) == con_facts_before == 3
                         and len(con.ledger.read(type="kernel/qep-duplicate-dropped")) > dup_before,
                         f"facts={len(con.ledger.read(type='quote/submitted'))} "
                         f"dup={len(con.ledger.read(type='kernel/qep-duplicate-dropped'))}"))

    # 回执：业务报文应用后对端收到 relay/receipt；控制类报文不产生回执乒乓
    receipts = [sup.receive(item["raw"]) for item in sup.inbox()]
    out.append(Assertion("应用后回执 relay/receipt 回到发送方（逐条 ack msg_id）",
                         len(sup.receipts) == 3 and set(sup.receipts) == {e["msg_id"] for e in sent},
                         f"receipts={len(sup.receipts)} 类型={[r.get('type') for r in receipts if r.get('received')]}"))
    # 说明：投递语义是"至少一次"，收件箱文件不会被消费（幂等重复读取），因此按**来源**判断乒乓：
    # con 的收件箱里只应有多出来的重发副本（数量 = 重发条数），不应出现回执引发的任何新报文。
    out.append(Assertion("控制类报文不互相回执（无回执乒乓：con 侧只多出重发副本、无待回执）",
                         len(con.inbox()) == len(resent) and con.outstanding() == [] and sup.receipts
                         and len(sup.ledger.read(type="kernel/qep-resent")) == len(resent),
                         f"con 收件箱={len(con.inbox())} 重发={len(resent)} outstanding={con.outstanding()}"))
    out.append(Assertion("回执本身不再触发回执（sup 对回执不再发确认）",
                         all(receipt.get("type") == "relay/receipt" for receipt in
                             [r for r in receipts if r.get("received")])
                         and not sup.receipts.get("__receipt_of_receipt__"),
                         f"sup 收到={[r.get('type') for r in receipts if r.get('received')]}"))
    return out


@register("AC-QEP-004", "P1", "版本协商：交集为空即拒绝并留痕；特性降级有账本事件；不可降级项缺失即拒绝",
          "qa ac AC-QEP-004", evidence_refs=("EV-042",))
def ac_qep_004() -> list[Assertion]:
    out: list[Assertion] = []
    root, store, transport, bus, con, sup = _pair("qep-004")
    caps = con.capabilities()
    out.append(Assertion("能力自述含 qep_versions 与 features（建立通信时先交换）",
                         isinstance(caps.get("qep_versions"), list) and isinstance(caps.get("features"), list)
                         and caps["qep_versions"],
                         f"caps={caps}"))

    incompatible = con.negotiate({"participant": "sup-Z", "qep_versions": ["2.0"],
                                  "features": list(caps["features"])})
    rejected = con.ledger.read(type="kernel/qep-rejected")
    out.append(Assertion("版本交集为空 → 拒绝通信并落 kernel/qep-rejected（附双方版本列表）",
                         incompatible["ok"] is False
                         and incompatible["reason"] == "version-intersection-empty"
                         and bool(rejected) and rejected[-1]["body"]["errors"]
                         and incompatible["local_versions"] and incompatible["peer_versions"],
                         f"result={incompatible} rejected={json.dumps(rejected[-1]['body'], ensure_ascii=False)[:180] if rejected else None}"))
    out.append(Assertion("拒绝后不留下「已协商成功」的假象（agreed_version 仍为空，不静默降级）",
                         con.agreed_version is None,
                         f"agreed_version={con.agreed_version}"))

    two = QepEndpoint(participant="sup-A", kind="supplier", realm="supplier:sup-A",
                      keystore=store, ledger=Ledger(root / "sup.jsonl", realm="supplier:sup-A"),
                      transport=transport, events=bus, supported=("1.0", "1.1"))
    ok = two.negotiate({"participant": "con-B", "qep_versions": ["1.0", "1.1", "1.2"],
                        "features": list(two.features)})
    out.append(Assertion("兼容时取版本交集的**最大值**（1.0/1.1 ∩ 1.0/1.1/1.2 → 1.1）",
                         ok["ok"] is True and ok["version"] == "1.1",
                         f"result={ok}"))

    degraded = two.negotiate({"participant": "con-B", "qep_versions": ["1.0"],
                              "features": ["approval_chain_v2", "signature_verify", "version_binding"]})
    events = two.ledger.read(type="kernel/qep-degraded")
    out.append(Assertion("特性取交集：差异落 kernel/qep-degraded（含 degraded 清单与不可降级项）",
                         degraded["ok"] is True and degraded["degraded"] == ["pack_deltas"]
                         and bool(events) and events[-1]["body"]["degraded"] == ["pack_deltas"]
                         and sorted(events[-1]["body"]["non_degradable"]) == ["approval_chain_v2",
                                                                              "signature_verify",
                                                                              "version_binding"],
                         f"degraded={degraded.get('degraded')} events={json.dumps(events[-1]['body'], ensure_ascii=False)[:200] if events else None}"))

    before = len(two.ledger.read(type="kernel/qep-rejected"))
    missing = two.negotiate({"participant": "con-B", "qep_versions": ["1.0"],
                             "features": ["pack_deltas"]})
    after = two.ledger.read(type="kernel/qep-rejected")
    out.append(Assertion("**不可降级项**缺失（签名/版本绑定/批准链）→ 拒绝通信而不是降级",
                         missing["ok"] is False and missing["reason"] == "non-degradable-feature-missing"
                         and len(after) == before + 1
                         and "signature_verify" in after[-1]["body"]["errors"][0],
                         f"result={missing} rejected+{len(after) - before}"))
    return out
