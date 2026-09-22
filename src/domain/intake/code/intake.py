"""ctx.intake 的 P0 实现（`04-services-catalog.md` §4 / `06-agents-and-prompts.md` IntakeAgent）。

不变量：抽取结果逐条引用 `item_id` 与来源；**无引用的抽取进入 `[假设]`，人工确认后才成为事实**；
缺项检测必须覆盖草稿中人为删减的条目；疑问清单**必须人工确认后才能外发**（P8 人工门前置）。
P0 的"读包"由确定性 extractor 替身完成（模型替身），因此落账的是结构化抽取结果而不是模型自由文本。
"""

from __future__ import annotations

import copy
from typing import Any

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger
from .rfq import RfqService

INTAKE_EVENT = "quote/intake-completed"
ASSUMPTION_EVENT = "agent/assumption-raised"
ASKED_EVENT = "clarification/asked"

ASSUMPTION_MARKER = "[假设]"


class IntakeError(RuntimeError):
    """读包错误。"""


class UnconfirmedDraftError(IntakeError):
    """未获人工确认的草案不得外发 / 不得升级为事实。"""


class DependencyNotReady(IntakeError):
    """依赖（rfq）不可用。"""


class TemplateExtractor:
    """P0 的确定性读包替身（模型替身）：逐条读清单条目与规格引用。

    `include_unsourced=True` 时额外产出一条**无来源引用**的抽取项，用于演练 `[假设]` 路径
    （真实场景里这对应"模型自信但无据"的产出）。
    """

    name = "extractor.template@0.1.0"

    def __init__(self, *, include_unsourced: bool = False) -> None:
        self.include_unsourced = include_unsourced

    def extract(self, package: dict) -> list[dict]:
        lines: list[dict] = []
        for item in package.get("items", []):
            lines.append({
                "item_id": item["item_id"],
                "description": item.get("description", ""),
                "unit": item.get("unit"),
                "qty": item.get("qty"),
                "spec_refs": list(item.get("spec_refs") or []),
                "source": f"{package['package_id']}#rev{package['rev']}:{item['item_id']}",
                "status": "extracted",
            })
        if self.include_unsourced:
            lines.append({
                "item_id": "NEW-001",
                "description": "现场踏勘提到的临时封堵（无图纸/规范引用）",
                "unit": "m",
                "qty": 10,
                "spec_refs": [],
                "source": "",
                "status": "assumption",
                "marker": ASSUMPTION_MARKER,
                "assumption_reason": "抽取结果无来源引用（无 spec_refs、无图纸版本），只能作为待确认假设",
            })
        return lines


class IntakeService:
    """`ctx.intake` 的默认 Provider；依赖 `rfq`（依赖未就绪不得激活，FR-PLUGIN-001）。"""

    def __init__(self, *, ledger: Ledger | None = None, events: EventBus | None = None,
                 extractor: TemplateExtractor | None = None, actor: str = "agent:intake",
                 name: str = "intake") -> None:
        self.ledger = ledger
        self.events = events
        self.extractor = extractor or TemplateExtractor()
        self.actor = actor
        self.name = name
        self.rfq: RfqService | None = None
        self._lines: list[dict] = []
        self._questions: list[dict] = []
        self._intake_ref: dict | None = None

    # --- 装配 -------------------------------------------------------------
    def attach(self, ctx) -> None:
        self.rfq = ctx.service("rfq")
        ctx.effect("service", "intake:rfq", lambda: setattr(self, "rfq", None))

    def plugin_spec(self) -> dict:
        return {"name": self.name, "inject": ["rfq"], "provide": {self.name: self}, "setup": self.attach}

    # --- 读包 -------------------------------------------------------------
    def ingest(self, rev: int | None = None) -> dict:
        if self.rfq is None:
            raise DependencyNotReady("读包需要已装载的 rfq 服务（依赖未就绪）")
        package = self.rfq.package_ref(rev)
        extracted = self.extractor.extract(package)
        self._lines = [{**line, "package_id": package["package_id"], "rfq_rev": package["rev"]}
                       for line in extracted]
        facts = [line for line in self._lines if line["status"] == "extracted"]
        assumptions = [line for line in self._lines if line["status"] == "assumption"]
        body = {"package_id": package["package_id"], "rfq_rev": package["rev"],
                "items": len(facts), "assumptions": len(assumptions),
                "extractor": self.extractor.name,
                "item_ids": [line["item_id"] for line in facts]}
        ref = None
        if self.ledger is not None:
            ref = self.ledger.append(INTAKE_EVENT, body, correlation_id=package["package_id"],
                                     actor=self.actor,
                                     refs={"package_id": package["package_id"], "rfq_rev": package["rev"]})
        if self.events is not None:
            for line in assumptions:
                self.events.emit(ASSUMPTION_EVENT, {"package_id": package["package_id"],
                                                    "rfq_rev": package["rev"],
                                                    "item_id": line["item_id"],
                                                    "reason": line["assumption_reason"]})
        self._intake_ref = ref.as_dict() if ref else None
        self._questions = []
        return {"package_id": package["package_id"], "rfq_rev": package["rev"],
                "lines": copy.deepcopy(self._lines), "facts": copy.deepcopy(facts),
                "assumptions": copy.deepcopy(assumptions), "ledger_ref": self._intake_ref}

    def current_lines(self) -> list[dict]:
        return copy.deepcopy(self._lines)

    def confirm_assumption(self, item_id: str, *, by: str) -> dict:
        """假设项升级为事实：只能由人确认（agent 不得自行升级）。"""
        if not by.startswith("human:"):
            raise UnconfirmedDraftError(f"假设项只能由人确认，收到 {by!r}（agent 不得自行升级为事实）")
        for line in self._lines:
            if line["item_id"] == item_id and line["status"] == "assumption":
                line["status"] = "confirmed"
                line["confirmed_by"] = by
                return copy.deepcopy(line)
        raise IntakeError(f"没有待确认的假设项: {item_id}")

    # --- 缺项 -------------------------------------------------------------
    def missing(self, draft: dict | None = None) -> list[dict]:
        draft_ids = {line.get("item_id") for line in (draft or {}).get("lines", [])}
        out: list[dict] = []
        for line in self._lines:
            if line["status"] == "assumption" and line["item_id"] not in draft_ids:
                continue
            if line["item_id"] not in draft_ids:
                out.append({"item_id": line["item_id"],
                            "description": line.get("description", ""),
                            "reason": "in_draft_but_omitted",
                            "refs": [line["source"]] if line["source"] else [],
                            "next_action": "把该条目补进报价草稿，或向承包商发澄清说明为何不报（缺项不得静默）"})
        return out

    # --- 疑问草案 ---------------------------------------------------------
    def questions(self, draft: dict | None = None) -> list[dict]:
        drafts: list[dict] = []
        for index, line in enumerate(self._lines, 1):
            needs = line["status"] == "assumption" or not line.get("spec_refs")
            if not needs:
                continue
            reference = line["source"] or f"{line['package_id']}#rev{line['rfq_rev']}:{line['item_id']}"
            drafts.append({
                "question_id": f"Q-{index:03d}",
                "rfq_rev": line["rfq_rev"],
                "refs": [reference],
                "item_id": line["item_id"],
                "text": f"条目 {line['item_id']}（{line.get('description', '')}）的规格/计量口径请确认",
                "status": "draft",
                "confirmed_by": None,
            })
        self._questions = drafts
        return copy.deepcopy(drafts)

    def confirm_questions(self, question_ids: list[str] | None = None, *, by: str) -> dict:
        if not by.startswith("human:"):
            raise UnconfirmedDraftError(f"疑问清单只能由人确认后外发，收到 {by!r}（agent 代签被拒绝）")
        if not self._questions:
            self.questions()
        targets = set(question_ids) if question_ids else {q["question_id"] for q in self._questions}
        confirmed = []
        for question in self._questions:
            if question["question_id"] in targets:
                question["status"] = "confirmed"
                question["confirmed_by"] = by
                confirmed.append(question["question_id"])
        if not confirmed:
            raise IntakeError(f"没有匹配的疑问草案: {sorted(targets)}")
        return {"confirmed": confirmed, "confirmed_by": by}

    def send_questions(self, question_ids: list[str] | None = None) -> dict:
        if not self._questions:
            raise IntakeError("没有疑问草案（先调用 questions()）")
        targets = set(question_ids) if question_ids else {q["question_id"] for q in self._questions}
        pending = [q for q in self._questions if q["question_id"] in targets and q["status"] != "confirmed"]
        if pending:
            raise UnconfirmedDraftError(
                f"{len(pending)} 条疑问尚未获得人工确认（{pending[0]['question_id']} 等），禁止外发")
        sent = []
        for question in self._questions:
            if question["question_id"] not in targets:
                continue
            body = {"ticket_id": question["question_id"], "package_id": self._lines[0]["package_id"]
                    if self._lines else None, "rfq_rev": question["rfq_rev"],
                    "question": question["text"], "refs": list(question["refs"]),
                    "confirmed_by": question["confirmed_by"], "asked_by": self.actor}
            if self.ledger is not None:
                self.ledger.append(ASKED_EVENT, body,
                                   correlation_id=body["package_id"] or question["question_id"],
                                   actor=self.actor,
                                   refs={"package_id": body["package_id"],
                                         "rfq_rev": question["rfq_rev"]})
            sent.append({"question_id": question["question_id"], "refs": question["refs"],
                         "confirmed_by": question["confirmed_by"]})
        return {"sent": sent, "count": len(sent)}
