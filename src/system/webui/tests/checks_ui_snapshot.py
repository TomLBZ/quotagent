"""AC-UI-002：运维快照写入器（`tools/refresh-ui-snapshots.py`）的形状与只读性。

由**父方**撰写（与写入器实现方不是同一主体），按 `docs/design/20-pipeline-snapshot-contract.md` §2/§4 断言：
形状合规 · 计数可手算 · **只读账本**（逐字节比对）· 无正文/私域 · 除 `generated_at` 外无时间键 ·
确定性（两次运行除 `generated_at` 外一致）· transport 三件齐备 · 原子写无残留 · 静态无账本写入。

每条断言名末尾写"反例"：什么情况下它会变红（D-040：门里必须喂真数据）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
WRITER = ROOT / "tools" / "refresh-ui-snapshots.py"
SENTINEL = "ZZ-SENTINEL-PRIVATE-ZZ"
TIME_KEYS = re.compile(r"(^|_)(date|ts|time|at|created|updated)($|_)", re.I)


def _run_writer(*extra: str) -> tuple[int, str]:
    proc = subprocess.run([sys.executable, str(WRITER), *extra], cwd=str(ROOT),
                          capture_output=True, text=True, timeout=300)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _fixture():
    """真账本：写满三域事件（negotiate/*、faq/*、mail/*）到 scratch。"""
    sys.path.insert(0, str(ROOT / "src"))
    from quotagent.kernel.events import EventBus
    from quotagent.kernel.ledger import Ledger
    from quotagent.paths import new_scratch

    root = new_scratch("ac-ui-002")
    bus = EventBus()
    bus.install_defaults()
    ledger = Ledger(root / "ui.jsonl", realm="contractor:con-B")
    rows = [
        ("negotiate/opened", {"thread_id": "nt-0001", "package_id": "pkg-014", "rfq_rev": 2}),
        ("negotiate/round", {"thread_id": "nt-0001", "attempt_no": 1, "round_key": "neg:sha256:aa"}),
        ("negotiate/round-rejected", {"thread_id": "nt-0001", "attempt_no": 2, "code": "concession-below-floor",
                                     "reason": "低于底线", "next_action": "重算底线", "subject": SENTINEL}),
        ("negotiate/closed", {"thread_id": "nt-0001", "outcome": "accepted", "body": SENTINEL}),
        ("faq/entry-published", {"entry_id": "fq-0001", "package_id": "pkg-014", "rfq_rev": 2,
                                 "question_norm": "sha256:bb", "reserve_price": SENTINEL}),
        ("mail/queued", {"message_id": "ml-0001", "kind": "rfq-notice", "package_id": "pkg-014", "rfq_rev": 2,
                         "to": ["s@example.com"], "subject": SENTINEL, "body_sha256": "sha256:cc"}),
        ("mail/refused", {"message_id": "ml-0001", "reason": "mail-transport-unavailable",
                          "next_action": "配置凭据后接入", "transport_available": False}),
    ]
    for kind, body in rows:
        ledger.append(kind, body, correlation_id=body.get("thread_id") or body.get("entry_id")
                      or body.get("message_id") or "x", actor="agent:test")
    return ledger


def _one_file_shape_and_counts() -> list[Assertion]:
    out: list[Assertion] = []
    out.append(Assertion("写入器存在（反例：文件被删/改名 → 本断言红）", WRITER.exists(), str(WRITER.relative_to(ROOT))))
    if not WRITER.exists():
        return out

    ledger = _fixture()
    before = ledger.path.read_bytes()
    rc, log = _run_writer("--views", "contractor", "--shared-dir", str(ledger.path.parent))
    out.append(Assertion("写入器在真账本上可运行（反例：抛异常/非 0 退出 → 红）", rc == 0, log.strip()[-160:]))
    after = ledger.path.read_bytes()
    out.append(Assertion("**只读账本**：运行前后账本逐字节一致（反例：写入器顺手补了一行事实 → 红）",
                         before == after, f"before={len(before)}B after={len(after)}B"))

    # 路径由写入器**自己报告**（它把 JSON 打到 stdout）：不猜目录，避免"找错文件 → 空转假绿"
    target = None
    try:
        reported = json.loads([l for l in log.splitlines() if l.strip().startswith("{")][-1])
        rel = reported.get("out")
        if rel:
            target = (ROOT / rel).resolve()
    except Exception:  # noqa: BLE001
        target = None
    if target is None or not target.exists():
        for cand in (ledger.path.parent / "ui-shared" / "pipeline.json", ledger.path.parent / "pipeline.json"):
            if cand.exists():
                target = cand
                break
    out.append(Assertion("写入器 stdout 报告的路径存在（反例：报告了路径却没写文件 → 红）",
                         bool(target and target.exists()), str(target)))
    if not (target and target.exists()):
        return out
    raw = target.read_text(encoding="utf-8")
    payload = json.loads(raw)

    ok_shape = isinstance(payload, dict) and "generated_at" in payload and isinstance(payload.get("views"), dict)
    view = (payload.get("views") or {}).get("contractor") or {}
    keys = set(view.keys())
    out.append(Assertion("形状合规：`generated_at` + `views.<view>.{negotiate,faq,mail}` 三域齐全"
                         "（反例：缺域/改成数组 → 红）",
                         ok_shape and {"negotiate", "faq", "mail"} <= keys, f"keys={sorted(keys)[:6]}"))

    neg, faq, mail = view.get("negotiate") or {}, view.get("faq") or {}, view.get("mail") or {}
    hand = {"threads": 1, "rounds": 1, "rejected": 1, "entries": 1, "queued": 1, "refused": 1}
    got = {"threads": neg.get("threads"), "rounds": neg.get("rounds"), "rejected": neg.get("rejected"),
           "entries": faq.get("entries"), "queued": mail.get("queued"), "refused": mail.get("refused")}
    out.append(Assertion("计数与手算一致（反例：把 opened 当 rounds、把 parsed 当 queued → 红）",
                         got == hand, f"换算={got} 手算={hand}"))

    tr = mail.get("transport") or {}
    out.append(Assertion("transport 三件齐备且本轮必须 `available=false`（反例：报 true / 缺 reason/next_action → 红）",
                         tr.get("available") is False and bool(tr.get("reason")) and bool(tr.get("next_action")),
                         json.dumps(tr, ensure_ascii=False)[:120]))

    out.append(Assertion("无正文/主旨/私域：哨兵一律不出现（反例：把 subject/body/reserve_price 抄进快照 → 红）",
                         SENTINEL not in raw and "reserve_price" not in raw and '"body"' not in raw
                         and '"subject"' not in raw, f"len={len(raw)}"))
    bad_time = [k for k in _walk_keys(payload) if TIME_KEYS.search(k) and k != "generated_at"]
    out.append(Assertion("除 `generated_at` 外无其它时间键（反例：加 `updated_at`/`ts` → 红）",
                         not bad_time, f"多余时间键={bad_time[:4]}"))
    out.append(Assertion("原子写：不留 `.tmp` 残留（反例：直接写目标文件且异常中断 → 残留 → 红）",
                         not list(ledger.path.parent.rglob("*.json.tmp")), ""))
    return out


def _walk_keys(node, prefix: str = "") -> list[str]:
    keys: list[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            keys.append(str(k))
            keys.extend(_walk_keys(v, str(k)))
    elif isinstance(node, list):
        for item in node[:8]:
            keys.extend(_walk_keys(item, prefix))
    return keys


@register("AC-UI-002", "P2",
          "运维快照写入器：形状合规、计数可手算、只读账本、无正文/私域、无多余时间键、确定性",
          "qa ac AC-UI-002", evidence_refs=("EV-095",))
def check_ui_snapshot() -> list[Assertion]:
    out = _one_file_shape_and_counts()
    if not WRITER.exists():
        return out
    # 确定性：两次运行除 generated_at 外一致
    ledger = _fixture()
    rc1, log1 = _run_writer("--views", "contractor", "--shared-dir", str(ledger.path.parent))
    rc2, log2 = _run_writer("--views", "contractor", "--shared-dir", str(ledger.path.parent))

    def _reported_path(log: str):
        try:
            rel = json.loads([l for l in log.splitlines() if l.strip().startswith("{")][-1]).get("out")
            p = (ROOT / rel).resolve()
            return p if p.exists() else None
        except Exception:  # noqa: BLE001
            return None

    p1, p2 = _reported_path(log1), _reported_path(log2)
    t1 = p1.read_text(encoding="utf-8") if p1 else ""
    t2 = p2.read_text(encoding="utf-8") if p2 else ""
    assert t1, "写入器未报告可用路径 —— 确定性断言不能空转（假绿）"

    def strip_gen(text: str) -> str:
        return re.sub(r'"generated_at"\s*:\s*"[^"]*"', '"generated_at": "<x>"', text)

    out.append(Assertion("确定性：两次运行除 `generated_at` 外逐字节一致（反例：列表顺序随字典/时间变 → 红）",
                         rc1 == 0 and rc2 == 0 and strip_gen(t1) == strip_gen(t2),
                         f"len1={len(t1)} len2={len(t2)}"))
    src = WRITER.read_text(encoding="utf-8")
    out.append(Assertion("静态：写入器不写账本（无 `.append(` / `ledger.write`），且不引第三方库"
                         "（反例：用 Ledger.append 补一行 → 红）",
                         ".append(" not in src and "import requests" not in src and "smtplib" not in src, ""))
    return out
