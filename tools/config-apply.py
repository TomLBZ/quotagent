#!/usr/bin/env python3
"""config-apply —— 配置与凭据的**唯一落盘者**（Python 侧；宿主只落 0600 待处理项）。

对应规格：`docs/work/plans/config-凭据UX规格.md.txt`（U4/U5/U6/U8/U10/U12 与 §2/§3.3/§4/§6）。
宿主侧（`host/modules/config-view.mjs` + `host/modules/webui.mjs` 的路由）**只**在
`<inbox>/cfg-<sha256 前 16 位>.json`（权限 0600、原子写）落一条待处理项，**账本零新增**：

    {"request_id":"<sha256 前 16>","layer":"project|plugin|credential","target":"<键路径 / ns/plugin / 凭据名>",
     "fields":{"<名>":"<值>"},"payload_sha256":"<sha256(规范化 fields)>","bytes":123,"schema":1,
     "submitted_at":null,"submitted_by":"admin-session"}

本脚本是把它变成**文件事实 + 账本事实**的唯一入口。职责边界（每一条都有对应机检）：

- **输入全部显式传入**：`--inbox` / `--file` / `--ledger` / `--approval-ref` / `--actor` / `--now` 都要给；
  本脚本**不读墙钟**（`--now` 是唯一时间源）、不读环境变量决定行为、不联网、不随机。
- **人工门不可绕过**：`--approval-ref` 必须形如 `ap-NNNN`、`--actor` 必须以 `human:` 开头；缺一、形状不对 →
  **整次拒绝**（退出码 2、零落盘、零账本、stdout 一行 JSON 说清理由）。
- **权限即门**：待处理项**权限必须恰为 0600**（0644 等一律拒），不猜、不自动改权限。凭据文件落盘后**必须** 0600。
- **重算校验**：`payload_sha256` 与 `bytes` 一律用 `fields` 重算比对（不采信文件自述），不一致即拒。
- **白名单 + 类型**：`project` 层的键必须**同时**在 `host/lib/schema.mjs` 白名单与 `host/lib/config-keys.mjs`
  登记表里（两处都是**同一份文件**被解析，不存在第二份白名单）；`frozen` 永拒、`humanOnly` 必须带人工引用；
  未登记键 → `unknown-key`；类型不符 → `type-mismatch`。
- **YAML 子集**：只支持"顶层映射 + 嵌套映射 + 标量 + 简单列表 + 内联 {}/[]"；锚点/别名、多文档、块标量、
  制表符缩进、重复键一律**拒并给 reason**（不静默糊掉）。宿主侧同一子集（`host/lib/config-ui.mjs`），
  门用同一份夹具对两侧做逐字节比对（防漂移）。
- **原子写 + 回滚 + 无部分效果**：同目录 `.名字.tmp.<pid>` 写入 → `fsync` → `os.replace()`；
  写前把旧内容留一份 `<file>.bak`（只留上一版）；写完**必须回读**（逐键值相等 + 非受管段字节不变），
  任一步失败 → `os.replace(bak, file)` 还原并整次失败；临时文件不残留。
- **只写受管段**：`project` / `plugins` / `credentials` 三段由本脚本整段重写，**其余段逐字节保留**（用户注释不丢）。
- **账本事件只出键名与摘要**：`config/changed` / `config/refused` / `credential/rotated` 的 body **没有值**，
  也没有字段值；凭据只留 `value_sha256` 与 `fingerprint_first8`。**顺序固定：先文件、后账本**；
  账本失败 → 回滚文件（守住"生效 ⟺ 可见"）。
- **幂等**：同 `(layer, target, payload_sha256)` 再次出现（归档件或账本已有同事实）→ **零新增零落盘**，
  stdout 标 `duplicate`。
- **不删源**：消费成功后把待处理项**移入** `<inbox>/applied/`；凭据类在归档前**先把明文换成
  `sha256` + 指纹前 8 位**（修规格 §1.4 偏差 ③：归档里不残留明文）。
- **凭据永不回显**：stdout/stderr/账本/归档里值出现次数 = 0（`--status` 写的状态快照也只有指纹与来源）。

退出码：0 = 成功（含幂等重复）/ 2 = 拒绝（用法门或待处理项被拒；被拒项各落 **1 行** `config/refused`）。

用法::

    python3 tools/config-apply.py --inbox <dir> --file <yaml> --ledger <jsonl> \\
        --approval-ref ap-0007 --actor human:zhang --now 2026-09-21T00:00:00Z \\
        [--cred-dir <dir>] [--status <json>] [--only <request_id>] [--dry-run]
    python3 tools/config-apply.py --init --file <yaml> --ledger <jsonl> --actor human:zhang --now <ISO>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from quotagent.kernel.ledger import Ledger  # noqa: E402  （唯一写账本的地方就是这个脚本）

EXIT_OK = 0
EXIT_REFUSED = 2
SCHEMA = 1
REALM = "config"
ARCHIVE_DIR = "applied"
#: 待处理项的层名（提交面用的字面量）与它们写在 YAML 的**段名**的对应（唯一的映射处）
LAYERS = ("project", "plugin", "credential")
MANAGED_SECTIONS = ("project", "plugins", "credentials")
SECTION_OF = {"project": "project", "plugin": "plugins", "credential": "credentials"}
EVENT_CHANGED = "config/changed"
EVENT_REFUSED = "config/refused"
EVENT_ROTATED = "credential/rotated"
#: 事件 body 的键白名单（**多一个键就是违约**：值/字段名不得进账本）
BODY_KEYS = {
    EVENT_CHANGED: ("layer", "target", "key_path", "old_digest", "new_digest", "source", "actor",
                    "approval_ref", "schema", "ts"),
    EVENT_REFUSED: ("layer", "target", "key_path", "keys", "reason", "actor", "approval_ref", "schema", "ts"),
    EVENT_ROTATED: ("name", "configured", "fingerprint_first8", "value_sha256", "mode", "source", "actor",
                    "approval_ref", "schema", "ts"),
}
APPROVAL_REF_RE = re.compile(r"^ap-\d{4}$")
ACTOR_RE = re.compile(r"^human:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
TARGET_RE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
PLUGIN_TARGET_RE = re.compile(r"^[a-z0-9-]{1,64}/[a-z0-9-]{1,64}$")

TEMPLATE_NOTE = (
    "# quotagent 配置（**唯一落盘者是 tools/config-apply.py**；宿主只落 0600 待处理项，不写本文件）\n"
    "# 每一段是什么、值怎么填，都写在本文件的注释里；**凭据值不写在本文档**（凭据只登记指针与指纹）。\n"
    "# 本模板里的值一律是**占位符**（形如 <...> / human:<你的人名>）：照抄不会生效，先换成你自己的值。\n"
    "# 子集：顶层/嵌套映射、标量、简单列表、内联 {}/[]；锚点/多文档/块标量会**被拒**（不静默糊掉）。\n"
)


# ---------------------------------------------------------------------------
# 单一真源：解析 host/lib 下的登记表与白名单（**不写第二份白名单**）
# ---------------------------------------------------------------------------
def _registry() -> tuple[dict, dict]:
    """读 `host/lib/config-keys.mjs`（键 → 类型；凭据名 → env/file/required_mode）。解析不出来就拒（fail-closed）。"""
    text = (ROOT / "host" / "lib" / "config-keys.mjs").read_text(encoding="utf-8")
    keys: dict[str, dict] = {}
    for match in re.finditer(r"'([^']+)':\s*\{\s*type:\s*'([a-z]+)',\s*default:\s*([^,}]+)", text):
        keys[match.group(1)] = {"type": match.group(2), "default": _literal(match.group(3).strip())}
    creds: dict[str, dict] = {}
    for match in re.finditer(
            r"^\s*([a-z_][a-z0-9_]*):\s*\{\s*env:\s*'([^']*)',\s*file:\s*'([^']*)',\s*required_mode:\s*'([^']*)'",
            text, re.M):
        creds[match.group(1)] = {"env": match.group(2), "file": match.group(3),
                                 "required_mode": match.group(4)}
    if not keys or not creds:
        raise RuntimeError("host/lib/config-keys.mjs 解析为空：登记表是白名单的一部分，解析不到就拒绝整次运行")
    return keys, creds


def _literal(text: str) -> Any:
    if text in ("true", "false"):
        return text == "true"
    try:
        return json.loads(text)
    except ValueError:
        return text.strip("'\"")


def _schema() -> dict:
    """读 `host/lib/schema.mjs`（键模式 → frozen/humanOnly）。**唯一白名单真源**。"""
    text = (ROOT / "host" / "lib" / "schema.mjs").read_text(encoding="utf-8")
    rules: dict[str, dict] = {}
    for match in re.finditer(r"^\s*'([^']+)':\s*\{([^}]*)\}", text, re.M):
        body = match.group(2)
        rules[match.group(1)] = {"frozen": "frozen: true" in body, "humanOnly": "humanOnly: true" in body}
    if not rules:
        raise RuntimeError("host/lib/schema.mjs 解析为空：白名单真源读不到就拒绝整次运行")
    return rules


def match_schema(key: str, rules: dict) -> dict | None:
    """最长前缀优先、`*` 匹配一个段（与 `host/lib/config-keys.mjs` 的同名函数同一口径）。"""
    segments = str(key).split(".")
    best = None
    for pattern, rule in rules.items():
        parts = pattern.split(".")
        if len(parts) != len(segments):
            continue
        if any(part != "*" and part != segments[index] for index, part in enumerate(parts)):
            continue
        specificity = sum(1 for part in parts if part != "*")
        if best is None or specificity > best["specificity"]:
            best = {"pattern": pattern, "rule": rule, "specificity": specificity}
    return best


# ---------------------------------------------------------------------------
# 规范化 / 摘要：**与宿主 `canonical()` 逐字节同形**（键排序、无空格、非 ASCII 不转义、整数化浮点）
# ---------------------------------------------------------------------------
def _normalize(value: Any) -> Any:
    """JS 只有 double：`12.0` 在两侧都必须序列化成 `12`（否则跨语言比对会假红）。"""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e15:
        return int(value)
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    return value


def canonical(value: Any) -> str:
    return json.dumps(_normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def payload_digest(fields: dict) -> str:
    return hashlib.sha256(canonical(fields).encode("utf-8")).hexdigest()


def _iso(text: Any) -> str | None:
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat().replace("+00:00", "Z")


def _stdout(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))


def _note(text: str) -> None:
    print(f"[config-apply] {text}", file=sys.stderr)


def _refusal(reason: str, file: Any = None, **extra: Any) -> dict:
    out = {"file": None if file is None else str(file), "reason": reason}
    out.update(extra)
    return out


# ---------------------------------------------------------------------------
# YAML 子集（与 host/lib/config-ui.mjs 同一实现口径；门用同一份夹具逐字节比对）
# ---------------------------------------------------------------------------
UNSUPPORTED = (
    (re.compile(r"^\s*---\s*$|^\s*\.\.\.\s*$", re.M), "multi-document-mark"),
    (re.compile(r"^\s*\t|\t", re.M), "tab-indent"),
    (re.compile(r":\s*[|>][+-]?\s*(#.*)?$", re.M), "block-scalar"),
    (re.compile(r":\s*[&*][A-Za-z0-9_-]+", re.M), "anchor-or-alias"),
    (re.compile(r"^\s*-?\s*<<\s*:", re.M), "merge-key"),
)
INT_RE = re.compile(r"^-?\d+$")
FLOAT_RE = re.compile(r"^-?\d*\.\d+([eE][+-]?\d+)?$")


class YamlError(ValueError):
    pass


def _strip_comment(raw: str) -> str:
    quote = None
    for index, char in enumerate(raw):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == "#" and index > 0 and raw[index - 1].isspace():
            return raw[:index]
    return raw


def _split_top_level(text: str, separator: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    quote = None
    current = ""
    for char in text:
        if quote:
            current += char
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            current += char
            continue
        if char in "[{":
            depth += 1
        if char in "]}":
            depth -= 1
        if char == separator and depth == 0:
            parts.append(current)
            current = ""
            continue
        current += char
    parts.append(current)
    return parts


def _unquote(text: str) -> str:
    value = text.strip()
    if len(value) >= 2 and value[0] == "'" and value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1].replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
    return value


def parse_scalar(raw: str) -> Any:
    text = _strip_comment(str(raw)).strip()
    if text == "":
        return None
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        return [] if inner == "" else [parse_scalar(item) for item in _split_top_level(inner, ",")]
    if text.startswith("{") and text.endswith("}"):
        inner = text[1:-1].strip()
        out: dict = {}
        if inner == "":
            return out
        for item in _split_top_level(inner, ","):
            at = item.find(":")
            if at < 0:
                raise YamlError("flow-map-entry-without-colon")
            out[_unquote(item[:at])] = parse_scalar(item[at + 1:])
        return out
    if text[0] in "\"'":
        return _unquote(text)
    if text in ("true", "True", "TRUE"):
        return True
    if text in ("false", "False", "FALSE"):
        return False
    if text in ("null", "~", "Null", "NULL"):
        return None
    if INT_RE.match(text):
        return int(text)
    if FLOAT_RE.match(text):
        return float(text)
    return text


def _split_key(text: str) -> tuple[str, str] | None:
    quote = None
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == ":" and (index == len(text) - 1 or text[index + 1].isspace()):
            return _unquote(text[:index]), text[index + 1:]
    return None


def _preprocess(text: str) -> list[dict]:
    source = str(text or "")
    for pattern, reason in UNSUPPORTED:
        if pattern.search(source):
            raise YamlError(reason)
    rows = []
    for index, line in enumerate(source.split("\n")):
        if line.strip() == "" or line.strip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        rows.append({"indent": indent, "body": line.strip(), "line": index + 1})
    return rows


def parse_yaml(text: str) -> Any:
    """子集解析；失败抛 `YamlError(reason)`（reason 是机器可读原因码）。"""
    rows = _preprocess(text)
    if not rows:
        return {}

    def build(start: int, indent: int) -> tuple[Any, int]:
        is_list = rows[start]["body"].startswith("- ") or rows[start]["body"] == "-"
        container: Any = [] if is_list else {}
        seen: set = set()
        index = start
        while index < len(rows):
            row = rows[index]
            if row["indent"] < indent:
                break
            if row["indent"] > indent:
                raise YamlError(f"unexpected-indent:第 {row['line']} 行")
            if is_list:
                rest = re.sub(r"^-\s?", "", row["body"], count=1)
                if rest == "":
                    if index + 1 < len(rows) and rows[index + 1]["indent"] > indent:
                        nested, index = build(index + 1, rows[index + 1]["indent"])
                        container.append(nested)
                    else:
                        container.append(None)
                        index += 1
                    continue
                pair = _split_key(rest)
                if pair and pair[1].strip() != "":
                    item: dict = {}
                    item[pair[0]] = parse_scalar(pair[1])
                    if index + 1 < len(rows) and rows[index + 1]["indent"] > indent:
                        nested, index = build(index + 1, rows[index + 1]["indent"])
                        if not isinstance(nested, dict):
                            raise YamlError(f"bad-list-map:第 {row['line']} 行")
                        item.update(nested)
                    else:
                        index += 1
                    container.append(item)
                    continue
                if pair and pair[1].strip() == "":
                    item = {}
                    if index + 1 < len(rows) and rows[index + 1]["indent"] > indent:
                        nested, index = build(index + 1, rows[index + 1]["indent"])
                        item[pair[0]] = nested
                    else:
                        item[pair[0]] = None
                        index += 1
                    container.append(item)
                    continue
                container.append(parse_scalar(rest))
                index += 1
                continue
            if row["body"].startswith("- "):
                raise YamlError(f"list-item-in-map:第 {row['line']} 行")
            pair = _split_key(row["body"])
            if pair is None:
                raise YamlError(f"not-a-mapping:第 {row['line']} 行")
            key, rest = pair[0], pair[1].strip()
            if key == "":
                raise YamlError(f"empty-key:第 {row['line']} 行")
            if key in seen:
                raise YamlError(f"duplicate-key:{key}")
            seen.add(key)
            if rest == "":
                if index + 1 < len(rows) and rows[index + 1]["indent"] > indent:
                    nested, index = build(index + 1, rows[index + 1]["indent"])
                    container[key] = nested
                else:
                    container[key] = None
                    index += 1
                continue
            container[key] = parse_scalar(rest)
            index += 1
        return container, index

    value, consumed = build(0, rows[0]["indent"])
    if consumed != len(rows):
        raise YamlError(f"trailing-lines:第 {rows[consumed]['line']} 行")
    return value


def render_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)
    if isinstance(value, list):
        return "[" + ", ".join(render_scalar(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{}"
    text = str(value)
    risky = (text == "" or not re.match(r"^[A-Za-z0-9_./@:+*-]*$", text)
             or re.match(r"^(true|false|null|~|\d+|-?\d*\.\d+)$", text))
    if risky:
        return "'" + text.replace("'", "''") + "'"
    return text


def _quote_key(key: str) -> str:
    return key if re.match(r"^[A-Za-z0-9_.-]+$", key) else '"' + str(key).replace('"', '\\"') + '"'


def render_node(node: Any, indent: int) -> list[str]:
    pad = " " * indent
    if isinstance(node, list):
        return [f"{pad}- {render_scalar(item)}" for item in node]
    if isinstance(node, dict):
        out: list[str] = []
        for key in sorted(node):
            value = node[key]
            if isinstance(value, dict) and value:
                out.append(f"{pad}{_quote_key(key)}:")
                out.extend(render_node(value, indent + 2))
            else:
                out.append(f"{pad}{_quote_key(key)}: {render_scalar(value)}")
        return out
    return [f"{pad}{render_scalar(node)}"]


def section_ranges(text: str) -> tuple[list[str], dict]:
    lines = str(text or "").split("\n")
    starts: list[dict] = []
    for index, line in enumerate(lines):
        match = re.match(r"^([^\s#][^:]*?)\s*:", line)
        if match and not line.startswith("-"):
            starts.append({"key": _unquote(match.group(1)), "index": index})
    ranges: dict = {}
    for position, entry in enumerate(starts):
        end = starts[position + 1]["index"] if position + 1 < len(starts) else len(lines)
        ranges[entry["key"]] = (entry["index"], end)
    return lines, ranges


def splice_section(text: str, key: str, node: Any) -> str:
    lines, ranges = section_ranges(text)
    body = [f"{key}:", *render_node(node or {}, 2)]
    if key not in ranges:
        base = str(text or "")
        tail = "" if base == "" or base.endswith("\n") else "\n"
        return f"{base}{tail}{'\n'.join(body)}\n"
    start, end = ranges[key]
    return "\n".join([*lines[:start], *body, *lines[end:]])


def read_managed_sections(text: str) -> dict:
    """只解析受管三段（其余段永不触碰）；受管段内有不支持的结构 → 抛 YamlError。"""
    lines, ranges = section_ranges(text)
    out: dict = {}
    for key in MANAGED_SECTIONS:
        if key not in ranges:
            continue
        start, end = ranges[key]
        block = "\n".join(lines[start:end])
        parsed = parse_yaml(block)
        section = parsed.get(key) if isinstance(parsed, dict) else None
        if section is not None and not isinstance(section, dict):
            raise YamlError(f"managed-section-not-a-mapping:{key}")
        out[key] = section or {}
    return out


# ---------------------------------------------------------------------------
# 待处理项：权限门 → 形状门 → 重算校验（理由里不出现任何字段值）
# ---------------------------------------------------------------------------
def _load_item(path: Path) -> tuple[dict | None, str | None]:
    try:
        info = os.stat(path)
    except OSError as exc:
        return None, f"读不到文件：{exc}"
    if not stat.S_ISREG(info.st_mode):
        return None, "不是普通文件（符号链接/目录/设备一律拒）"
    mode = stat.S_IMODE(info.st_mode)
    if mode != 0o600:
        return None, f"权限不是 600（收到 {oct(mode)}）：待处理项必须由提交面以 0600 落盘，本脚本不改权限"
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"不是合法 JSON：{exc}"
    if not isinstance(record, dict):
        return None, "待处理项必须是 JSON 对象"
    if record.get("schema") != SCHEMA:
        return None, f"schema 必须是 {SCHEMA}（未知版本不猜）"
    layer = record.get("layer")
    if layer not in LAYERS:
        return None, f"layer 不在 {list(LAYERS)} 内（不猜、不默认）"
    target = record.get("target")
    if not isinstance(target, str) or not target.strip():
        return None, "缺 target（或不是非空字符串）"
    fields = record.get("fields")
    if not isinstance(fields, dict) or not fields:
        return None, "fields 必须是非空对象（没有内容就没有可落的配置事实）"
    for key, value in fields.items():
        if not isinstance(key, str) or not isinstance(value, (str, int, float, bool, list, type(None))):
            return None, "fields 必须是「字符串 → 标量/标量列表」（不猜非标量的形状）"
    digest = record.get("payload_sha256")
    if not isinstance(digest, str) or not HEX64_RE.match(digest):
        return None, "payload_sha256 必须是 64 位小写 hex"
    size = record.get("bytes")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0:
        return None, "bytes 必须是非负整数"
    recomputed = payload_digest(fields)
    if recomputed != digest:
        return None, "payload_sha256 与重算结果不符（文件自述不可信；不采信、不落盘）"
    actual = len(canonical(fields).encode("utf-8"))
    if actual != size:
        return None, f"bytes 与重算结果不符（自述 {size}、重算 {actual}）"
    if record.get("submitted_at") not in (None, ""):
        return None, "submitted_at 必须为空（宿主不取墙钟；时间由 Python 侧按 --now 落账）"
    return {"layer": layer, "target": target.strip(), "fields": fields, "payload_sha256": digest,
            "bytes": actual, "request_id": str(record.get("request_id") or "")}, None


# ---------------------------------------------------------------------------
# 白名单 / 类型 / 目标形状 → 拒绝理由（**只出键名，不出值**）
# ---------------------------------------------------------------------------
def validate_item(item: dict, *, keys: dict, creds: dict, schema: dict) -> list[dict]:
    layer, target, fields = item["layer"], item["target"], item["fields"]
    reasons: list[dict] = []
    if layer == "project":
        for key in sorted(fields):
            matched = match_schema(key, schema)
            if matched is None:
                reasons.append({"code": "unknown-key", "key": key, "reason": "键不在 host/lib/schema.mjs 白名单内"})
                continue
            if matched["rule"].get("frozen"):
                reasons.append({"code": "frozen", "key": key, "reason": f"冻结键（{matched['pattern']}）：永拒"})
                continue
            if key not in keys:
                reasons.append({"code": "unknown-key", "key": key,
                                "reason": "白名单前缀命中，但键未登记类型与默认值（先改 host/lib/config-keys.mjs）"})
                continue
            declared = keys[key]["type"]
            value = fields[key]
            ok = ((declared == "boolean" and isinstance(value, bool))
                  or (declared == "number" and isinstance(value, (int, float)) and not isinstance(value, bool))
                  or (declared == "integer" and isinstance(value, int) and not isinstance(value, bool))
                  or (declared == "string" and isinstance(value, str) and value != ""))
            if not ok:
                seen = "array" if isinstance(value, list) else ("bool" if isinstance(value, bool) else type(value).__name__)
                reasons.append({"code": "type-mismatch", "key": key,
                                "reason": f"类型必须是 {declared}（收到 {seen}）"})
    elif layer == "plugin":
        if not PLUGIN_TARGET_RE.match(target):
            reasons.append({"code": "bad-target", "key": "",
                            "reason": "插件层 target 必须形如 <ns>/<plugin>（小写字母/数字/连字符）"})
        for key in sorted(fields):
            if not KEY_RE.match(key):
                reasons.append({"code": "bad-field", "key": "", "reason": "字段名只允许 [A-Za-z0-9_.-]（1..120）"})
                continue
            value = fields[key]
            scalar = value is None or isinstance(value, (str, int, float, bool)) or (
                isinstance(value, list) and all(item is None or isinstance(item, (str, int, float, bool)) for item in value))
            if not scalar:
                reasons.append({"code": "type-mismatch", "key": key,
                                "reason": "插件配置字段只接受标量或标量列表（嵌套映射由插件自己声明）"})
    else:  # credential
        if target not in creds:
            reasons.append({"code": "unknown-credential", "key": "",
                            "reason": "凭据名不在登记表内（不猜）"})
        value = fields.get("value")
        if not isinstance(value, str) or value == "":
            reasons.append({"code": "empty-value", "key": "value", "reason": "凭据值必须是非空字符串"})
        if set(fields) - {"value"}:
            reasons.append({"code": "bad-field", "key": "",
                            "reason": "凭据层只接受 value 一个字段（不猜别的形状）"})
    return reasons


def _body(event: str, payload: dict) -> dict:
    if tuple(sorted(payload)) != tuple(sorted(BODY_KEYS[event])):
        raise RuntimeError(f"{event} 事件正文键集与契约不符：{sorted(payload)} != {sorted(BODY_KEYS[event])}")
    return payload


# ---------------------------------------------------------------------------
# 文件写入：原子写 + 回滚 + 回读校验（无部分效果）
# ---------------------------------------------------------------------------
def _write_atomic(path: Path, text: str, mode: int) -> None:
    tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def _restore(path: Path, backup: Path | None) -> None:
    if backup is not None and backup.exists():
        shutil.copy2(backup, path)
    elif path.exists():
        path.unlink()


def apply_to_file(path: Path, updates: dict, *, expect: dict) -> tuple[bool, dict]:
    """把 updates（{段名: {键: 值}}）写进 YAML：原子写 + 回读校验 + 失败回滚。

    返回 `(ok, detail)`；`detail` 只含键名与原因码，**不含任何值**。
    """
    existed = path.exists()
    original = path.read_text(encoding="utf-8") if existed else ""
    mode = stat.S_IMODE(os.stat(path).st_mode) if existed else 0o600
    non_managed: dict[str, str] = {}
    if existed:
        _, ranges = section_ranges(original)
        lines = original.split("\n")
        for key, (start, end) in ranges.items():
            if key not in MANAGED_SECTIONS:
                non_managed[key] = "\n".join(lines[start:end])
    try:
        doc = read_managed_sections(original) if existed else {}
    except YamlError as exc:
        return False, {"reason": f"unsupported-yaml:{exc}", "keys": sorted(updates.keys())}
    for section, patch in updates.items():
        node = doc.get(section) if isinstance(doc.get(section), dict) else {}
        # 深合并：只动提交的键，其余键原样保留
        merged = json.loads(json.dumps(node, ensure_ascii=False))
        for key, value in patch.items():
            if section == "project":
                merged[key] = value
            elif section == "plugins":
                target = key
                current = merged.get(target) if isinstance(merged.get(target), dict) else {}
                current.update(value)
                merged[target] = current
            else:
                merged[key] = value
        doc[section] = merged
    text = original
    for section in MANAGED_SECTIONS:
        if section in doc:
            text = splice_section(text, section, doc[section])
    backup = path.parent / f"{path.name}.bak" if existed else None
    if backup is not None:
        shutil.copy2(path, backup)
    try:
        _write_atomic(path, text, mode)
    except OSError as exc:
        return False, {"reason": f"write-failed:{type(exc).__name__}", "keys": sorted(updates.keys())}
    # --- 回读校验：逐键值相等 + 非受管段字节不变（任一不满足即回滚）---
    try:
        reread = path.read_text(encoding="utf-8")
        back = read_managed_sections(reread)
    except (OSError, YamlError) as exc:
        _restore(path, backup)
        return False, {"reason": f"reread-failed:{type(exc).__name__}:{exc}", "keys": sorted(updates.keys())}
    for key, value in expect.items():
        section, _, path_key = key.partition("|")
        got = back.get(section, {}).get(path_key)
        if canonical(got) != canonical(value):
            _restore(path, backup)
            return False, {"reason": "reread-mismatch", "keys": [key]}
    for key, block in non_managed.items():
        if block not in reread:
            _restore(path, backup)
            return False, {"reason": f"non-managed-section-changed:{key}", "keys": sorted(non_managed)}
    if path.parent.joinpath(f".{path.name}.tmp.{os.getpid()}").exists():
        _restore(path, backup)
        return False, {"reason": "temp-file-leftover", "keys": sorted(updates.keys())}
    return True, {"reason": "", "mode": oct(stat.S_IMODE(os.stat(path).st_mode)), "bytes": len(reread.encode("utf-8"))}


def _write_secret(path: Path, value: str) -> None:
    """凭据文件：**恰为 0600**、原子写（目录不建 0700 之外的权限面）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    _write_atomic(path, value if value.endswith("\n") else value + "\n", 0o600)


# ---------------------------------------------------------------------------
# 归档 / 幂等 / 状态快照
# ---------------------------------------------------------------------------
def _archived_facts(inbox: Path) -> set:
    archive = inbox / ARCHIVE_DIR
    if not archive.is_dir():
        return set()
    out = set()
    for path in sorted(archive.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(record, dict) and record.get("payload_sha256"):
            out.add((str(record.get("layer")), str(record.get("target")), str(record["payload_sha256"])))
    return out


def _ledger_facts(path: Path) -> dict:
    facts: dict = {"duplicates": set(), "lines": 0, "error": None}
    if not path.exists():
        return facts
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        facts["error"] = f"账本读不到：{exc}"
        return facts
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        facts["lines"] += 1
        try:
            record = json.loads(line)
        except ValueError as exc:
            facts["error"] = f"账本第 {lineno} 行不是合法 JSON（{exc}）：宁可不写，先修账本"
            return facts
        if not isinstance(record, dict):
            facts["error"] = f"账本第 {lineno} 行不是记录对象：宁可不写，先修账本"
            return facts
    return facts


def _archive(inbox: Path, path: Path, stem: str, record: dict | None = None) -> Path:
    archive = inbox / ARCHIVE_DIR
    archive.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(archive, 0o700)
    except OSError:
        pass
    target = archive / f"{stem}.json"
    if target.exists():
        index = 1
        while (archive / f"{stem}.{index}.json").exists():
            index += 1
        target = archive / f"{stem}.{index}.json"
    if record is not None:                      # 凭据类：先就地脱敏，再移入（修偏差 ③：归档不残留明文）
        tmp = archive.parent / f".{stem}.redact.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    shutil.move(str(path), str(target))
    return target


def _status_snapshot(path: Path, now: str, creds: dict, applied: list) -> None:
    """只写 configured/source/required_mode/指纹前 8 位 —— **不含值**（宿主凭据视图据此显示）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"schema": SCHEMA, "generated_at": now, "credentials": creds, "applied": applied,
               "note": "只含 configured/source/required_mode/fingerprint_first8：不含任何凭据值"}
    tmp = path.parent / f".{path.name}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=1) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="config-apply", add_help=False,
                                     description="配置/凭据的唯一落盘者（宿主只落 0600 待处理项）")
    parser.add_argument("--inbox")
    parser.add_argument("--file")
    parser.add_argument("--ledger")
    parser.add_argument("--approval-ref", dest="approval_ref")
    parser.add_argument("--actor")
    parser.add_argument("--now")
    parser.add_argument("--cred-dir", dest="cred_dir")
    parser.add_argument("--status")
    parser.add_argument("--only")
    parser.add_argument("--init", action="store_true")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true")
    parser.add_argument("-h", "--help", action="store_true", dest="help")
    return parser


def _emit(ok: bool, applied: list, duplicates: list, refused: list, ledger_added: int, **extra: Any) -> int:
    payload = {"ok": ok, "applied": applied, "duplicates": duplicates, "refused": refused,
               "ledger_added": ledger_added}
    payload.update(extra)
    _stdout(payload)
    if refused:
        _note(f"{len(refused)} 项被拒：对它们零落盘（被拒的变更各落 1 行 {EVENT_REFUSED}）")
        return EXIT_REFUSED
    return EXIT_OK


def _usage_refuse(reason: str, **extra: Any) -> int:
    _note(f"用法拒绝：{reason}（零落盘、零账本：本脚本在构造 Ledger 之前返回，连空账本文件都不会创建）")
    return _emit(False, [], [], [_refusal(reason)], 0, **extra)


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(sys.argv[1:] if argv is None else argv)
    ledger_path = str(args.ledger or "")
    file_path = str(args.file or "")

    if args.help:
        _note("用法：--inbox <dir> --file <yaml> --ledger <jsonl> --approval-ref ap-NNNN --actor human:<名> "
              "--now <ISO> [--cred-dir <dir>] [--status <json>] [--only <request_id>] [--dry-run] ；"
              "或 --init --file <yaml> --ledger <jsonl> --actor human:<名> --now <ISO>")
        return _usage_refuse("--help", ledger=ledger_path)

    if not file_path.strip():
        return _usage_refuse("缺 --file（受管配置文件路径必须显式给）", ledger=ledger_path)
    if not ledger_path.strip():
        return _usage_refuse("缺 --ledger（账本落点必须显式给）", ledger=ledger_path)
    actor = args.actor
    if not isinstance(actor, str) or not ACTOR_RE.match(actor.strip()):
        return _usage_refuse(f"--actor 必须是 human:<名>（agent 不得代签）：{actor!r}", ledger=ledger_path)
    now = _iso(args.now)
    if now is None:
        return _usage_refuse("--now 必填且必须是合法 ISO 时间（本脚本不读墙钟）", ledger=ledger_path)

    try:
        keys, creds = _registry()
        schema = _schema()
    except (OSError, RuntimeError) as exc:
        return _usage_refuse(f"登记表/白名单读不到：{exc}", ledger=ledger_path)

    file_obj = Path(file_path)
    ledger_file = Path(ledger_path)
    facts = _ledger_facts(ledger_file)
    if facts["error"]:
        return _usage_refuse(str(facts["error"]), ledger=ledger_path)

    # ---------------- --init：文件不存在才生成模板 ----------------
    if args.init:
        if file_obj.exists():
            return _usage_refuse(f"--init 只用于初始化：{file_obj} 已存在（不覆盖用户配置）", ledger=ledger_path)
        text = (TEMPLATE_NOTE
                + "apiVersion: quotagent/v1\n"
                + "meta:\n"
                + "  schema: 1\n"
                + f"  updated_at: '{now}'\n"
                + "  updated_by: 'human:<你的人名>\n"
                + "\n"
                + "# ── 层 1：项目配置（键必须同时登记在 host/lib/schema.mjs 与 host/lib/config-keys.mjs）──────\n"
                + "# 写法：键路径 = 点分字符串（例如 pricing.markup_pct: 12.5）\n"
                + "project: {}\n"
                + "\n"
                + "# ── 层 2：插件配置（键 = \"<ns>/<plugin>\"，值 = 该插件自己 Config 的字段）────────────────\n"
                + "plugins: {}\n"
                + "\n"
                + "# ── 层 3：凭据（**只登记指针与指纹，永不写值**；值放 0600 文件或环境变量）──────────────\n"
                + "credentials: {}\n")
        if args.dry_run:
            _note(f"dry-run --init：将生成 {file_obj}（{len(text.encode('utf-8'))} 字节）；未写任何文件、未写账本")
            return _emit(True, [{"init": str(file_obj), "dry_run": True}], [], [], 0, file=str(file_obj))
        file_obj.parent.mkdir(parents=True, exist_ok=True)
        backup = None
        try:
            _write_atomic(file_obj, text, 0o600)
        except OSError as exc:
            _restore(file_obj, backup)
            return _usage_refuse(f"初始化写失败：{type(exc).__name__}", ledger=ledger_path)
        body = _body(EVENT_CHANGED, {"layer": "project", "target": str(file_obj), "key_path": "<init>",
                                     "old_digest": None, "new_digest": f"sha256:{hashlib.sha256(text.encode()).hexdigest()}",
                                     "source": f"human:{actor.strip()[6:]}", "actor": actor.strip(),
                                     "approval_ref": None, "schema": SCHEMA, "ts": now})
        ledger = Ledger(ledger_file, realm=REALM)
        ref = ledger.append(EVENT_CHANGED, body, correlation_id=f"config:init:{file_obj.name}", actor=actor.strip(), ts=now)
        _note(f"初始化 {file_obj}（0600）；账本 {EVENT_CHANGED} seq={ref.seq} duplicate={ref.duplicate}")
        return _emit(True, [{"init": str(file_obj), "bytes": len(text.encode("utf-8")), "mode": "0o600"}],
                     [], [], 0 if ref.duplicate else 1, file=str(file_obj))

    # ---------------- 待处理项消费 ----------------
    inbox_arg = str(args.inbox or "")
    if not inbox_arg.strip():
        return _usage_refuse("缺 --inbox（宿主提交面的待处理目录必须显式给）", ledger=ledger_path, file=str(file_obj))
    inbox = Path(inbox_arg)
    if not inbox.is_dir():
        return _usage_refuse(f"--inbox 不是目录：{inbox}", ledger=ledger_path, file=str(file_obj))
    ref_arg = args.approval_ref
    if not isinstance(ref_arg, str) or not ref_arg.strip():
        return _usage_refuse("缺人工批准引用 --approval-ref（ap-NNNN）：人工门不可绕过", ledger=ledger_path)
    if not APPROVAL_REF_RE.match(ref_arg.strip()):
        return _usage_refuse(f"批准引用形状非法（须 ap-NNNN，不做修补）：{ref_arg!r}", ledger=ledger_path)
    approval_ref = ref_arg.strip()
    actor_ref = actor.strip()

    candidates = [path for path in sorted(inbox.glob("*.json")) if path.is_file() and not path.name.startswith(".")]
    if args.only:
        wanted = str(args.only).strip()
        candidates = [path for path in candidates if path.stem.endswith(wanted)]
        if not candidates:
            _note(f"--only {wanted}：收件箱里没有匹配的待处理项（可能已消费并归档；不改任何状态）")

    archived = _archived_facts(inbox)
    ledger: Ledger | None = None
    applied: list[dict] = []
    duplicates: list[dict] = []
    refused: list[dict] = []
    ledger_added = 0
    status_creds: dict = {}

    def append(event: str, payload: dict, correlation: str) -> bool:
        nonlocal ledger, ledger_added
        body = _body(event, payload)
        if ledger is None:
            ledger = Ledger(ledger_file, realm=REALM)
        ref = ledger.append(event, body, correlation_id=correlation, actor=actor_ref, ts=now)
        if not ref.duplicate:
            ledger_added += 1
        return not ref.duplicate

    for path in candidates:
        item, reason = _load_item(path)
        if reason is not None:
            refused.append(_refusal(reason, path))
            _note(f"拒绝 {path.name}：{reason}")
            if not args.dry_run:
                append(EVENT_REFUSED, {"layer": "unknown", "target": path.stem,
                                       "key_path": None, "keys": [], "reason": "item-invalid", "actor": actor_ref,
                                       "approval_ref": approval_ref, "schema": SCHEMA, "ts": now},
                       f"config:refused:{path.stem}")
            continue
        assert item is not None
        layer, target, fields = item["layer"], item["target"], item["fields"]
        digest = item["payload_sha256"]
        if (layer, target, digest) in archived:
            duplicates.append({"request_id": item["request_id"], "layer": layer, "target": target,
                               "status": "duplicate", "file": str(path),
                               "reason": "归档/账本里已有同 (layer, target, payload_sha256) 的事实（幂等：零新增）"})
            _note(f"重复（duplicate）{path.name}：幂等零新增；原件保留在收件箱（不重复归档、不覆盖）")
            continue
        reasons = validate_item(item, keys=keys, creds=creds, schema=schema)
        if reasons:
            refused.append(_refusal(reasons[0]["reason"], path, code=reasons[0]["code"],
                                    keys=sorted(fields), layer=layer))
            _note(f"拒绝 {path.name}：{reasons[0]['code']}（{reasons[0]['reason']}）")
            if not args.dry_run:
                append(EVENT_REFUSED, {"layer": layer, "target": target, "key_path": None,
                                       "keys": sorted(fields), "reason": reasons[0]["code"], "actor": actor_ref,
                                       "approval_ref": approval_ref, "schema": SCHEMA, "ts": now},
                       f"config:refused:{item['request_id']}")
            continue

        # --- 读旧值（合并基准 + 账本只记摘要）---
        try:
            before_doc = read_managed_sections(file_obj.read_text(encoding="utf-8")) if file_obj.exists() else {}
        except (OSError, YamlError):
            before_doc = {}

        # --- 组装写入内容 ---
        updates: dict = {}
        expect: dict = {}
        old_digests: dict = {}
        secret_path: Path | None = None
        if layer == "project":
            updates["project"] = {key: fields[key] for key in sorted(fields)}
            for key in sorted(fields):
                expect[f"project|{key}"] = fields[key]
        elif layer == "plugin":
            updates["plugins"] = {target: {key: fields[key] for key in sorted(fields)}}
            # 回读校验要比**合并后的整段**（多次提交同一插件时逐字段都要在）
            current = before_doc.get("plugins", {}).get(target) or {}
            expect[f"plugins|{target}"] = {**current, **{key: fields[key] for key in sorted(fields)}}
        else:  # credential：YAML 只登记指针；值落 0600 文件
            declared = creds[target]
            cred_dir = str(args.cred_dir or "")
            if cred_dir:
                secret_path = Path(cred_dir) / f"{target}.secret"
            elif declared["file"]:
                secret_path = Path(declared["file"])
            else:
                refused.append(_refusal("credential-file-undecided（未给 --cred-dir，登记表里也没有默认落点）", path,
                                        code="credential-file-undecided", keys=["value"], layer=layer))
                if not args.dry_run:
                    append(EVENT_REFUSED, {"layer": layer, "target": target, "key_path": None, "keys": ["value"],
                                           "reason": "credential-file-undecided", "actor": actor_ref,
                                           "approval_ref": approval_ref, "schema": SCHEMA, "ts": now},
                           f"config:refused:{item['request_id']}")
                continue
            updates["credentials"] = {target: {"source": "file", "file": str(secret_path),
                                               "env": declared["env"], "required_mode": declared["required_mode"],
                                               "fingerprint_first8": hashlib.sha256(fields["value"].encode()).hexdigest()[:8]}}

        if layer == "credential":
            assert secret_path is not None   # 上面所有分支要么赋了值、要么 continue

        # --- 旧值摘要（账本只记摘要）---
        for key in sorted(fields):
            if layer == "project":
                old = before_doc.get("project", {}).get(key)
            elif layer == "plugin":
                old = (before_doc.get("plugins", {}).get(target) or {}).get(key)
            else:
                old = None
            old_digests[key] = None if old is None else f"sha256:{hashlib.sha256(canonical(old).encode()).hexdigest()}"

        if args.dry_run:
            applied.append({"request_id": item["request_id"], "layer": layer, "target": target,
                            "keys": sorted(fields), "dry_run": True,
                            "events": ([EVENT_CHANGED] * len(fields)) if layer != "credential" else [EVENT_ROTATED]})
            continue

        # --- 凭据：先落 0600 文件（唯一带值的写面），再写 YAML 指针 ---
        if layer == "credential":
            try:
                _write_secret(secret_path, fields["value"])
            except OSError as exc:
                refused.append(_refusal(f"凭据文件写失败：{type(exc).__name__}", path, code="secret-write-failed",
                                        keys=["value"], layer=layer))
                append(EVENT_REFUSED, {"layer": layer, "target": target, "key_path": None, "keys": ["value"],
                                       "reason": "secret-write-failed", "actor": actor_ref,
                                       "approval_ref": approval_ref, "schema": SCHEMA, "ts": now},
                       f"config:refused:{item['request_id']}")
                continue
            mode = oct(stat.S_IMODE(os.stat(secret_path).st_mode))
            if mode != "0o600":
                refused.append(_refusal(f"凭据文件权限不是 600（收到 {mode}）", path, code="secret-mode",
                                        keys=["value"], layer=layer))
                append(EVENT_REFUSED, {"layer": layer, "target": target, "key_path": None, "keys": ["value"],
                                       "reason": "secret-mode", "actor": actor_ref, "approval_ref": approval_ref,
                                       "schema": SCHEMA, "ts": now},
                       f"config:refused:{item['request_id']}")
                continue

        # --- 写 YAML（原子写 + 回读校验 + 失败回滚）---
        ok, detail = apply_to_file(file_obj, updates, expect=expect)
        if not ok:
            refused.append(_refusal(detail["reason"], path, code="write-refused", keys=sorted(fields), layer=layer))
            _note(f"拒绝 {path.name}：{detail['reason']}（已回滚，目标文件与写入前一致）")
            append(EVENT_REFUSED, {"layer": layer, "target": target, "key_path": None, "keys": sorted(fields),
                                   "reason": str(detail["reason"]).split(":")[0], "actor": actor_ref,
                                   "approval_ref": approval_ref, "schema": SCHEMA, "ts": now},
                   f"config:refused:{item['request_id']}")
            continue

        # --- 文件落定后再落账本（顺序固定；账本失败 → 回滚文件）---
        events: list[dict] = []
        try:
            if layer == "credential":
                value = fields["value"]
                sha = hashlib.sha256(value.encode()).hexdigest()
                payload = {"name": target, "configured": True, "fingerprint_first8": sha[:8],
                           "value_sha256": f"sha256:{sha}", "mode": "0600", "source": "file",
                           "actor": actor_ref, "approval_ref": approval_ref, "schema": SCHEMA, "ts": now}
                append(EVENT_ROTATED, payload, f"config:{layer}:{target}:{item['request_id']}")
                events.append(EVENT_ROTATED)
                status_creds[target] = {"configured": True, "source": "file",
                                        "required_mode": creds[target]["required_mode"],
                                        "fingerprint_first8": sha[:8], "file": str(secret_path),
                                        "mode": "0600", "updated_at": now}
            else:
                for key in sorted(fields):
                    new = fields[key]
                    new_digest = f"sha256:{hashlib.sha256(canonical(new).encode()).hexdigest()}"
                    payload = {"layer": layer, "target": target if layer != "project" else key,
                               "key_path": key, "old_digest": old_digests[key], "new_digest": new_digest,
                               "source": f"human:{actor_ref[6:]}", "actor": actor_ref,
                               "approval_ref": approval_ref, "schema": SCHEMA, "ts": now}
                    append(EVENT_CHANGED, payload, f"config:{layer}:{target}:{key}:{item['request_id']}")
                    events.append(EVENT_CHANGED)
        except Exception as exc:  # noqa: BLE001 —— 账本拒绝（冻结/链断）就是拒绝落账：回滚文件
            _restore(file_obj, file_obj.parent / f"{file_obj.name}.bak" if file_obj.exists() else None)
            refused.append(_refusal(f"账本拒绝追加：{type(exc).__name__}", path, code="ledger-refused",
                                    keys=sorted(fields), layer=layer))
            _note(f"拒绝 {path.name}：账本拒绝追加（{type(exc).__name__}）；文件已回滚（生效 ⟺ 可见）")
            continue

        # --- 归档（凭据类先脱敏）+ 幂等记账 ---
        if layer == "credential":
            redacted = {"request_id": item["request_id"], "layer": layer, "target": target,
                        "fields": {"value": None}, "payload_sha256": digest, "bytes": item["bytes"], "schema": SCHEMA,
                        "submitted_at": None, "submitted_by": "admin-session", "redacted": True,
                        "value_sha256": f"sha256:{hashlib.sha256(fields['value'].encode()).hexdigest()}",
                        "fingerprint_first8": hashlib.sha256(fields["value"].encode()).hexdigest()[:8],
                        "plaintext_removed": True}
            moved = _archive(inbox, path, f"cfg-{item['request_id']}", record=redacted)
        else:
            moved = _archive(inbox, path, f"cfg-{item['request_id']}")
        archived.add((layer, target, digest))
        applied.append({"request_id": item["request_id"], "layer": layer, "target": target,
                        "keys": sorted(fields), "events": events, "archive": str(moved.name),
                        "file": str(file_obj), "mode": detail.get("mode")})
        _note(f"应用 {path.name} → {len(events)} 条事件 {sorted(set(events))}；待处理项移入 {moved.name}")

    if status_creds and str(args.status or "").strip() and not args.dry_run:
        _status_snapshot(Path(str(args.status)), now, status_creds, applied)

    return _emit(not refused, applied, duplicates, refused, ledger_added, file=str(file_obj),
                 inbox=str(inbox), approval_ref=approval_ref, actor=actor_ref, now=now)


if __name__ == "__main__":
    raise SystemExit(main())
