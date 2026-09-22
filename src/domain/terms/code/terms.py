"""B12：services/terms.py —— 条款库（版本化 + 默认条款应用 + 冲突标注，绝不静默取其一）。

设计依据 `docs/design/04-services-catalog.md` §`ctx.terms`（P1）：
- 职责：合同条款库与冲突检测（付款、质保、罚则、验收标准）
- Definition：`library(query)` · `conflicts(quote) -> Conflict[]` · `apply_defaults(package)`
- 不变量：**条款冲突只能标注并提请人工，不得静默取其一**

实现要点（全部有 AC-TERMS-001 断言）：
- 版本化：`define/revise` 只追加新版本，旧版本保留；`as_of` 取当时生效版本；
- 默认条款：只补**缺失键**、绝不覆盖已给值，且每条补入项标 `source=library-default`（不得冒充供应商承诺）；
- 冲突：逐族逐键**并列 required/offered**，`resolution=None`、`requires_human=True`，输出中**不存在任何胜出值字段**；
- 未知键（库里没有）也照样提请人工，不因"库不认识"就放行；
- 基线只能由 `human:*` 或 `bundle:*` 载入（agent 不能单方面改写承包商条款基线）。
"""
from __future__ import annotations

from typing import Any

FAMILIES: tuple[str, ...] = ("payment_terms", "warranty_terms", "penalty_terms", "acceptance_terms")
FAMILY_LABELS = {"payment_terms": "付款", "warranty_terms": "质保", "penalty_terms": "罚则",
                 "acceptance_terms": "验收"}

DEFINED_EVENT = "terms/defined"
APPLIED_EVENT = "terms/applied"
CONFLICT_EVENT = "terms/conflict"

ALLOWED_SOURCES = ("human:", "bundle:")


class TermsError(ValueError):
    """条款库用法错误（族名/来源/版本非法等）。"""


def _offered_side(document: dict | None, family: str) -> dict:
    """供应商侧族名别名：交换协议中付款等族以 `payment_terms_offered` 形式出现（`03` §条款行）。

    单点识别别名，避免每个调用方各自记这一条（guard/compare/terms 只认这一个函数）。
    """
    body = document or {}
    return body.get(family) or body.get(f"{family}_offered") or {}


class Conflict(dict):
    """冲突条目：只有并列事实，没有胜出值（`resolution` 恒为 None）。"""


class TermLibrary:
    def __init__(self, *, ledger=None, events=None, as_of: str | None = None) -> None:
        self.ledger = ledger
        self.events = events
        self.as_of = as_of
        self._entries: dict[str, dict[str, list[dict]]] = {family: {} for family in FAMILIES}

    # --- 载入基线 ---------------------------------------------------------
    def define(self, family: str, key: str, value: Any, *, version: int = 1,
               effective_from: str | None = None, source: str = "human:ops", note: str = "") -> dict:
        if family not in FAMILIES:
            raise TermsError(f"未知条款族: {family!r}（仅 {FAMILIES}）")
        if not key:
            raise TermsError("条款键不能为空")
        if not str(source).startswith(ALLOWED_SOURCES):
            raise TermsError(f"条款基线只能由 human:/bundle: 载入，收到 source={source!r}"
                             f"（agent 不得单方面改写条款基线）")
        record = {"family": family, "key": key, "value": value, "version": int(version),
                  "effective_from": effective_from or self.as_of or "1970-01-01T00:00:00Z",
                  "source": source, "note": note}
        history = self._entries[family].setdefault(key, [])
        if any(item["version"] == record["version"] for item in history):
            raise TermsError(f"版本已存在: {family}/{key} v{record['version']}（修订请用 revise）")
        history.append(record)
        history.sort(key=lambda item: (item["effective_from"], item["version"]))
        self._emit(DEFINED_EVENT, record)
        return record

    def revise(self, family: str, key: str, value: Any, *, effective_from: str | None = None,
               source: str = "human:ops", note: str = "") -> dict:
        history = self._entries.get(family, {}).get(key) or []
        if not history:
            raise TermsError(f"未定义的条款不能修订: {family}/{key}（先 define 基线）")
        return self.define(family, key, value, version=history[-1]["version"] + 1,
                           effective_from=effective_from, source=source, note=note)

    # --- 视图 -------------------------------------------------------------
    def library(self, query: str | None = None, *, as_of: str | None = None) -> dict:
        """生效版本视图（`as_of` 取当时生效版本；不传用 `self.as_of`）。"""
        moment = as_of or self.as_of
        out: dict[str, dict] = {}
        for family in FAMILIES:
            if query and query != family:
                continue
            chosen: dict[str, dict] = {}
            for key, history in self._entries[family].items():
                live = [item for item in history if not moment or item["effective_from"] <= moment]
                if live:
                    chosen[key] = dict(live[-1])
            if chosen:
                out[family] = chosen
        return out

    # --- 默认条款应用（FR-TERMS-001） --------------------------------------
    def apply_defaults(self, terms: dict | None, *, as_of: str | None = None) -> dict:
        """只补**缺失键**；已有值一律不动（不静默覆盖），补入项显式标 `source=library-default`。"""
        given = dict(terms or {})
        library = self.library(as_of=as_of)
        applied: list[dict] = []
        for family, keys in library.items():
            bucket = given.setdefault(family, {})
            for key, item in keys.items():
                if key in bucket:
                    continue
                bucket[key] = item["value"]
                applied.append({"family": family, "key": key, "value": item["value"],
                                "version": item["version"], "source": "library-default"})
        result = {"terms": given, "applied": applied, "applied_count": len(applied),
                  "note": "默认条款只补缺失键，且标 source=library-default（不等于供应商承诺）"}
        if applied:
            self._emit(APPLIED_EVENT, {"applied": applied, "applied_count": len(applied),
                                       "keys": [f"{item['family']}/{item['key']}" for item in applied],
                                       "families": sorted({item["family"] for item in applied}),
                                       "source": "library-default"})
        return result

    # --- 冲突标注（FR-TERMS-002：必须，不得静默取其一） --------------------
    def conflicts(self, required: dict | None, offered: dict | None = None, *,
                  quote_id: str | None = None, as_of: str | None = None) -> list[Conflict]:
        library = self.library(as_of=as_of)
        out: list[Conflict] = []
        families = [family for family in FAMILIES
                    if (required or {}).get(family) or _offered_side(offered, family)]
        for family in families:
            want = (required or {}).get(family) or {}
            have = _offered_side(offered, family) or {}
            known = set((library.get(family) or {}))
            for key in sorted(set(want) | set(have)):
                left, right = want.get(key), have.get(key)
                if left is None and right is None:
                    continue
                if left == right:
                    continue  # 双方一致即无差异（库认不认识都不构成冲突）
                if left is None or right is None:
                    missing = "required" if left is None else "offered"
                    out.append(Conflict(self._item(family, key, left, right, quote_id,
                                                  status=f"{missing}_only", severity="low",
                                                  detail=f"{FAMILY_LABELS[family]}条款 {key} 仅一方给出"
                                                         f"（{missing} 缺）——信息项，不自动补入对方")))
                    continue
                if key not in known:
                    out.append(Conflict(self._item(family, key, left, right, quote_id,
                                                  status="unknown_key", severity="medium",
                                                  detail=f"{FAMILY_LABELS[family]}条款键不在库中：{key}"
                                                         f"（不因库不认识就放行）")))
                    continue
                out.append(Conflict(self._item(family, key, left, right, quote_id,
                                              status="mismatch", severity="medium",
                                              detail=f"{FAMILY_LABELS[family]}条款 {key} 双方不一致，"
                                                     f"只能提请人工裁定")))
        return out

    def escalate(self, conflicts: list[Conflict], *, approvals, ref: str, approvers: list[str],
                 reason: str = "条款冲突需人工裁定") -> dict | None:
        """把冲突提请人工门（**绝不自动选值**）；无冲突则不产生任何批准请求。"""
        blocking = [item for item in conflicts if item["status"] in ("mismatch", "unknown_key")]
        if not blocking:
            return None
        payload = {"conflicts": [dict(item) for item in blocking], "count": len(blocking),
                   "families": sorted({item["family"] for item in blocking})}
        for item in blocking:
            self._emit(CONFLICT_EVENT, dict(item))
        return approvals.request("terms.resolve", payload, ref=ref, approvers=approvers,
                                 reason=reason, summary=f"{len(blocking)} 处条款冲突待裁定",
                                 flags=[f"term_conflict:{item['family']}" for item in blocking])

    # --- 内部 -------------------------------------------------------------
    def _item(self, family: str, key: str, required: Any, offered: Any, quote_id,
              *, status: str, severity: str, detail: str) -> dict:
        return {"kind": "term_conflict", "family": family, "key": key, "status": status,
                "required": required, "offered": offered, "resolution": None,
                "requires_human": True, "severity": severity, "detail": detail,
                "quote_id": quote_id,
                "evidence_refs": [ref for ref in (f"quote:{quote_id}:{family}" if quote_id else None,
                                                  f"terms:{family}/{key}") if ref]}

    def _emit(self, event: str, body: dict) -> None:
        if self.ledger is not None:
            self.ledger.append(event, body, correlation_id=body.get("quote_id") or body.get("key"))
        if self.events is not None:
            self.events.emit(event, body)
