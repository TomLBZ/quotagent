"""事件分发 AC（T-103）：AC-EVT-001（五模式判据）、AC-EVT-002（waterfall 短路且文档登记）。"""

from __future__ import annotations

import re
from pathlib import Path

from ..kernel.events import EventBus, EventModeError, UnknownEventError
from ..paths import repo_root
from .registry import Assertion, register

MODE_JUDGEMENTS = {
    "emit": "通知/留痕：全部调用、不看返回值",
    "parallel": "并发扇出：全部跑完，有错则聚合抛错",
    "serial": "链式决策：遇非 None 即停",
    "bail": "首个有效决策胜出：遇真值即停",
    "waterfall": "中间件：不调 next() 即短路",
}


def _section_rows(rel: str, section: str) -> list[list[str]]:
    """取 markdown 某二级标题下第一个表格的数据行（§5 拦截点总表用）。"""
    text = (repo_root() / rel).read_text(encoding="utf-8")
    block = re.search(rf"^##\s+{re.escape(section)}.*?(?=^##\s|\Z)", text, re.S | re.M)
    if not block:
        return []
    rows = []
    for line in block.group(0).splitlines():
        if line.startswith("|") and not re.match(r"^\|\s*-{2,}", line):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if cells and not cells[0].startswith("拦截"):
                rows.append(cells)
    return rows


@register("AC-EVT-001", "P0", "五模式的分发顺序与返回值符合 05-events.md §1 判据",
          "qa ac AC-EVT-001", evidence_refs=("EV-009",))
def ac_evt_001() -> list[Assertion]:
    out: list[Assertion] = []
    bus = EventBus()
    for name, mode in (("t/emit", "emit"), ("t/parallel", "parallel"), ("t/serial", "serial"),
                       ("t/bail", "bail"), ("t/waterfall", "waterfall")):
        bus.declare(name, mode, reason="AC-EVT-001 的中间件链测试事件（短路理由已在 05-events.md §5 登记机制内）"
                    if mode == "waterfall" else "")

    # emit：全部调用、顺序保持、返回值为 None（不看返回值）
    seen: list[str] = []
    bus.on("t/emit", lambda *a: seen.append("A"))
    bus.on("t/emit", lambda *a: (seen.append("B"), "ignored")[1])
    emitted = bus.emit("t/emit")
    out.append(Assertion(f"emit —— {MODE_JUDGEMENTS['emit']}", seen == ["A", "B"] and emitted is None,
                         f"order={seen} return={emitted!r}"))

    # parallel：全部跑完，有错则聚合抛错；全部执行是重点
    ran: list[str] = []

    def boom() -> None:
        ran.append("B")
        raise ValueError("listener B failed")

    bus.on("t/parallel", lambda: ran.append("A"))
    bus.on("t/parallel", boom)
    bus.on("t/parallel", lambda: ran.append("C"))
    aggregated = None
    try:
        bus.parallel("t/parallel")
        aggregated = False
    except Exception as exc:  # noqa: BLE001 - 断言层需要看到聚合异常
        aggregated = exc
    out.append(Assertion(f"parallel —— {MODE_JUDGEMENTS['parallel']}",
                         ran == ["A", "B", "C"] and isinstance(aggregated, Exception)
                         and getattr(aggregated, "errors", None) is not None
                         and "listener B failed" in str(aggregated),
                         f"ran={ran} error={aggregated!r}"))

    ok_bus = EventBus()
    ok_bus.declare("t/parallel-ok", "parallel")
    ok_bus.on("t/parallel-ok", lambda: 1)
    ok_bus.on("t/parallel-ok", lambda: 2)
    results = ok_bus.parallel("t/parallel-ok")
    out.append(Assertion("parallel —— 无错时按注册顺序返回结果列表", results == [1, 2], f"results={results}"))

    # serial：遇非 None 即停，后续不执行
    serial_seen: list[str] = []
    bus.on("t/serial", lambda: serial_seen.append("A"))
    bus.on("t/serial", lambda: (serial_seen.append("B"), "stop")[1])
    bus.on("t/serial", lambda: serial_seen.append("C"))
    serial_result = bus.serial("t/serial")
    out.append(Assertion(f"serial —— {MODE_JUDGEMENTS['serial']}",
                         serial_result == "stop" and serial_seen == ["A", "B"],
                         f"result={serial_result!r} called={serial_seen}"))

    # bail：首个真值胜出，后续不执行
    bail_seen: list[str] = []
    bus.on("t/bail", lambda: (bail_seen.append("A"), None)[1])
    bus.on("t/bail", lambda: (bail_seen.append("B"), False)[1])
    bus.on("t/bail", lambda: (bail_seen.append("C"), "winner")[1])
    bus.on("t/bail", lambda: (bail_seen.append("D"), "loser")[1])
    bail_result = bus.bail("t/bail")
    out.append(Assertion(f"bail —— {MODE_JUDGEMENTS['bail']}",
                         bail_result == "winner" and bail_seen == ["A", "B", "C"],
                         f"result={bail_result!r} called={bail_seen}"))

    # waterfall：链式改写，返回值是最终值；顺序保持
    wf_seen: list[str] = []

    def step1(value, next_):
        wf_seen.append("1")
        return next_(value + "1")

    def step2(value, next_):
        wf_seen.append("2")
        return next_(value + "2")

    bus.on("t/waterfall", step1)
    bus.on("t/waterfall", step2)
    wf_result = bus.waterfall("t/waterfall", "")
    out.append(Assertion(f"waterfall —— {MODE_JUDGEMENTS['waterfall']}（委托链正常时顺序执行）",
                         wf_result == "12" and wf_seen == ["1", "2"],
                         f"result={wf_result!r} called={wf_seen}"))

    # 每个事件只有一个 @mode：用错方法即报错
    wrong_emit = None
    try:
        bus.emit("t/waterfall")
    except EventModeError as exc:
        wrong_emit = exc
    wrong_waterfall = None
    try:
        bus.waterfall("t/emit", "v")
    except EventModeError as exc:
        wrong_waterfall = exc
    undeclared = None
    try:
        bus.emit("t/never-declared")
    except UnknownEventError as exc:
        undeclared = exc
    out.append(Assertion("每个事件只有一个 @mode：用错分发方法/未声明事件即报错（05-events.md §0 规则 1）",
                         wrong_emit is not None and wrong_waterfall is not None and undeclared is not None,
                         f"emit->{wrong_emit!r} waterfall->{wrong_waterfall!r} undeclared->{undeclared!r}"))

    # 注册即 effect：disposer 撤销后不再被调用
    calls: list[str] = []
    dispose = bus.on("t/emit", lambda *a: calls.append("X"))
    bus.emit("t/emit")
    before = list(calls)
    dispose()
    bus.emit("t/emit")
    out.append(Assertion("on() 返回 disposer，撤销后监听器不再被调用（FR-EVT-002）",
                         before == ["X"] and calls == before, f"before={before} after={calls}"))
    return out


@register("AC-EVT-002", "P0", "waterfall 不调 next() 即短路（下游不执行），且短路点已在 05-events.md §5 登记",
          "qa ac AC-EVT-002", evidence_refs=("EV-010",))
def ac_evt_002() -> list[Assertion]:
    out: list[Assertion] = []
    bus = EventBus()
    bus.install_defaults(reason_check=True)

    # 用文档已登记的 waterfall 事件做实测：quote/normalize（05-events.md §3 + §5）
    calls: list[str] = []

    def unit_step(value, next_):
        calls.append("unit")
        return next_(value)

    def tax_step(value, next_):
        calls.append("tax")
        return {"rejected": "缺少计量规则", "at": "tax"}

    def align_step(value, next_):
        calls.append("align")
        return next_(value)

    bus.on("quote/normalize", unit_step)
    bus.on("quote/normalize", tax_step)
    bus.on("quote/normalize", align_step)
    result = bus.waterfall("quote/normalize", {"line": 1})
    out.append(Assertion("waterfall 监听器不调 next() → 下游监听器不执行，其返回值即最终值",
                         calls == ["unit", "tax"] and result == {"rejected": "缺少计量规则", "at": "tax"},
                         f"called={calls} result={result!r}"))

    short = bus.short_circuits
    out.append(Assertion("短路被显式记录（事件名 + 监听器位置 + 返回值摘要），不是静默丢弃",
                         bool(short) and short[-1]["event"] == "quote/normalize"
                         and short[-1]["index"] == 1,
                         f"short_circuits={short[-1] if short else None}"))

    rows = _section_rows("docs/design/05-events.md", "5. 拦截点总表")
    documented = {(row[1].strip("` "), row[2].strip()) for row in rows if len(row) >= 3}
    out.append(Assertion("该短路点在 05-events.md §5 拦截点总表中登记为 waterfall",
                         ("quote/normalize", "waterfall") in documented,
                         f"§5 中 waterfall 行={sorted(n for n, m in documented if m == 'waterfall')}"))

    declared_waterfall = [name for name, mode in EventBus.default_table().items() if mode == "waterfall"]
    undocumented = [name for name in declared_waterfall if (name, "waterfall") not in documented]
    out.append(Assertion("默认事件表中每个 waterfall 事件都在 §5 有登记（FR-EVT-003：短路必须是文档化设计意图）",
                         not undocumented and bool(declared_waterfall),
                         f"未登记={undocumented} 已声明={declared_waterfall}"))

    mismatch = None
    try:
        bus.install_defaults(reason_check=True)
        EventBus().declare("t/bad-waterfall", "waterfall", reason="")
    except Exception as exc:  # noqa: BLE001
        mismatch = exc
    out.append(Assertion("声明 waterfall 必须给出短路理由（空理由被拒绝）", mismatch is not None,
                         f"error={mismatch!r}"))
    return out
