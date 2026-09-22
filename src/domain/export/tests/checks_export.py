"""AC-COMPARE-004：比较表导出与账本逐行一致（T-214）。"""

import csv
import io
from pathlib import Path

from quotagent.kernel.events import EventBus
from quotagent.kernel.ledger import Ledger
from quotagent.paths import new_scratch
from quotagent.services.compare import CompareService
from quotagent.services.export import ROW_HEADER as EXPORT_HEADER, ExportService
from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]

def _fixture():
    root = new_scratch("compare-004")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "con.jsonl", realm="contractor:con-B")
    compare = CompareService(ledger=ledger, events=bus)
    export = ExportService(ledger=ledger, events=bus)
    package = {"package_id": "pkg-014", "rev": 2, "currency": "CNY",
               "items": [{"item_id": "L-001", "qty": 100, "unit": "m"},
                         {"item_id": "L-002", "qty": 50, "unit": "m"}],
               "deadlines": {"delivery_by": "2026-10-20T00:00:00Z"}}
    quotes = [
        {"quote_id": "q-a", "rfq_rev": 2, "currency": "CNY",
         "lines": [{"item_id": "L-001", "unit_price": 88.5, "qty": 100},
                   {"item_id": "L-002", "unit_price": 12.0, "qty": 50}],
         "lead_time_days": 10, "payment_terms": {"days": 45, "advance_pct": 0},
         "warranty_terms": {"months": 24}, "notes": ""},
        {"quote_id": "q-b", "rfq_rev": 2, "currency": "CNY",
         "lines": [{"item_id": "L-001", "unit_price": 91.0, "qty": 100},
                   {"item_id": "L-002", "unit_price": 11.5, "qty": 50}],
         "lead_time_days": 14, "payment_terms": {"days": 30, "advance_pct": 10},
         "warranty_terms": {"months": 18}, "notes": ""},
        {"quote_id": "q-old", "rfq_rev": 1, "currency": "CNY",
         "lines": [{"item_id": "L-001", "unit_price": 80.0, "qty": 100}],
         "lead_time_days": 9, "payment_terms": {}, "warranty_terms": {}, "notes": ""},
    ]
    flags = [{"kind": "abnormal_low", "severity": "high", "target_ref": "q-b",
              "detail": "报价单价低于成本下限 8%", "requires_human": True},
             {"kind": "deviation", "severity": "medium", "target_ref": "q-b",
              "detail": "交期比包内要求晚 4 天", "requires_human": True}]
    return root, ledger, bus, compare, export, package, quotes, flags


@register("AC-COMPARE-004", "P1", "导出的比较表与账本逐行一致，含 Flag 与差异说明（含被排除报价的逐行原因）",
          "qa ac AC-COMPARE-004", evidence_refs=("EV-053",))
def check_compare_004() -> list[Assertion]:
    out: list[Assertion] = []
    root, ledger, bus, compare, export, package, quotes, flags = _fixture()
    evaluation = compare.rank(package, quotes, flags=flags)
    rows = export.comparison_rows(evaluation)
    ranked = [row for row in rows if row["row_type"] == "ranked"]
    excluded = [row for row in rows if row["row_type"] == "excluded"]
    out.append(Assertion("**逐行**：参与排序的报价每个一行（rank 从 1 连续），被排除的报价也各占一行（不静默消失）",
                         len(ranked) == len(evaluation["ranking"]) == 2
                         and [row["rank"] for row in ranked] == [1, 2]
                         and len(excluded) == 1 and excluded[0]["quote_id"] == "q-old",
                         f"ranked={len(ranked)} excluded={[row['quote_id'] for row in excluded]}"))
    out.append(Assertion("被排除行给出可行动信息：`code`/`reason`/`next_action` 齐全（版本不一致）",
                         excluded[0]["code"] == "rfq_version_mismatch"
                         and "rev1" in excluded[0]["reason"] and excluded[0]["next_action"],
                         f"excluded={excluded[0]['code']} reason={excluded[0]['reason'][:60]}"))
    report = export.verify(rows, evaluation=evaluation, ledger=ledger)
    out.append(Assertion("与 `Evaluation` 逐行一致：分数、TCO、五项分量逐字段相等",
                         report["ok"] is True and report["rows_checked"] == 3,
                         f"report={report}"))
    ledger_scores = ledger.read(type="compare/rank-computed")[0]["body"]["scores"]
    out.append(Assertion("**与账本逐行一致**：导出行分数 == `compare/rank-computed` 的 scores，"
                         "排名顺序与排除清单也一致",
                         {row["quote_id"]: row["score"] for row in ranked} == ledger_scores
                         and ledger.read(type="compare/rank-computed")[0]["body"]["ranking"]
                         == [row["quote_id"] for row in ranked],
                         f"export={ {row['quote_id']: row['score'] for row in ranked} } ledger={ledger_scores}"))

    tampered = [dict(row) for row in rows]
    tampered[0]["score"] = 12.0
    bad = export.verify(tampered, evaluation=evaluation, ledger=ledger)
    out.append(Assertion("篡改一行分数 → 核对失败并**定位到该行**（逐行核对不是口号）",
                         bad["ok"] is False and "不一致" in bad["first_mismatch"],
                         f"first_mismatch={bad['first_mismatch']}"))
    bad_ref = [dict(row) for row in rows]
    bad_ref[0]["citations"] = "quote:q-not-exist|policy:weights.price"
    ref_report = export.verify(bad_ref, evaluation=evaluation, ledger=ledger)
    out.append(Assertion("篡改引用 → 核对失败（引用必须能在账本/包里解析）",
                         ref_report["ok"] is False and "引用无法解析" in ref_report["first_mismatch"],
                         f"first_mismatch={ref_report['first_mismatch']}"))
    out.append(Assertion("含 Flag 与差异说明：q-b 行带 `abnormal_low|deviation` 与差异文案，q-a 行为空",
                         ranked[1]["flags"] == "abnormal_low|deviation"
                         and ranked[1]["deviation_note"] and ranked[0]["flags"] == "",
                         f"q-b flags={ranked[1]['flags']} note={ranked[1]['deviation_note'][:40]}"))
    out.append(Assertion("每行带引用链（**含被排除行**：排除必须有据，且全部可解析）",
                         all(row["citations"] for row in rows)
                         and all(export._resolve(ref, ledger, evaluation) is True
                                 for row in rows for ref in row["citations"].split("|") if ref),
                         f"citations={[row['citations'][:48] for row in rows]}"))

    target = root / "compare.csv"
    first = export.export(evaluation, target)
    second_text = export.to_csv(export.comparison_rows(evaluation))
    out.append(Assertion("确定性：同输入两次导出**字节一致**（无时间戳、无自增序号）",
                         first["text"] == second_text
                         and open(target, encoding="utf-8").read() == first["text"],
                         f"len={len(first['text'])}"))
    readback = list(csv.reader(io.StringIO(first["text"].lstrip("\ufeff"))))
    out.append(Assertion("CSV 可读回：列头稳定（含 row_type/score/flags/citations/code/next_action），"
                         "数据行数 = 3",
                         readback[0] == [name for name in EXPORT_HEADER]
                         and len(readback) == 4,
                         f"header={readback[0][:6]}… rows={len(readback) - 1}"))
    out.append(Assertion("Excel 可直接打开：文件以 UTF-8 BOM 开头（双击不乱码）",
                         first["text"].startswith("\ufeff") and first["body"]["bom"] is True,
                         f"bom={first['text'][:1]!r}"))
    exported = ledger.read(type="compare/table-exported")
    out.append(Assertion("导出留痕 `compare/table-exported`（evaluation_id / 行数 / 字节数）",
                         len(exported) == 1 and exported[0]["body"]["evaluation_id"] == evaluation["evaluation_id"]
                         and exported[0]["body"]["rows"] == 3 and exported[0]["body"]["bytes"] > 0,
                         f"rows={exported[0]['body']['rows'] if exported else None}"))
    spec = (ROOT / "docs/work/decisions.md").read_text(encoding="utf-8")
    out.append(Assertion("`.xlsx` 的取舍已登记在案（D-016：P1 以 CSV 交付，xlsx 走宿主层）",
                         "D-016" in spec and "CSV" in spec.split("D-016")[1][:400],
                         "decisions.md 缺 D-016"))
    return out
