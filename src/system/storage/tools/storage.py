#!/usr/bin/env python3
"""存储（文件管理 + 极简键值表）—— **Python 侧唯一写入者**（标准库，零第三方依赖）。

契约：`docs/design/25-storage-plugins.md`；围栏门：`host/t277-storage-gate.mjs`；
规划来源：`docs/design/23-agent-runtime-and-storage-plugins.md` §1/§2/§3。

法则（每条都由门断言，不靠文档纪律）：

  · **唯一写入者**：存储的落盘只有本文件做。宿主侧（`host/`）零写面 ——
    `host/modules/storage-view.mjs` 只读聚合，不写文件、不起子进程、不写账本。
  · **不得成为第二条事实写路径**：存储只能放**非事实**内容（缓存 / 中间产物 / 索引 / 附件）。
    事实只进账本（Python 内核独占写入）。以下三类目标一律拒（`storage-fact-path`）：
    ① `--ledger` 声明的路径（含其子树）；② 仓库内 `tmp/ui-shared/**/ledger.jsonl`
    （以及任何名字叫 `ledger.jsonl` 的行）；③ `user-space/` 里**别人的 ns**。
    拒绝时磁盘**零变化**（门逐字节核对真账本目录）。
  · **租户隔离**：一个 ns 一个根 `<root>/<ns>/`（文件面 `<ns>/files/**`，数据库面 `<ns>/db/*.jsonl`）。
    跨租户（`storage-outside-ns`）、逃出根的 `..`/绝对路径/符号链（`storage-path-escape`）一律拒。
  · **有界**：单条 / 单次 / 单文件 / 单租户 / 条数都有声明上界（见 `limits` 子命令）。
    超界**拒绝**（`storage-limit-exceeded`）或**截断并报破条数**（`read_tail` 的
    `omitted`/`broken`/`clipped`；`broken_lines` 就是"破条数"）—— 绝不静默丢、绝不静默补零。
  · **确定性**：不读墙钟（时间由调用方 `--at` 传入；`modified` 来自文件系统元数据）、
    键与路径按码点稳定排序、UTF-8 全程显式（`encoding='utf-8'`，JSON `ensure_ascii=False`）。
  · **每条拒绝都有机器可读 `code` + `next_action`**（`codes` 子命令给出闭合集合与下一步表）。
  · **可用性不得伪装**：root 未配 / 不是目录 / 读不出来 → `storage-unavailable` + 有名 reason；
    "确实没有"（空租户 / 没这个键）与"读不到"必须可区分（前者 `ok:true` + 有名 reason）。

为什么写在 `tools/` 而不是 `src/`：存储是**工具面**（给宿主与运维用的一次性 CLI + 可 import 的
纯函数），不是业务事实层；事实层（账本/内核）与此零耦合 —— 本文件**不 import** `src/` 的任何东西。

用法：
    python3 tools/storage.py limits
    python3 tools/storage.py open-append --ns acme --rel logs/run.log --text 第一行 --text 第二行
    python3 tools/storage.py read-tail --ns acme --rel logs/run.log --limit 5
    python3 tools/storage.py list-files --ns acme
    python3 tools/storage.py stat --ns acme --rel logs/run.log
    python3 tools/storage.py put --ns acme --table kv --key k1 --value v1 [--at 2026-09-21T00:00:00Z]
    python3 tools/storage.py get --ns acme --table kv --key k1
    python3 tools/storage.py delete --ns acme --table kv --key k1
    python3 tools/storage.py scan --ns acme --table kv [--limit 20]
    python3 tools/storage.py snapshot [--ns acme]... [--out tmp/storage/snapshot.json]

输出：**一行** JSON（`{ok, code, reason, next_action, ...载荷}`）。退出码：0 成功 / 1 被拒 / 2 致命。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# --- 仓库位置（路径真源；门与契约文档同口径） --------------------------------
# 实体搬迁（迁移阶段 5，本批 `EV-178`）：`tools/` → `src/<层>/<插件>/tools/` ⇒ 仓库根由 4 层上溯
# 推出（`tools/` → 插件 → 层 → `src/` → 仓库根）；旧路径 `tools/storage.py` 只剩**薄转发**。
ROOT = Path(__file__).resolve().parents[4]
DEFAULT_ROOT = ROOT / "tmp" / "storage"
UI_SHARED = ROOT / "tmp" / "ui-shared"
USER_SPACE = ROOT / "user-space"
LEDGER_BASENAME = "ledger.jsonl"

# --- 声明上界（`limits` 子命令把它们吐出来；门按真值断言） --------------------
MAX_LINE_BYTES = 4096          # 单条日志行（UTF-8 字节，含换行）
MAX_APPEND_BYTES = 16384       # 单次 open_append 的批总量
MAX_FILE_BYTES = 1048576       # 单文件字节（append-only 日志；也是 read_tail 的读取上界）
MAX_PATH_DEPTH = 8             # ns 根以下的路径深度
MAX_TAIL_LINES = 200           # read_tail 的 limit 上界
MAX_VALUE_BYTES = 4096         # 单条 KV 值的 JSON 字节
MAX_ROW_BYTES = 5120           # 单条事件行（值 + 元数据）
MAX_KEY_BYTES = 256
MAX_KEYS_PER_TABLE = 4096
MAX_EVENTS_PER_TABLE = 20000   # 单表事件行上界（append-only 增长有界）
MAX_REPLAY_EVENTS = 20000      # 内存重放上界
MAX_TABLES = 32                # 单 ns 表数
MAX_SCAN_KEYS = 200            # scan 一次最多出多少键
MAX_LIST_ENTRIES = 200         # list_files 一次最多出多少条
MAX_SCAN_FILES = 4096          # 一次目录遍历最多看多少条（超出即报，不静默）
MAX_HASH_FILES = 8             # 一次最多算多少份 sha256（有界）
MAX_TENANT_BYTES = 8388608     # 单租户总字节
MAX_SNAPSHOT_TENANTS = 64      # 快照最多收多少租户
MAX_SNAPSHOT_SAMPLES = 3       # 每个租户最多几条样本

NS_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
TABLE_RE = NS_RE
# 键名：基础名（**不带冒号** —— 借别人 `cred:` 前缀的形状在这里就被挡掉）
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SQL_RE = re.compile(r"(?i)(\bselect\b|\binsert\b|\bupdate\b|\bdelete\s+from\b|\bdrop\b|\bcreate\s+table\b|--|;)")
DSN_RE = re.compile(r"(?i)^\s*[a-z][a-z0-9+.-]*://")
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# --- 拒绝码（闭合集合）与每条码的下一步（固定映射 → 输出确定） ----------------
CODES = ("storage-outside-ns", "storage-path-escape", "storage-fact-path", "storage-unbounded-read",
         "storage-limit-exceeded", "storage-unavailable", "storage-schema-refused")
NEXT_ACTIONS = {
    "storage-outside-ns": "只操作本租户（ns）的根：把目标改回 <root>/<ns>/ 里；跨租户读写一律拒",
    "storage-path-escape": "路径先解析再判定：不要用绝对路径、`..` 或符号链接逃出本租户根",
    "storage-fact-path": "事实只进账本（Python 内核独占写入）：把目标改到非事实区（缓存/中间产物/索引/附件）",
    "storage-unbounded-read": "读取必须给有界 limit（1..%d）：无界读取一律拒" % MAX_TAIL_LINES,
    "storage-limit-exceeded": "缩到 docs/design/25-storage-plugins.md §4/§5 声明的上界内；超界不得静默截断",
    "storage-unavailable": "存储当前不可用：核对 --root（默认 tmp/storage/）后重试；不得用\"看起来健康的空\"冒充可用",
    "storage-schema-refused": "只收声明式接口：表名/键名是基础名，不收 raw SQL 与连接串形状的入参",
}


def _envelope(ok: bool, code: str = "", reason: str = "", next_action: str = "", **payload):
    out = {"ok": bool(ok), "code": code, "reason": reason, "next_action": next_action}
    out.update(payload)
    return out


def _refuse(code: str, reason: str, **payload):
    """拒绝载荷：与成功载荷**同形**（ok/code/reason/next_action），调用方不必分支解析。"""
    out = {"ok": False, "code": code, "reason": reason, "next_action": NEXT_ACTIONS.get(code, "")}
    out.update(payload)
    return out


def _ok(**payload):
    out = {"ok": True, "code": "", "reason": "", "next_action": ""}
    out.update(payload)
    return out


def _posix(path) -> str:
    return str(path).replace("\\", "/")


def _inside(root: Path, target: Path) -> bool:
    root_s = str(root)
    target_s = str(target)
    if target_s == root_s:
        return True
    return target_s.startswith(root_s.rstrip(os.sep) + os.sep)


def _zone_forms(path) -> tuple:
    """一个路径的**两种形态**：词法（原样）与真实路径（跟随符号链接）。

    为什么要两种：`user-space` 是**指向 `src/userspace/` 的符号链接**（阶段 5.1 的单一事实源）
    ⇒ 词法形态（`<root>/user-space`）与真实形态（`<root>/src/userspace`）**指向同一片事实区**；
    只比一种形态会漏判。返回元组去重后保持顺序（真实 = 词法时只留一种，比较次数不变）。
    """
    lexical = Path(str(path))
    real = Path(os.path.realpath(str(lexical)))
    return (lexical, real) if real != lexical else (lexical,)


def _inside_zone(zone, target) -> bool:
    """目标是否落在**事实区** `zone` 里 —— 词法/真实两种形态**交叉各判一次**（任一命中即命中）。

    **收紧方向**（相对旧版只做一次词法比较，见 STORAGE-SYMLINK-FACT-ZONE）：
    旧版 `_inside(USER_SPACE, <realpath>)` 在 `user-space` 是符号链接时**恒假** ⇒ 事实区判据失效
    （实测：`--root user-space/<别人的 ns>` 与 `--root user-space/<本 ns>` 操作别人的 ns 都被放行）。
    本函数把"两种形态 × 两种形态"全判一遍 ⇒ 只可能**多**判成事实区，不可能少判。
    """
    for root in _zone_forms(zone):
        for item in _zone_forms(target):
            if _inside(root, item):
                return True
    return False


def _resolve_root(root):
    """`--root` 归一化：`None` = **没给**（用默认 `tmp/storage/`）；给了空串 = **未配**（见 `_root_path`）。"""
    if root is None:
        return DEFAULT_ROOT
    if isinstance(root, str) and root.strip() == "":
        return None
    return Path(os.path.abspath(str(root)))


def _stamp(seconds: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


def _ledger_set(ledgers) -> list:
    out = []
    for item in ledgers or ():
        if isinstance(item, (str, os.PathLike)) and str(item).strip() != "":
            path = Path(os.path.abspath(str(item)))
            out.append((path, Path(os.path.realpath(str(path)))))
    return out


# ---------------------------------------------------------------------------
# 判定：root / ns / 目标路径（顺序即优先级：事实路径 → 逃逸 → 跨租户 → 深度）
# ---------------------------------------------------------------------------
def _root_path(root, ns, ledgers):
    """解析并判定存储根：返回 `(root_path, refusal)`（`None` = 未配 / 事实区 / 不是目录）。"""
    rp = _resolve_root(root)
    if rp is None:
        return None, _refuse("storage-unavailable", "root-unconfigured", root=str(root))
    real = Path(os.path.realpath(str(rp)))
    if _inside(UI_SHARED, real) or _inside(UI_SHARED, rp):
        return None, _refuse("storage-fact-path", "root-inside-ledger-area", root=_posix(rp))
    for path, path_real in _ledger_set(ledgers):
        if _inside(path_real, real) or str(real) == str(path_real):
            return None, _refuse("storage-fact-path", "root-is-ledger-path", root=_posix(rp),
                                 ledger=_posix(path))
    if (USER_SPACE.exists() or USER_SPACE.parent.exists()) and _inside_zone(USER_SPACE, real):
        if not (isinstance(ns, str) and NS_RE.match(ns) and _inside_zone(USER_SPACE / ns, real)):
            return None, _refuse("storage-fact-path", "root-in-user-space-other-ns", root=_posix(rp),
                                 ns=ns)
    if rp.exists() and not rp.is_dir():
        return None, _refuse("storage-unavailable", "root-not-a-directory", root=_posix(rp))
    return rp, None


def _ns_refusal(ns):
    if not isinstance(ns, str) or not NS_RE.match(ns):
        return _refuse("storage-outside-ns", "namespace-invalid", ns=str(ns))
    return None


def _schema_refusal(name, value):
    """raw SQL / 连接串形状的入参一律拒（只暴露声明式接口）。"""
    text = str(value)
    if DSN_RE.match(text) or SQL_RE.search(text):
        return _refuse("storage-schema-refused", "raw-sql-or-dsn-shape", field=name)
    return None


def _target(root_path: Path, ns: str, rel, ledgers):
    """解析目标路径（相对 ns 根）。返回 `(path, refusal)`；判定顺序见文件头与契约文档 §2。"""
    if not isinstance(rel, str) or rel.strip() == "":
        return None, _refuse("storage-path-escape", "rel-empty", ns=ns, rel=str(rel))
    if "\x00" in rel:
        return None, _refuse("storage-path-escape", "rel-has-nul", ns=ns)
    raw = rel.replace("\\", "/")
    parts = [item for item in raw.split("/") if item not in ("", ".")]
    ns_root = root_path / ns
    # ① 事实路径：先判（否则真原因会被"逃逸"掩盖）
    if any(item == LEDGER_BASENAME for item in parts):
        return None, _refuse("storage-fact-path", "ledger-name-reserved", ns=ns, rel=rel)
    candidate = Path(raw) if os.path.isabs(raw) else ns_root / raw
    candidate = Path(os.path.normpath(str(candidate)))
    cand_real = Path(os.path.realpath(str(candidate)))
    for path, path_real in _ledger_set(ledgers):
        if _inside(path, candidate) or _inside(path_real, cand_real) or str(candidate) == str(path):
            return None, _refuse("storage-fact-path", "ledger-path-refused", ns=ns, rel=rel,
                                 ledger=_posix(path))
    if _inside_zone(UI_SHARED, candidate) or _inside_zone(UI_SHARED, cand_real):
        return None, _refuse("storage-fact-path", "inside-ledger-area", ns=ns, rel=rel)
    if (USER_SPACE.exists() or USER_SPACE.parent.exists()) and _inside_zone(USER_SPACE, cand_real) \
            and not _inside_zone(USER_SPACE / ns, cand_real):
        return None, _refuse("storage-fact-path", "user-space-other-ns", ns=ns, rel=rel)
    # ② 绝对路径一律拒
    if os.path.isabs(raw):
        return None, _refuse("storage-path-escape", "absolute-path-refused", ns=ns, rel=rel)
    # ③ `..` 一律拒（即使解析后仍在本 ns 根里：严于"恰好没逃出去"）
    if ".." in parts:
        if _inside(root_path, candidate) and not _inside(ns_root, candidate):
            return None, _refuse("storage-outside-ns", "cross-ns-path", ns=ns, rel=rel)
        if _inside(ns_root, candidate):
            return None, _refuse("storage-path-escape", "dotdot-component", ns=ns, rel=rel)
        return None, _refuse("storage-path-escape", "escapes-storage-root", ns=ns, rel=rel)
    # ④ 容器判定：词法 + 真实路径（符号链越界在这里被摊平）；在存储根里但不在本 ns 根里 = 跨租户
    ns_real = Path(os.path.realpath(str(ns_root)))
    if not _inside(ns_root, candidate):
        if _inside(root_path, candidate):
            return None, _refuse("storage-outside-ns", "cross-ns-path", ns=ns, rel=rel)
        return None, _refuse("storage-path-escape", "escapes-storage-root", ns=ns, rel=rel)
    if not _inside(ns_real, cand_real):
        return None, _refuse("storage-path-escape", "symlink-escapes-ns-root", ns=ns, rel=rel)
    # ⑤ 深度上界
    depth = len(candidate.relative_to(ns_root).parts)
    if depth > MAX_PATH_DEPTH:
        return None, _refuse("storage-limit-exceeded", "path-depth-cap", ns=ns, rel=rel,
                             depth=depth, limit=MAX_PATH_DEPTH)
    return candidate, None


def _prepare(ns, rel, root, ledgers):
    """公共前段：ns → root → 目标路径。"""
    refusal = _ns_refusal(ns)
    if refusal:
        return None, None, refusal
    rp, refusal = _root_path(root, ns, ledgers)
    if refusal:
        return None, None, refusal
    path, refusal = _target(rp, ns, rel, ledgers)
    if refusal:
        return None, None, refusal
    return rp, path, None


def _table_rel(table):
    return "db/%s.jsonl" % table


def _table_refusal(table):
    if not isinstance(table, str) or not TABLE_RE.match(table):
        return _refuse("storage-schema-refused", "table-invalid", table=str(table))
    return _schema_refusal("table", table)


def _key_refusal(key):
    if not isinstance(key, str) or not KEY_RE.match(key):
        return _refuse("storage-schema-refused", "key-invalid", key=str(key))
    return _schema_refusal("key", key)


def _tree_bytes(root: Path, limit: int = MAX_SCAN_FILES * 4):
    """有界遍历（**不跟随越界符号链**）：返回 `(bytes, entries, capped)`。"""
    total = 0
    entries = 0
    capped = False
    real_root = Path(os.path.realpath(str(root)))
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            names = sorted(os.listdir(str(current)))
        except OSError:
            continue
        for name in names:
            path = current / name
            entries += 1
            if entries > limit:
                return total, entries, True
            try:
                if not _inside(real_root, Path(os.path.realpath(str(path)))):
                    continue
                if path.is_dir():
                    stack.append(path)
                else:
                    total += path.stat().st_size
            except OSError:
                continue
    return total, entries, capped


# ---------------------------------------------------------------------------
# 文件管理面
# ---------------------------------------------------------------------------
def _line_payloads(ns, rel, texts):
    """把待写文本过一遍上界（**一行一条**；写前判定 → 一行都不写就拒）。返回 `(payloads, refusal)`。"""
    if not isinstance(texts, (list, tuple)):
        texts = [texts]
    payloads = []
    for index, text in enumerate(texts):
        if not isinstance(text, str):
            return None, _refuse("storage-schema-refused", "append-text-not-a-string", ns=ns, rel=rel,
                                 index=index)
        if "\x00" in text:
            return None, _refuse("storage-schema-refused", "append-text-has-nul", ns=ns, rel=rel, index=index)
        if "\n" in text or "\r" in text:
            return None, _refuse("storage-schema-refused", "append-text-has-newline", ns=ns, rel=rel,
                                 index=index)
        payload = (text + "\n").encode("utf-8")
        if len(payload) > MAX_LINE_BYTES:
            return None, _refuse("storage-limit-exceeded", "line-too-large", ns=ns, rel=rel, index=index,
                                 bytes=len(payload), limit=MAX_LINE_BYTES)
        payloads.append(payload)
    return payloads, None


def open_append(ns, rel, texts=(), *, root=None, ledgers=(), at=""):
    """打开（必要时创建）本租户的 append-only 日志，可选追加若干行。

    每行 = **一次 `os.write` + `O_APPEND`**（行级原子，不劈行、不重写历史），随后 `fsync`。
    上界全部写前判定：任何一行超界 → **整批拒**（一行都不写）。
    """
    rp, path, refusal = _prepare(ns, rel, root, ledgers)
    if refusal:
        return refusal
    payloads, refusal = _line_payloads(ns, rel, texts)
    if refusal:
        return refusal
    total = sum(len(item) for item in payloads)
    if total > MAX_APPEND_BYTES:
        return _refuse("storage-limit-exceeded", "append-batch-too-large", ns=ns, rel=rel,
                       bytes=total, limit=MAX_APPEND_BYTES)
    before = 0
    if path.exists():
        if not path.is_file():
            return _refuse("storage-unavailable", "path-not-a-file", ns=ns, rel=rel, path=_posix(path))
        before = path.stat().st_size
    if before + total > MAX_FILE_BYTES:
        return _refuse("storage-limit-exceeded", "file-byte-cap", ns=ns, rel=rel,
                       bytes=before + total, limit=MAX_FILE_BYTES)
    tenant_bytes, _, _ = _tree_bytes(rp / ns)
    if tenant_bytes + total > MAX_TENANT_BYTES:
        return _refuse("storage-limit-exceeded", "namespace-byte-cap", ns=ns,
                       bytes=tenant_bytes + total, limit=MAX_TENANT_BYTES)
    written = 0
    error = None
    if payloads:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        except OSError as exc:
            return _refuse("storage-unavailable", "open-failed", ns=ns, rel=rel, path=_posix(path),
                           detail=str(exc)[:120])
        try:
            for payload in payloads:
                count = os.write(fd, payload)
                if count != len(payload):
                    error = "short-write"
                    break
                written += count
            os.fsync(fd)
        except OSError as exc:
            error = "write-failed"
            detail = str(exc)[:120]
        finally:
            os.close(fd)
        if error:
            return _refuse("storage-unavailable", error, ns=ns, rel=rel, path=_posix(path),
                           bytes_written=written, torn_tail=True,
                           detail=locals().get("detail", ""))
    return _ok(ns=ns, rel=rel, path=_posix(path), lines=len(payloads), bytes_written=written,
               file_bytes=path.stat().st_size if path.exists() else 0, limit_bytes=MAX_FILE_BYTES,
               at=at, atomic_line_write=True, ledger_written=False)


def read_tail(ns, rel, limit=None, *, root=None, ledgers=(), max_line_bytes=MAX_LINE_BYTES):
    """读本租户日志的**尾部有界窗口**（必须给 limit；无界读取一律拒）。

    诚实计数（**截断必报**）：`omitted`（窗口外被丢的行数）、`broken`（破条数：半写行 + 非法 UTF-8 行）、
    `clipped`（被夹到 `max_line_bytes` 的行数，而每行的 `bytes` 仍是原文真值）。
    缺席文件 = `ok:true` + `exists:false`（"确实没有"），读不出来 = `storage-unavailable`（"读不到"）。
    """
    if limit is None or isinstance(limit, bool):
        return _refuse("storage-unbounded-read", "limit-missing", ns=ns, rel=rel, limit=limit)
    if not isinstance(limit, int):
        try:
            limit = int(str(limit).strip())
        except (TypeError, ValueError):
            return _refuse("storage-unbounded-read", "limit-not-an-integer", ns=ns, rel=rel, limit=limit)
    if limit <= 0:
        return _refuse("storage-unbounded-read", "limit-not-positive", ns=ns, rel=rel, limit=limit)
    if limit > MAX_TAIL_LINES:
        return _refuse("storage-limit-exceeded", "limit-over-cap", ns=ns, rel=rel, limit=limit,
                       cap=MAX_TAIL_LINES)
    if isinstance(max_line_bytes, bool) or not isinstance(max_line_bytes, int) \
            or max_line_bytes <= 0 or max_line_bytes > MAX_LINE_BYTES:
        return _refuse("storage-limit-exceeded", "max-line-bytes-out-of-range", ns=ns, rel=rel,
                       max_line_bytes=max_line_bytes, limit=MAX_LINE_BYTES)
    rp, path, refusal = _prepare(ns, rel, root, ledgers)
    if refusal:
        return refusal
    if not path.exists():
        return _ok(ns=ns, rel=rel, path=_posix(path), exists=False, limit=limit, lines=[],
                   counts={"lines_seen": 0, "lines_ok": 0, "lines_returned": 0, "lines_omitted": 0,
                           "broken_lines": 0, "invalid_utf8_lines": 0, "clipped_lines": 0,
                           "bytes_total": 0, "bytes_returned": 0},
                   truncated=False, omitted=0, broken=0, clipped=0, degraded=False,
                   reason="file-absent", next_action="", at="")
    if not path.is_file():
        return _refuse("storage-unavailable", "path-not-a-file", ns=ns, rel=rel, path=_posix(path))
    size = path.stat().st_size
    if size > MAX_FILE_BYTES:
        return _refuse("storage-limit-exceeded", "file-over-read-cap", ns=ns, rel=rel,
                       bytes=size, limit=MAX_FILE_BYTES)
    try:
        data = path.read_bytes()
    except OSError as exc:
        return _refuse("storage-unavailable", "file-unreadable", ns=ns, rel=rel, path=_posix(path),
                       detail=str(exc)[:120])
    torn = bool(data) and not data.endswith(b"\n")
    rows = data.split(b"\n")
    if rows and rows[-1] == b"":
        rows.pop()
    broken = 0
    invalid = 0
    torn_tail = False
    decoded = []
    for index, raw in enumerate(rows):
        if torn and index == len(rows) - 1:
            broken += 1
            torn_tail = True
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            broken += 1
            invalid += 1
            continue
        decoded.append((index + 1, raw, text))
    window = decoded[-limit:]
    omitted = len(decoded) - len(window)
    clipped = 0
    lines = []
    for number, raw, text in window:
        out = text
        if len(raw) > max_line_bytes:
            clipped += 1
            out = _clip(text, max_line_bytes)
        lines.append({"n": number, "bytes": len(raw), "clipped": out != text, "text": out})
    degraded = broken > 0
    reason = "log-torn-tail" if torn_tail else ("log-broken-lines" if broken else "")
    if reason == "log-torn-tail" and invalid:
        reason = "log-torn-and-invalid"
    return _ok(ns=ns, rel=rel, path=_posix(path), exists=True, limit=limit, lines=lines,
               counts={"lines_seen": len(rows), "lines_ok": len(decoded), "lines_returned": len(window),
                       "lines_omitted": omitted, "broken_lines": broken, "invalid_utf8_lines": invalid,
                       "clipped_lines": clipped, "bytes_total": len(data),
                       "bytes_returned": sum(len(item[1]) for item in window)},
               truncated=bool(omitted or clipped or broken), omitted=omitted, broken=broken,
               clipped=clipped, torn_tail=torn_tail, degraded=degraded, reason=reason,
               next_action=("日志有残缺行（半写 / 非法 UTF-8）：核对写入方后重建该日志，"
                            "本工具不会静默跳过" if degraded else ""),
               at="")


def _clip(text, max_bytes):
    """按 UTF-8 字节夹取（整码点步进：不劈开多字节字符）。"""
    if len(text.encode("utf-8")) <= max_bytes:
        return text
    out = []
    used = 0
    for char in text:
        size = len(char.encode("utf-8"))
        if used + size > max_bytes:
            break
        out.append(char)
        used += size
    return "".join(out)


def _file_info(path: Path, rel: str, hash_budget: list):
    size = None
    try:
        stat = path.stat()
        size = stat.st_size
        modified = _stamp(stat.st_mtime)
    except OSError:
        return {"rel": rel, "bytes": None, "lines": None, "modified": "", "sha256": None,
                "over_read_cap": False, "unreadable": True}
    info = {"rel": rel, "bytes": size, "lines": None, "modified": modified, "sha256": None,
            "over_read_cap": size > MAX_FILE_BYTES, "unreadable": False}
    if size <= MAX_FILE_BYTES:
        try:
            data = path.read_bytes()
        except OSError:
            info["unreadable"] = True
            return info
        info["lines"] = data.count(b"\n")
        info["torn_tail"] = bool(data) and not data.endswith(b"\n")
        if hash_budget[0] > 0:
            info["sha256"] = hashlib.sha256(data).hexdigest()
            hash_budget[0] -= 1
    return info


def _walk_ns(ns_root: Path):
    """ns 根下的文件（稳定排序、有界、**不跟随越界符号链**）。

    返回 `(rel_paths, escaped, capped)`：`escaped` 是指向 ns 根之外的符号链（只报名字、**不读内容**）。
    """
    out = []
    escaped = []
    capped = False
    ns_real = Path(os.path.realpath(str(ns_root)))
    stack = [ns_root]
    while stack:
        current = stack.pop()
        try:
            names = sorted(os.listdir(str(current)))
        except OSError:
            continue
        for name in names:
            path = current / name
            if len(out) >= MAX_SCAN_FILES:
                capped = True
                break
            try:
                real = Path(os.path.realpath(str(path)))
            except OSError:
                continue
            if not _inside(ns_real, real):
                escaped.append(_posix(path.relative_to(ns_root)))     # 越界符号链：只报，不读
                continue
            try:
                if path.is_dir():
                    stack.append(path)
                elif path.is_file():
                    out.append(path)
            except OSError:
                continue
        if capped:
            break
    return sorted(out, key=lambda item: _posix(item)), sorted(escaped), capped


def list_files(ns, *, root=None, ledgers=(), max_entries=MAX_LIST_ENTRIES):
    """列出本租户的文件（条数有界、稳定排序、含每文件 sha256 有预算）。

    空租户 = `ok:true` + `reason='namespace-empty'`（"确实没有"），读不出来 = `storage-unavailable`。
    """
    refusal = _ns_refusal(ns)
    if refusal:
        return refusal
    rp, refusal = _root_path(root, ns, ledgers)
    if refusal:
        return refusal
    ns_root = rp / ns
    if not ns_root.exists():
        return _ok(ns=ns, files=[], counts={"files": 0, "bytes": 0, "tables": 0, "hashed": 0,
                                           "unreadable": 0, "escaped": 0},
                   escaped_symlinks=[],
                   truncated=False, omitted=0, clipped=0, counts_exact=True, degraded=False,
                   reason="namespace-empty",
                   next_action="本租户还没有任何文件：先 open-append 或 put（存储不会凭空造租户）")
    if not ns_root.is_dir():
        return _refuse("storage-unavailable", "namespace-not-a-directory", ns=ns, path=_posix(ns_root))
    paths, escaped, capped = _walk_ns(ns_root)
    if capped:
        return _refuse("storage-limit-exceeded", "namespace-over-scan-cap", ns=ns,
                       scanned=MAX_SCAN_FILES, limit=MAX_SCAN_FILES)
    budget = [MAX_HASH_FILES]
    files = []
    total_bytes = 0
    tables = 0
    unreadable = 0
    for path in paths:
        rel = _posix(path.relative_to(ns_root))
        info = _file_info(path, rel, budget)
        if info.get("unreadable"):
            unreadable += 1
        if isinstance(info.get("bytes"), int):
            total_bytes += info["bytes"]
        if rel.startswith("db/") and rel.endswith(".jsonl"):
            tables += 1
        files.append(info)
    shown = files[:max(0, int(max_entries))]
    omitted = len(files) - len(shown)
    degraded = unreadable > 0 or len(escaped) > 0
    reason = "files-unreadable" if unreadable else ("symlinks-escaped-ns-root" if escaped else "")
    return _ok(ns=ns, files=shown, escaped_symlinks=escaped[:MAX_LIST_ENTRIES],
               counts={"files": len(files), "bytes": total_bytes, "tables": tables,
                       "hashed": min(MAX_HASH_FILES, len(files)), "unreadable": unreadable,
                       "escaped": len(escaped)},
               truncated=omitted > 0 or len(escaped) > MAX_LIST_ENTRIES, omitted=omitted, clipped=0,
               counts_exact=True, root_bytes=_tree_bytes(ns_root)[0], degraded=degraded,
               reason=reason,
               next_action=("有文件读不出来：先核对权限/内容，本工具不把它算成空" if unreadable
                            else ("本租户里有指向根外的符号链（已只报名、不读内容）："
                                  "要么删掉它，要么把数据搬进本租户根" if escaped else "")))


def stat(ns, rel, *, root=None, ledgers=()):
    """报一个目标的状态（**不写**）：缺席 = `ok:true` + `exists:false`。"""
    rp, path, refusal = _prepare(ns, rel, root, ledgers)
    if refusal:
        return refusal
    if not path.exists():
        return _ok(ns=ns, rel=rel, path=_posix(path), exists=False, kind="missing",
                   reason="path-absent", next_action="先写一次（open-append / put）再 stat")
    if path.is_dir():
        try:
            names = sorted(os.listdir(str(path)))
        except OSError as exc:
            return _refuse("storage-unavailable", "dir-unreadable", ns=ns, rel=rel, path=_posix(path),
                           detail=str(exc)[:120])
        return _ok(ns=ns, rel=rel, path=_posix(path), exists=True, kind="dir", entries=len(names),
                   listing=names[:MAX_LIST_ENTRIES], truncated=len(names) > MAX_LIST_ENTRIES,
                   reason="", next_action="")
    budget = [MAX_HASH_FILES]
    info = _file_info(path, rel, budget)
    return _ok(ns=ns, rel=rel, path=_posix(path), exists=True, kind="file", bytes=info["bytes"],
               lines=info["lines"], modified=info["modified"], sha256=info["sha256"],
               over_read_cap=info["over_read_cap"], reason="", next_action="")


# ---------------------------------------------------------------------------
# 数据库面：极简键值表（底层 JSONL：append-only 事件 + 内存重放成当前值）
# ---------------------------------------------------------------------------
def _replay(path: Path):
    """把 append-only 事件行重放成当前值。返回 `(state, refusal)`。

    `state = {values: {key: (value, version)}, rows, revision, broken_rows, torn_tail, at}`。
    半写行（无换行的尾行）与非法行**不应用**并计入 `broken_rows`（破行数必须报出来）。
    """
    state = {"values": {}, "rows": 0, "revision": 0, "broken_rows": 0, "torn_tail": False, "at": ""}
    if not path.exists():
        return state, None
    if not path.is_file():
        return None, _refuse("storage-unavailable", "table-path-not-a-file", table=_posix(path))
    data = path.read_bytes()
    if len(data) > MAX_EVENTS_PER_TABLE * MAX_ROW_BYTES:
        return None, _refuse("storage-limit-exceeded", "table-over-read-cap", bytes=len(data),
                             limit=MAX_EVENTS_PER_TABLE * MAX_ROW_BYTES)
    torn = bool(data) and not data.endswith(b"\n")
    rows = data.split(b"\n")
    if rows and rows[-1] == b"":
        rows.pop()
    for index, raw in enumerate(rows):
        if torn and index == len(rows) - 1:
            state["broken_rows"] += 1
            state["torn_tail"] = True
            continue
        if index >= MAX_REPLAY_EVENTS:
            return None, _refuse("storage-limit-exceeded", "replay-cap", rows=len(rows),
                                 limit=MAX_REPLAY_EVENTS)
        try:
            text = raw.decode("utf-8")
            event = json.loads(text)
        except (UnicodeDecodeError, ValueError):
            state["broken_rows"] += 1
            continue
        if not isinstance(event, dict) or event.get("op") not in ("put", "delete") \
                or not isinstance(event.get("key"), str):
            state["broken_rows"] += 1
            continue
        state["revision"] = int(event.get("seq", state["revision"] + 1))
        if event["op"] == "put":
            state["values"][event["key"]] = (event.get("value"), int(event.get("version", 1)))
        else:
            state["values"].pop(event["key"], None)
        state["at"] = event.get("at", state["at"])
    state["rows"] = len(rows)
    return state, None


def _table_file(rp: Path, ns: str, table: str):
    return rp / ns / "db" / ("%s.jsonl" % table)


def _table_count(rp: Path, ns: str) -> int:
    db_dir = rp / ns / "db"
    try:
        return len([item for item in os.listdir(str(db_dir)) if item.endswith(".jsonl")])
    except OSError:
        return 0


def _value_bytes(value) -> int:
    try:
        return len(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8"))
    except (TypeError, ValueError):
        return -1


def put(ns, table, key, value, *, root=None, ledgers=(), at=""):
    """写入一条键值（append-only 事件行；版本号 = 该键的写入次数）。"""
    refusal = _ns_refusal(ns) or _table_refusal(table) or _key_refusal(key)
    if refusal:
        return refusal
    rp, path, refusal = _prepare(ns, _table_rel(table), root, ledgers)
    if refusal:
        return refusal
    size = _value_bytes(value)
    if size < 0:
        return _refuse("storage-schema-refused", "value-not-json-serializable", ns=ns, table=table, key=key)
    if size > MAX_VALUE_BYTES:
        return _refuse("storage-limit-exceeded", "value-too-large", ns=ns, table=table, key=key,
                       bytes=size, limit=MAX_VALUE_BYTES)
    row = {"seq": 0, "op": "put", "key": key, "value": value, "version": 0, "at": at}
    state, refusal = _replay(path)
    if refusal:
        return refusal
    if state["torn_tail"]:
        return _refuse("storage-unavailable", "event-log-torn", ns=ns, table=table, key=key,
                       broken_rows=state["broken_rows"])
    if state["rows"] >= MAX_EVENTS_PER_TABLE:
        return _refuse("storage-limit-exceeded", "table-event-cap", ns=ns, table=table,
                       rows=state["rows"], limit=MAX_EVENTS_PER_TABLE)
    if key not in state["values"] and len(state["values"]) >= MAX_KEYS_PER_TABLE:
        return _refuse("storage-limit-exceeded", "table-key-cap", ns=ns, table=table,
                       keys=len(state["values"]), limit=MAX_KEYS_PER_TABLE)
    if not path.exists() and _table_count(rp, ns) >= MAX_TABLES:
        return _refuse("storage-limit-exceeded", "table-cap", ns=ns, tables=_table_count(rp, ns),
                       limit=MAX_TABLES)
    version = (state["values"][key][1] + 1) if key in state["values"] else 1
    row["seq"] = state["rows"] + 1
    row["version"] = version
    payload = (json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    if len(payload) > MAX_ROW_BYTES:
        return _refuse("storage-limit-exceeded", "row-too-large", ns=ns, table=table, key=key,
                       bytes=len(payload), limit=MAX_ROW_BYTES)
    tenant_bytes, _, _ = _tree_bytes(rp / ns)
    if tenant_bytes + len(payload) > MAX_TENANT_BYTES:
        return _refuse("storage-limit-exceeded", "namespace-byte-cap", ns=ns,
                       bytes=tenant_bytes + len(payload), limit=MAX_TENANT_BYTES)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    except OSError as exc:
        return _refuse("storage-unavailable", "open-failed", ns=ns, table=table, path=_posix(path),
                       detail=str(exc)[:120])
    written = 0
    error = None
    try:
        written = os.write(fd, payload)
        os.fsync(fd)
    except OSError as exc:
        error = "write-failed"
        detail = str(exc)[:120]
    finally:
        os.close(fd)
    if error or written != len(payload):
        return _refuse("storage-unavailable", error or "short-write", ns=ns, table=table, key=key,
                       path=_posix(path), bytes_written=written, torn_tail=True,
                       detail=locals().get("detail", ""))
    return _ok(ns=ns, table=table, key=key, version=version, seq=row["seq"], revision=row["seq"],
               value_bytes=size, bytes_written=written, at=at, ledger_written=False)


def delete(ns, table, key, *, root=None, ledgers=(), at=""):
    """删除一个键：写**墓碑事件**（append-only，不销毁任何历史行）；键不在 → 不写、如实报。"""
    refusal = _ns_refusal(ns) or _table_refusal(table) or _key_refusal(key)
    if refusal:
        return refusal
    rp, path, refusal = _prepare(ns, _table_rel(table), root, ledgers)
    if refusal:
        return refusal
    state, refusal = _replay(path)
    if refusal:
        return refusal
    if state["torn_tail"]:
        return _refuse("storage-unavailable", "event-log-torn", ns=ns, table=table, key=key,
                       broken_rows=state["broken_rows"])
    if key not in state["values"]:
        return _ok(ns=ns, table=table, key=key, deleted=False, tombstone_written=False,
                   version=0, seq=0, revision=state["revision"], reason="key-not-found",
                   next_action="先 put 一次再 delete（缺键不写墓碑，避免无意义的增长）")
    if state["rows"] >= MAX_EVENTS_PER_TABLE:
        return _refuse("storage-limit-exceeded", "table-event-cap", ns=ns, table=table,
                       rows=state["rows"], limit=MAX_EVENTS_PER_TABLE)
    version = state["values"][key][1] + 1
    row = {"seq": state["rows"] + 1, "op": "delete", "key": key, "version": version, "at": at}
    payload = (json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    except OSError as exc:
        return _refuse("storage-unavailable", "open-failed", ns=ns, table=table, path=_posix(path),
                       detail=str(exc)[:120])
    written = 0
    error = None
    try:
        written = os.write(fd, payload)
        os.fsync(fd)
    except OSError as exc:
        error = "write-failed"
        detail = str(exc)[:120]
    finally:
        os.close(fd)
    if error or written != len(payload):
        return _refuse("storage-unavailable", error or "short-write", ns=ns, table=table, key=key,
                       path=_posix(path), bytes_written=written, detail=locals().get("detail", ""))
    return _ok(ns=ns, table=table, key=key, deleted=True, tombstone_written=True, version=version,
               seq=row["seq"], revision=row["seq"], at=at, ledger_written=False)


def get(ns, table, key, *, root=None, ledgers=()):
    """读一个键的当前值（内存重放）。键不在 = `ok:true` + `found:false`（"确实没有"）。"""
    refusal = _ns_refusal(ns) or _table_refusal(table) or _key_refusal(key)
    if refusal:
        return refusal
    rp, path, refusal = _prepare(ns, _table_rel(table), root, ledgers)
    if refusal:
        return refusal
    state, refusal = _replay(path)
    if refusal:
        return refusal
    if key not in state["values"]:
        return _ok(ns=ns, table=table, key=key, found=False, value=None, version=0,
                   revision=state["revision"], broken_rows=state["broken_rows"],
                   degraded=state["broken_rows"] > 0, reason="key-not-found",
                   next_action="先 put 一次再 get（本表没有这个键，与『读不到』不同）")
    value, version = state["values"][key]
    return _ok(ns=ns, table=table, key=key, found=True, value=value, version=version,
               value_bytes=_value_bytes(value), revision=state["revision"],
               broken_rows=state["broken_rows"], degraded=state["broken_rows"] > 0,
               reason="event-log-broken-rows" if state["broken_rows"] else "",
               next_action=("事件日志有破行（已跳过、未应用）：核对写入方后重建" if state["broken_rows"]
                            else ""))


def scan(ns, table, limit=MAX_SCAN_KEYS, *, root=None, ledgers=()):
    """扫一个表的键（**只出键名/版本/字节数，不出值正文**；条数有界、截断报数）。"""
    refusal = _ns_refusal(ns) or _table_refusal(table)
    if refusal:
        return refusal
    if isinstance(limit, bool) or not isinstance(limit, int):
        try:
            limit = int(str(limit).strip())
        except (TypeError, ValueError):
            return _refuse("storage-unbounded-read", "limit-not-an-integer", ns=ns, table=table, limit=limit)
    if limit <= 0:
        return _refuse("storage-unbounded-read", "limit-not-positive", ns=ns, table=table, limit=limit)
    if limit > MAX_SCAN_KEYS:
        return _refuse("storage-limit-exceeded", "limit-over-cap", ns=ns, table=table, limit=limit,
                       cap=MAX_SCAN_KEYS)
    rp, path, refusal = _prepare(ns, _table_rel(table), root, ledgers)
    if refusal:
        return refusal
    state, refusal = _replay(path)
    if refusal:
        return refusal
    keys = []
    for key in sorted(state["values"]):
        value, version = state["values"][key]
        keys.append({"key": key, "version": version, "value_bytes": _value_bytes(value)})
    shown = keys[:limit]
    omitted = len(keys) - len(shown)
    return _ok(ns=ns, table=table, keys=shown,
               counts={"keys": len(keys), "rows": state["rows"], "revision": state["revision"],
                       "broken_rows": state["broken_rows"]},
               truncated=omitted > 0, omitted=omitted, degraded=state["broken_rows"] > 0,
               reason="event-log-broken-rows" if state["broken_rows"] else "",
               next_action=("事件日志有破行（已跳过、未应用）：核对写入方后重建"
                            if state["broken_rows"] else ""), values_included=False)


# ---------------------------------------------------------------------------
# 只读快照（给宿主侧 `storage-view` 聚合；派生副本，丢了可重建）
# ---------------------------------------------------------------------------
def _tenant_entry(rp: Path, ns: str):
    ns_root = rp / ns
    if not ns_root.exists():
        return {"ns": ns, "files": 0, "file_bytes": 0, "tables": 0, "keys": 0, "last_write": "",
                "file_samples": [], "table_samples": [], "escaped_symlinks": [], "broken_rows": 0,
                "unreadable": False, "reason": "namespace-empty"}
    if not ns_root.is_dir():
        return {"ns": ns, "files": 0, "file_bytes": 0, "tables": 0, "keys": 0, "last_write": "",
                "file_samples": [], "table_samples": [], "escaped_symlinks": [], "broken_rows": 0,
                "unreadable": True, "reason": "namespace-not-a-directory"}
    listing = list_files(ns, root=str(rp))
    if not listing.get("ok"):
        return {"ns": ns, "files": 0, "file_bytes": 0, "tables": 0, "keys": 0, "last_write": "",
                "file_samples": [], "table_samples": [], "escaped_symlinks": [], "broken_rows": 0,
                "unreadable": True, "reason": listing.get("reason", "namespace-unreadable")}
    entries = listing["files"]
    last = ""
    for item in entries:
        if item.get("modified", "") > last:
            last = item["modified"]
    tables = []
    keys = 0
    broken = 0
    for item in entries:
        if not item["rel"].startswith("db/") or not item["rel"].endswith(".jsonl"):
            continue
        state, refusal = _replay(ns_root / item["rel"])
        if refusal:
            broken += 1
            continue
        keys += len(state["values"])
        broken += state["broken_rows"]
        tables.append({"table": Path(item["rel"]).stem, "keys": len(state["values"]),
                       "rows": state["rows"], "value_bytes": sum(
                           _value_bytes(value) for value, _ in state["values"].values()),
                       "last_event_at": state["at"], "modified": item.get("modified", "")})
    tables.sort(key=lambda item: item["table"])
    escaped = listing.get("escaped_symlinks", [])
    return {"ns": ns, "files": len(entries), "file_bytes": listing["counts"]["bytes"],
            "tables": len(tables), "keys": keys, "last_write": last,
            "file_samples": entries[:MAX_SNAPSHOT_SAMPLES],
            "table_samples": tables[:MAX_SNAPSHOT_SAMPLES],
            "escaped_symlinks": escaped[:MAX_SNAPSHOT_SAMPLES], "escaped": len(escaped),
            "broken_rows": broken, "unreadable": False, "reason": "", "listing_exact": True}


def snapshot(ns_list=None, *, root=None, ledgers=(), out=None, at="", max_tenants=MAX_SNAPSHOT_TENANTS):
    """把存储的**只读统计**写成一份快照（派生副本；宿主侧只读它，不读存储目录）。

    `out` 默认 `<root>/snapshot.json`；写入用临时文件 + rename（原子）。`--at` 由调用方给
    （本工具不读墙钟；`modified`/`last_write` 来自文件系统元数据）。
    """
    rp, refusal = _root_path(root, None, ledgers)
    if refusal:
        return refusal
    names = None
    if ns_list:
        names = []
        for ns in ns_list:
            r = _ns_refusal(ns)
            if r:
                return r
            names.append(ns)
        names = sorted(set(names))
    else:
        if rp.exists() and not rp.is_dir():
            return _refuse("storage-unavailable", "root-not-a-directory", root=_posix(rp))
        try:
            names = sorted([item for item in os.listdir(str(rp))
                            if NS_RE.match(item) and (rp / item).is_dir()])
        except OSError:
            names = []
    omitted = max(0, len(names) - max(0, int(max_tenants)))
    tenants = [_tenant_entry(rp, ns) for ns in names[:max(0, int(max_tenants))]]
    counts = {"tenants": len(names), "files": sum(item["files"] for item in tenants),
              "file_bytes": sum(item["file_bytes"] for item in tenants),
              "tables": sum(item["tables"] for item in tenants),
              "keys": sum(item["keys"] for item in tenants)}
    unreadable = [item["ns"] for item in tenants if item["unreadable"]]
    broken = sum(item.get("broken_rows", 0) for item in tenants)
    escaped = sum(item.get("escaped", 0) for item in tenants)
    payload = _ok(source="tools/storage.py", generated_at=at, root=_posix(rp), tenants=tenants,
                  counts=counts, limits=limits_table(), truncated=omitted > 0, omitted_tenants=omitted,
                  clipped=0, degraded=bool(unreadable or broken or escaped),
                  reason=("some-tenants-unreadable" if unreadable
                          else ("escaped-symlinks-present" if escaped
                                else ("event-log-broken-rows" if broken else ""))),
                  next_action=("有租户读不出来、有越界符号链或有破行：先核对"
                               "（本工具不会把它当成空租户）" if (unreadable or broken or escaped)
                               else ""),
                  unreadable_tenants=unreadable, broken_rows=broken, escaped_symlinks=escaped,
                  deterministic=True)
    target = Path(os.path.abspath(str(out))) if out else rp / "snapshot.json"
    for path, path_real in _ledger_set(ledgers):
        if _inside_zone(path, target) or _inside_zone(path_real, target) or _inside_zone(UI_SHARED, target):
            return _refuse("storage-fact-path", "snapshot-target-is-fact-path", out=_posix(target))
    if (USER_SPACE.exists() or USER_SPACE.parent.exists()) and _inside_zone(USER_SPACE, target):
        return _refuse("storage-fact-path", "snapshot-target-in-user-space", out=_posix(target))
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.parent / (target.name + ".tmp")
        temp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1),
                        encoding="utf-8")
        temp.replace(target)
    except OSError as exc:
        return _refuse("storage-unavailable", "snapshot-write-failed", out=_posix(target),
                       detail=str(exc)[:120])
    payload["out"] = _posix(target)
    payload["out_bytes"] = target.stat().st_size
    return payload


def limits_table():
    """声明上界表（机器可读；契约文档 §4/§5 与门按这份真值断言）。"""
    return {
        "max_line_bytes": MAX_LINE_BYTES, "max_append_bytes": MAX_APPEND_BYTES,
        "max_file_bytes": MAX_FILE_BYTES, "max_path_depth": MAX_PATH_DEPTH,
        "max_tail_lines": MAX_TAIL_LINES, "max_value_bytes": MAX_VALUE_BYTES,
        "max_row_bytes": MAX_ROW_BYTES, "max_key_bytes": MAX_KEY_BYTES,
        "max_keys_per_table": MAX_KEYS_PER_TABLE, "max_events_per_table": MAX_EVENTS_PER_TABLE,
        "max_replay_events": MAX_REPLAY_EVENTS, "max_tables": MAX_TABLES,
        "max_scan_keys": MAX_SCAN_KEYS, "max_list_entries": MAX_LIST_ENTRIES,
        "max_scan_files": MAX_SCAN_FILES, "max_hash_files": MAX_HASH_FILES,
        "max_tenant_bytes": MAX_TENANT_BYTES, "max_snapshot_tenants": MAX_SNAPSHOT_TENANTS,
        "max_snapshot_samples": MAX_SNAPSHOT_SAMPLES,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _common_options():
    """全局选项（`--root` / `--ledger` / `--at`）：子命令也各带一份（两级都能写；子级覆盖主级）。"""
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", default=argparse.SUPPRESS, help="存储根（默认 tmp/storage/）")
    parser.add_argument("--ledger", action="append", default=argparse.SUPPRESS,
                        help="声明一条事实路径（账本）：落在它里面/它就是它 → 一律拒（可重复）")
    parser.add_argument("--at", default=argparse.SUPPRESS, help="写入时间戳（调用方给；本工具不读墙钟）")
    return parser


def _build_parser():
    parser = argparse.ArgumentParser(prog="storage.py",
                                     description="存储（文件管理 + 键值表）—— Python 侧唯一写入者")
    parser.add_argument("--root", default=str(DEFAULT_ROOT), help="存储根（默认 tmp/storage/）")
    parser.add_argument("--ledger", action="append", default=[],
                       help="声明一条事实路径（账本）：落在它里面/它就是它 → 一律拒（可重复）")
    parser.add_argument("--at", default="", help="写入时间戳（调用方给；本工具不读墙钟）")
    common = _common_options()
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("limits", parents=[common], help="打印声明上界表与拒绝码闭合集合")

    append = sub.add_parser("open-append", parents=[common], help="打开/追加 append-only 日志")
    append.add_argument("--ns", required=True)
    append.add_argument("--rel", required=True)
    append.add_argument("--text", action="append", default=[])

    tail = sub.add_parser("read-tail", parents=[common], help="读日志尾部有界窗口（必须给 limit）")
    tail.add_argument("--ns", required=True)
    tail.add_argument("--rel", required=True)
    tail.add_argument("--limit", type=int, default=None)
    tail.add_argument("--max-line-bytes", type=int, default=MAX_LINE_BYTES)

    listing = sub.add_parser("list-files", parents=[common], help="列出本租户的文件")
    listing.add_argument("--ns", required=True)
    listing.add_argument("--max-entries", type=int, default=MAX_LIST_ENTRIES)

    state = sub.add_parser("stat", parents=[common], help="报一个目标的状态")
    state.add_argument("--ns", required=True)
    state.add_argument("--rel", required=True)

    putting = sub.add_parser("put", parents=[common], help="写入键值")
    putting.add_argument("--ns", required=True)
    putting.add_argument("--table", required=True)
    putting.add_argument("--key", required=True)
    putting.add_argument("--value", required=True)
    putting.add_argument("--value-json", action="store_true", help="把 --value 当 JSON 解析")

    getting = sub.add_parser("get", parents=[common], help="读一个键")
    getting.add_argument("--ns", required=True)
    getting.add_argument("--table", required=True)
    getting.add_argument("--key", required=True)

    deleting = sub.add_parser("delete", parents=[common], help="删除一个键（写墓碑事件）")
    deleting.add_argument("--ns", required=True)
    deleting.add_argument("--table", required=True)
    deleting.add_argument("--key", required=True)

    scanning = sub.add_parser("scan", parents=[common], help="扫一个表的键")
    scanning.add_argument("--ns", required=True)
    scanning.add_argument("--table", required=True)
    scanning.add_argument("--limit", type=int, default=MAX_SCAN_KEYS)

    snap = sub.add_parser("snapshot", parents=[common], help="写出只读统计快照（派生副本）")
    snap.add_argument("--ns", action="append", default=[])
    snap.add_argument("--out", default=None)
    snap.add_argument("--max-tenants", type=int, default=MAX_SNAPSHOT_TENANTS)
    return parser


def main(argv=None) -> int:
    args = _build_parser().parse_args(argv)
    ledgers = getattr(args, "ledger", [])
    root = getattr(args, "root", str(DEFAULT_ROOT))
    at = getattr(args, "at", "")
    if args.command == "limits":
        payload = _ok(source="tools/storage.py", limits=limits_table(), codes=list(CODES),
                      next_actions=dict(NEXT_ACTIONS), ledger_basename=LEDGER_BASENAME,
                      ui_shared=_posix(UI_SHARED), user_space=_posix(USER_SPACE),
                      default_root=_posix(DEFAULT_ROOT))
    elif args.command == "open-append":
        payload = open_append(args.ns, args.rel, args.text, root=root, ledgers=ledgers, at=at)
    elif args.command == "read-tail":
        payload = read_tail(args.ns, args.rel, args.limit, root=root, ledgers=ledgers,
                            max_line_bytes=args.max_line_bytes)
    elif args.command == "list-files":
        payload = list_files(args.ns, root=root, ledgers=ledgers, max_entries=args.max_entries)
    elif args.command == "stat":
        payload = stat(args.ns, args.rel, root=root, ledgers=ledgers)
    elif args.command == "put":
        value = args.value
        if args.value_json:
            try:
                value = json.loads(args.value)
            except ValueError as exc:
                payload = _refuse("storage-schema-refused", "value-json-invalid", detail=str(exc)[:120])
                print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
                return 1
        payload = put(args.ns, args.table, args.key, value, root=root, ledgers=ledgers, at=at)
    elif args.command == "get":
        payload = get(args.ns, args.table, args.key, root=root, ledgers=ledgers)
    elif args.command == "delete":
        payload = delete(args.ns, args.table, args.key, root=root, ledgers=ledgers, at=at)
    elif args.command == "scan":
        payload = scan(args.ns, args.table, args.limit, root=root, ledgers=ledgers)
    elif args.command == "snapshot":
        payload = snapshot(args.ns or None, root=root, ledgers=ledgers, out=args.out, at=at,
                           max_tenants=args.max_tenants)
    else:  # pragma: no cover - argparse 已挡住
        payload = _refuse("storage-schema-refused", "unknown-command", command=args.command)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:  # pragma: no cover
        sys.exit(2)
