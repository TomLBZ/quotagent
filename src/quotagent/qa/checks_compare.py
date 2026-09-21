"""比价 AC（T-112）：AC-COMPARE-001（版本失配不进入排序）、AC-COMPARE-002（确定性 + 可复算）、
AC-COMPARE-003（每个数值都有引用链，删引用即校验失败）。"""

from __future__ import annotations

import copy
import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..paths import new_scratch
from ..services.compare import CompareService, MissingCitation
from .registry import Assertion, register

PACKAGE = {
    "package_id": "pkg-0007",
    "rev": 2,
    "currency": "CNY",
    "items": [
        {"item_id": "L-001", "unit": "m", "qty": 60, "spec_refs": ["spec://piping/DN100"]},
        {"item_id": "L-002", "unit": "kg", "qty": 400, "spec_refs": ["spec://support/STD"]},
    ],
    "deadlines": {"quote_by": "2026-09-25T00:00:00Z", "delivery_by": "2026-11-30T00:00:00Z"},
    "payment_terms": {"advance_pct": 20, "days": 30},
    "warranty_months": 24,
}

# 允许交期 = quote_by → delivery_by = 66 天
WEIGHTS = {"price": 0.6, "delivery": 0.15, "payment": 0.1, "warranty": 0.05, "deviation": 0.1}
WEIGHTS_ALT = {"price": 0.2, "delivery": 0.4, "payment": 0.1, "warranty": 0.1, "deviation": 0.2}
POLICY = {"time_cost_per_day": 800.0, "capital_rate": 0.08, "warranty_cost_per_month": 2000.0}

# 三条报价：q-a / q-b 基于 rev2，q-stale 基于 rev1；q-b 交期超 10 天（多 8000）、
# 质保少 6 个月（多 12000）、付款条件 45 天（融资成本）
QUOTES = [
    {"quote_id": "q-a", "rfq_rev": 2, "currency": "CNY", "total_amount": 400000.0,
     "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
     "warranty_months": 24, "deviation_ids": []},
    {"quote_id": "q-b", "rfq_rev": 2, "currency": "CNY", "total_amount": 392000.0,
     "lead_time_days": 76, "payment_terms_offered": {"advance_pct": 10, "days": 45},
     "warranty_months": 18, "deviation_ids": []},
    {"quote_id": "q-stale", "rfq_rev": 1, "currency": "CNY", "total_amount": 380000.0,
     "lead_time_days": 60, "payment_terms_offered": {"advance_pct": 20, "days": 30},
     "warranty_months": 24, "deviation_ids": []},
]


def _stack(tmp_name: str):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "ledger.jsonl")
    bus = EventBus()
    return CompareService(ledger=ledger, events=bus, actor="agent:compare"), ledger, bus, root


@register("AC-COMPARE-001", "P0", "报价 rfq_rev 与包版本不一致 → 不进入排序 + rfq/version-mismatch",
          command="qa ac AC-COMPARE-001")
def check_compare_001() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus, _ = _stack("ac-compare-001")

    evaluation = service.rank(PACKAGE, QUOTES, weights=WEIGHTS, policy=POLICY)
    ranked_ids = [row["quote_id"] for row in evaluation["ranking"]]
    excluded = {row["quote_id"]: row for row in evaluation["excluded"]}
    out.append(Assertion("版本失配的报价被排除在排序之外",
                         sorted(ranked_ids) == ["q-a", "q-b"] and "q-stale" not in ranked_ids
                         and sorted(excluded) == ["q-stale"],
                         f"ranking={ranked_ids} excluded={sorted(excluded)}"))
    out.append(Assertion("排名里没有基于 rev1 的报价",
                         "q-stale" not in ranked_ids and excluded["q-stale"]["code"] == "rfq_version_mismatch",
                         f"excluded={json.dumps(excluded.get('q-stale'), ensure_ascii=False)}"))

    mismatches = ledger.read(type="rfq/version-mismatch")
    out.append(Assertion("产生 rfq/version-mismatch 事件（挂起该报价，含双方版本）",
                         len(mismatches) == 1
                         and mismatches[0]["body"]["quote_id"] == "q-stale"
                         and mismatches[0]["body"]["quote_rev"] == 1
                         and mismatches[0]["body"]["package_rev"] == 2,
                         f"events={json.dumps([m['body'] for m in mismatches], ensure_ascii=False)[:200]}"))
    out.append(Assertion("失配报价的金额没有进入任何 TCO 分量（不进排序也不进合计）",
                         all(row["components"]["price"]["value"] != 380000.0
                             for row in evaluation["ranking"]),
                         f"prices={[row['components']['price']['value'] for row in evaluation['ranking']]}"))
    out.append(Assertion("失配报价被挂起（可读、可审计），不是被静默丢弃",
                         evaluation["excluded"][0]["next_action"]
                         and "rev" in evaluation["excluded"][0]["next_action"],
                         f"next_action={evaluation['excluded'][0].get('next_action')}"))

    # 覆盖漏洞补丁：之前这条 AC 没挂事件总线，于是 compare 误用 emit 派发 bail 事件不会被发现。
    bus = EventBus()
    bus.install_defaults()
    seen: list[dict] = []
    bus.on("rfq/version-mismatch", lambda payload: seen.append(dict(payload)))
    wired_root = new_scratch("compare-001-wired")
    wired = CompareService(ledger=Ledger(wired_root / "wired.jsonl", realm="contractor:con-B"), events=bus)
    wired_package = {"package_id": "pkg-014", "rev": 2, "items": [{"item_id": "L-001", "qty": 100, "unit": "m"}]}
    wired_quote = {"quote_id": "q-wired", "rfq_rev": 1, "supplier": {"participant_id": "sup-A"},
                   "lines": [{"item_id": "L-001", "unit_price": 88.5, "qty": 100, "unit": "m"}]}
    wired_ok, wired_note = True, ""
    try:
        wired.rank(wired_package, [wired_quote, _quote_for_rank(2)])
    except Exception as err:  # noqa: BLE001 - 这里要的是"不是 EventModeError"
        wired_ok, wired_note = type(err).__name__ != "EventModeError", f"{type(err).__name__}: {err}"
    out.append(Assertion("挂了事件总线时，bail 模式的 rfq/version-mismatch 仍被正确派发（不得误用 emit）",
                         wired_ok and any(item.get("quote_id") == "q-wired" for item in seen)
                         and "EventModeError" not in wired_note,
                         f"listener_seen={seen[:1]} note={wired_note}"))
    return out


@register("AC-COMPARE-002", "P0", "同输入两次排序完全一致；TCO 各分量可按策略 patch 复算",
          command="qa ac AC-COMPARE-002")
def check_compare_002() -> list[Assertion]:
    out: list[Assertion] = []
    service, _, _, _ = _stack("ac-compare-002")

    first = service.rank(PACKAGE, QUOTES, weights=WEIGHTS, policy=POLICY)
    second = service.rank(PACKAGE, QUOTES, weights=WEIGHTS, policy=POLICY)
    out.append(Assertion("同输入两次排序结果完全一致（字节级）",
                         json.dumps(first, ensure_ascii=False, sort_keys=True)
                         == json.dumps(second, ensure_ascii=False, sort_keys=True),
                         f"first={[r['quote_id'] for r in first['ranking']]} "
                         f"second={[r['quote_id'] for r in second['ranking']]}"))
    out.append(Assertion("排序不是恒等顺序（判据真的在起作用）",
                         [r["quote_id"] for r in first["ranking"]] != sorted(
                             [q["quote_id"] for q in QUOTES if q["rfq_rev"] == 2]),
                         f"ranking={[r['quote_id'] for r in first['ranking']]}"))

    # 手算 q-b 的分量：交期 76-66=10 天 ×800 = 8000；质保缺 6 个月 ×2000 = 12000；
    #                 融资 = 392000×(1-10%)×45/365×0.08 = 3478.356164…
    q_b = next(row for row in first["ranking"] if row["quote_id"] == "q-b")
    expected_financing = 392000.0 * 0.9 * 45 / 365 * 0.08
    out.append(Assertion("TCO 分量与手算一致（交期 8000 / 质保 12000 / 融资 3478.356164）",
                         abs(q_b["components"]["delivery"]["value"] - 8000.0) < 1e-6
                         and abs(q_b["components"]["warranty"]["value"] - 12000.0) < 1e-6
                         and abs(q_b["components"]["payment"]["value"] - expected_financing) < 1e-6,
                         f"delivery={q_b['components']['delivery']['value']} "
                         f"warranty={q_b['components']['warranty']['value']} "
                         f"payment={q_b['components']['payment']['value']}"))
    total = 392000.0 + 8000.0 + 12000.0 + expected_financing
    out.append(Assertion("TCO 合计 = 价格 + 各调整分量（手算 " + f"{total:.6f}" + "）",
                         abs(q_b["tco_total"] - total) < 1e-6, f"tco_total={q_b['tco_total']}"))

    alt = service.rank(PACKAGE, QUOTES, weights=WEIGHTS_ALT, policy=POLICY)
    same_components = all(
        json.dumps(alt_row["components"], sort_keys=True)
        == json.dumps(next(r for r in first["ranking"] if r["quote_id"] == alt_row["quote_id"])["components"],
                      sort_keys=True)
        for alt_row in alt["ranking"])
    out.append(Assertion("换权重只改分数，不改分量（策略 patch 可复算）",
                         same_components
                         and [r["quote_id"] for r in alt["ranking"]] != [r["quote_id"] for r in first["ranking"]],
                         f"alt_ranking={[r['quote_id'] for r in alt['ranking']]}"))

    recomputed = service.recompute(first, weights=WEIGHTS_ALT)
    out.append(Assertion("复算：用旧分量的数值 + 新权重能重现新排序的分数",
                         all(abs(recomputed["scores"][qid] - row["score"]) < 1e-9
                             for row in alt["ranking"] for qid in [row["quote_id"]]),
                         f"recomputed={recomputed['scores']} alt={[ (r['quote_id'], r['score']) for r in alt['ranking']]}"))
    return out


@register("AC-COMPARE-003", "P0", "Evaluation 中每个数值都有引用链；人为删掉一条引用后校验失败",
          command="qa ac AC-COMPARE-003")
def check_compare_003() -> list[Assertion]:
    out: list[Assertion] = []
    service, _, _, _ = _stack("ac-compare-003")

    evaluation = service.rank(PACKAGE, QUOTES, weights=WEIGHTS, policy=POLICY)
    numbers = service.numbers(evaluation)
    cited = service.cite(evaluation)
    out.append(Assertion("每个数值都有一个引用（数量对得上）",
                         numbers and len(cited) >= len(numbers),
                         f"numbers={len(numbers)} citations={len(cited)}"))
    out.append(Assertion("引用指向真实来源（账本条目 / 清单条目 / 报价字段 / 策略）",
                         all(ref.split(":", 1)[0] in {"ledger", "package", "quote", "policy", "deviation"}
                             for ref in cited),
                         f"prefixes={sorted({ref.split(':', 1)[0] for ref in cited})}"))
    out.append(Assertion("正常 Evaluation 通过引用校验（含排序建议与分量）",
                         service.verify_citations(evaluation) is None,
                         "verify_citations 返回 None（通过）"))

    tampered = copy.deepcopy(evaluation)
    victim = tampered["ranking"][0]["components"]["price"]
    removed = victim.pop("citations")
    failure = None
    try:
        service.verify_citations(tampered)
    except MissingCitation as exc:
        failure = exc
    out.append(Assertion("人为删掉一条引用 → 校验失败并指出位置（无引用即无效）",
                         failure is not None
                         and tampered["ranking"][0]["quote_id"] in str(failure)
                         and "price" in str(failure),
                         f"original_citations={removed} error={failure}"))

    ranking_tamper = copy.deepcopy(evaluation)
    ranking_tamper["ranking"][0].pop("citations")
    ranking_failure = None
    try:
        service.verify_citations(ranking_tamper)
    except MissingCitation as exc:
        ranking_failure = exc
    out.append(Assertion("排序建议本身也必须带引用链（删掉即失败）",
                         ranking_failure is not None, f"error={ranking_failure}"))
    return out

def _quote_for_rank(rev: int) -> dict:
    """一条可参与排序的最小报价（用于"挂总线"的对照断言）。"""
    return {"quote_id": "q-ok", "rfq_rev": rev, "supplier": {"participant_id": "sup-B"},
            "lines": [{"item_id": "L-001", "unit_price": 90.0, "qty": 100, "unit": "m"}]}
