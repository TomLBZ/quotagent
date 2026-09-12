"""反例集（red-team，只增不减）——`09-observability-and-eval.md` §3.3。

反例既随仓库入库（`docs/work/scenarios/s4-counterexamples.json`，合成数据），
也由本模块提供**只增不减**的注册表：删除或改写既有反例一律 `CounterexampleImmutable`。
新增反例落账 `evolve/proposed`（`09` §3.3：新增反例 = 一次 evolve/proposed 事件）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..kernel.ledger import Ledger, utc_now
from ..paths import repo_root

SCENARIO_DIR = ("docs", "work", "scenarios")
CASES_FILE = "s4-counterexamples.json"
PROPOSED_EVENT = "evolve/proposed"


class CounterexampleImmutable(RuntimeError):
    """反例集只增不减：删除/改写被拒绝（防止通过改测试提高通过率）。"""


def default_path() -> Path:
    return repo_root().joinpath(*SCENARIO_DIR, CASES_FILE)


def load_counterexamples(path: str | Path | None = None) -> list[dict]:
    target = Path(path) if path is not None else default_path()
    payload = json.loads(Path(target).read_text(encoding="utf-8"))
    return [dict(case) for case in payload.get("cases", [])]


@dataclass
class CounterexampleRegistry:
    path: str | Path
    ledger: Ledger | None = None

    @property
    def file(self) -> Path:
        return Path(self.path)

    def _read(self) -> dict:
        if not self.file.exists():
            return {"schema": 1, "note": "反例集（只增不减）", "cases": []}
        return json.loads(self.file.read_text(encoding="utf-8"))

    def _write(self, payload: dict) -> None:
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def load(self) -> list[dict]:
        return [dict(case) for case in self._read().get("cases", [])]

    def add(self, case: dict, *, by: str, allow_rewrite: bool = False) -> dict:
        case_id = case.get("case_id")
        if not case_id:
            raise CounterexampleImmutable("反例必须带 case_id")
        payload = self._read()
        existing = {item["case_id"] for item in payload.get("cases", [])}
        if case_id in existing:
            raise CounterexampleImmutable(
                f"反例 {case_id} 已存在：反例集只增不减（改写测试等价于提高通过率，被拒绝；"
                f"allow_rewrite={allow_rewrite} 也不放行）")
        record = dict(case)
        record["added_by"] = by
        record["added_at"] = utc_now()
        payload.setdefault("cases", []).append(record)
        self._write(payload)
        if self.ledger is not None:
            self.ledger.append(PROPOSED_EVENT, {"proposal_id": f"cx-{case_id}", "kind": "counterexample",
                                                "case_id": case_id, "scenario": case.get("scenario"),
                                                "added_by": by, "origin": "red-team"},
                               correlation_id=case_id, event_class="fact", actor=by)
        return record

    def remove(self, case_id: str) -> None:
        raise CounterexampleImmutable(
            f"反例 {case_id} 不可删除：反例集只增不减（FR-EVAL-004 / 09 §3.3）")

    def replace(self, case: dict) -> None:
        raise CounterexampleImmutable(
            f"反例 {case.get('case_id')} 不可改写：只增不减（要修正就新增一条并注明取代关系）")

    def count(self) -> int:
        return len(self._read().get("cases", []))
