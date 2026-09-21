"""services/admin_blocks.py —— admin 道：agent 阻塞/进度**判定器** + 阻塞**状态机**（T-271）。

对应需求与验收：FR-ADMIN-004 / FR-ADMIN-006、AC-ADMIN-004 / AC-ADMIN-006；契约见
`docs/design/21-admin-console-contract.md` §3/§4（"阻塞清单手写常量表 → 否决"）。

设计边界（每一句都能被 `qa ac AC-ADMIN-004` / `qa ac AC-ADMIN-006` 的断言钉住）：

- **输入全部显式传入**：`derive_blocks(state_path, checklist_path, pipeline_snapshot_path, now, ...)`。
  本服务**不读墙钟、不读环境变量、不猜仓库路径**（默认值只出现在 `tools/refresh-admin-snapshot.py` 那个工具里）。
- **真源，不是手写常量表**（D-040 / 21 §4）：阻塞只从三处**采集**出来 ——
  ① `.agents/state.json`：`human_required` 条目 + `blockers` 条目 + `notes` 里以 `blocked` 开头的条目；
  ② `docs/work/progress-checklist.md`：状态列恰为 `blocked` 的任务行；
  ③ 三域快照 `pipeline.json`：任何 `{"available": false}` 的节点（服务**自述**不可用，如
     `views.<view>.mail.transport`）。源里删掉一条，对应 block 立刻消失（没有第二条通路把它报回来）。
- **kind 确定性分类**：整条文本（含 refs 与自述的 next_action）含 `插件/建议层/jev` → `plugin-request`；
  含 `凭据/key/SMTP/IMAP/token` → `credential`；否则 `other`。**插件关键词先判**：
  T-224「需外部凭据（Jev key…）」两条都命中，按插件需求归类（AC-ADMIN-004 要的正是这条 `plugin-request`）。
- **`block_id` = 来源 + 序号**（`blk-<source>-NNNN`）：同输入同 id；同一底层需求在多个来源各记一条
  （判定器**不去重**：去重是推断，宁可多列，不可漏报；来源写在 `refs`/`source` 里可核）。
- **降级可分辨**：任一源缺失/损坏 → `degraded=true` + `reason` + `next_action`，且 `progress.sources`
  逐源给状态（`ok|missing|corrupt`）。「读不到」与「确实零阻塞」不是同一张脸：
  前者 `degraded=true`，后者 `degraded=false`。判定器**不补默认值、不猜**：可读源里的事实照报，
  读不到的部分一律不编（全不可读时计数为 0，且 `reason` 明说"0 只表示无可读事实"）。
- **计数不按列表长度推**（D-056）：`counts` 覆盖**全部**记录（含调用方传入的账本侧历史记录），
  `blocks` 只是**有界**的存活清单（`blocked`/`pending`，上限 `max_blocks`）——
  两者可以不等，且 `progress.blocks_bounded` 明标 `omitted/truncated`。
- **状态机（AC-ADMIN-006 的 Python 侧）**：`allowed_transitions` 只有 `blocked→pending`、
  `pending→resolved|rejected|expired`；`apply_transition()` 是**纯函数** —— 非法转移、缺人工批准引用
  一律拒且**零新增**（`added=[]`、`events=[]`、`records` 与输入逐字节一致，不留部分效果）。
- **本服务不写账本**（H1）：它只产出"该落什么事件"的**载荷**（`events`），落账由后续批次的 Python
  生产者做。本文件里没有 `Ledger`、没有 `.append(`、没有写文件调用。
- **无暗门**：不存在任何"按时间自动转移/自动批准/自动解除"的分支。`now` 只被**校验**（必须显式给、
  必须合法），**不参与任何状态判定** —— 推时钟不改变阻塞状态（AC-ADMIN-007 的反例就查这个）。
- **只读白名单**（INV-008 纪律，照 `services/retention.py`）：state.json 只读
  `phase`/`next_task`/`human_required`/`blockers`/`notes`，其余键**不读也不回显**，只计个数
  `redacted_fields`；未知形状的条目宁可跳过并计数，也不 `json.dumps` 整条读进来。

【本批次**未做**（诚实标注，不是"已完成"）】
- 四条事件名 `admin/block-pending|resolved|rejected|expired` **尚未登记**进
  `docs/design/05-events.md` 与 `kernel/events.py` 的 `DEFAULT_TABLE`（本项目"声明即登记"）。
  本任务只能动本文件，登记属于真正落账那一批（T-265）：**登记前不得把 `events` 里的载荷写进账本**。
- `apply_transition` 只能校验"引用给没给、形状合不合法"。引用**是不是**一笔 `granted` 且
  `decided_by=human:*` 的批准，必须到账本 / `ApprovalService` 里核（先例：
  `services/retention_exec.py` 的 `_approval_state`）。**引用本身不是批准**。
- `replay()`（从账本重建当前状态，AC-ADMIN-006 的另一半）属写入侧的账本重放，本批不做；
  调用方可以把自己重建出的记录经 `records=` 传进来，判定器按 `block_id` 采纳其状态。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..kernel.canon import canonical_json

# ---------------------------------------------------------------------------
# 状态机（AC-ADMIN-006：只允许 blocked→pending→resolved|rejected|expired）
# ---------------------------------------------------------------------------
BLOCKED = "blocked"
PENDING = "pending"
RESOLVED = "resolved"
REJECTED = "rejected"
EXPIRED = "expired"
#: 取值域（顺序即文档顺序；canonical JSON 会按键排序，这里只为可读）
STATES = (BLOCKED, PENDING, RESOLVED, REJECTED, EXPIRED)
#: **唯一**的合法转移表：终态（resolved/rejected/expired）之后无路可走
ALLOWED_TRANSITIONS: dict[str, tuple[str, ...]] = {
    BLOCKED: (PENDING,),
    PENDING: (RESOLVED, REJECTED, EXPIRED),
    RESOLVED: (),
    REJECTED: (),
    EXPIRED: (),
}
#: 判定器认为"还需要人管"的状态（面板展示的就是这些）
LIVE_STATES = (BLOCKED, PENDING)
#: 转移 → 要落的账本事件类型（**尚未登记**，见模块 docstring「本批次未做」）
TRANSITION_EVENTS: dict[str, str] = {
    PENDING: "admin/block-pending",
    RESOLVED: "admin/block-resolved",
    REJECTED: "admin/block-rejected",
    EXPIRED: "admin/block-expired",
}
#: 批准引用形状：账本侧的批准 id（`ap-NNNN`，先例 retention_exec）或直接的人署名（`human:*`）。
#: 别的形状（空串、`agent:*`、`ap-1`、乱码）一律拒 —— 不修补、不猜。
APPROVAL_REF_RE = re.compile(r"^(?:ap-\d{4}|human:[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$")
#: `sha256:` + 64 hex（AC-ADMIN-005 的 `resolution_sha256`；顺带挡住"把凭据正文当哈希传进来"）
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

# ---------------------------------------------------------------------------
# 真源（三处；键名即契约，改了就是改契约）
# ---------------------------------------------------------------------------
SOURCE_STATE = "state"          # .agents/state.json（任务登记 + 阻塞 + 进度）
SOURCE_CHECKLIST = "checklist"  # docs/work/progress-checklist.md（任务行状态列）
SOURCE_PIPELINE = "pipeline"    # tmp/ui-shared/pipeline.json（三域快照：服务自述不可用）
SOURCES = (SOURCE_STATE, SOURCE_CHECKLIST, SOURCE_PIPELINE)

#: state.json 里允许被读取的键（其余不读也不回显 —— INV-008）
STATE_READ_KEYS = ("phase", "next_task", "human_required", "blockers", "notes")
#: blockers / 未知形状条目里允许被读取的子键（其余不读）
BLOCKER_READ_KEYS = ("reason", "summary", "task", "ref", "required_action")
#: 进度清单里 status 列的取值域（AGENTS.md 规则 6 同一口径）
CHECKLIST_STATUSES = ("done", "doing", "blocked", "todo")
#: 任务行首列形状（`T-215a` 这类也认；`D-003`/`V-002` 也在同一形状族里）
TASK_ROW_RE = re.compile(r"^[A-Z]+-\d+[a-z]?$")
#: 从文本里抽任务号（进 `task` 字段，给面板做可点链接用）
TASK_ID_RE = re.compile(r"\b(T-\d+[a-z]?|V-\d{3}|D-\d{3})\b")

#: kind 关键词（小写匹配；插件先判，见 docstring）
PLUGIN_KEYWORDS = ("插件", "建议层", "jev")
CREDENTIAL_KEYWORDS = ("凭据", "key", "smtp", "imap", "token")
KINDS = ("plugin-request", "credential", "other")

#: 默认有界上限（有界输出是纪律：大 state.json / 大快照不得变成洪流）
DEFAULT_MAX_BLOCKS = 20
#: reason 是**逐字**来源文本，但夹取到有界（超出加省略号，明示被截）
REASON_CLIP = 400

#: 进度数字的口径来源（AC-ADMIN-004 要的"标注口径来源"；宿主 `admin-view` 的 `progress.source`）
CALIBER = ("进度数字只读：phase/next_task 取 .agents/state.json（任务登记表）；done/todo 取 "
           "docs/work/progress-checklist.md 的任务行状态列**逐行计数**（不按任何展示列表的长度推，D-056）；"
           "counts 覆盖判定器已知的**全部**记录（含调用方传入的账本侧记录），blocks 只是存活阻塞的**有界**清单")


def _counts_source(sources: dict, total: int) -> str:
    """`counts` 的口径来源（宿主 `admin-view` 缺这个键即判降级：没有口径就没有可信数字）。"""
    readable = ",".join(name for name in SOURCES if sources[name]["status"] == "ok") or "none"
    note = "" if all(sources[name]["status"] == "ok" for name in SOURCES) else "（部分源不可读，计数只覆盖可读源）"
    return f"admin_blocks.derive_blocks：{total} 条记录按 state 逐条计数；可读源={readable}{note}"


class AdminBlockError(RuntimeError):
    """用法错误（缺 now、now 非法、records 不是记录集合……）—— 宁可不判，不猜。"""


# ---------------------------------------------------------------------------
# 小工具：确定性文本处理
# ---------------------------------------------------------------------------
def classify_kind(text: Any) -> str:
    """整条文本 → `plugin-request` / `credential` / `other`（确定性；插件关键词先判）。"""
    low = str(text or "").lower()
    if any(keyword in low for keyword in PLUGIN_KEYWORDS):
        return "plugin-request"
    if any(keyword in low for keyword in CREDENTIAL_KEYWORDS):
        return "credential"
    return "other"


def allowed_transitions(state: Any) -> tuple[str, ...]:
    """某个状态允许转移到哪些状态（未知/终态 → 空元组：无处可去）。"""
    return tuple(ALLOWED_TRANSITIONS.get(str(state), ()))


def _task_id(text: Any) -> str | None:
    found = TASK_ID_RE.search(str(text or ""))
    return found.group(1) if found else None


def _note_task(key: Any) -> str | None:
    """`notes` 的键（`t224` / `T-224`）→ 规范任务号（`T-224`）；不是任务号的键给 `None`。"""
    found = re.match(r"^[tT]-?(\d+)([a-z]?)$", str(key or "").strip())
    return f"T-{found.group(1)}{found.group(2)}" if found else None


def _clip(text: Any, limit: int = REASON_CLIP) -> str:
    value = str(text or "")
    return value if len(value) <= limit else value[: limit - 1] + "…"


def _config_target(text: str) -> str | None:
    """文本里出现的配置文件落点（`/workspace/config.yaml`、`config.yml` 都认）。"""
    found = re.search(r"[A-Za-z0-9_./~-]*config\.ya?ml", text)
    return found.group(0) if found else None


def _provider(text: str) -> str:
    """从文本里取"要提供什么"（确定性顺序：先具体后笼统）。"""
    low = text.lower()
    if "smtp" in low or "imap" in low:
        return "SMTP/IMAP"
    if "jev" in low:
        return "Jev（advisor 建议层）"
    if "cloudflare" in low:
        return "Cloudflare"
    if "vercel" in low:
        return "Vercel"
    return "外部服务"


def _required_action(kind: str, text: str, block_id: str, task: str | None) -> str:
    """把"缺什么"翻成**可操作**的下一步（每条都点到落点或凭据类型，不写"请处理"这种空话）。"""
    low = text.lower()
    provider = _provider(text)
    target = _config_target(text)
    if kind == "plugin-request":
        if "隔离" in text:
            return ("人工确认插件隔离粒度（进程内独立 Context 是否够用）并把结论写进 docs/design，"
                    "随后由 Python 侧消费该决定并落 admin/* 事件（宿主只提交、不判定）")
        if target:
            return (f"把 {provider} 的 key 放进 {target} 的 LLM 段（在管理道 UI 内提交，"
                    f"宿主只落待处理提交、不写账本），提交由 Python 侧消费后落 admin/* 事件")
        return ("补齐该插件所需的 key 与配置：把 key 放进 /workspace/config.yaml 的 LLM 段"
                "（或 0600 文件），或人工确认放弃该插件（写进 docs/design），二者都由人在 UI 内提交")
    if kind == "credential":
        if "smtp" in low or "imap" in low:
            return ("提供 SMTP/IMAP 凭据（服务端注入：环境变量或 0600 文件；凭据不得进 HTML/JS、"
                    "快照、账本、日志四处）并在管理道 UI 内提交，由 Python 侧消费后落 admin/block-resolved")
        return (f"提供 {provider} 凭据/密钥（落 {target or '0600 文件'}，经人工门决定）并在管理道 UI 内提交，"
                f"由 Python 侧消费后落 admin/block-resolved")
    return (f"人工确认 {task or block_id} 的处理方式（保留 / 解除）并在管理道 UI 内提交，"
            f"提交由 Python 侧消费（判定器不替人决定）")


def _block(source_key: str, index: int, text: str, refs: Iterable[str], redacted_fields: int,
           *, classify_extra: str = "", required_action: str | None = None) -> dict:
    """造一条阻塞记录（`state` 一律从 `blocked` 起 —— 之后的转移只走 `apply_transition`）。"""
    refs = [str(item) for item in refs]
    kind = classify_kind(" ".join([text, classify_extra, *refs]))
    task = _task_id(text) or _task_id(" ".join(refs))
    block_id = f"blk-{source_key}-{index:04d}"
    action = required_action if (required_action and str(required_action).strip()) else \
        _required_action(kind, text, block_id, task)
    return {
        "block_id": block_id,
        "kind": kind,
        "reason": _clip(text),
        "required_action": str(action).strip(),
        "refs": refs,
        # --- 附加只读字段（状态机与计数需要；不是对上面五个键的替代） ---
        "state": BLOCKED,
        "source": source_key,
        "task": task,
        "redacted_fields": int(redacted_fields),
    }


# ---------------------------------------------------------------------------
# 只读采集器：三个真源 → 逐源状态 + 逐源记录（缺失/损坏一律如实报，不补默认值）
# ---------------------------------------------------------------------------
def _missing(path: Path, detail: str) -> dict:
    return {"status": "missing", "detail": detail, "path": str(path), "records": [], "payload": None}


def _corrupt(path: Path, detail: str) -> dict:
    return {"status": "corrupt", "detail": detail, "path": str(path), "records": [], "payload": None}


def _read_json_source(path: Any, *, shape_ok, shape: str) -> dict:
    """读一个 JSON 源：不存在 = `missing`；解析失败/形状不符 = `corrupt`（两者都不当"空文件"）。"""
    target = Path(str(path))
    if not target.is_file():
        return _missing(target, "文件不存在（没有真源就没有事实，不当作空文件）")
    try:
        raw = target.read_text(encoding="utf-8")
    except OSError as exc:
        return _missing(target, f"读不到：{exc}")
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        return _corrupt(target, f"不是合法 JSON：{exc}")
    if not shape_ok(payload):
        return _corrupt(target, f"结构不符（期望 {shape}）")
    return {"status": "ok", "detail": "", "path": str(target), "records": [], "payload": payload}


def _collect_state(path: Any) -> dict:
    source = _read_json_source(path, shape_ok=lambda p: isinstance(p, dict) and any(k in p for k in STATE_READ_KEYS),
                              shape="含 phase/next_task/human_required/blockers/notes 之一的对象")
    if source["status"] != "ok":
        return source
    payload = source["payload"]
    redacted = sum(1 for key in payload if key not in STATE_READ_KEYS)
    records, skipped = [], []

    human = payload.get("human_required")
    if human is not None and not isinstance(human, list):
        return _corrupt(Path(source["path"]), "human_required 必须是条目数组")
    for index, item in enumerate(human or []):
        if isinstance(item, str) and item.strip():
            records.append(_block("state-human-required", index, item, [f"state:human_required[{index}]"], redacted))
        else:
            skipped.append(f"human_required[{index}]")

    blockers = payload.get("blockers")
    if blockers is not None and not isinstance(blockers, list):
        return _corrupt(Path(source["path"]), "blockers 必须是条目数组")
    for index, item in enumerate(blockers or []):
        ref = f"state:blockers[{index}]"
        if isinstance(item, str) and item.strip():
            records.append(_block("state-blockers", index, item, [ref], redacted))
        elif isinstance(item, dict) and any(item.get(k) for k in BLOCKER_READ_KEYS):
            # 只读白名单子键：未知子键**不读也不回显**（不 json.dumps 整条）
            text = "；".join(str(item[read_key]) for read_key in BLOCKER_READ_KEYS if item.get(read_key))
            extra = str(item.get("ref") or item.get("task") or "").strip()
            refs = [ref, f"state:{extra}"] if extra else [ref]
            records.append(_block("state-blockers", index, text, refs, redacted))
        else:
            skipped.append(ref)

    notes = payload.get("notes")
    if notes is not None and not isinstance(notes, dict):
        return _corrupt(Path(source["path"]), "notes 必须是对象")
    note_index = 0
    for key in sorted(notes or {}):                      # 键排序 → 迭代顺序确定
        value = (notes or {})[key]
        if not isinstance(value, str) or not value.strip().lower().startswith("blocked"):
            continue                                     # 只认"状态 = blocked"的笔记（done：/doing：等不读）
        row = _block("state-notes", note_index, value, [f"state:notes.{key}"], redacted)
        row["task"] = row["task"] or _note_task(key)     # `notes.t224` → `T-224`（给面板做链接用）
        note_index += 1
        records.append(row)
    source["records"] = records
    source["skipped"] = skipped
    return source


def _collect_checklist(path: Any) -> dict:
    target = Path(str(path))
    if not target.is_file():
        return _missing(target, "文件不存在（没有真源就没有事实，不当作空文件）")
    try:
        text = target.read_text(encoding="utf-8")
    except OSError as exc:
        return _missing(target, f"读不到：{exc}")

    counts = {status: 0 for status in CHECKLIST_STATUSES}
    records, rows = [], 0
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or not TASK_ROW_RE.match(cells[0]):
            continue
        found = [index for index, cell in enumerate(cells) if cell in CHECKLIST_STATUSES]
        if not found:
            continue                                     # 表头/缺陷表等没有状态列 → 不是任务行
        rows += 1
        status = cells[found[0]]
        counts[status] += 1
        if status != BLOCKED:
            continue
        task = cells[0]
        records.append(_block("checklist", len(records), " | ".join(cells),
                              [f"checklist:{task}", f"checklist:L{lineno}"], 0))
    if rows == 0:
        return _corrupt(target, "解析不出任何任务行（表格形状不符）")
    return {"status": "ok", "detail": "", "path": str(target), "payload": {"counts": counts, "rows": rows},
            "records": records, "counts": counts, "rows": rows}


def _available_false(node: Any, path: str = "") -> list[tuple[str, dict]]:
    """递归找 `{"available": false}` 节点（服务自述不可用）；键排序 → 遍历顺序确定。"""
    found: list[tuple[str, dict]] = []
    if isinstance(node, dict):
        for key in sorted(node):
            value = node[key]
            here = f"{path}.{key}" if path else str(key)
            if isinstance(value, dict) and value.get("available") is False:
                found.append((here, value))
            found.extend(_available_false(value, here))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            found.extend(_available_false(item, f"{path}[{index}]"))
    return found


def _collect_pipeline(path: Any) -> dict:
    source = _read_json_source(path, shape_ok=lambda p: isinstance(p, dict) and bool(p.get("views"))
                              and isinstance(p.get("views"), dict),
                              shape="含非空 views 对象的快照")
    if source["status"] != "ok":
        return source
    payload = source["payload"]
    records = []
    for path_key, node in _available_false(payload):
        reason = str(node.get("reason") or "未给理由")
        next_action = str(node.get("next_action") or "").strip()
        text = f"服务自述不可用：{path_key} available=false（reason={reason}）"
        supplied = (f"{next_action}（服务自述的下一步；在管理道 UI 内提交后由 Python 侧消费，宿主不写账本）"
                    if next_action else None)
        records.append(_block("pipeline", len(records), text, [f"pipeline:{path_key}"],
                              sum(1 for key in node if key not in ("available", "reason", "next_action")),
                              classify_extra=next_action, required_action=supplied))
    source["records"] = records
    return source


def read_sources(state_path: Any, checklist_path: Any, pipeline_snapshot_path: Any) -> dict:
    """只读采集三个真源（**不写任何文件**）；返回逐源状态 + 逐源记录。"""
    return {
        SOURCE_STATE: _collect_state(state_path),
        SOURCE_CHECKLIST: _collect_checklist(checklist_path),
        SOURCE_PIPELINE: _collect_pipeline(pipeline_snapshot_path),
    }


# ---------------------------------------------------------------------------
# 判定器（纯函数：同输入两次字节一致；不让时钟进任何状态）
# ---------------------------------------------------------------------------
def _moment(now: Any) -> float:
    if now is None:
        raise AdminBlockError("now 必须显式传入：本判定器不读墙钟（也不让时钟参与任何状态判定）")
    if isinstance(now, bool) or not isinstance(now, (str, datetime)):
        raise AdminBlockError(f"now 必须是 ISO 时间字符串或 datetime，收到 {type(now).__name__}")
    if isinstance(now, str):
        try:
            value = datetime.fromisoformat(now.strip().replace("Z", "+00:00"))
        except ValueError as exc:
            raise AdminBlockError(f"now 不是合法 ISO 时间: {now!r}（{exc}）") from exc
    else:
        value = now
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _input_rows(records: Iterable) -> list:
    """入参记录的**原样拷贝**（拒绝时就逐字节还回去 —— 零新增就是零变化）。"""
    if records is None or isinstance(records, (str, bytes, dict)) or not hasattr(records, "__iter__"):
        raise AdminBlockError(f"records 必须是记录的可迭代集合，收到 {type(records).__name__}")
    return [dict(row) if isinstance(row, dict) else row for row in records]


def _normalize_records(records: Iterable | None) -> tuple[list[dict], int]:
    """调用方给的记录（账本侧重建结果）→ 规范化；坏条目逐条拒绝并计数（不崩整次判定）。"""
    if records is None:
        return [], 0
    if isinstance(records, (str, bytes, dict)) or not hasattr(records, "__iter__"):
        raise AdminBlockError(f"records 必须是记录的可迭代集合，收到 {type(records).__name__}")
    out, rejected = [], 0
    for item in records:
        if not isinstance(item, dict) or not str(item.get("block_id") or "").strip() \
                or item.get("state") not in STATES:
            rejected += 1
            continue
        row = dict(item)
        row["block_id"] = str(row["block_id"])
        row.setdefault("refs", [])
        row.setdefault("kind", classify_kind(row.get("reason")))
        row.setdefault("source", "ledger")
        row.setdefault("task", _task_id(row.get("reason")))
        row.setdefault("redacted_fields", 0)
        out.append(row)
    return out, rejected


def _source_report(sources: dict) -> dict:
    report = {}
    for name in SOURCES:
        source = sources[name]
        entry = {"status": source["status"], "records": len(source["records"]), "path": source["path"]}
        if source["detail"]:
            entry["detail"] = source["detail"]
        if source.get("skipped"):
            entry["skipped"] = list(source["skipped"])
        report[name] = entry
    return report


def _degraded_reason(sources: dict) -> str:
    parts = [f"{name}={sources[name]['status']}（{sources[name]['detail']}）"
             for name in SOURCES if sources[name]["status"] != "ok"]
    text = "源不可用：" + "；".join(parts)
    if all(sources[name]["status"] != "ok" for name in SOURCES):
        text += ("。三个源都不可读：本次计数为 0 只表示**没有任何可读事实**，"
                 "不表示「无阻塞」（读不到 ≠ 零阻塞）")
    else:
        text += "。本次只报可读源里的事实，读不到的部分一律不编（读不到 ≠ 零阻塞）"
    return text


def _degraded_action(sources: dict) -> str:
    hints = []
    for name in SOURCES:
        state = sources[name]["status"]
        if state == "missing":
            hints.append(f"{name}：文件不存在 —— 先恢复/生成该真源再重跑（不要用空值顶替）")
        elif state == "corrupt":
            hints.append(f"{name}：内容不是合法 JSON/表格 —— 修好内容再重跑（不要用默认值顶替）")
    return "；".join(hints)


def derive_blocks(state_path: Any, checklist_path: Any, pipeline_snapshot_path: Any, now: Any, *,
                  records: Iterable | None = None, max_blocks: int = DEFAULT_MAX_BLOCKS) -> dict:
    """真源 → 阻塞清单 + 只读计数/进度（唯一判定入口；纯函数，零副作用）。

    形状（键名即契约；与宿主 `host/modules/admin-view.mjs` 的读取端逐键对齐）::

        {"blocks": [{block_id, kind, reason, required_action, refs, state, source, task, redacted_fields}],
         "counts": {blocked, pending, resolved, rejected, expired},
         "counts_source": "<口径来源：多少条记录、按什么计数、覆盖哪些可读源>",
         "progress": {phase, next_task, done, todo, by_status, checklist_rows, source,
                      sources, blocks_bounded, records_rejected},
         "degraded": bool, "reason": str|None, "next_action": str|None}

    · `blocks` = 存活阻塞（`blocked`/`pending`）的**有界**清单（上限 `max_blocks`）；
    · `counts` = 对**全部**已知记录的逐状态计数（含 `records=` 传入的账本侧记录）；
    · `counts_source` / `progress.source` = 口径来源（宿主缺这两个键即判降级，所以它们不是装饰）；
    · 源缺失/损坏 → `degraded=true` + `reason` + `next_action`（`progress.sources` 逐源给状态）。
    """
    _moment(now)                                     # 校验 now（显式注入；**不参与任何状态判定**）
    if isinstance(max_blocks, bool) or not isinstance(max_blocks, int) or max_blocks < 1:
        raise AdminBlockError(f"max_blocks 必须是 ≥ 1 的整数（有界输出），收到 {max_blocks!r}")

    sources = read_sources(state_path, checklist_path, pipeline_snapshot_path)
    broken = [name for name in SOURCES if sources[name]["status"] != "ok"]

    merged: dict[str, dict] = {}
    known, rejected_records = _normalize_records(records)
    for row in known:
        merged[row["block_id"]] = row
    derived = [record for name in SOURCES for record in sources[name]["records"]]
    for row in derived:
        merged.setdefault(row["block_id"], row)      # 账本侧记录优先（同 block_id 只出现一次）

    all_records = [merged[key] for key in sorted(merged)]
    counts = {state: sum(1 for row in all_records if row.get("state") == state) for state in STATES}
    live = [row for row in sorted(all_records, key=lambda r: (str(r.get("state")), str(r["block_id"])))
            if row.get("state") in LIVE_STATES]
    listed = live[:max_blocks]

    by_status = {state: int((sources[SOURCE_CHECKLIST].get("counts") or {}).get(state, 0))
                 for state in CHECKLIST_STATUSES}
    state_payload = sources[SOURCE_STATE].get("payload") or {}
    checklist_rows = int(sources[SOURCE_CHECKLIST].get("rows") or 0)
    progress = {
        "phase": state_payload.get("phase"),
        "next_task": state_payload.get("next_task"),
        "done": by_status["done"],
        "todo": by_status["todo"],
        # --- 附加只读元数据（口径/降级/有界；不是对上面四个键的替代） ---
        "by_status": by_status,
        "checklist_rows": checklist_rows,
        "source": CALIBER,
        "sources": _source_report(sources),
        "blocks_bounded": {"limit": max_blocks, "listed": len(listed),
                           "omitted": max(0, len(live) - len(listed)),
                           "truncated": len(live) > len(listed)},
        "records_rejected": rejected_records,
    }
    return {
        "blocks": listed,
        "counts": counts,
        "counts_source": _counts_source(sources, len(all_records)),
        "progress": progress,
        "degraded": bool(broken),
        "reason": _degraded_reason(sources) if broken else None,
        "next_action": _degraded_action(sources) if broken else None,
    }


def render(result: Any) -> str:
    """确定性序列化（canonical JSON：键排序 + NFC；同输入两次字节一致）。"""
    return canonical_json(result)


# ---------------------------------------------------------------------------
# 状态机（唯一写者纪律：本服务只**产出载荷**，不写账本）
# ---------------------------------------------------------------------------
def _reject(records_in: list, block_id: Any, to: Any, approval_ref: Any, reason: str,
            next_action: str) -> dict:
    """拒绝体：**零新增**（`added=[]`、`events=[]`），记录**原样**返回（逐字节等于入参，不留部分效果）。"""
    return {"ok": False, "block_id": block_id, "from": None, "to": to, "approval_ref": approval_ref,
            "added": [], "records": records_in, "events": [], "reason": reason, "next_action": next_action}


def apply_transition(records: Iterable, block_id: Any, to: Any, *, approval_ref: Any = None,
                     resolution_sha256: Any = None) -> dict:
    """状态转移（**纯函数**）：合法 → 新记录 + 要落的事件载荷；非法/缺人工批准引用 → 零新增。

    合法转移只有 `blocked→pending`、`pending→resolved|rejected|expired`（`allowed_transitions`）。
    每次转移都要给 `approval_ref`（`ap-NNNN` 或 `human:*`）：**引用本身不是批准**，
    它是不是一笔 `granted` 且 `decided_by=human:*` 的批准要在账本侧核（先例 retention_exec）。
    `records` 是**当前态视图**（每个 `block_id` 一条）：合法转移**替换**该条（位置不变）并把新记录放进
    `added`；账本侧累积的是**事件**（`events`），当前态由账本重放得出（AC-ADMIN-006 的 `replay()`）——
    两件事不混。本函数**不写账本**、不动任何文件、不改入参对象：被拒时返回的 `records` 是入参记录的
    原样拷贝（逐字节等于入参，`added=[]`、`events=[]`）。
    `resolution_sha256`（可选，`sha256:<64hex>`）只用于 `pending→resolved`：AC-ADMIN-005 的
    `admin/block-resolved` body 要这个字段，而凭据**正文**永远不进事件（传非哈希值即拒）。
    """
    raw = _input_rows(records)                       # 原样拷贝：拒绝时逐字节还回去
    normalized, rejected_records = _normalize_records(raw)
    original = [dict(row) for row in normalized]

    if to not in STATES:
        return _reject(raw, block_id, to, approval_ref,
                       f"未知目标状态 {to!r}；取值域 {list(STATES)}",
                       f"用状态机声明的取值域重试：{list(STATES)}")
    matches = [row for row in original if row["block_id"] == str(block_id)]
    if not matches:
        return _reject(raw, block_id, to, approval_ref,
                       f"找不到 block_id={block_id!r} 的记录（账本里没有这条事实，不自动建）",
                       "先用判定器/账本重放拿到该 block_id 的当前记录，再提交转移")
    if len(matches) > 1:
        return _reject(raw, block_id, to, approval_ref,
                       f"block_id={block_id!r} 命中 {len(matches)} 条记录（身份含糊，宁可不判）",
                       "同一 block_id 只应有一条当前记录：先核对账本，别在这里替它挑一条")
    current = matches[0]
    source_state = str(current.get("state"))
    if to not in allowed_transitions(source_state):
        return _reject(raw, block_id, to, approval_ref,
                       f"非法转移 {source_state}→{to}；{source_state} 只允许 →"
                       f"{list(allowed_transitions(source_state)) or '（终态，无处可去）'}"
                       f"（AC-ADMIN-006：不允许跳过 pending，也不允许从终态复活）",
                       f"按状态机走：{source_state}→…；非法转移不产生任何新记录、不落任何事件")

    ref = approval_ref if isinstance(approval_ref, str) else ""
    if not ref.strip():
        return _reject(raw, block_id, to, approval_ref,
                       f"缺人工批准引用：{source_state}→{to} 必须带 approval_ref（ap-NNNN 或 human:*）；"
                       f"引用不是批准，agent 不得代签（人工门不可绕过）",
                       "由人决定后带上批准引用重试（ap-NNNN 来自 ApprovalService；引用须能在账本里核出）")
    if not APPROVAL_REF_RE.match(ref.strip()):
        return _reject(raw, block_id, to, approval_ref,
                       f"批准引用形状非法（须 ap-NNNN 或 human:*，不做修补）：{approval_ref!r}",
                       "用账本侧的批准 id（ap-NNNN）或人署名（human:<who>）重试")
    if resolution_sha256 is not None and not SHA256_RE.match(str(resolution_sha256)):
        return _reject(raw, block_id, to, approval_ref,
                       "resolution_sha256 必须是 sha256:<64hex>（凭据正文不得进事件载荷，只进哈希）",
                       "先对提交件求 sha256 再重试；凭据正文由 Python 侧单独安全处理")

    new_record = dict(current)
    new_record["state"] = to
    new_record["approval_ref"] = ref.strip()
    new_record["history"] = list(current.get("history") or []) + [
        {"from": source_state, "to": to, "approval_ref": ref.strip()}]
    # `records` 是**当前态视图**（每个 block_id 一条）：转移**替换**该条，位置不变。
    # 账本侧累积的是**事件**（`events`），当前态由账本重放得出 —— 两件事不混。
    new_records = [new_record if row["block_id"] == new_record["block_id"] else row for row in original]
    body = {"block_id": new_record["block_id"], "kind": new_record.get("kind"),
            "from": source_state, "to": to, "approval_ref": ref.strip()}
    if new_record.get("task"):
        body["task"] = new_record["task"]
    if resolution_sha256 is not None:
        body["resolution_sha256"] = str(resolution_sha256)
    event = {"type": TRANSITION_EVENTS[to], "body": body}
    if rejected_records:
        body["records_rejected"] = rejected_records   # 坏条目被跳过这件事必须可见（不静默）
    return {"ok": True, "block_id": new_record["block_id"], "from": source_state, "to": to,
            "approval_ref": ref.strip(), "added": [new_record], "records": new_records,
            "events": [event],
            "reason": f"合法转移 {source_state}→{to}（批准引用 {ref.strip()}）",
            "next_action": None}


__all__ = ["derive_blocks", "read_sources", "render", "apply_transition", "classify_kind",
           "allowed_transitions", "ALLOWED_TRANSITIONS", "TRANSITION_EVENTS", "STATES", "LIVE_STATES",
           "BLOCKED", "PENDING", "RESOLVED", "REJECTED", "EXPIRED", "SOURCES", "SOURCE_STATE",
           "SOURCE_CHECKLIST", "SOURCE_PIPELINE", "STATE_READ_KEYS", "BLOCKER_READ_KEYS",
           "CHECKLIST_STATUSES", "KINDS", "PLUGIN_KEYWORDS", "CREDENTIAL_KEYWORDS", "CALIBER",
           "DEFAULT_MAX_BLOCKS", "REASON_CLIP", "APPROVAL_REF_RE", "SHA256_RE", "AdminBlockError"]
