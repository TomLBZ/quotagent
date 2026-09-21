"""services/retention.py —— 留存策略引擎（只读计划，FR-EVIDENCE-004 / NFR-COMP-003）。

设计边界（每一句都有 AC-AUDIT-003 的机检断言）：

- **只计算计划，不执行**：本服务不写文件、不删文件、不追加账本、不发起批准。它返回"该做什么"的
  计划（`plan(entries, now)`），真正执行与留痕属于调用方——且执行前必须先过人工门。
- **账本行永不销毁**：`Ledger.append` 是唯一写入口，历史只增不改（FR-LEDGER-001）。任何把**账本行**
  判为可销毁的意图一律拒绝：策略配置里写 `scope: "ledger"` 在建策略时就抛
  `LedgerRowNotDestroyable`；逐条判定时该行被判 `keep`，拒绝理由进结果并计入 `counts.refused`。
  `purge-copy` 只针对**派生副本**（审计包、导出文件、缓存），永远不是账本行。
- **不依赖墙钟**：时间只由参数传入（`now=None` 即拒绝，绝不回退到 `utc_now()`）；同一输入两次
  输出**字节一致**（`render()` 走 `canonical_json`，结果里没有时间戳、没有自增序号）。
- **未知事件类型不判销毁**：策略未声明即 `keep` + 计入 `counts.undecided`（宁可不判，不默认放行销毁）。
- **不接触私域字段**（INV-008 / AGENTS.md 规则 4）：条目里只读白名单键（`seq`/`id`/`type`/`ts`/
  `at`/`kind`），私域/regulated 键**不读值也不记事名**（名字泄漏本身就是本项目踩过的坑），
  只在结果里记个数 `redacted_fields`。
- **人工门没有"超时自动批准"**（P8 / `04-services-catalog.md` §2）：需要门的动作带出
  `approval` 引用（`scope`/`ref`/`reason`/`status=pending`），`auto_approved` 恒为 0——本服务
  不批准任何动作，`decide()` 只能由人调用（`services/approval.py`）。
- **有界**：逐项清单与批准引用清单都夹取到 `max_items`，超出部分以 `bounded` 标明（否则大账本会
  把结果变成不可消费的洪流）。
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Iterable

from ..kernel.canon import canonical_json, digest
from .approval import DEFAULT_TIMEOUT_POLICY, TIMEOUT_POLICIES
from .realm import PRIVATE_CLASSES, REGULATED, classify_status

KEEP = "keep"
ARCHIVE = "archive"
PURGE_COPY = "purge-copy"
ACTIONS = (KEEP, ARCHIVE, PURGE_COPY)
# 对**账本行**而言这两个动作都不可接受（历史不可移动、不可删）
DESTRUCTIVE_ACTIONS = (ARCHIVE, PURGE_COPY)

LEDGER_ROW = "ledger-row"
DERIVED_COPY = "derived-copy"
KINDS = (LEDGER_ROW, DERIVED_COPY)

# 执行方**真正执行**后必须落的留痕事件（FR-EVIDENCE-004「销毁动作留痕」；本服务只声明，不落）
TRACE_EVENTS = {
    KEEP: None,
    ARCHIVE: "evidence/retention-archived",
    PURGE_COPY: "evidence/retention-copy-purged",
}
# 动作 → 人工门的 scope（`ctx.approval.request(scope, payload, ref=...)` 的 scope）
APPROVAL_SCOPES = {
    ARCHIVE: "evidence.archive",
    PURGE_COPY: "evidence.purge-copy",
}
# 条目里允许被读取的键（其余一律不读——INV-008）
READ_KEYS = ("seq", "id", "type", "ts", "at", "kind")
RULE_KEYS = ("retain_days", "after", "requires_approval", "scope")
COPY_SCOPES = ("copy", "derived")
DEFAULT_MAX_ITEMS = 20

NOTE = ("只读计划：不写文件、不删文件、不追加账本、不批准任何动作；账本行永不销毁（purge-copy 只针对派生副本）；"
        "需要门的动作须经 ctx.approval 由人决定（无超时自动批准）")


class RetentionError(RuntimeError):
    """留存策略错误基类。"""


class PolicyError(RetentionError):
    """策略配置非法（未知键、负留存期、非法动作……）。"""


class LedgerRowNotDestroyable(RetentionError):
    """企图销毁/移动**账本行**：账本 append-only，一律拒绝（FR-LEDGER-001）。"""


class InputRejected(RetentionError):
    """单条输入非法（缺 seq/id、时间不可解析、NaN、负数……），拒绝该条而不是崩掉整次计划。"""


class RetentionPolicy:
    """留存策略：事件类型 → 保留天数 + 到期动作；只做**判定**与**计划**，不做任何执行。"""

    def __init__(self, rules: dict | None = None, *, default_days: float | None = None,
                 max_items: int = DEFAULT_MAX_ITEMS) -> None:
        if isinstance(max_items, bool) or not isinstance(max_items, int) or max_items < 1:
            raise PolicyError(f"max_items 必须是 ≥ 1 的整数（有界输出），收到 {max_items!r}")
        if rules is not None and not isinstance(rules, dict):
            raise PolicyError(f"策略必须是 {{事件类型: 规则}} 的字典，收到 {type(rules).__name__}")
        self.max_items = max_items
        self.default_days = _days(default_days, "default_days")
        self.rules: dict[str, dict] = {}
        for type_name in sorted(rules or {}):
            self.rules[str(type_name)] = self._rule(str(type_name), (rules or {})[type_name])

    # --- 策略（只读） -----------------------------------------------------
    def _rule(self, type_name: str, raw: Any) -> dict:
        if not type_name.strip():
            raise PolicyError("事件类型不能是空字符串（空键会让「未知类型」判断失真）")
        if not isinstance(raw, dict):
            raise PolicyError(f"策略 {type_name!r} 的规则必须是字典，收到 {type(raw).__name__}")
        unknown = sorted(set(raw) - set(RULE_KEYS))
        if unknown:
            raise PolicyError(f"策略 {type_name!r} 含未知键 {unknown}（拼错的键会静默失效，宁可拒绝）"
                              f"；可用键: {list(RULE_KEYS)}")
        scope = str(raw.get("scope", "copy"))
        if scope not in COPY_SCOPES:
            raise LedgerRowNotDestroyable(
                f"策略 {type_name!r} 声明 scope={scope!r}：账本行永不销毁（append-only，FR-LEDGER-001）；"
                f"销毁只能针对派生副本（scope 取 {list(COPY_SCOPES)} 之一）")
        after = raw.get("after", KEEP)
        if after not in ACTIONS:
            raise PolicyError(f"策略 {type_name!r} 的 after={after!r} 非法；取值: {list(ACTIONS)}"
                              f"（销毁派生副本用 {PURGE_COPY!r}，没有「删账本行」这个选项）")
        requires = raw.get("requires_approval", after == PURGE_COPY)
        if not isinstance(requires, bool):
            raise PolicyError(f"策略 {type_name!r} 的 requires_approval 必须是布尔值，收到 {requires!r}")
        if after == PURGE_COPY and not requires:
            raise PolicyError(f"策略 {type_name!r}：销毁派生副本必须经人工门（requires_approval=False 被拒）；"
                              f"没有「自动销毁」这一选项")
        return {"retain_days": _days(raw.get("retain_days", 0), f"{type_name}.retain_days"),
                "after": after, "requires_approval": requires, "scope": scope}

    def rule_for(self, type_name: str) -> dict | None:
        rule = self.rules.get(type_name)
        return None if rule is None else dict(rule)

    def retain_days(self, type_name: str) -> float | None:
        rule = self.rules.get(type_name)
        return None if rule is None else rule["retain_days"]

    def table(self) -> dict:
        """策略快照（只读、可哈希）：计划里 `policy_digest` 就是它的摘要。"""
        return {"default_days": self.default_days, "max_items": self.max_items,
                "types": list(sorted(self.rules)), "rules": {key: dict(self.rules[key]) for key in sorted(self.rules)}}

    def rule_digest(self) -> str:
        return digest(self.table())

    # --- 硬约束 -----------------------------------------------------------
    def guard_destroy(self, entry: dict) -> bool:
        """任何「销毁/移动这个对象」的调用先过这里：账本行一律拒绝（专门异常）。"""
        if _is_ledger_row(entry):
            seq = entry.get("seq")
            raise LedgerRowNotDestroyable(
                f"拒绝销毁账本行 seq={seq!r}：账本 append-only（`Ledger.append` 是唯一写入口，"
                f"FR-LEDGER-001），历史不可删、不可移出账本；销毁只能针对派生副本")
        return True

    # --- 判定 -------------------------------------------------------------
    def classify(self, entry: dict, now: Any) -> dict:
        """单条判定；非法输入抛 `InputRejected`，账本行的销毁意图抛 `LedgerRowNotDestroyable`。"""
        moment = _moment(now)
        return self._item(entry, moment)

    def _item(self, entry: Any, moment: float) -> dict:
        if not isinstance(entry, dict):
            raise InputRejected(f"条目必须是对象（dict），收到 {type(entry).__name__}")
        kind = entry.get("kind")
        if kind is not None and kind not in KINDS:
            raise InputRejected(f"未知条目种类 kind={kind!r}；取值: {list(KINDS)}")
        seq = entry.get("seq")
        if isinstance(seq, bool) or (seq is not None and not isinstance(seq, int)):
            raise InputRejected(f"seq 必须是整数（账本行序号从 1 开始），收到 {seq!r}")
        if kind is None and seq is not None and entry.get("id") is not None:
            raise InputRejected("身份含糊：同时给了 seq 与 id，分不清账本行还是派生副本（宁可不判）")
        ledger_row = kind == LEDGER_ROW or (kind is None and seq is not None)
        if ledger_row:
            if seq is None:
                raise InputRejected("声明为账本行但缺少 seq（无法定位，宁可不判）")
            if seq < 1:
                raise InputRejected(f"seq 必须 ≥ 1，收到 {seq!r}（seq 从 1 开始）")
            object_key = f"seq:{seq}"
        else:
            if seq is not None:
                raise InputRejected(f"派生副本不应带 seq（seq 属于账本行），收到 {seq!r}")
            ident = entry.get("id")
            if not isinstance(ident, str) or not ident.strip():
                raise InputRejected(f"派生副本必须给非空 id，收到 {ident!r}")
            object_key = f"id:{ident.strip()}"
        type_name = entry.get("type")
        if not isinstance(type_name, str) or not type_name.strip():
            raise InputRejected(f"条目必须给非空 type，收到 {type_name!r}")
        type_name = type_name.strip()
        age_days = round((moment - _instant(entry, moment_key="ts")) / 86400.0, 6)
        if not math.isfinite(age_days):
            raise InputRejected(f"时间差不是有限数（age_days={age_days!r}）：拒绝")
        if age_days < 0:
            raise InputRejected(f"时间戳在未来（age_days={_num(age_days)} < 0）：算不出留存期，宁可不判")

        rule = self.rules.get(type_name)
        undecided = rule is None
        refused = False
        approval: dict | None = None
        if rule is None:
            action = KEEP
            reason = (f"未知事件类型 {type_name!r}：留存策略未声明，按「宁可不判」处理（不默认放行销毁；"
                      f"default_days={_num(self.default_days)} 只用于报告）")
        elif age_days < rule["retain_days"]:
            action = KEEP
            reason = f"未到期：已 {_num(age_days)} 天 < 留存 {_num(rule['retain_days'])} 天"
        elif rule["after"] == KEEP:
            action = KEEP
            reason = f"策略声明到期后仍保留（after={KEEP}，{type_name!r} 永不动）"
        elif ledger_row:
            action = KEEP
            refused = True
            reason = f"拒绝：请求的动作 {rule['after']!r} 对账本行无效，该行保持可读"
            try:
                self.guard_destroy(entry)
            except LedgerRowNotDestroyable as exc:
                reason = str(exc)
        else:
            action = rule["after"]
            reason = (f"到期：已 {_num(age_days)} 天 ≥ 留存 {_num(rule['retain_days'])} 天"
                      f" → 对**派生副本**执行 {action}")
            if rule["requires_approval"]:
                approval = {"scope": APPROVAL_SCOPES[action], "ref": object_key,
                            "reason": f"{action} 需要人工门：{reason}",
                            "status": "pending", "decided_by": None,
                            "timeout_policy": DEFAULT_TIMEOUT_POLICY, "auto_approve": False}
        return {
            "object": object_key, "seq": seq, "id": None if ledger_row else entry.get("id"),
            "kind": LEDGER_ROW if ledger_row else DERIVED_COPY, "type": type_name,
            "age_days": age_days, "retain_days": None if rule is None else rule["retain_days"],
            "action": action, "reason": reason, "undecided": undecided, "refused": refused,
            "ledger_row": ledger_row,
            "trace_event": TRACE_EVENTS.get(action) if action != KEEP else None,
            "approval_required": approval is not None, "approval": approval,
            "redacted_fields": sum(1 for key in entry if key not in READ_KEYS and _is_private_key(key)),
        }

    # --- 计划（唯一的公开入口） ------------------------------------------
    def plan(self, entries: Iterable, now: Any) -> dict:
        """产出留存计划：每档计数 + 逐项动作（有界）+ 需要哪些人工门引用。

        `now` 必须由调用方给出（本服务不读墙钟）；`entries` 里的非法条目被逐条拒绝并计入
        `counts.rejected`，不会让整次计划失败，也不回显条目内容（避免把私域带出来）。
        """
        moment = _moment(now)
        if entries is None or isinstance(entries, (str, bytes, dict)) or not hasattr(entries, "__iter__"):
            raise RetentionError(f"entries 必须是条目的可迭代集合，收到 {type(entries).__name__}")
        accepted: list[dict] = []
        rejected: list[dict] = []
        for index, entry in enumerate(entries):
            try:
                accepted.append(self._item(entry, moment))
            except LedgerRowNotDestroyable as exc:  # 理论上 guard 会被 _item 吸收，这里兜底
                rejected.append({"at": index, "reason": str(exc)})
            except InputRejected as exc:
                rejected.append({"at": index, "reason": str(exc)})
        counts = {action: sum(1 for item in accepted if item["action"] == action) for action in ACTIONS}
        counts.update(accepted=len(accepted), rejected=len(rejected), total=len(accepted) + len(rejected),
                      undecided=sum(1 for item in accepted if item["undecided"]),
                      refused=sum(1 for item in accepted if item["refused"]),
                      approval_required=sum(1 for item in accepted if item["approval_required"]))
        approvals = [dict(item["approval"]) for item in accepted if item["approval"] is not None]
        proposed, omitted = approvals[:self.max_items], max(0, len(approvals) - self.max_items)
        listed, dropped = accepted[:self.max_items], max(0, len(accepted) - self.max_items)
        rejected_listed, rejected_dropped = rejected[:self.max_items], max(0, len(rejected) - self.max_items)
        return {
            "policy_digest": self.rule_digest(),
            "evaluated_at": _stamp(moment),
            "counts": counts,
            "items": listed,
            "bounded": {"limit": self.max_items, "listed": len(listed), "omitted": dropped,
                        "truncated": dropped > 0},
            "approvals": proposed,
            "approvals_bounded": {"limit": self.max_items, "listed": len(proposed),
                                 "omitted": omitted, "truncated": omitted > 0},
            "rejected": rejected_listed,
            "rejected_bounded": {"limit": self.max_items, "listed": len(rejected_listed),
                                 "omitted": rejected_dropped, "truncated": rejected_dropped > 0},
            "trace_events": self.trace_events(accepted),
            "ledger_rows_destroyed": 0,
            "auto_approved": 0,
            "side_effects": {"files_written": 0, "files_deleted": 0, "ledger_appends": 0},
            "note": NOTE,
        }

    def trace_events(self, items: list[dict]) -> list[dict]:
        """执行方**真正执行后**必须落的留痕事件清单（本服务只声明，不落 — FR-EVIDENCE-004）。"""
        rows = [{"type": TRACE_EVENTS[item["action"]], "ref": item["object"],
                 "reason": f"{item['action']} 执行后留痕（含对象、动作、执行人）"}
                for item in items if item["action"] in DESTRUCTIVE_ACTIONS]
        return rows[:self.max_items]

    def approval_requests(self, result: dict) -> list[dict]:
        """从计划里取需要人工门的动作（引用 + 理由）；本服务**不**批准、不轮询、不超时自动批准。"""
        return [dict(row) for row in (result.get("approvals") or [])]

    # --- 核对与序列化 -----------------------------------------------------
    def verify_plan(self, result: dict, *, entries: Iterable, now: Any) -> dict:
        """把一份计划与「同输入重算的计划」逐项核对（篡改计数或某条动作都能定位）。"""
        fresh = self.plan(entries, now)
        if not isinstance(result, dict):
            return {"ok": False, "checked": 0, "first_mismatch": f"计划必须是对象，收到 {type(result).__name__}"}
        if result.get("policy_digest") != fresh["policy_digest"] or result.get("evaluated_at") != fresh["evaluated_at"]:
            return {"ok": False, "checked": 0,
                    "first_mismatch": f"策略或时点不一致: {result.get('policy_digest')}@{result.get('evaluated_at')}"
                                      f" ≠ {fresh['policy_digest']}@{fresh['evaluated_at']}"}
        if result.get("counts") != fresh["counts"]:
            return {"ok": False, "checked": 0, "first_mismatch": f"计数不一致: {result.get('counts')} ≠ {fresh['counts']}"}
        checked = 0
        for want, have in zip(fresh["items"], result.get("items") or []):
            checked += 1
            if (want["object"], want["action"], want["age_days"]) != (have.get("object"), have.get("action"),
                                                                      have.get("age_days")):
                return {"ok": False, "checked": checked,
                        "first_mismatch": f"第 {checked} 项不一致: {have.get('object')} "
                                          f"{have.get('action')} ≠ {want['action']}"}
        if len(result.get("items") or []) != len(fresh["items"]):
            return {"ok": False, "checked": checked,
                    "first_mismatch": f"逐项清单长度不一致: {len(result.get('items') or [])} ≠ {len(fresh['items'])}"}
        if [row["ref"] for row in result.get("approvals") or []] != [row["ref"] for row in fresh["approvals"]]:
            return {"ok": False, "checked": checked, "first_mismatch": "人工门引用清单不一致"}
        return {"ok": True, "checked": checked, "first_mismatch": None}

    def render(self, result: Any) -> str:
        """确定性序列化（同输入两次字节一致；不含时间戳/自增序号）。"""
        return canonical_json(result)


# --- 内部：时间、数值、键 -------------------------------------------------
def _days(value: Any, where: str) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PolicyError(f"{where} 必须是数字，收到 {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise PolicyError(f"{where} 必须是有限数（NaN/inf 无法判定留存），收到 {value!r}")
    if number < 0:
        raise PolicyError(f"{where} 不能为负（负留存期＝立即销毁，那是把销毁写成默认值），收到 {value!r}")
    return number


def _parse(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (str, datetime)):
        raise InputRejected(f"{where} 必须是 ISO 时间字符串或 datetime，收到 {value!r}")
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise InputRejected(f"{where} 不是合法 ISO 时间: {value!r}（{exc}）") from exc
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    number = value.timestamp()
    if not math.isfinite(number):
        raise InputRejected(f"{where} 时间戳不是有限数: {value!r}")
    return number


def _stamp(moment: float) -> str:
    return datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _moment(now: Any) -> float:
    if now is None:
        raise RetentionError("plan(entries, now) 必须显式传入 now：本服务不读墙钟（两次同输入必须字节一致）")
    try:
        return _parse(now, "now")
    except InputRejected as exc:
        raise RetentionError(str(exc)) from exc


def _instant(entry: dict, *, moment_key: str) -> float:
    for key in ("ts", moment_key, "at"):
        if key in entry:
            return _parse(entry.get(key), f"条目 {key}")
    raise InputRejected("条目缺少时间（ts/at）：无法算留存期，宁可不判")


def _is_ledger_row(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    return entry.get("kind") == LEDGER_ROW or (entry.get("kind") is None and entry.get("seq") is not None)


def _is_private_key(key: Any) -> bool:
    status = classify_status(str(key))
    return status in PRIVATE_CLASSES or status == REGULATED


def _num(value: Any) -> str:
    if value is None:
        return "未声明"
    if isinstance(value, int) or float(value).is_integer():
        return str(int(value))
    return f"{float(value):.6f}".rstrip("0").rstrip(".")


__all__ = ["RetentionPolicy", "RetentionError", "PolicyError", "LedgerRowNotDestroyable", "InputRejected",
           "KEEP", "ARCHIVE", "PURGE_COPY", "ACTIONS", "DESTRUCTIVE_ACTIONS", "LEDGER_ROW", "DERIVED_COPY",
           "KINDS", "TRACE_EVENTS", "APPROVAL_SCOPES", "READ_KEYS", "RULE_KEYS", "DEFAULT_MAX_ITEMS", "NOTE",
           "TIMEOUT_POLICIES", "DEFAULT_TIMEOUT_POLICY"]
