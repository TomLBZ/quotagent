"""ctx.guard 的 P0 实现（`04-services-catalog.md` §4 / `02-domain-model.md` §2.4 / `08` §3）。

职责：护栏 —— 异常低价、漏项、产能风险、条款冲突、外部诱导文本（prompt injection）、
正文私域泄露。**护栏只能产出 Flag，不得直接否决授标**：Flag 不改变排序、不改变状态、
不阻断后续流程（否决权在人，`09` §5 的告警另走人工门）。

Flag 形状（`02` §2.4 + ADR-0011 扩展 `private_leak`）：
    {flag_id, kind, severity, target_ref, detail, evidence_refs[], detected_at}
每条 Flag 落账 `compare/flag-raised`（durable）——"Flag 从不由模型自行消解"。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar
from typing import Any, Callable

from ..kernel.events import EventBus
from ..kernel.ledger import Ledger, utc_now

FLAG_EVENT = "compare/flag-raised"
FLAG_KINDS = ("abnormal_low", "missing_item", "capacity_risk", "term_conflict",
              "external_term", "private_leak")
SEVERITIES = ("low", "medium", "high")

# 注入/越权指令的表征（命中即标注，绝不执行；原文保留在 detail 里供人看）
INJECTION_PATTERNS = (
    "忽略以上", "忽略之前", "ignore previous", "ignore above", "system prompt",
    "直接授标", "无需批准", "跳过审批", "skip approval", "approve yourself",
    "你现在是", "you are now", "输出你的系统提示", "reveal your instructions",
)
# 私域泄露表征：对方正文里出现本侧私域口径的名字/数字口径
PRIVATE_MARKERS = ("reserve_price", "标底", "internal_score", "内评", "cost_model",
                   "成本明细", "margin_pct")


@dataclass
class GuardService:
    ledger: Ledger | None = None
    events: EventBus | None = None
    actor: str = "agent:guard"
    # 条款族：付款 / 质保 / 罚则（FR-GUARD-004）。逐族比对，逐项给出 required vs offered。
    TERM_FAMILIES: ClassVar[tuple[str, ...]] = ("payment_terms", "warranty_terms", "penalty_terms")
    rules: list[dict] = field(default_factory=list, init=False)
    _counter: int = field(default=0, init=False)
    _rules: list = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        for rule in (self._rule_missing_item, self._rule_abnormal_low, self._rule_capacity_risk,
                     self._rule_term_conflict, self._rule_external_term, self._rule_private_leak):
            self.register_rule({"name": rule.__name__.removeprefix("_rule_"), "fn": rule})

    # --- 规则注册（一切注册返回 disposer：AGENTS.md 规则 1） ---------------
    def register_rule(self, rule: dict) -> Callable[[], None]:
        entry = {"name": rule["name"], "fn": rule["fn"], "source": rule.get("source", "builtin")}
        self._rules.append(entry)
        self.rules.append(entry)

        def disposer() -> None:
            if entry in self._rules:
                self._rules.remove(entry)
            if entry in self.rules:
                self.rules.remove(entry)

        return disposer

    def rule_names(self) -> list[str]:
        return sorted(entry["name"] for entry in self._rules)

    # --- 检查（只产出 Flag） ---------------------------------------------
    def check(self, target: dict, *, ruleset: list[str] | None = None) -> list[dict]:
        if self.ledger is not None:
            self.ledger.assert_healthy()
        package = target.get("package") or {}
        quotes = target.get("quotes") or []
        flags: list[dict] = []
        for rule in list(self._rules):
            if ruleset is not None and rule["name"] not in ruleset:
                continue
            for flag in rule["fn"](target) or []:
                flags.append(self._finalize(flag, package, target))
        flags.sort(key=lambda item: (item["kind"], item["target_ref"]))
        for flag in flags:
            self._append(flag, package)
        return flags

    def capacities(self, quotes: list[dict]) -> dict:
        return {quote["quote_id"]: (quote.get("capacity") or {}) for quote in quotes}

    # --- 内置规则 ---------------------------------------------------------
    def _rule_missing_item(self, target: dict) -> list[dict]:
        package = target.get("package") or {}
        required = [item["item_id"] for item in package.get("items", [])]
        out = []
        for quote in target.get("quotes", []):
            offered = {line.get("item_id") for line in quote.get("lines") or []}
            missing = [item_id for item_id in required if item_id not in offered]
            if missing:
                out.append({"kind": "missing_item", "severity": "high", "target_ref": quote["quote_id"],
                            "detail": f"清单条目在报价中缺失: {missing}",
                            "evidence_refs": [f"package:{package.get('package_id')}#rev{package.get('rev')}:items",
                                              f"quote:{quote['quote_id']}:lines"]})
        return out

    def _rule_abnormal_low(self, target: dict) -> list[dict]:
        quotes = sorted(target.get("quotes", []), key=lambda item: item["quote_id"])
        if len(quotes) < 3:
            return []
        amounts = sorted(float(quote.get("total_amount") or 0.0) for quote in quotes)
        median = amounts[len(amounts) // 2]
        threshold = float((target.get("thresholds") or {}).get("abnormal_low_ratio", 0.6)) * median
        out = []
        for quote in quotes:
            amount = float(quote.get("total_amount") or 0.0)
            if amount < threshold:
                out.append({"kind": "abnormal_low", "severity": "high", "target_ref": quote["quote_id"],
                            "detail": f"报价 {amount:.2f} 低于同包中位价 {median:.2f} 的 "
                                      f"{(target.get('thresholds') or {}).get('abnormal_low_ratio', 0.6):.0%} "
                                      f"（阈值 {threshold:.2f}）；异常低价不得自动否决，只能提请人工",
                            "evidence_refs": [f"quote:{quote['quote_id']}:total_amount",
                                              f"compare:median:{median:.2f}"]})
        return out

    def _rule_capacity_risk(self, target: dict) -> list[dict]:
        """产能风险两条来源：① 声称产能超过可验证上限；② 产能日历/关键路径算出的不可行结论（T-207）。"""
        package = target.get("package") or {}
        limit = ((package.get("capacity") or {}).get("max_tonnes_per_month"))
        out = []
        for quote in target.get("quotes", []):
            claim = (quote.get("capacity") or {}).get("declared_tonnes_per_month")
            if limit is not None and claim is not None and float(claim) > float(limit):
                out.append({"kind": "capacity_risk", "severity": "high", "target_ref": quote["quote_id"],
                            "requires_human": True,
                            "detail": f"声称产能 {claim} t/月 超过本包可验证上限 {limit} t/月"
                                      f"（该声称记为 [假设]，不自动采信）",
                            "evidence_refs": [f"quote:{quote['quote_id']}:capacity",
                                              f"package:{package.get('package_id')}#rev{package.get('rev')}:capacity"]})
        # 由产能服务（ctx.capacity）算出的日历/关键路径结论：只转 Flag，不改交期、不否决
        for conflict in target.get("capacity_conflicts") or []:
            out.append({"kind": "capacity_risk", "severity": "high",
                        "target_ref": conflict.get("quote_id") or conflict.get("commitment_id"),
                        "requires_human": True,
                        "detail": f"产能/交期不可行：需要 {float(conflict.get('required', 0)):g}，"
                                  f"日历可用 {float(conflict.get('available', 0)):g}"
                                  f"（缺口 {float(conflict.get('shortfall', 0)):g}）",
                        "evidence_refs": [f"commitment:{conflict.get('commitment_id')}:window",
                                          "calendar:private"]})
        return out

    def _rule_term_conflict(self, target: dict) -> list[dict]:
        package = target.get("package") or {}
        out = []
        for family in self.TERM_FAMILIES:
            required = package.get(family) or {}
            if not required:
                continue
            for quote in target.get("quotes", []):
                offered = quote.get(family) or quote.get(f"{family}_offered") or {}
                diffs = {key: {"required": required.get(key), "offered": offered.get(key)}
                         for key in set(required) | set(offered) if required.get(key) != offered.get(key)}
                if not diffs:
                    continue
                label = {"payment_terms": "付款", "warranty_terms": "质保", "penalty_terms": "罚则"}[family]
                out.append({"kind": "term_conflict", "severity": "medium", "target_ref": quote["quote_id"],
                            "detail": f"{label}条款与包内要求不一致: {sorted(diffs)}",
                            "requires_human": True, "family": family, "diffs": diffs,
                            "evidence_refs": [f"quote:{quote['quote_id']}:{family}",
                                              f"package:{package.get('package_id')}#rev{package.get('rev')}:{family}"]})
        return out

    def _rule_external_term(self, target: dict) -> list[dict]:
        out = []
        for quote in target.get("quotes", []):
            for hit in self.screen_text(quote.get("notes") or ""):
                out.append({"kind": "external_term", "severity": "high", "target_ref": quote["quote_id"],
                            "detail": f"报价正文含外部诱导文本（原文保留、只标注，不执行）: {hit['snippet']}",
                            "evidence_refs": [f"quote:{quote['quote_id']}:notes"],
                            "sub_kind": "prompt_injection", "pattern": hit["pattern"]})
        return out

    def _rule_private_leak(self, target: dict) -> list[dict]:
        out = []
        for quote in target.get("quotes", []):
            text = str(quote.get("notes") or "")
            hits = [marker for marker in PRIVATE_MARKERS if marker in text]
            if hits:
                out.append({"kind": "private_leak", "severity": "high", "target_ref": quote["quote_id"],
                            "detail": f"报价正文出现私域口径标记 {hits}（硬阻断在投影层，"
                                      f"这里只标注并留痕）",
                            "evidence_refs": [f"quote:{quote['quote_id']}:notes"]})
        return out

    # --- 工具 -------------------------------------------------------------
    def screen_text(self, text: str) -> list[dict]:
        hits = []
        lowered = text.lower()
        for pattern in INJECTION_PATTERNS:
            if pattern.lower() in lowered:
                index = lowered.index(pattern.lower())
                hits.append({"pattern": pattern,
                             "snippet": text[max(0, index - 24):index + len(pattern) + 24].replace("\n", " ")})
        return hits

    def _finalize(self, flag: dict, package: dict, target: dict) -> dict:
        self._counter += 1
        record = dict(flag)
        record.setdefault("severity", "medium")
        record.setdefault("evidence_refs", [])
        record["flag_id"] = f"fl-{self._counter:04d}"
        record["detected_at"] = utc_now()
        record["package_id"] = package.get("package_id")
        record["realm"] = getattr(self.ledger, "realm", "local")
        return record

    def _append(self, flag: dict, package: dict) -> None:
        if self.ledger is None:
            return
        body = {key: value for key, value in flag.items() if key != "detected_at"}
        self.ledger.append(FLAG_EVENT, body, correlation_id=package.get("package_id") or "package",
                           actor=self.actor, refs={"target_ref": flag["target_ref"]})
        if self.events is not None and self.events.mode_of(FLAG_EVENT) not in (None, "waterfall"):
            self.events.emit(FLAG_EVENT, body)
