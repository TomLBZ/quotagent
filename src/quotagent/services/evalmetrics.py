"""ctx.eval 的 P0 子集：指标采集与基线报告（`09-observability-and-eval.md` §2）。

P0 规则：**只采集与记录基线，不设目标值**（目标值由人在 P1 前设定并写入项目 patch）。
指标全部从账本事件推导——指标口径与依据事件都写进报告，避免"凭空数字"。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..kernel.ledger import Ledger, utc_now

METRIC_KEYS = (
    "报价可比率", "口径一致率", "澄清轮次", "比价耗时", "人工改写率",
    "异常检出率/误报率", "重建一致率", "重放确定性", "端到端时延/失败率",
)

DEFINITIONS = {
    "报价可比率": "无需人工重算即可进入比价的报价占比",
    "口径一致率": "字段语义校验通过率（归一化成功 / 尝试归一化）",
    "澄清轮次": "同包平均往返次数",
    "比价耗时": "末份报价到排名产出的时长",
    "人工改写率": "人工相对 agent 草案的编辑比例",
    "异常检出率/误报率": "Flag 命中率 / 人工确认的误报比例",
    "重建一致率": "rebuild(inputs) == observed 的抽样比例",
    "重放确定性": "同一包多次排序结果一致的比例",
    "端到端时延/失败率": "关键路径失败事件占比（时延为墙钟量，不在账本内）",
}


@dataclass
class EvalService:
    ledger: Ledger

    def collect(self) -> dict:
        return collect_metrics(self.ledger)

    def baseline_report(self, *, out_path: str | Path) -> Path:
        return baseline_report(self.ledger, out_path=out_path)


def _ts(entry: dict) -> str:
    """账本条目的时间戳字段是 `ts`（ADR-0007 的字节格式）。"""
    return str(entry.get("ts") or entry.get("at") or "")


def collect_metrics(ledger: Ledger) -> dict:
    events = ledger.read()
    by_type: dict[str, list[dict]] = {}
    for entry in events:
        by_type.setdefault(entry["type"], []).append(entry)

    def entries(*names: str) -> list[dict]:
        out: list[dict] = []
        for name in names:
            out.extend(by_type.get(name, []))
        return out

    def basis(*names: str) -> dict:
        counts = {name: len(by_type.get(name, [])) for name in names}
        return {"types": list(names), "events": sum(counts.values()), "per_type": counts}

    normalized = by_type.get("quote/normalized", [])
    rejected = by_type.get("quote/normalize-rejected", [])
    attempts = len(normalized) + len(rejected)
    quote_ids = {entry["body"].get("quote_id") for entry in normalized}

    asked = by_type.get("clarification/asked", [])
    package_ids = {entry["body"].get("package_id") for entry in asked}

    rank_events = by_type.get("compare/rank-computed", [])
    durations = []
    for entry in rank_events:
        previous = [item for item in normalized if item["seq"] < entry["seq"]]
        if not previous:
            continue
        try:
            start = datetime.fromisoformat(str(_ts(previous[-1])).replace("Z", "+00:00"))
            end = datetime.fromisoformat(str(_ts(entry)).replace("Z", "+00:00"))
        except ValueError:
            continue
        durations.append(max(0.0, (end - start).total_seconds()))

    flags = by_type.get("compare/flag-raised", [])
    deterministic = []
    for package_id in {entry["body"].get("package_id") for entry in rank_events}:
        runs = [entry["body"].get("ranking") for entry in rank_events
                if entry["body"].get("package_id") == package_id]
        if len(runs) >= 2:
            deterministic.append(len({tuple(run or []) for run in runs}) == 1)

    failures = entries("quote/normalize-rejected", "rfq/version-mismatch", "approval/denied",
                       "kernel/qep-duplicate-dropped", "kernel/qep-rejected")
    metrics: dict[str, dict] = {}

    def put(key: str, value: Any, unit: str, basis_entry: dict, note: str = "") -> None:
        metrics[key] = {"label": key, "value": value, "unit": unit, "definition": DEFINITIONS[key],
                        "basis": dict(basis_entry, note=note) if note else basis_entry}

    put("报价可比率", (len(quote_ids) / attempts) if attempts else None, "ratio",
        basis("quote/normalized", "quote/normalize-rejected"),
        "分母 = 归一化成功 + 被拒绝的报价数（每份报价只计一次）")
    put("口径一致率", (len(normalized) / attempts) if attempts else None, "ratio",
        basis("quote/normalized", "quote/normalize-rejected"))
    put("澄清轮次", (len(asked) / len(package_ids)) if package_ids else None, "rounds/pkg",
        basis("clarification/asked", "clarification/answered", "clarification/broadcast-incomplete"),
        "同包往返次数；广播不完整不计入轮次")
    put("比价耗时", (sum(durations) / len(durations)) if durations else None, "seconds",
        basis("compare/rank-computed", "quote/normalized"),
        "末份 quote/normalized 到 compare/rank-computed 的账本时间差")
    put("人工改写率", None, "ratio", basis("approval/granted", "quote/human-approved"),
        "需要人在 payload 里记录编辑比例（P1 落地）；P0 无该字段，记 None 而不是补零")
    put("异常检出率/误报率",
        {"detection": (len(flags) / len(quote_ids)) if quote_ids else None, "false_positive": None},
        "ratio", basis("compare/flag-raised"),
        "误报率需人工结论（P1 的审批队列回填）；P0 记 None")
    put("重建一致率", None, "ratio", basis("kernel/model-call", "kernel/model-reply"),
        "逐次重建由 AC-AUDIT-002 验证；P0 未在账本内记一致性比例")
    put("重放确定性", (sum(deterministic) / len(deterministic)) if deterministic else None, "ratio",
        basis("compare/rank-computed"),
        "同一包需≥2 次排序才有值（S1 场景一次运行只有一个值）")
    put("端到端时延/失败率", (len(failures) / len(events)) if events else None, "ratio",
        basis("quote/normalize-rejected", "rfq/version-mismatch", "approval/denied",
              "kernel/qep-duplicate-dropped", "kernel/qep-rejected"),
        "时延为墙钟量、不在账本内；失败率 = 失败事件 / 全部事件")

    return {"metrics": metrics, "event_count": len(events), "realm": getattr(ledger, "realm", "local"),
            "generated_at": utc_now(), "rule": "P0 只采集基线，不设目标值"}


def baseline_report(ledger: Ledger, *, out_path: str | Path) -> Path:
    data = collect_metrics(ledger)
    lines = [
        "# 指标基线报告（P0）",
        "",
        f"- 生成时间: {data['generated_at']}",
        f"- realm: {data['realm']} · 账本事件数: {data['event_count']}",
        "- 规则: P0 只采集与记录基线，**不设目标值**；目标值由人在 P1 开始前设定并写入项目 patch"
        "（`docs/work/roadmap.md` 的 G1 门）。",
        "- 空缺项记 `None` 并写明原因，不补零（避免把「没测」伪装成「测了」）。",
        "",
        "## 指标",
        "",
        "| 指标 | 定义 | 值 | 依据 |",
        "|---|---|---|---|",
    ]
    for key in METRIC_KEYS:
        row = data["metrics"][key]
        value = row["value"]
        shown = "None（见备注）" if value is None else (
            f"{value}" if not isinstance(value, float) else f"{value:.4f}")
        detail = f"{row['basis']['events']} 事件（{', '.join(row['basis']['types'])}）"
        if row["basis"].get("note"):
            detail += f"；{row['basis']['note']}"
        lines.append(f"| {key} | {row['definition']} | {shown}{'' if value is None else ' ' + row['unit']} "
                     f"| {detail} |")
    lines += [
        "",
        "## 依据来源",
        "",
        "全部数值由账本事件推导（`ctx.eval.collect`），事件类型见上表「依据」列；",
        "未出现在账本里的量（墙钟时延、人工编辑比例）一律记 `None` 并注明落地任务。",
        "",
    ]
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
