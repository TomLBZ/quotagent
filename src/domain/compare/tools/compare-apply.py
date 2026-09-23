#!/usr/bin/env python3
"""src/domain/compare/tools/compare-apply.py —— 「比价」写动作的**唯一落账本者**（DEF-012）。

两步（只落**已登记**的事件类型；新增事件类型属账本格式变更，须先有 ADR ⇒ 本轮不新造）：

  · `--step weights` 「保存权重为事实」：把界面上调好的五个权重**存成插件配置**
    （`<ui-shared>/compare/weights.json`：重启后还在，面板下次直接读回来），并跑一次
    `CompareService.rank(ledger=…)` 落 `compare/rank-computed`（"用这组权重排过一次"这条事实）。
    同样的权重 + 同样的报价 ⇒ 账本**零新增**（`compare/rank-computed` 是幂等的：同 correlation_id +
    同 body ⇒ 去重命中），如实报 `duplicates`。
  · `--step export`  导出 CSV：`ExportService.export(evaluation, path, ledger=…)` 落
    `compare/table-exported`（行数/字节数/`evaluation_id`）并写**排名表 CSV**；同时写
    **比较矩阵 CSV**（`compare-rank.py` 的 `per_item_matrix` —— 单元格只在**同一行项目内**比较）与
    **人读正文 TXT**（`ranking_txt()`：同一份评估，不重算；csv 给机器 / txt 给人）。
    页脚写 `source=eval:<id>` 与行数，可与账本逐行核对。

只读复算与展示仍走 `src/domain/compare/tools/compare-rank.py`（它账本零新增）。

纪律：权限门（恰 0600 + 普通文件）→ 形状门（schema/kind/action）→ 重算校验 → 业务前置
（包必须真的在本侧账本里发布过、报价必须真的收到）→ 落账 → 归档；拒绝时**账本零新增**；
stdout 恰一行 JSON；退出码 0/1/2。

用法：
  python3 src/domain/compare/tools/compare-apply.py --step weights --request <pending.json> \\
      --ledger-contractor .../contractor/ledger.jsonl --now 2026-09-22T14:40:00Z
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.events import EventBus  # noqa: E402
from quotagent.kernel.ledger import Ledger, LedgerError  # noqa: E402
from quotagent.services.compare import COMPONENTS, DEFAULT_WEIGHTS, CompareService  # noqa: E402
from quotagent.services.export import ExportService  # noqa: E402

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SAFE_RE = re.compile(r"[^A-Za-z0-9._-]")
REALM_RE = re.compile(r"^[a-z][a-z0-9-]*:[A-Za-z0-9._-]{1,64}$")

SCHEMA = "quotagent/pending/v1"
KIND = "compare-apply"
STEPS = ("weights", "export")
MAX_FILE_BYTES = 262144
IGNORED_KEYS = ("payload_sha256", "bytes", "submitted_at")


def emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return code


def refusal(code: str, reason: str, next_action: str) -> dict:
    return {"code": code, "reason": reason, "next_action": next_action}


def usage_error(code: str, reason: str, next_action: str) -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "refusal": refusal(code, reason, next_action)}, 2)


def deny(code: str, reason: str, next_action: str, step: str, request: str = "") -> int:
    return emit({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                 "step": step, "request": request, "refusal": refusal(code, reason, next_action)}, 1)


def digest_of(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(record: dict) -> str:
    payload = {key: value for key, value in record.items() if key not in IGNORED_KEYS}
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_rows(path: Path) -> tuple[list[dict] | None, str | None]:
    if not path.exists():
        return [], None
    rows: list[dict] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError as exc:
            return None, f"{path}:{lineno} 不是合法 JSON：{exc}"
        if not isinstance(record, dict):
            return None, f"{path}:{lineno} 不是对象"
        rows.append(record)
    return rows, None


def body_of(row: dict) -> dict:
    body = row.get("body")
    return body if isinstance(body, dict) else {}


def realm_of(rows: list[dict], fallback: str) -> str:
    for row in rows:
        value = str(row.get("realm") or "").strip()
        if REALM_RE.match(value):
            return value
    return fallback


def read_pending(path: Path, step: str) -> tuple[dict | None, dict | None]:
    try:
        info = path.stat()
    except FileNotFoundError:
        return None, refusal("pending-missing", f"待办件不存在：{path}", "让宿主先落待办件（页面点动作会落它）")
    if not stat.S_ISREG(info.st_mode):
        return None, refusal("pending-not-regular", f"待办件不是普通文件：{path}", "待办件必须是宿主落的普通文件")
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, refusal("pending-insecure-mode", f"待办件权限 {oct(mode)} 不是 0600", "chmod 600 后再消费")
    if info.st_size > MAX_FILE_BYTES:
        return None, refusal("pending-too-large", f"待办件 {info.st_size} 字节超过上限", "拆小后重提")
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, refusal("pending-not-json", f"待办件不是 JSON：{exc}", "让宿主按 schema 重落待办件")
    if not isinstance(record, dict):
        return None, refusal("pending-not-an-object", "待办件不是对象", "让宿主按 schema 重落待办件")
    if record.get("schema") != SCHEMA or record.get("kind") != KIND:
        return None, refusal("pending-schema-unknown",
                             f"schema/kind 不匹配：{record.get('schema')!r}/{record.get('kind')!r}",
                             "这份待办件不是比价动作的载荷")
    if record.get("action") != step:
        return None, refusal("action-mismatch", f"action 不是 {step}：{record.get('action')!r}",
                             "用这一动作的待办件（一步一件）")
    if str(record.get("submitted_at") or "") != "":
        return None, refusal("pending-tampered", "submitted_at 必须为空（宿主不取墙钟）", "让宿主重落待办件")
    if str(record.get("payload_sha256") or "") != digest_of(canonical(record)):
        return None, refusal("pending-tampered", "payload_sha256 与重算不一致", "让宿主重落待办件")
    note = str(record.get("note") or "")
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size != len(note.encode("utf-8")):
        return None, refusal("pending-tampered", "bytes 与说明长度不一致", "让宿主重落待办件")
    return record, None


def archive(inbox: Path, request: Path) -> str:
    applied = inbox / "applied"
    applied.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(applied, 0o700)
    except OSError:
        pass
    target = applied / request.name
    index = 1
    while target.exists():
        target = applied / f"{request.stem}.{index}.json"
        index += 1
    shutil.move(str(request), str(target))
    return str(target)


def weights_of(raw: object) -> tuple[dict | None, str | None]:
    """载荷里的权重对象 → `{分量: 权重}`；不认识的键 / 非有限数 / 越界一律拒（不静默夹取）。"""
    if not isinstance(raw, dict):
        return None, f"weights 必须是对象，收到 {type(raw).__name__}"
    out: dict[str, float] = {}
    for key, value in raw.items():
        if key not in COMPONENTS:
            return None, f"不认识的分量：{key!r}（可用 {list(COMPONENTS)}）"
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None, f"{key} 的权重不是数：{value!r}"
        if number != number or number in (float("inf"), float("-inf")):
            return None, f"{key} 的权重不是有限数：{value!r}"
        if number < 0 or number > 1:
            return None, f"{key} 的权重必须在 [0,1]：{number}"
        out[key] = number
    for name in COMPONENTS:
        out.setdefault(name, 0.0)
    return out, None


def package_of(ui_shared: Path, package_id: str) -> tuple[dict | None, str | None, str]:
    """本侧的包快照（唯一写者 `rfq-publish.py` 落的）：版本 + 行项目 + 币种。"""
    candidates = sorted((ui_shared / "contractor").glob(f"rfq-{package_id}-rev*.json"))
    if not candidates:
        return None, f"没有 {package_id} 的包快照（先发布一次：APP 的「发布 RFQ」）", ""
    latest = candidates[-1]
    try:
        snapshot = json.loads(latest.read_text(encoding="utf-8"))
    except ValueError as exc:
        return None, f"包快照不可解析：{latest}（{exc}）", str(latest)
    spec = snapshot.get("spec") if isinstance(snapshot.get("spec"), dict) else {}
    return {"package_id": package_id, "rev": int(snapshot.get("rev") or 0),
            "currency": snapshot.get("currency") or spec.get("currency") or "CNY",
            "deadlines": snapshot.get("deadlines") or spec.get("deadlines") or {},
            "items": spec.get("items") if isinstance(spec.get("items"), list) else [],
            "snapshot_hash": snapshot.get("snapshot_hash")}, None, str(latest)


def quote_lines_of(body: dict) -> list[dict]:
    """一条 `quote/submitted` 事实的**逐行报价**（两种形状都认，口径见 29 §7.5）：

      · **多行报价**：行在 `lines[]` 里（`item_id` + `unit_price_cents`；只给 `unit_price` 时 ×100 换成分）。
        多行形态的 body 顶层是 `item_id: ""` / `unit_price_cents: null`（真值在行里）——**只看顶层会得到空集**。
      · **单行报价**：body 顶层就是那 12 键（`item_id` + `unit_price_cents`）—— 与旧口径逐字节一致。

    读不出来的行（不是对象 / 没有 id / 价不是有限数）**逐行跳过**：不编价、不拿 0 冒充，也不放宽任何判据
    （候选集为空时写者照旧按 `no-quotes-for-package` 拒）。
    """
    raw = body.get("lines")
    out: list[dict] = []
    if isinstance(raw, list) and raw:
        for line in raw:
            if not isinstance(line, dict):
                continue
            item_id = str(line.get("item_id") or line.get("ref_line") or "").strip()
            cents = line.get("unit_price_cents")
            if cents is None:
                price = line.get("unit_price")
                cents = round(float(price) * 100) if isinstance(price, (int, float)) else None
            if item_id == "" or isinstance(cents, bool) or not isinstance(cents, (int, float)):
                continue
            out.append({"item_id": item_id, "unit_price_cents": float(cents),
                        "lead_time_days": line.get("lead_time_days")})
        return out
    item_id = str(body.get("item_id") or "").strip()
    cents = body.get("unit_price_cents")
    if item_id != "" and not isinstance(cents, bool) and isinstance(cents, (int, float)):
        out.append({"item_id": item_id, "unit_price_cents": float(cents),
                    "lead_time_days": body.get("lead_time_days")})
    return out


def prepared_of(rows: list[dict], package: dict) -> list[dict]:
    """已送达本侧的报价 → `CompareService.rank` 的候选（与 `compare-rank.py` 同口径）。

    **逐行读数走 `quote_lines_of`（29 §7.5 的两种形状）**：修前这里只认 body 顶层的
    `item_id`/`unit_price_cents`，而一份多行报价的顶层那两个键是空的 ⇒ 候选集恒为空 ⇒ 写者按
    `no-quotes-for-package` 拒：比价矩阵/导出/打印/存权重在纯界面下**全部走不通**（P39 终局验收
    的阻断项）。行形状是**既有语义**（账本里就是这么落的），不是本脚本新造的判据。
    """
    quotes: dict[str, dict] = {}
    for row in rows:
        if str(row.get("type")) != "quote/submitted":
            continue
        body = body_of(row)
        if str(body.get("package_id") or "") != str(package.get("package_id") or ""):
            continue
        quote_id = str(body.get("quote_id") or "")
        lines = quote_lines_of(body)
        if not quote_id or not lines:
            continue
        entry = quotes.setdefault(quote_id, {"quote_id": quote_id, "currency": str(body.get("currency") or "CNY"),
                                             "lead_time_days": body.get("lead_time_days"),
                                             "supplier": str(body.get("supplier") or ""), "items": {}})
        for line in lines:
            entry["items"][line["item_id"]] = line["unit_price_cents"]
            if entry.get("lead_time_days") is None and line.get("lead_time_days") is not None:
                entry["lead_time_days"] = line["lead_time_days"]
    qty_of = {str(item.get("item_id")): item.get("qty") for item in package.get("items") or []}
    out: list[dict] = []
    for entry in quotes.values():
        lines = []
        total = 0.0
        for item_id, cents in sorted(entry["items"].items()):
            qty = qty_of.get(item_id)
            qty = float(qty) if isinstance(qty, (int, float)) else 1.0
            unit_price = round(cents / 100.0, 6)
            lines.append({"item_id": item_id, "qty": qty, "unit_price": unit_price})
            total += qty * unit_price
        out.append({"quote_id": entry["quote_id"], "rfq_rev": int(package.get("rev") or 0),
                    "currency": entry["currency"], "lines": lines, "total_amount": round(total, 6),
                    "lead_time_days": entry["lead_time_days"],
                    "payment_terms_offered": {"days": 45, "advance_pct": 0}, "warranty_months": 24,
                    "supplier": entry["supplier"]})
    return out


def load_matrix_tool():
    """导入只读工具 `compare-rank.py`（复用它的 per-item 矩阵，不重写一份口径）。"""
    spec = importlib.util.spec_from_file_location("compare_rank_tool", Path(__file__).with_name("compare-rank.py"))
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def matrix_csv(matrix: dict) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["item_id", "qty", "quote_id", "supplier", "unit_price_cents", "line_total_cents",
                     "delta_pct_vs_item_min", "normalized", "contribution", "is_item_min", "note"])
    for item in matrix.get("items") or []:
        for cell in item.get("cells") or []:
            writer.writerow([item.get("item_id"), item.get("qty"), cell.get("quote_id"), cell.get("supplier"),
                             cell.get("unit_price_cents"), cell.get("line_total_cents"),
                             cell.get("delta_pct_vs_item_min"), cell.get("normalized"), cell.get("contribution"),
                             cell.get("is_item_min"), cell.get("reason") or ""])
        writer.writerow([f"# 行小计：{item.get('item_id')} 本行最低价（分）", item.get("min_unit_price_cents"),
                         "", "", "", "", "", "", "", "", f"极差 {item.get('spread_pct')}%"])
    return buffer.getvalue()


def ranking_txt(evaluation: dict, prepared: list[dict], weights: dict, footer: str) -> str:
    """**人读正文**（`.txt`）：同一份评估的排名表 —— 每名一行，带得分、五分量贡献、引用链。

    与 `ExportService.export` 落的 `-ranking.csv` **同源**（同一份 `evaluation`，不重算、不改口径）：
    CSV 给机器，TXT 给人（导出格式三件套 csv / txt / html 里的 txt；html 与打印走界面上的
    `compare.print`）。行序即名次；页脚写 `source=eval:<id>` 与权重，便于逐行回账本核。
    """
    supplier_of = {str(quote.get("quote_id")): str(quote.get("supplier") or "") for quote in prepared}
    lines = ["比价表（承包商侧导出 · 人读正文）",
             f"包 {evaluation.get('package_id')} rev{evaluation.get('package_rev')}"
             f" · 币种 {evaluation.get('currency')}",
             f"权重：{json.dumps(weights, ensure_ascii=False, sort_keys=True)}",
             "",
             f"{'名次':<4} {'得分':>8}  {'报价':<22} {'供应商':<14} 分量贡献 / 引用链"]
    for position, row in enumerate(evaluation.get("ranking") or [], start=1):
        quote_id = str(row.get("quote_id"))
        components = row.get("components") or {}
        why = " · ".join(f"{name}={components[name]['value']}" for name in COMPONENTS if name in components)
        citations = " ".join(row.get("citations") or [])
        lines.append(f"{position:<4} {row.get('score'):>8}  {quote_id:<22} {supplier_of.get(quote_id, ''):<14} {why}")
        if citations:
            lines.append(f"{'':<4} {'':>8}  {'':<22} {'':<14} 引用：{citations}")
    excluded = evaluation.get("excluded") or []
    if excluded:
        lines.append("")
        lines.append(f"被排除（{len(excluded)} 家）：{' '.join(str(item) for item in excluded)}")
    lines.append("")
    lines.append(footer.rstrip("\n"))
    lines.append("（这份 TXT 与同一目录下的 -ranking.csv / -matrix.csv 同源；csv 给机器、txt 给人；"
                 "可打印的 HTML 由界面上的「导出 / 打印比价表」生成）")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:  # noqa: C901
    parser = argparse.ArgumentParser(description="比价写动作的唯一落账本者（存权重 / 导出 CSV）")
    parser.add_argument("--step", required=True, choices=STEPS)
    parser.add_argument("--request", default="")
    parser.add_argument("--inbox", default="")
    parser.add_argument("--ui-shared", default=str(ROOT / "tmp" / "ui-shared"))
    parser.add_argument("--ledger-contractor", default="")
    parser.add_argument("--now", default="", help="落账时间（**必填**；本脚本不读墙钟）")
    parser.add_argument("--dry-run", action="store_true")
    args, unknown = parser.parse_known_args(argv)
    step = args.step
    if unknown:
        return usage_error("usage-unknown-flag", str(unknown), "去掉不认识的参数")
    if not args.now or not ISO_RE.match(args.now):
        return usage_error("usage-now", "缺 --now 或不是合法 ISO8601", "显式给时间：--now 2026-09-22T14:40:00Z")

    ui_shared = Path(args.ui_shared)
    inbox = Path(args.inbox) if args.inbox else ui_shared / KIND
    if args.request:
        request = Path(args.request)
    else:
        candidates = sorted(path for path in inbox.glob("*.json") if path.is_file()) if inbox.exists() else []
        if not candidates:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "duplicates": [],
                         "ledger_added": 0, "refusal": None, "pending": 0, "note": "待办件目录空（空跑）"}, 0)
        request = candidates[0]
    record, deny_reason = read_pending(request, step)
    if deny_reason is not None:
        return emit({"ok": False, "step": step, "event": None, "applied": [], "duplicates": [],
                     "ledger_added": 0, "request": str(request), "refusal": deny_reason}, 1)
    assert record is not None

    actor = str(record.get("actor") or "").strip()
    if not actor.startswith("human:"):
        return deny("human-required", f"{step} 必须有人署名：actor 以 human: 开头",
                    "写 human:<你的名字>（存权重/导出都要有人认领）", step, str(request))
    package_id = str(record.get("package_id") or "").strip()
    if not ID_RE.match(package_id):
        return deny("package-id-malformed", f"package_id 形状非法：{package_id!r}",
                    "从比价页的包列表里选一个真包（不猜、不凭 URL）", step, str(request))
    weights, bad = weights_of(record.get("weights"))
    if weights is None:
        return deny("weights-invalid", str(bad),
                    f"分量只有 {list(COMPONENTS)}，每个权重取 [0,1] 内的数（越界一律拒、不夹取）", step, str(request))

    ledger_path = Path(args.ledger_contractor) if args.ledger_contractor \
        else ui_shared / "contractor" / "ledger.jsonl"
    rows, error = load_rows(ledger_path)
    if error is not None or rows is None:
        return usage_error("ledger-unreadable", str(error), "先修账本（本脚本不往坏账本追加）")
    published = [body_of(row) for row in rows if str(row.get("type")) == "rfq/published"
                 and str(body_of(row).get("package_id") or "") == package_id]
    if not published:
        return deny("package-not-found", f"本侧账本里没有已发布的包 {package_id}",
                    "先在「发包」里发布这一包（比价只能针对本侧真的发布过的包）", step, str(request))
    package, why, snapshot_file = package_of(ui_shared, package_id)
    if package is None:
        return deny("package-snapshot-missing", str(why), "重新发布一次这一包（快照是版本锚点）", step, str(request))
    prepared = prepared_of(rows, package)
    if not prepared:
        return deny("no-quotes-for-package", f"本侧还没有收到 {package_id} 的任何报价",
                    "等供应商在 APP 里人签提交报价（收件箱里能看到）", step, str(request))
    realm = realm_of(rows, "contractor:gui")
    key = digest_of(canonical(record))
    archived_before = inbox / "applied" / request.name
    if archived_before.exists():
        try:
            previous = json.loads(archived_before.read_text(encoding="utf-8"))
        except ValueError:
            previous = {}
        if digest_of(canonical(previous)) == key:
            return emit({"ok": True, "step": step, "event": None, "applied": [], "ledger_added": 0,
                         "duplicates": [{"reason": "already-applied", "key": key}], "refusal": None,
                         "request": str(request), "note": "同一份载荷已消费过：账本零新增（幂等）"}, 0)
    if args.dry_run:
        return emit({"ok": True, "step": step, "dry_run": True, "applied": [], "duplicates": [],
                     "ledger_added": 0, "refusal": None, "weights": weights, "quotes": len(prepared),
                     "note": "干跑：校验通过、账本零新增、文件未写"}, 0)

    try:
        ledger = Ledger(ledger_path, realm=realm)
    except LedgerError as exc:
        return usage_error("ledger-frozen", str(exc)[0:200], "先修账本（本脚本不往校验不过的账本追加）")
    bus = EventBus()
    bus.install_defaults()
    before = len(rows)
    evaluation = CompareService(ledger=ledger, events=bus, actor=actor).rank(package, prepared, weights=weights)
    after_rows, _ = load_rows(ledger_path)
    ledger_added = max(0, len(after_rows or []) - before)
    applied = [{"event": "compare/rank-computed", "evaluation_id": evaluation["evaluation_id"],
                "package_id": package_id, "package_rev": package.get("rev"),
                "ranking": [row["quote_id"] for row in evaluation["ranking"]],
                "scores": {row["quote_id"]: row["score"] for row in evaluation["ranking"]}}]

    config_path = ui_shared / "compare" / "weights.json"
    saved = None
    if step == "weights":
        config_path.parent.mkdir(parents=True, exist_ok=True)
        saved = {"schema": 1, "saved_at": args.now, "saved_by": actor, "package_id": package_id,
                 "weights": weights, "evaluation_id": evaluation["evaluation_id"],
                 "ranking": [{"quote_id": row["quote_id"], "score": row["score"]} for row in evaluation["ranking"]],
                 "note": "插件配置：界面上的权重滑块下次打开时读回这一组（不是账本事实；账本事实是 compare/rank-computed）"}
        config_path.write_text(json.dumps(saved, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                               encoding="utf-8")
    else:
        matrix_tool = load_matrix_tool()
        matrix = matrix_tool.per_item_matrix(package, prepared, weights)
        tag = SAFE_RE.sub("", str(evaluation["evaluation_id"] or "eval"))[:40] or "eval"
        ranking_path = ui_shared / "compare" / f"export-{tag}-ranking.csv"
        matrix_path = ui_shared / "compare" / f"export-{tag}-matrix.csv"
        exported = ExportService(ledger=ledger, events=bus).export(
            evaluation, ranking_path, flags=list(evaluation.get("flags") or []))
        body = exported["body"]
        ranking_text = Path(ranking_path).read_text(encoding="utf-8")
        footer = (f"# source=eval:{evaluation['evaluation_id']} 行数={body['rows']}"
                  f"（ranked {body['ranked']} · excluded {body['excluded']}）"
                  f" 权重={json.dumps(weights, ensure_ascii=False, sort_keys=True)}\n")
        Path(ranking_path).write_text(ranking_text + footer, encoding="utf-8")
        matrix_text = (matrix_csv(matrix) + footer
                       + f"# 矩阵：{matrix['counts']['items']} 行项目 × {matrix['counts']['quotes']} 家"
                         f"（单元格只在同一行项目内比较）\n")
        matrix_path.write_text(matrix_text, encoding="utf-8")
        # **人读正文**（导出格式三件套里的 txt）：同一份评估，不重算、不改口径（CSV 给机器 / TXT 给人）。
        txt_path = ui_shared / "compare" / f"export-{tag}-ranking.txt"
        txt_text = ranking_txt(evaluation, prepared, weights, footer)
        txt_path.write_text(txt_text, encoding="utf-8")
        after_export, _ = load_rows(ledger_path)
        ledger_added = max(0, len(after_export or []) - before)
        applied.append({"event": "compare/table-exported", "evaluation_id": evaluation["evaluation_id"],
                        "path": str(ranking_path), "rows": body["rows"], "bytes": len(ranking_text.encode("utf-8")),
                        "matrix_path": str(matrix_path),
                        "matrix_bytes": len(matrix_text.encode("utf-8")),
                        "txt_path": str(txt_path), "txt_bytes": len(txt_text.encode("utf-8"))})
        saved = {"ranking_csv": str(ranking_path), "matrix_csv": str(matrix_path), "ranking_txt": str(txt_path),
                 "rows": body["rows"], "ranked": body["ranked"], "excluded": body["excluded"],
                 "matrix_counts": matrix["counts"]}

    archived = archive(inbox, request) if request.resolve().parent == inbox.resolve() else ""
    # **回执文案与账本增量同源**（P49）：同一份评估已经登记过时 `ledger_added == 0`（幂等：账本去重命中），
    # 那就**不能**说"落了一条事实" —— 修前这句话是无条件写的，与同一份回执里的 `ledger_added: 0` 打架
    # （用户会以为又落了一条，也无法解释为什么账本没长）。
    if step == "weights":
        hint = (("权重已存成插件配置（%s），并落了一条 compare/rank-computed；下次打开比价页会读回这组权重。"
                 % str(config_path)) if ledger_added else
                ("权重已存成插件配置（%s）；这一份评估（evaluation_id=%s）**已经在账本里**，"
                 "本次账本零新增（幂等：同一评估不重复登记）—— 这组权重下次打开比价页会读回。"
                 % (str(config_path), evaluation["evaluation_id"])))
    else:
        hint = ("已导出三份文件（排名表 CSV + 同一行项目内的比较矩阵 CSV + 人读正文 TXT）"
                + ("并落了一条 compare/table-exported；" if ledger_added
                   else "；这一份评估的导出记录**已经在账本里**，本次账本零新增（幂等）；")
                + "页脚写了 source=eval:<id> 与行数，可与账本逐行核对。")
    return emit({"ok": True, "step": step, "event": applied[-1]["event"], "applied": applied,
                 "duplicates": [] if ledger_added else [{"reason": "idempotent-rank", "evaluation_id": evaluation["evaluation_id"]}],
                 "ledger_added": ledger_added, "refusal": None, "request": str(request), "archived": archived,
                 "package_id": package_id, "rev": package.get("rev"), "by": actor, "at": args.now,
                 "weights": weights, "evaluation_id": evaluation["evaluation_id"],
                 "ranking": [{"quote_id": row["quote_id"], "score": row["score"]} for row in evaluation["ranking"]],
                 "config": saved, "snapshot": snapshot_file, "quotes": len(prepared),
                 "next_action_runtime": hint,
                 "note": "比价写动作只落已登记事件：compare/rank-computed（存权重为事实）与 "
                         "compare/table-exported（导出留痕）；权重的可读配置在 <ui-shared>/compare/weights.json"}, 0)


def crash_guard(fn, argv):
    try:
        return fn(argv)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        import traceback
        print(json.dumps({"ok": False, "event": None, "applied": [], "duplicates": [], "ledger_added": 0,
                          "refusal": {"code": "writer-crashed", "reason": f"{type(exc).__name__}: {exc}",
                                      "next_action": "看 stderr 的堆栈修工具（本次账本零新增）"},
                          "traceback_tail": traceback.format_exc().splitlines()[-6:]},
                         ensure_ascii=False, sort_keys=True))
        return 2


if __name__ == "__main__":
    raise SystemExit(crash_guard(main, sys.argv[1:]))
