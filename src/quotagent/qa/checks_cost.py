"""成本构成与私域 AC（T-109）：AC-COST-001（要素分解与可解释）、AC-TRUST-001（三处均不存在私域字段）。"""

from __future__ import annotations

import json
from pathlib import Path

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..kernel.modelgate import DeterministicModelProvider, ModelGateway
from ..paths import new_scratch, scratch_root
from ..services.costmodel import (ELEMENTS, CostLibrary, CostModelService, PrivateAccessDenied)
from ..services.realm import (DEFAULT_FIELD_CLASSES, PrivateLeak, RealmProjector, RealmView,
                              classify_status)
from .registry import Assertion, register

ITEMS = [
    {"item_id": "L-001", "unit": "m", "qty": 120, "spec_refs": ["spec://piping/DN100"]},
    {"item_id": "L-002", "unit": "kg", "qty": 480, "spec_refs": ["spec://support/STD"]},
]

SUPPLIER_REALM = "supplier:sup-A"
CONTRACTOR_REALM = "contractor:con-B"


def _library() -> CostLibrary:
    return CostLibrary({
        "L-001": {"material": {"unit_rate": 42.0, "unit": "m"},
                  "labour": {"unit_rate": 18.0, "unit": "m"},
                  "plant": {"unit_rate": 6.0, "unit": "m"},
                  "overhead_pct": 8.0, "risk_pct": 3.0, "finance_pct": 1.5, "tax_pct": 13.0},
        "L-002": {"material": {"unit_rate": 6.4, "unit": "kg"},
                  "labour": {"unit_rate": 1.6, "unit": "kg"},
                  "plant": {"unit_rate": 0.4, "unit": "kg"},
                  "overhead_pct": 8.0, "risk_pct": 3.0, "finance_pct": 1.5, "tax_pct": 13.0},
    })


def _cost_service(tmp_name: str = "cost-001"):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "supplier.jsonl", realm=SUPPLIER_REALM)
    bus = EventBus()
    bus.install_defaults()
    service = CostModelService(realm=SUPPLIER_REALM, library=_library(), ledger=ledger, events=bus,
                               store_root=root / "private")
    return service, ledger, bus, root


@register("AC-COST-001", "P0", "成本构成可按要素分解且可解释；私域在对方 realm 取不到值",
          "qa ac AC-COST-001", evidence_refs=("EV-023",))
def ac_cost_001() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus, root = _cost_service()

    model = service.build(ITEMS, quote_id="q-0007")
    out.append(Assertion("成本构成按条目与成本要素分解（材料/人工/机具/管理/风险/税/财务）",
                         set(model["items"]["L-001"]["elements"]) == set(ELEMENTS)
                         and model["items"]["L-001"]["elements"]["material"]["amount"] > 0,
                         f"elements={sorted(model['items']['L-001']['elements'])}"))
    # 手算：L-001 material = 42.0 * 120 = 5040；labour = 18*120 = 2160；plant = 6*120 = 720
    material = model["items"]["L-001"]["elements"]["material"]["amount"]
    labour = model["items"]["L-001"]["elements"]["labour"]["amount"]
    plant = model["items"]["L-001"]["elements"]["plant"]["amount"]
    out.append(Assertion("各要素金额与手算一致（单位费率 × 工程量）",
                         abs(material - 5040.0) < 1e-6 and abs(labour - 2160.0) < 1e-6
                         and abs(plant - 720.0) < 1e-6,
                         f"material={material} labour={labour} plant={plant}（手算 5040/2160/720）"))
    # 间接要素按直接费基数百分比：管理 8% → (5040+2160+720)*0.08 = 633.6
    overhead = model["items"]["L-001"]["elements"]["overhead"]["amount"]
    out.append(Assertion("间接要素按声明基数与费率计算（管理 8% × 直接费 7920 = 633.6）",
                         abs(overhead - 633.6) < 1e-6, f"overhead={overhead}"))

    explained = service.explain("q-0007", "L-001")
    out.append(Assertion("可解释：每个要素可追溯到费率与基数（可查因子）",
                         bool(explained) and all({"element", "amount", "factors"} <= set(e) for e in explained)
                         and any(e["element"] == "material" and e["factors"]["unit_rate"] == 42.0 for e in explained),
                         f"explain={json.dumps(explained[:2], ensure_ascii=False)}"))

    # 手算（成本模型的计算顺序：直接费 → 管理费 → 风险 → 财务 → 税）：
    # direct = 5040+2160+720 = 7920; overhead = 7920*0.08 = 633.6; subtotal = 8553.6
    # risk = 8553.6*0.03 = 256.608; finance = 8553.6*0.015 = 128.304
    # pre_tax = 8938.512; tax = 8938.512*0.13 = 1162.00656; incl = 10100.51856
    # unit_excl = 8938.512/120 = 74.4876; unit_incl = 10100.51856/120 = 84.170988
    unit_cost = service.unit_cost("L-001")
    out.append(Assertion("unit_cost 与手算一致（不含税 74.4876 / 含税 84.170988 每 m）",
                         abs(unit_cost["excl_tax"] - 74.4876) < 1e-4
                         and abs(unit_cost["incl_tax"] - 84.170988) < 1e-4
                         and abs(unit_cost["total_excl_tax"] - 8938.512) < 1e-3,
                         f"unit_cost={unit_cost}（手算 excl=74.4876 incl=84.170988）"))

    own = service.read_view(SUPPLIER_REALM)
    out.append(Assertion("本 realm 可读完整私域成本构成（不是把数据删掉了）",
                         own["items"]["L-001"]["elements"]["material"]["amount"] > 0,
                         f"own_keys={sorted(own)}"))
    denial = None
    try:
        service.read_view(CONTRACTOR_REALM)
    except PrivateAccessDenied as exc:
        denial = exc
    out.append(Assertion("对方 realm 读取成本构成被拒绝（私域不出 realm，P5）",
                         denial is not None, f"error={denial}"))

    cost_events = ledger.read(type="quote/cost-built")
    out.append(Assertion("成本构成落账只带引用与哈希（明细留在本 realm 私域存储），账本链完整",
                         len(cost_events) == 1
                         and cost_events[0]["body"]["artifact_hash"].startswith("sha256:")
                         and "elements" not in json.dumps(cost_events[0]["body"].get("items", []))
                         and ledger.verify_chain(),
                         f"body={json.dumps(cost_events[0]['body'], ensure_ascii=False)[:240]}"))

    forged = None
    try:
        service.private_store.get(cost_events[0]["body"]["artifact_hash"], realm=CONTRACTOR_REALM)
    except PrivateAccessDenied as exc:
        forged = exc
    out.append(Assertion("私域工件按哈希引用，但跨 realm 取件同样被拒绝",
                         forged is not None, f"error={forged}"))
    out.append(Assertion("私域字段分类已声明（成本构成/利润率属 Private-supplier）",
                         classify_status("cost_model", DEFAULT_FIELD_CLASSES) == "private-supplier"
                         and classify_status("reserve_price", DEFAULT_FIELD_CLASSES) == "private-contractor",
                         f"cost_model={classify_status('cost_model', DEFAULT_FIELD_CLASSES)} "
                         f"reserve_price={classify_status('reserve_price', DEFAULT_FIELD_CLASSES)}"))
    return out


@register("AC-TRUST-001", "P0", "对方私域字段在本侧投影、模型输入、视图中三处均不存在（INV-008）",
          "qa ac AC-TRUST-001", evidence_refs=("EV-024",))
def ac_trust_001() -> list[Assertion]:
    out: list[Assertion] = []
    root = new_scratch("trust-001")
    ledger = Ledger(root / "supplier.jsonl", realm=SUPPLIER_REALM)
    bus = EventBus()
    bus.install_defaults()
    projector = RealmProjector()

    supplier_record = {
        "realm": SUPPLIER_REALM,
        "quote_id": "q-0007",
        "lines": [{"item_id": "L-001", "unit_price": 88.5, "qty": 120}],
        "cost_model": {"items": {"L-001": {"material": 5040.0, "margin_pct": 12.0}}},
        "margin_pct": 12.0,
        "reserve_price": 950000.0,      # 承包商私域（不应出现在供应商侧）
        "internal_score": 87,           # 承包商私域
        "approvals": [{"by": "human:zhang", "scope": "quote.submit"}],
        "signature": "hmac-sha256:con-B-k1:deadbeef",
    }

    peer_view = projector.project(supplier_record, to_realm=CONTRACTOR_REALM)
    stripped = projector.stripped(supplier_record, to_realm=CONTRACTOR_REALM)
    out.append(Assertion("投影（对方视角）不含本侧私域字段，且被剥离字段可枚举（可审计）",
                         "cost_model" not in peer_view and "margin_pct" not in peer_view
                         and "cost_model" in stripped,
                         f"peer_keys={sorted(peer_view)} stripped={stripped}"))
    out.append(Assertion("投影仍保留交换范围字段（不是把内容全删了）",
                         peer_view.get("quote_id") == "q-0007" and peer_view.get("lines"),
                         f"peer_view={json.dumps(peer_view, ensure_ascii=False)[:160]}"))
    out.append(Assertion("本侧视角保留自己的私域（过滤有方向，不是无条件清空）",
                         projector.project(supplier_record, to_realm=SUPPLIER_REALM).get("cost_model") is not None,
                         "own view keeps cost_model"))

    view = RealmView(projector, realm=CONTRACTOR_REALM)
    out.append(Assertion("视图（对方 realm 的 RealmView）中私域字段不存在",
                         "cost_model" not in view.of(supplier_record)
                         and "margin_pct" not in view.of(supplier_record),
                         f"view_keys={sorted(view.of(supplier_record))}"))

    context = projector.model_context(supplier_record, realm=SUPPLIER_REALM)
    out.append(Assertion("本侧模型输入含本侧私域（08 §3：Private 可进模型，仅本侧），不含对方私域与 Regulated 字段",
                         "cost_model" in context and "reserve_price" not in context
                         and "internal_score" not in context and "approvals" not in context
                         and "signature" not in context,
                         f"context_keys={sorted(context)}"))

    gateway = ModelGateway(ledger, DeterministicModelProvider())
    reply = gateway.call(step="cost-review",
                         messages=[{"role": "system", "content": "供应商内部成本评审（私域）"},
                                   {"role": "user", "content": json.dumps(context, ensure_ascii=False)}],
                         agent_id="agent:cost", correlation_id="corr-cost-review")
    rebuilt = gateway.rebuild_inputs(reply.call_id)
    blob = json.dumps(rebuilt, ensure_ascii=False)
    out.append(Assertion("模型输入可从账本重建，且重建结果里没有对方私域字段（模型可见 ⟺ 账本可见 + INV-008）",
                         gateway.rebuild_matches(reply.call_id)["equal"] is True
                         and "reserve_price" not in blob and "internal_score" not in blob
                         and "cost_model" in blob,
                         f"equal={gateway.rebuild_matches(reply.call_id)['equal']} "
                         f"has_forbidden={[f for f in ('reserve_price', 'internal_score') if f in blob]}"))

    leak = None
    try:
        projector.assert_clean({"quote_id": "q-0008", "cost_model": {"margin_pct": 12.0}},
                               to_realm=CONTRACTOR_REALM)
    except PrivateLeak as exc:
        leak = exc
    out.append(Assertion("负控：出站载荷含私域字段即被拦（守卫非空转）",
                         leak is not None and "cost_model" in str(leak), f"error={leak}"))

    unclassified = projector.project({"quote_id": "q-0009", "brand_new_field": 1}, to_realm=CONTRACTOR_REALM)
    out.append(Assertion("未分类字段被显式记录（新增字段不会静默按公开处理）",
                         "brand_new_field" in projector.unclassified_paths(),
                         f"unclassified={projector.unclassified_paths()} keys={sorted(unclassified)}"))

    # 默认私域根：不传 store_root 时也必须落在仓库内 tmp/（ADR-0007 的运行约束：不写仓库外文件）
    default_service = CostModelService(realm=SUPPLIER_REALM, library=_library())
    default_root = Path(default_service.private_store.root).resolve()
    tmp_root = Path(scratch_root()).resolve()
    out.append(Assertion("私域存储默认根落在仓库内 tmp/（不写仓库外文件、不落在跟踪路径）",
                         default_root.is_relative_to(tmp_root) and "tmp" in default_root.parts,
                         f"root={default_root} tmp={tmp_root}"))
    return out
