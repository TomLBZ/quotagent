"""AC-ADMIN-004 / AC-ADMIN-006：admin 道「agent 进度与阻塞」的 Python 侧判定与状态机（T-271）。

两条验收条目在 `docs/work/plans/p3-spec.json` 里的逐字断言（本机检按它们写）：

  AC-ADMIN-004 ——「面板是真数据：至少报出 2 条阻塞，`kind` 分别含 `plugin-request`（advisor／Jev 建议层）
    与 `credential`（邮件收发缺 SMTP/IMAP 凭据），每条含 `block_id/kind/reason/required_action/refs`；
    清单由 Python 判定器从**真来源**生成（任务登记表的 blocked 行 + 服务自述的不可用原因，如邮件通道
    `available=false`），**不是手写常量表**；进度数字（按状态计数）只读、标注口径来源、不得由列表长度
    推计数（D-056）；快照写入幂等（同输入两次除 `generated_at` 外逐字节一致）；快照不含正文与私域键；
    快照缺失或损坏 → 面板降级（计数 0 + reason）不崩不猜」
  AC-ADMIN-006 ——「状态机与唯一写者（Python 侧）：`services/admin_blocks.py` 只接受
    `blocked→pending→resolved / rejected / expired`；非法转移（`resolved→blocked`、`blocked→resolved`
    跳过 `pending`、`expired→pending`）全部拒绝且账本零新增；每次合法转移落一条账本事件且只由该服务产生；
    缺人工批准引用的解阻塞一律拒绝（人工门不可绕过）；宿主侧无写账本路径（H1 负控）；`replay()` 可从账本
    重建当前状态」

本机检覆盖：真源真值 · 逐条形状/可操作性 · **删条目即消失**（反手证"不是常量表"）· 计数独立复算（D-056）
· 有界夹取 · 快照幂等/原子写/不建账本/无私域 · 缺源与全零可分（degraded + 逐源状态）· 状态机取值域 ·
5 类非法转移全拒且零新增（入参不被改）· 缺引用/引用形状非法全拒 · 合法转移的事件**载荷**（不写账本）·
时钟推 100 年状态不变 · 静态扫描无写账本/无墙钟/无环境变量。

【本批**不**机检的部分（写在注释里，不假装通过）】
  · 「宿主侧无写账本路径」（H1 负控）与 `/quotagent/admin/api/blocks` 的 HTTP 行为属 T-272（宿主道）：
    本文件只证 Python 侧**不写账本**（静态扫描 + `apply_transition` 只产出载荷）。
  · 「`replay()` 可从账本重建当前状态」属落账那一批（T-265）：`apply_transition` 生成的 `admin/block-*`
    事件名**尚未登记**进 `docs/design/05-events.md` 与 `kernel/events.py`（本任务只能改这 4 个文件），
    所以本文件**只断言载荷形状**，不断言账本里有行。
  · 四条事件名的登记状态：本机检会断言这四条名字在 `admin_blocks.py` 里是常量（`TRANSITION_EVENTS`），
    登记与否由 `verify.sh events` 那道门在登记后负责 —— 未登记时**不得**拿它当"已落账"。
"""
from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
from pathlib import Path

from ..paths import new_scratch, repo_root
from ..services.admin_blocks import (ALLOWED_TRANSITIONS, CHECKLIST_STATUSES, KINDS, SOURCES, STATES,
                                     TRANSITION_EVENTS, AdminBlockError, apply_transition, derive_blocks,
                                     render)
from .registry import Assertion, register

ROOT = Path(__file__).resolve().parents[3]
SERVICE = ROOT / "src" / "quotagent" / "services" / "admin_blocks.py"
WRITER = ROOT / "tools" / "refresh-admin-snapshot.py"
REAL_STATE = ROOT / ".agents" / "state.json"
REAL_CHECKLIST = ROOT / "docs" / "work" / "progress-checklist.md"
REAL_PIPELINE = ROOT / "tmp" / "ui-shared" / "pipeline.json"

NOW = "2026-09-21T00:00:00Z"
LATER = "2126-09-21T00:00:00Z"
SENTINEL = "ZZ-ADMIN-SENTINEL-ZZ"
SHA_A = "sha256:" + "a" * 64
REQUIRED_BLOCK_KEYS = ("block_id", "kind", "reason", "required_action", "refs")
ACTIONABLE_MARKERS = ("提供", "放入", "放进", "配置", "确认", "补齐", "写进")

# ---------------------------------------------------------------------------
# 夹具（写**真** state.json / 进度清单 / 三域快照：判定器读什么，夹具就是什么形状）
#
# 夹具里的任务号刻意用**已定义**的真 ID（T-224/T-259/T-260/T-264/T-265、V-003），FR/AC 列写 `–`：
# 这些 .md 夹具万一在硬杀（SIGKILL/超时）后留在 `tmp/ac/` 里，也不会让文档门的
# 「未解析 ID 引用 / 占位符」扫描变红（文档门会扫仓库内所有 *.md，包括 tmp/）。
# ---------------------------------------------------------------------------
STATE_PLUGIN = "T-224 需外部凭据（Jev key，放 /workspace/config.yaml），否则建议层不可用"
STATE_CREDENTIAL = "T-259 邮件真收发需 SMTP/IMAP 凭据"
STATE_OTHER = "V-003 现场验证结论待人工签字"
CHECKLIST = "\n".join([
    "# 进度清单（夹具）",
    "",
    "| T | 阶段 | 内容 | FR | AC | status | evidence |",
    "|---|---|---|---|---|---|---|",
    "| T-260 | P2 | 已完成的事 | – | – | done | EV-001 |",
    "| T-264 | P2 | 在做的事 | – | – | doing | – |",
    "| T-265 | P2 | 待做的事 | – | – | todo | – |",
    "| T-259 | 邮件**发信/收信**（需 SMTP/IMAP 凭据）：接入传输实现 | B58 | blocked | 待人工提供凭据 |",
    "",
    "## 缺陷与阻塞",
    "",
    "| 编号 | 类型 | 内容 | 影响 | 状态 |",
    "|---|---|---|---|---|",
    "| D-001 | 已知缺陷 | 已执行 AC 不全 | 门 G0 未开始 | open（P0 进行中） |",
    "",
])


def _write_state(path: Path, human: list | None = None, blockers: list | None = None,
                 notes: dict | None = None, *, phase="P2-fixture", next_task="T-271 admin 阻塞判定器") -> Path:
    payload = {"schema": 1, "phase": phase, "next_task": next_task,
               "human_required": list(human or []), "blockers": list(blockers or []),
               "notes": dict(notes or {}),
               # 白名单外的键（含私域名/哨兵）：判定器**不读也不回显**，只计个数
               "private": {"reserve_price": SENTINEL, "cost_model": {"element_rates": [1, 2]}}}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return path


def _write_checklist(path: Path, text: str = CHECKLIST) -> Path:
    path.write_text(text, encoding="utf-8")
    return path


def _write_pipeline(path: Path, *, contractor_available=False) -> Path:
    def transport(available: bool) -> dict:
        if available:
            return {"available": True, "reason": "", "next_action": ""}
        return {"available": False, "reason": "mail-transport-unavailable",
                "next_action": "配置 SMTP/IMAP 凭据后接入"}
    payload = {"generated_at": NOW, "views": {
        "contractor": {"faq": {"entries": 1, "revs": [1]},
                       "mail": {"queued": 0, "refused": 0,
                                "transport": transport(contractor_available)}},
        "supplier": {"faq": {"entries": 1, "revs": [1]},
                     "mail": {"queued": 0, "refused": 0, "transport": transport(True)}}}}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    return path


def _stack(prefix: str) -> tuple[Path, Path, Path, Path]:
    root = new_scratch(prefix)
    return (root, _write_state(root / "state.json", [STATE_PLUGIN, STATE_CREDENTIAL, STATE_OTHER],
                               [], {"t224": "doing：等凭据", "t259": "blocked：" + STATE_CREDENTIAL}),
            _write_checklist(root / "checklist.md"), _write_pipeline(root / "pipeline.json"))


def _own_checklist_counts(text: str) -> dict:
    """夹具/真清单的**独立**复算（与判定器不是同一段代码：D-056 要的就是这个交叉核对）。"""
    counts = {status: 0 for status in CHECKLIST_STATUSES}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or not re.match(r"^[A-Z]+-\d+[a-z]?$", cells[0]):
            continue
        hit = [cell for cell in cells if cell in CHECKLIST_STATUSES]
        if hit:
            counts[hit[0]] += 1
    return counts


def _walk_keys(node, prefix: str = "") -> list[str]:
    """递归收集键名（用于"除 generated_at 外没有别的时间键"这类扫描）。"""
    keys: list[str] = []
    if isinstance(node, dict):
        for key, value in node.items():
            keys.append(str(key))
            keys.extend(_walk_keys(value, str(key)))
    elif isinstance(node, list):
        for item in node[:8]:
            keys.extend(_walk_keys(item, prefix))
    return keys


def _code_only(source: str) -> str:
    """去掉注释与字符串/文档字符串后的**代码**文本（静态扫描只该看代码，不看注释里的自述）。"""
    import io
    import tokenize

    parts = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in (tokenize.COMMENT, tokenize.STRING, tokenize.NL, tokenize.NEWLINE):
            continue
        parts.append(token.string)
    return " ".join(parts)


def _run_writer(*extra: str) -> tuple[int, str]:
    proc = subprocess.run([sys.executable, str(WRITER), *extra], cwd=str(ROOT),
                          capture_output=True, text=True, timeout=300)
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _attempt(fn) -> object:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 —— 负控就是要看它抛什么
        return exc


def _record(block_id: str, state: str, **extra) -> dict:
    return {"block_id": block_id, "state": state, "kind": "other", "reason": "账本侧记录",
            "required_action": "（账本侧已有处置）", "refs": [], "source": "ledger", **extra}


# ---------------------------------------------------------------------------
# AC-ADMIN-004
# ---------------------------------------------------------------------------
@register("AC-ADMIN-004", "P2",
          "admin 阻塞面板是真数据：判定器从真源（state.json / 进度清单 / 服务自述）生成，"
          "kind 覆盖 plugin-request+credential，计数独立可复算（D-056），快照幂等、缺源降级可分辨",
          "qa ac AC-ADMIN-004", evidence_refs=("EV-100",))
def check_admin_004() -> list[Assertion]:
    out: list[Assertion] = []
    root, state, checklist, pipeline = _stack("ac-admin-004")

    # --- 1. 真源真值（真 .agents/state.json + 真进度清单） ------------------
    real_pipeline = REAL_PIPELINE if REAL_PIPELINE.is_file() else _write_pipeline(root / "real-pipeline.json")
    real = derive_blocks(REAL_STATE, REAL_CHECKLIST, real_pipeline, NOW)
    kinds = sorted({row["kind"] for row in real["blocks"]})
    out.append(Assertion("真源真值：真 `.agents/state.json` + 真进度清单 + 真三域快照上报出 ≥2 条阻塞，"
                         "且 `kind` 同时含 `plugin-request`（advisor／Jev 建议层）与 `credential`"
                         "（邮件缺 SMTP/IMAP 凭据）（反例：判定器漏读 human_required / 分类硬编码 → 红）",
                         len(real["blocks"]) >= 2 and {"plugin-request", "credential"} <= set(kinds)
                         and real["degraded"] is False,
                         f"blocks={len(real['blocks'])} kinds={kinds} degraded={real['degraded']} "
                         f"ids={[row['block_id'] for row in real['blocks']][:4]}"))
    missing_keys = [row["block_id"] for row in real["blocks"]
                    if [key for key in REQUIRED_BLOCK_KEYS if key not in row]]
    bad_kind = [row["block_id"] for row in real["blocks"] if row["kind"] not in KINDS]
    out.append(Assertion("真源逐条形状：每条含 `block_id/kind/reason/required_action/refs`，`kind` 在取值域内，"
                         "理由逐字来自源、不是空串（反例：少一个键 / kind 写成自由文本 → 红）",
                         not missing_keys and not bad_kind
                         and all(row["reason"].strip() and row["refs"] for row in real["blocks"]),
                         f"缺键={missing_keys[:3]} 越域={bad_kind[:3]}"))
    weak = [row["block_id"] for row in real["blocks"]
            if not any(marker in row["required_action"] for marker in ACTIONABLE_MARKERS)]
    out.append(Assertion("`required_action` 可操作：每条都点到凭据类型或落点（含 提供/放入/配置/确认/补齐/写进 "
                         "之一），不是「请处理」这种空话（反例：required_action 给空串或通用话术 → 红）",
                         not weak, f"不具体={weak[:3]} 例={real['blocks'][0]['required_action'][:60]}"))

    # --- 2. 不是手写常量表：删掉源里的条目 → 对应 block 立刻消失 -------------
    before = derive_blocks(state, checklist, pipeline, NOW)
    k_before = {(row["kind"], row["task"]) for row in before["blocks"]}
    thin = _write_state(root / "state-thin.json", [], [], {})
    after = derive_blocks(thin, checklist, pipeline, NOW)
    k_after = {(row["kind"], row["task"]) for row in after["blocks"]}
    out.append(Assertion("**不是手写常量表**（负控）：把真源 state.json 里的条目清空后重跑，"
                         "来自该源的 4 条阻塞与两类 kind 立刻消失（只剩进度清单与服务自述那 2 条）"
                         "（反例：常量表 → 清空源后数字不变 → 红）",
                         len(before["blocks"]) == 6 and len(after["blocks"]) == 2
                         and before["counts"]["blocked"] == 6 and after["counts"]["blocked"] == 2
                         and {("plugin-request", "T-224"), ("credential", "T-259")} <= k_before
                         and ("plugin-request", "T-224") not in k_after,
                         f"清空前={sorted(k_before, key=str)} 清空后={sorted(k_after, key=str)}"))

    # --- 3. kind 分类确定性 + block_id 稳定 -------------------------------
    again = derive_blocks(state, checklist, pipeline, NOW)
    ids = [row["block_id"] for row in before["blocks"]]
    kind_by_task = {row["task"]: row["kind"] for row in before["blocks"] if row["task"]}
    out.append(Assertion("分类与 id 确定性：同输入两次 `render()` **字节一致**，`block_id` 逐个相同；"
                         "插件关键词先判（T-224 同时含 Jev 与「凭据」→ `plugin-request`），"
                         "纯凭据条目 → `credential`（反例：分类顺序随字典/正则漂移 → 红）",
                         render(before) == render(again)
                         and [row["block_id"] for row in again["blocks"]] == ids
                         and kind_by_task.get("T-224") == "plugin-request"
                         and kind_by_task.get("T-259") == "credential",
                         f"bytes={len(render(before).encode('utf-8'))} ids={ids} kinds={kind_by_task}"))

    # --- 4. 计数独立复算（D-056：不按列表长度推） --------------------------
    real_counts = _own_checklist_counts(REAL_CHECKLIST.read_text(encoding="utf-8"))
    progress = real["progress"]
    out.append(Assertion("进度数字只读且口径可核：`done/todo` 与**独立复算**的真进度清单一致，"
                         "`phase/next_task` 取自 state.json，`progress.source` 非空（反例：写成固定数字 / 口径空 → 红）",
                         (progress["done"], progress["todo"]) == (real_counts["done"], real_counts["todo"])
                         and progress["by_status"] == real_counts
                         and bool(str(progress.get("source") or "").strip())
                         and progress["phase"] == "P2-advisor-and-live-canary"
                         and bool(str(progress["next_task"] or "").strip()),
                         f"done/todo={progress['done']}/{progress['todo']} 复算={real_counts} "
                         f"phase={progress['phase']}"))
    bounded = derive_blocks(state, checklist, pipeline, NOW, max_blocks=1)
    ledger_records = [_record("blk-checklist-0000", "resolved"), _record("blk-state-human-required-0000", "pending")]
    with_history = derive_blocks(state, checklist, pipeline, NOW, records=ledger_records)
    out.append(Assertion("**计数不由列表长度推**（D-056）+ 有界夹取 + 账本侧记录优先："
                         "`max_blocks=1` 时 `blocks` 只 1 条而 `counts.blocked` 仍是 6、"
                         "`blocks_bounded.truncated=true`/`omitted` 明标；传入账本侧记录后同 id 采纳其状态"
                         "（resolved/pending 各计 1，不重复计入 blocked）",
                         len(bounded["blocks"]) == 1 and bounded["counts"]["blocked"] == 6
                         and bounded["progress"]["blocks_bounded"] == {"limit": 1, "listed": 1, "omitted": 5,
                                                                       "truncated": True}
                         and len(with_history["blocks"]) == 5
                         and with_history["counts"]["resolved"] == 1 and with_history["counts"]["pending"] == 1
                         and with_history["counts"]["blocked"] == 4,
                         f"bounded={bounded['progress']['blocks_bounded']} counts={with_history['counts']}"))

    # --- 5. 快照写入器：幂等 · 原子写 · 不建账本 · 无私域 -------------------
    snap_dir = new_scratch("ac-admin-004-snap")
    out1, out2 = snap_dir / "admin-blocks.json", snap_dir / "admin-blocks-2.json"
    args = ("--state", str(state), "--checklist", str(checklist), "--pipeline", str(pipeline))
    rc1, log1 = _run_writer(*args, "--out", str(out1), "--now", NOW)
    rc2, log2 = _run_writer(*args, "--out", str(out2), "--now", NOW)
    text1 = out1.read_text(encoding="utf-8") if out1.is_file() else ""
    text2 = out2.read_text(encoding="utf-8") if out2.is_file() else ""
    payload = json.loads(text1) if text1 else {}
    out.append(Assertion("写入器：两次运行都退出 0、stdout 恰好一行 JSON（含 `out`），快照含全部契约键"
                         "（反例：crash / 打多行 / 少 `degraded` → 红）",
                         rc1 == 0 and rc2 == 0 and len([l for l in log1.splitlines() if l.strip()]) == 1
                         and json.loads(log1.strip()).get("out") and set(payload) ==
                         {"generated_at", "blocks", "counts", "counts_source", "progress", "degraded",
                          "reason", "next_action"},
                         f"rc={rc1}/{rc2} keys={sorted(payload)[:8]} log={log1.strip()[:90]}"))

    out.append(Assertion("**宿主读取端不会降级**：快照带非空的 `counts_source` 与 `progress.source`"
                         "（口径来源）——宿主 `host/modules/admin-view.mjs` 缺这两个键就判"
                         "`snapshot-counts-source-missing`/`snapshot-progress-source-missing`，"
                         "真实数据也会被显示成降级（反例：删掉口径来源键 → 面板降级 → 红）",
                         bool(str(payload.get("counts_source") or "").strip())
                         and bool(str((payload.get("progress") or {}).get("source") or "").strip())
                         and str((payload.get("progress") or {}).get("source")) != "unavailable",
                         f"counts_source={str(payload.get('counts_source'))[:70]}… "
                         f"progress.source={str((payload.get('progress') or {}).get('source'))[:50]}…"))

    def strip_gen(text: str) -> str:
        return re.sub(r'"generated_at"\s*:\s*"[^"]*"', '"generated_at": "<x>"', text)

    time_keys = [key for key in _walk_keys(payload) if re.search(r"(^|_)(ts|time|at|date|updated)($|_)", key, re.I)
                 and key != "generated_at"]
    out.append(Assertion("快照**幂等**：同输入两次运行除 `generated_at` 外**逐字节一致**；除该键外没有别的时间键；"
                         "原子写不留 `.tmp` 残留（反例：列表顺序随字典走 / 先后写出两份不同文本 → 红）",
                         bool(text1) and bool(text2) and strip_gen(text1) == strip_gen(text2)
                         and not time_keys and not list(snap_dir.rglob("*.tmp")),
                         f"bytes={len(text1.encode('utf-8'))}/{len(text2.encode('utf-8'))} "
                         f"多余时间键={time_keys[:4]} tmp={[p.name for p in snap_dir.rglob('*.tmp')]}"))
    out.append(Assertion("快照**不含私域键与私域值**：state.json 白名单外的 `private.reserve_price` "
                         "既不出现在快照文本里，也没有出现在任何 block 的字段里（只留 `redacted_fields` 计数）"
                         "（反例：把整条状态对象 json.dumps 进快照 → 红）",
                         SENTINEL not in text1 and "reserve_price" not in text1 and "cost_model" not in text1
                         and any(row["redacted_fields"] > 0 for row in payload["blocks"]),
                         f"哨兵={'命中' if SENTINEL in text1 else '未命中'} "
                         f"redacted={[row['redacted_fields'] for row in payload['blocks']][:6]}"))
    solo = new_scratch("ac-admin-004-ledger")
    rc4, log4 = _run_writer(*args, "--out", str(solo / "snapshot.json"), "--now", NOW)
    out.append(Assertion("**不创建账本**：写入器跑完后目标目录只有快照这一个文件（没有 `*.jsonl`、没有目录）；"
                         "写入器源码无 `Ledger`/`ledger.append`（反例：顺手 `Ledger.append` 补一行 → 红）",
                         rc4 == 0 and sorted(p.name for p in solo.rglob("*")) == ["snapshot.json"]
                         and "Ledger" not in WRITER.read_text(encoding="utf-8")
                         and "ledger.append" not in WRITER.read_text(encoding="utf-8")
                         and ".jsonl" not in log4,
                         f"目录={sorted(p.name for p in solo.rglob('*'))} rc4={rc4}"))

    # --- 6. 缺源/损坏 → 降级可分辨（读不到 ≠ 零阻塞） ---------------------
    empty_dir = new_scratch("ac-admin-004-empty")
    gone = derive_blocks(empty_dir / "nope.json", empty_dir / "nope.md", empty_dir / "nope-pipeline.json", NOW)
    clean_state = _write_state(empty_dir / "state-clean.json", [], [], {})
    clean_checklist = _write_checklist(empty_dir / "checklist-clean.md",
                                      "| T | 阶段 | 内容 | FR | AC | status | evidence |\n|---|---|---|---|---|---|---|\n"
                                      "| T-260 | P2 | 已完成 | – | – | done | EV-001 |\n")
    clean_pipeline = _write_pipeline(empty_dir / "pipeline-clean.json", contractor_available=True)
    zero = derive_blocks(clean_state, clean_checklist, clean_pipeline, NOW)
    out.append(Assertion("缺源 → 降级（计数 0 + reason + next_action，不崩不猜）；**可读但确实零阻塞** → 计数 0 "
                         "且 `degraded=false`：两态靠 `degraded` 与 `progress.sources` 逐源状态区分"
                         "（反例：读不到时照样报 degraded=false → 把「读不到」写成「零阻塞」→ 红）",
                         gone["degraded"] is True and gone["blocks"] == []
                         and set(gone["counts"].values()) == {0}
                         and bool(str(gone["reason"])) and bool(str(gone["next_action"]))
                         and all(gone["progress"]["sources"][name]["status"] == "missing" for name in SOURCES)
                         and "读不到 ≠ 零阻塞" in gone["reason"]
                         and zero["degraded"] is False and zero["blocks"] == []
                         and set(zero["counts"].values()) == {0} and zero["reason"] is None,
                         f"全缺：degraded={gone['degraded']} counts={gone['counts']}；"
                         f"零阻塞：degraded={zero['degraded']} counts={zero['counts']}"))
    broken_dir = new_scratch("ac-admin-004-broken")
    broken_state = broken_dir / "state.json"
    broken_state.write_text('{"phase": "P2", "human_required": [', encoding="utf-8")
    partial = derive_blocks(broken_state, checklist, pipeline, NOW)
    rc3, log3 = _run_writer("--state", str(broken_state), "--checklist", str(checklist),
                            "--pipeline", str(pipeline), "--out", str(broken_dir / "admin.json"), "--now", NOW)
    out.append(Assertion("源**损坏**（state.json 半截 JSON）→ `degraded=true`、`reason` 点名该源与原因、"
                         "`next_action` 给出修法，可读源的事实照报（不因为一个源坏了就把别的源也说成 0）；"
                         "写入器在这种输入下照样写出完整降级形状（反例：抛异常 / 静默当空文件 → 红）",
                         partial["degraded"] is True
                         and partial["progress"]["sources"]["state"]["status"] == "corrupt"
                         and "state=corrupt" in partial["reason"]
                         and partial["counts"]["blocked"] >= 2
                         and rc3 == 0 and "degraded" in log3
                         and json.loads((broken_dir / "admin.json").read_text(encoding="utf-8"))["degraded"] is True,
                         f"sources={ {k: v['status'] for k, v in partial['progress']['sources'].items()} } "
                         f"counts={partial['counts']} rc3={rc3}"))

    # --- 7. 输入契约：now 必须显式、records 形状非法即拒 -------------------
    no_now = _attempt(lambda: derive_blocks(state, checklist, pipeline, None))
    bad_now = _attempt(lambda: derive_blocks(state, checklist, pipeline, "not-a-time"))
    bad_records = _attempt(lambda: derive_blocks(state, checklist, pipeline, NOW, records=42))
    out.append(Assertion("输入契约：`now` 必须显式给出且为合法 ISO（`None` 即拒、绝不回退墙钟），"
                         "`records` 不是记录集合即拒（用法错误拒绝，不猜）"
                         "（反例：`now=None` 时静默用墙钟 → 红）",
                         isinstance(no_now, AdminBlockError) and "不读墙钟" in str(no_now)
                         and isinstance(bad_now, AdminBlockError) and isinstance(bad_records, AdminBlockError),
                         f"None→{no_now} bad_now→{str(bad_now)[:40]} records=42→{str(bad_records)[:40]}"))
    return out


# ---------------------------------------------------------------------------
# AC-ADMIN-006
# ---------------------------------------------------------------------------
@register("AC-ADMIN-006", "P2",
          "阻塞状态机（Python 侧唯一写者）：只允许 blocked→pending→resolved/rejected/expired，"
          "非法转移与缺人工批准引用一律拒且零新增，合法转移只产出事件载荷（本服务不写账本）",
          "qa ac AC-ADMIN-006", evidence_refs=("EV-101",))
def check_admin_006() -> list[Assertion]:
    out: list[Assertion] = []
    root, state, checklist, pipeline = _stack("ac-admin-006")
    derived = derive_blocks(state, checklist, pipeline, NOW)
    records = derived["blocks"]
    blocked_id = [row["block_id"] for row in records if row["kind"] == "credential"][0]
    snapshot = render(records)

    # --- 1. 取值域 --------------------------------------------------------
    out.append(Assertion("取值域：`allowed_transitions` 只允许 `blocked→pending`、"
                         "`pending→resolved|rejected|expired`；三个终态无处可去；未声明状态给空元组"
                         "（反例：出现 `blocked→resolved`/`resolved→blocked` 这类边 → 红）",
                         ALLOWED_TRANSITIONS == {"blocked": ("pending",), "pending": ("resolved", "rejected",
                                                                                     "expired"),
                                                 "resolved": (), "rejected": (), "expired": ()}
                         and tuple(STATES) == ("blocked", "pending", "resolved", "rejected", "expired")
                         and derive_each_allowed(),
                         f"表={ {k: list(v) for k, v in ALLOWED_TRANSITIONS.items()} }"))

    # --- 2. 非法转移全拒且零新增 -----------------------------------------
    illegal = [("resolved", "blocked"), ("blocked", "resolved"), ("blocked", "rejected"),
               ("blocked", "expired"), ("expired", "pending"), ("pending", "pending")]
    verdicts = []
    for source_state, target in illegal:
        rows = [_record("blk-y-0000", source_state)]
        before = render(rows)
        result = apply_transition(rows, "blk-y-0000", target, approval_ref="ap-0007")
        verdicts.append((source_state, target, result["ok"], result["added"], result["events"],
                         render(rows) == before, result["reason"]))
    bad = [item for item in verdicts if item[2] or item[3] or item[4] or not item[5] or "非法转移" not in item[6]]
    ghost = apply_transition([_record("blk-y-0000", "ghost")], "blk-y-0000", "pending", approval_ref="ap-0007")
    out.append(Assertion("**非法转移一律拒且零新增**：`resolved→blocked`、`blocked→resolved`（跳过 pending）、"
                         "`blocked→rejected`、`blocked→expired`、`expired→pending`、`pending→pending` → "
                         "全部 `ok=false`、`added=[]`、`events=[]`、入参记录逐字节未变；"
                         "源状态不在取值域（`ghost`）的记录被拒绝加载 → 同样零新增"
                         "（不留部分效果；反例：任何一种被放行 → 红）",
                         not bad and ghost["ok"] is False and ghost["added"] == [] and ghost["events"] == []
                         and bool(str(ghost["reason"])),
                         f"被放行/被改动={[(i[0], i[1]) for i in bad] or '无'} "
                         f"（共试 {len(illegal)} 种；ghost→{ghost['reason'][:40]}）"))

    # --- 3. 缺人工批准引用 / 引用形状非法 一律拒 --------------------------
    probes = {"缺引用": None, "空串": "", "agent 自带": "agent:bot", "编号不用四位数": "ap-1",
              "只有前缀": "human:", "乱码": "已经批准了"}
    results = {name: apply_transition(records, blocked_id, "pending", approval_ref=ref)
               for name, ref in probes.items()}
    out.append(Assertion("**人工门不可绕过**：合法转移但缺 `approval_ref`（或引用形状不是 `ap-NNNN`/`human:*`）"
                         "一律拒且零新增，理由点名「引用不是批准、agent 不得代签」"
                         "（反例：`None` 或 `agent:*` 被当成批准 → 红）",
                         all(result["ok"] is False and result["added"] == [] and result["events"] == []
                             for result in results.values())
                         and "批准引用" in results["缺引用"]["reason"]
                         and "代签" in results["缺引用"]["reason"],
                         f"探针={ {k: (v['ok'], v['reason'][:34]) for k, v in results.items()} }"))
    out.append(Assertion("零新增是**逐字节**的：被拒的每一次调用返回的 `records` 与传入记录 `render()` 完全一致，"
                         "且 `next_action` 给出怎么重试（反例：返回「改了一半」的记录 → 红）",
                         all(render(result["records"]) == snapshot and bool(str(result["next_action"]))
                             for result in results.values()),
                         f"len={len(records)} 一致性={[render(r['records']) == snapshot for r in results.values()]}"))

    # --- 4. 合法转移：新记录 + 事件**载荷**（本服务不写账本） ---------------
    step1 = apply_transition(records, blocked_id, "pending", approval_ref="human:zhang")
    pending_record = step1["added"][0]
    step2 = apply_transition(step1["records"], blocked_id, "resolved", approval_ref="ap-0007",
                             resolution_sha256=SHA_A)
    event2 = step2["events"][0]
    out.append(Assertion("合法转移：`blocked→pending`（human:* 引用）→ 1 条新记录 + 1 条事件载荷；"
                         "`pending→resolved`（ap-NNNN 引用）→ 事件类型 `admin/block-resolved`、"
                         "body 含 `block_id/kind/from/to/approval_ref/resolution_sha256`、"
                         "记录带 `history`（当前态视图里**替换**该条、位置不变；历史在记录里累积）"
                         "（反例：跳过历史 / body 少字段 / 记录数凭空膨胀 → 红）",
                         step1["ok"] and pending_record["state"] == "pending"
                         and [event["type"] for event in step1["events"]] == [TRANSITION_EVENTS["pending"]]
                         and step2["ok"] and step2["added"][0]["state"] == "resolved"
                         and event2["type"] == "admin/block-resolved"
                         and set(event2["body"]) >= {"block_id", "kind", "from", "to", "approval_ref",
                                                     "resolution_sha256"}
                         and event2["body"]["from"] == "pending" and event2["body"]["to"] == "resolved"
                         and event2["body"]["resolution_sha256"] == SHA_A
                         and step2["added"][0]["history"] == [{"from": "blocked", "to": "pending",
                                                               "approval_ref": "human:zhang"},
                                                              {"from": "pending", "to": "resolved",
                                                               "approval_ref": "ap-0007"}]
                         and len(step2["records"]) == len(records),
                         f"events={[e['type'] for e in step1['events'] + step2['events']]} "
                         f"body={sorted(event2['body'])}"))
    out.append(Assertion("事件载荷**不含凭据正文/私域值**：body 只有 id/kind/状态/引用（+任务号与哈希），"
                         "没有 `reason`/`required_action` 原文，哨兵搜不到；`resolution_sha256` 传非哈希"
                         "（如凭据正文）即拒（反例：把提交件正文塞进 body → 红）",
                         not {"reason", "required_action", "refs"} & set(event2["body"])
                         and SENTINEL not in json.dumps(step1["events"] + step2["events"], ensure_ascii=False)
                         and not apply_transition(step1["records"], blocked_id, "resolved", approval_ref="ap-0007",
                                                  resolution_sha256="passw0rd")["ok"],
                         f"body={event2['body']}"))
    terminal = apply_transition(step2["records"], blocked_id, "resolved", approval_ref="ap-0007")
    out.append(Assertion("终态之后无路可走：已 `resolved` 的 block 再转移（resolved→resolved）被拒且零新增"
                         "（反例：终态可以再动 → 红）",
                         terminal["ok"] is False and terminal["added"] == [] and terminal["events"] == []
                         and render(terminal["records"]) == render(step2["records"]),
                         f"ok={terminal['ok']} reason={terminal['reason'][:60]}"))
    targets = {target: apply_transition(apply_transition(records, blocked_id, "pending",
                                                        approval_ref="human:zhang")["records"],
                                        blocked_id, target, approval_ref="ap-0007")["ok"]
               for target in ("resolved", "rejected", "expired")}
    out.append(Assertion("`pending` 的三个出口都合法（resolved / rejected / expired 各落一条对应事件）"
                         "（反例：只放行 resolved → 红）",
                         all(targets.values())
                         and len({TRANSITION_EVENTS[target] for target in targets}) == 3,
                         f"出口={targets} 事件={ {k: TRANSITION_EVENTS[k] for k in targets} }"))

    # --- 5. 时钟进不了状态（顺证 AC-ADMIN-007 的无暗门纪律） ---------------
    far = derive_blocks(state, checklist, pipeline, LATER, records=[_record(blocked_id, "pending")])
    near = derive_blocks(state, checklist, pipeline, NOW, records=[_record(blocked_id, "pending")])
    out.append(Assertion("**没有「超时自动解除」这条通路**：把判定器的时钟推后 100 年，阻塞状态、计数、"
                         "事件一律不变（`render()` 字节一致）——`now` 只被校验，不参与任何状态判定"
                         "（反例：加一条按时间自动 resolved 的分支 → 红）",
                         render(far) == render(near) and far["counts"] == near["counts"]
                         and [row["state"] for row in far["blocks"]] == [row["state"] for row in near["blocks"]]
                         and any(row["state"] == "blocked" for row in near["blocks"]),
                         f"NOW={NOW} LATER={LATER} counts={near['counts']} "
                         f"states={sorted({row['state'] for row in near['blocks']})}"))

    # --- 6. 静态：不写账本 / 不读墙钟 / 不读环境变量 ----------------------
    source = SERVICE.read_text(encoding="utf-8")
    code = _code_only(source)                    # 去掉注释与字符串字面量：只扫**真代码**
    write_needles = ("from ..kernel.ledger", "kernel.ledger", "Ledger", "append(", "write_text",
                     "write_bytes", "os.remove", "shutil", "mkdir", "open(", "truncate(")
    hits = [needle for needle in write_needles if needle in code]
    out.append(Assertion("**本服务不写账本**（静态·文本，注释与字符串已剔除）：`services/admin_blocks.py` 的代码里"
                         "没有账本写入口（`Ledger`/`kernel.ledger`）、没有写文件调用（`write_text`/`write_bytes`/"
                         "`open(`/`mkdir`），也没有任何 `append(` —— 它只读源、只产出事件载荷"
                         "（反例：此处出现 `Ledger.append` → 红）",
                         not hits, f"命中={hits or '无'}（已扫描代码 {len(code)} 字符 / 源 {len(source)} 字节）"))
    tree = ast.parse(source)
    imports: set[str] = set()
    clock_calls: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level:
            imports.add((node.module or "").split(".")[0])
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in ("now", "utcnow", "today", "time", "getenv", "environ"):
                clock_calls.add(node.func.attr)
            if isinstance(node.func.value, ast.Attribute) and node.func.value.attr == "environ":
                clock_calls.add("environ")
    out.append(Assertion("不读墙钟/不读环境变量（静态·AST）：外部导入只限 json/re/datetime/pathlib/typing/"
                         "`__future__`（没有 os/time/shutil/subprocess/socket），没有 `now()/today()` "
                         "时钟调用与 `os.environ/getenv`（反例：import os + 读环境变量 → 红）",
                         imports <= {"json", "re", "datetime", "pathlib", "typing", "__future__"}
                         and not (imports & {"os", "time", "shutil", "subprocess", "socket", "tempfile",
                                             "random"})
                         and not clock_calls,
                         f"imports={sorted(imports)} 可疑调用={sorted(clock_calls)}"))
    return out


def derive_each_allowed() -> bool:
    """`allowed_transitions()` 与常量表逐状态一致（防止有人只改一处）。"""
    from ..services.admin_blocks import allowed_transitions

    expected = {"blocked": ("pending",), "pending": ("resolved", "rejected", "expired"),
                "resolved": (), "rejected": (), "expired": ()}
    return all(allowed_transitions(name) == value for name, value in expected.items()) \
        and allowed_transitions("ghost") == () and allowed_transitions(None) == ()
