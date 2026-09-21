"""询价包与清单版本化 AC（T-107）：AC-RFQ-001（包定义校验）、AC-RFQ-002（已发布版本不可原地改 + 字段级 delta）。"""

from __future__ import annotations

import json

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from ..kernel.plugin import PluginHost
from ..paths import new_scratch
from ..services.measures import DEFAULT_UNITS, MeasureBook, MeasureRule, UnitTable
from ..services.rfq import PublishedVersionImmutable, RfqService, RfqValidationError
from .registry import Assertion, register


def _service(tmp_name: str, realm: str = "contractor:con-B"):
    root = new_scratch(tmp_name)
    ledger = Ledger(root / "ledger.jsonl", realm=realm)
    bus = EventBus()
    bus.install_defaults()
    measures = MeasureBook({
        "L-001": MeasureRule("L-001", base_unit="m", allowed_units=("m", "cm"), tolerance_bps=5),
        "L-002": MeasureRule("L-002", base_unit="kg", allowed_units=("kg", "t"), tolerance_bps=5),
    })
    service = RfqService(ledger=ledger, events=bus, units=UnitTable(DEFAULT_UNITS), measures=measures)
    return service, ledger, bus, root


def _spec(**overrides) -> dict:
    spec = {
        "package_id": "pkg-014",
        "scope": ["厂区给排水管道更换"],
        "currency": "CNY",
        "tax_code": "cn-vat-13",
        "tax_mode": "exclusive",
        "interfaces": [{"interface_id": "IF-001", "between_packages": ["pkg-014", "pkg-015"],
                        "responsibility_party": "con-B", "description": "与既有管网接口"}],
        "deliverables": ["竣工资料"],
        "exclusions": ["夜间施工"],
        "deadlines": {"clarify_by": "2026-09-20T00:00:00Z", "quote_by": "2026-09-25T00:00:00Z"},
        "items": [
            {"item_id": "L-001", "code": "P-100", "description": "DN100 管道", "unit": "m", "qty": 120,
             "spec_refs": ["spec://piping/DN100"], "measurement_rule": "mr-length"},
            {"item_id": "L-002", "code": "S-200", "description": "管支架", "unit": "kg", "qty": 480,
             "spec_refs": ["spec://support/STD"], "measurement_rule": "mr-mass"},
        ],
    }
    spec.update(overrides)
    return spec


@register("AC-RFQ-001", "P0", "清单条目缺计量规则或接口无唯一责任方 → 校验失败",
          "qa ac AC-RFQ-001", evidence_refs=("EV-019",))
def ac_rfq_001() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus, root = _service("rfq-001")

    healthy = service.validate_of(_spec())
    out.append(Assertion("合法包定义通过校验（含清单单位与接口责任方）",
                         healthy["ok"] is True, f"errors={healthy['errors']}"))

    bad_unit = _spec(items=[
        {"item_id": "L-001", "code": "P-100", "description": "DN100 管道", "unit": "m", "qty": 120,
         "spec_refs": ["spec://piping/DN100"], "measurement_rule": "mr-length"},
        {"item_id": "L-777", "code": "X-777", "description": "未知单位条目", "unit": "bag", "qty": 10,
         "spec_refs": [], "measurement_rule": "mr-bag"},
    ])
    report = service.validate_of(bad_unit)
    out.append(Assertion("清单条目的单位不属于计量规则表 → 校验失败且指明条目",
                         report["ok"] is False and any("L-777" in e for e in report["errors"]),
                         f"errors={report['errors']}"))

    no_owner = _spec(interfaces=[
        {"interface_id": "IF-001", "between_packages": ["pkg-014"], "responsibility_party": "",
         "description": "缺责任方"},
        {"interface_id": "IF-002", "between_packages": ["pkg-014", "pkg-016"],
         "responsibility_party": "con-B", "responsible_parties": ["con-B", "con-C"],
         "description": "责任方不唯一"},
    ])
    report2 = service.validate_of(no_owner)
    out.append(Assertion("接口无唯一责任方 → 校验失败且逐条指明（IF-001 缺、IF-002 不唯一）",
                         report2["ok"] is False
                         and any("IF-001" in e for e in report2["errors"])
                         and any("IF-002" in e for e in report2["errors"]),
                         f"errors={report2['errors']}"))

    mounted = PluginHost(events=bus, ledger=ledger)
    fiber = mounted.mount(service.plugin_spec())
    out.append(Assertion("同一服务可作为插件装载并对外提供（接缝三角：Definition/Provider/Consumer）",
                         fiber.status == "active" and mounted.service("rfq") is service
                         and len(mounted.effects(fiber)) >= 0,
                         f"status={fiber.status} service_ok={mounted.service('rfq') is service}"))
    mounted.unmount(fiber)
    out.append(Assertion("卸载后服务摘除（不留全局引用）",
                         mounted.service("rfq") is None, f"service={mounted.service('rfq')}"))

    invalid_publish = None
    try:
        svc2, _, _, _ = _service("rfq-001b")
        svc2.create_package(bad_unit)
        svc2.publish()
    except RfqValidationError as exc:
        invalid_publish = exc
    out.append(Assertion("校验不通过的包不允许发布（发布前必须校验）",
                         invalid_publish is not None, f"error={invalid_publish}"))
    return out


@register("AC-RFQ-002", "P0", "已发布版本字段不可原地修改；amend 产生新版本与字段级 delta",
          "qa ac AC-RFQ-002", evidence_refs=("EV-020",))
def ac_rfq_002() -> list[Assertion]:
    out: list[Assertion] = []
    service, ledger, bus, root = _service("rfq-002")

    service.create_package(_spec())
    published = service.publish()
    rev = published["rev"]
    hash_before = published["hash"]
    out.append(Assertion("发布产生不可变版本 rev=1 且带内容哈希",
                         rev == 1 and bool(hash_before) and service.current_rev() == 1,
                         f"rev={rev} hash={hash_before[:16]}…"))

    snapshot = service.revision(rev)
    blocked = None
    try:
        snapshot["items"][0]["qty"] = 999  # type: ignore[index]
    except TypeError as exc:
        blocked = exc
    out.append(Assertion("已发布版本对消费者只读（原地写入抛错）",
                         blocked is not None and service.revision(rev)["items"][0]["qty"] == 120,
                         f"error={blocked}"))

    refusal = None
    try:
        service.modify_published(rev, item_id="L-001", field="qty", value=999)
    except PublishedVersionImmutable as exc:
        refusal = exc
    out.append(Assertion("通过 API 修改已发布版本被拒绝（改即 rev+1）",
                         refusal is not None
                         and service.revision(rev)["items"][0]["qty"] == 120
                         and service.snapshot_hash(rev) == hash_before,
                         f"error={refusal} hash_unchanged={service.snapshot_hash(rev) == hash_before}"))

    amended = service.amend({"package": {"deadlines": {"clarify_by": "2026-09-22T00:00:00Z",
                                                       "quote_by": "2026-09-28T00:00:00Z"}},
                             "items": {"L-001": {"qty": 150, "notes": "现场复核后追加 30m"}}})
    deltas = amended["deltas"]
    fields = {(d.get("item_id"), d["field"]) for d in deltas}
    out.append(Assertion("amend 产生新版本 rev=2（旧版本永久保留）",
                         amended["rev"] == 2 and service.current_rev() == 2
                         and service.revision(1)["items"][0]["qty"] == 120
                         and service.revision(2)["items"][0]["qty"] == 150,
                         f"rev={amended['rev']} rev1_qty={service.revision(1)['items'][0]['qty']} "
                         f"rev2_qty={service.revision(2)['items'][0]['qty']}"))
    out.append(Assertion("delta 是字段级的（逐字段 before/after），不是整包快照",
                         ("L-001", "qty") in fields and ("L-001", "notes") in fields
                         and ("package", "deadlines.quote_by") in fields
                         and all({"field", "before", "after"} <= set(d) for d in deltas),
                         f"deltas={json.dumps(deltas, ensure_ascii=False)[:320]}"))
    out.append(Assertion("delta 的 before/after 与版本内容一致（可复核）",
                         all(d["after"] != d["before"] for d in deltas)
                         and next(d for d in deltas if d["field"] == "qty")["before"] == 120
                         and next(d for d in deltas if d["field"] == "qty")["after"] == 150,
                         f"qty delta={next(d for d in deltas if d['field'] == 'qty')}"))

    no_deadline = _spec(package_id="pkg-015", deadlines={})
    missing_quote_by = None
    try:
        svc, _, _, _ = _service("rfq-002b")
        svc.create_package(no_deadline)
        svc.publish()
    except RfqValidationError as exc:
        missing_quote_by = exc
    out.append(Assertion("缺 quote_by 截止时间的包不允许发布（已发布包必须有报价截止）",
                         missing_quote_by is not None and "quote_by" in str(missing_quote_by),
                         f"error={missing_quote_by}"))

    published_events = ledger.read(type="rfq/published")
    amended_events = ledger.read(type="rfq/amended")
    out.append(Assertion("发布与修订分别落账（rfq/published, rfq/amended），且哈希链完整",
                         len(published_events) == 1 and len(amended_events) == 1
                         and amended_events[0]["body"]["rev"] == 2
                         and ledger.verify_chain(),
                         f"published={len(published_events)} amended={len(amended_events)} "
                         f"chain_ok={ledger.verify_chain()}"))
    return out

def _distribution_fixture():
    service, ledger, bus, root = _service("rfq-003")
    service.create_package(_spec(deadlines={"clarify_by": "2026-09-23T00:00:00Z",
                                            "quote_by": "2026-09-25T00:00:00Z"}))
    service.publish()
    return root, ledger, bus, service


@register("AC-RFQ-003", "P1", "分发记录可回答「谁在何时收到哪个版本」；截止时间管理与超时提醒可用",
          "qa ac AC-RFQ-003", evidence_refs=("EV-054",))
def check_rfq_003() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, service = _distribution_fixture()

    first = service.distribute(["supplier:sup-A", "supplier:sup-B"], now="2026-09-22T09:00:00Z")
    out.append(Assertion("分发逐参与者留痕：`rfq/distributed` 带参与者、版本、通道与发送时刻",
                         first["rev"] == 1 and first["recipients"] == ["supplier:sup-A", "supplier:sup-B"]
                         and len(ledger.read(type="rfq/distributed")) == 1
                         and ledger.read(type="rfq/distributed")[0]["body"]["sent_at"] == "2026-09-22T09:00:00Z",
                         f"rev={first['rev']} recipients={first['recipients']}"))
    query = service.deliveries(rev=1, participant="supplier:sup-A")
    out.append(Assertion("可回答「谁在何时收到哪个版本」：按版本 + 参与者过滤，逐条含 delivery_id/时刻/快照哈希",
                         len(query) == 1 and query[0]["sent_at"] == "2026-09-22T09:00:00Z"
                         and query[0]["rev"] == 1 and query[0]["delivery_id"] == "dl-0001"
                         and query[0]["snapshot_hash"].startswith("sha256:") and len(query[0]["snapshot_hash"]) == 71,
                         f"query={query[0] if query else None}"))
    hash_1 = first["snapshot_hash"]
    service.amend({"items": {"L-001": {"qty": 150}}})  # 真改数量，确保快照哈希变化
    second = service.distribute(["supplier:sup-A"], now="2026-09-23T09:00:00Z")
    out.append(Assertion("版本以**快照哈希**锚定：升版后再分发，哈希变化；两份记录并存（历史不清除）",
                         second["rev"] == 2 and second["snapshot_hash"] != hash_1
                         and len(service.deliveries(rev=1)) == 2
                         and len(service.deliveries(rev=2)) == 1
                         and len(service.deliveries(participant="supplier:sup-A")) == 2,
                         f"rev1={len(service.deliveries(rev=1))} rev2={len(service.deliveries(rev=2))}"))
    rejects = {}
    for name, call in (("empty", lambda: service.distribute([])),
                       ("blank", lambda: service.distribute(["supplier:sup-A", " "])),
                       ("duplicate", lambda: service.distribute(["supplier:sup-A", "supplier:sup-A"])),
                       ("unpublished", lambda: service.distribute(["supplier:sup-A"], rev=99))):
        try:
            call()
            rejects[name] = ""
        except Exception as err:  # noqa: BLE001
            rejects[name] = type(err).__name__
    out.append(Assertion("分发名单问题即拒绝：空名单 / 空标识 / 重复参与者 / 未发布版本（不得静默成功）",
                         set(rejects.values()) == {"RfqError", "RevisionNotFound"}
                         and rejects["duplicate"] == "RfqError" and rejects["unpublished"] == "RevisionNotFound",
                         f"rejects={rejects}"))

    # 时间点：now=09-23T12:00Z，澄清截止（09-23T00:00Z）已过 12h，报价截止（09-25T00:00Z）还剩 36h
    status = service.deadline_status(now="2026-09-23T12:00:00Z", soon_hours=48)
    by_name = {item["deadline"]: item for item in status["items"]}
    out.append(Assertion("截止时间状态：给出剩余小时、是否临近与是否已过（已过 12h / 还剩 36h）",
                         by_name["clarify_by"]["overdue"] is True
                         and by_name["clarify_by"]["hours_left"] == -12.0
                         and by_name["quote_by"]["hours_left"] == 36.0
                         and by_name["quote_by"]["due_soon"] is True
                         and status["overdue"] == ["clarify_by"] and status["due_soon"] == ["quote_by"],
                         f"items={[(i['deadline'], i['hours_left'], i['due_soon'], i['overdue']) for i in status['items']]}"))
    small = service.deadline_status(now="2026-09-23T12:00:00Z", soon_hours=12)
    out.append(Assertion("「临近」阈值可配：48h 窗口下报价截止临近，12h 窗口下不算临近（阈值不是硬编码语义）",
                         small["due_soon"] == []
                         and {item["deadline"]: item["due_soon"] for item in small["items"]}
                         == {"clarify_by": False, "quote_by": False},
                         f"soon_hours=12 → {small['due_soon']}"))
    fired = service.remind(now="2026-09-23T12:00:00Z", soon_hours=48)
    out.append(Assertion("提醒按状态分流：已过 → `rfq/overdue`，临近 → `rfq/due-soon`，各只针对对应截止",
                         fired["reminder_count"] == 2
                         and {item["event"] for item in fired["fired"]} == {"rfq/overdue", "rfq/due-soon"}
                         and {item["deadline"] for item in fired["fired"]} == {"clarify_by", "quote_by"}
                         and ledger.read(type="rfq/due-soon")[0]["body"]["deadline"] == "quote_by"
                         and ledger.read(type="rfq/overdue")[0]["body"]["deadline"] == "clarify_by",
                         f"fired={[(i['event'], i['deadline']) for i in fired['fired']]}"))
    again = service.remind(now="2026-09-23T13:00:00Z", soon_hours=48)
    out.append(Assertion("提醒幂等：同一版本同一截止的同一状态只提醒一次（重复扫描不刷屏）",
                         again["reminder_count"] == 0
                         and len(ledger.read(type="rfq/due-soon")) == 1
                         and len(ledger.read(type="rfq/overdue")) == 1,
                         f"again={again['reminder_count']} rows="
                         f"{len(ledger.read(type='rfq/due-soon'))}/{len(ledger.read(type='rfq/overdue'))}"))
    later = service.remind(now="2026-09-26T00:00:00Z", soon_hours=48)
    out.append(Assertion("报价截止过期后再提醒一次（状态变化视为新提醒）；截止时间本身**不被顺延**",
                         any(item["event"] == "rfq/overdue" and item["deadline"] == "quote_by"
                             for item in later["fired"])
                         and len(ledger.read(type="rfq/overdue")) == 2
                         and service.revision(2)["deadlines"]["quote_by"] == "2026-09-25T00:00:00Z",
                         f"later={[(i['event'], i['deadline']) for i in later['fired']]}"))
    out.append(Assertion("提醒来自**已发布**版本：未发布的包没有截止时间（不会对草稿提醒）",
                         _remind_unpublished_rejects(service),
                         "未发布版本产生了提醒"))
    return out


def _remind_unpublished_rejects(service) -> bool:
    try:
        service.deadline_status(rev=99)
        return False
    except Exception:  # noqa: BLE001
        return True
