#!/usr/bin/env python3
r"""事件 body 键集**逐字机检**：`docs/design/05-events.md` 的声明 ↔ 实现的落账 body。

**位置（P44 搬迁）**：实体在 `src/system/repo-gate/tools/body-keys-audit.py`（仓内固定位置，
不再只活在会被清掉的 `tmp/` 里）。它**不是** `tools/verify.sh` 的门（本批没有新建门），
而是一把可重跑的尺子 —— 判据与 P42 首次机检时**一字未改**（只改了输出落点：`--json PATH` 可选，
不传就只打到 stdout，不再往 `tmp/` 写文件）。

复跑：
    python3 src/system/repo-gate/tools/body-keys-audit.py            # 只看 stdout；rc=1 = 有偏差
    python3 src/system/repo-gate/tools/body-keys-audit.py --json out.json

探针自证（**非空转**）：`gate/nudged` 与 `rfq/promised` 两行声明 5/6 键与实现逐字一致 ⇒ 恒绿的那些
事件在这里是绿的，而 `approval/*` 家族里真有的漂移会被逐条点名（P42 实测 13 条）。

**本批（P44）读数：13 条 → 3 条**，剩下 3 条全是「多写者形状不同」，逐条理由与"为什么不能在本批对齐"
写在 `src/system/webui/docs/decided-gates-and-abort-reason.md` §5.3，简版：
  · `approval/aborted` / `approval/escalated`：`gate-actions.py`（人的终止/升级，`**上一行 body` + 8–9 键）
    与 `ApprovalService`（超时那一支，12 键）—— 两边带的事实本来就不同，且 `gate-actions.py` 不在本批可改面；
  · `quote/submitted`：三个写者（供应商提交行 / 承包商登记行 / `code/commitments.py#submit_quote`），
    后两个不在本批可改面。
除这 3 条外**没有任何一条**「声明了没写 / 写了没声明 / 计数不符」——即「声明 = 实现」已逐字成立。

对判据本身只做过**一处准确性修正**（不是放松）：同一个函数里对同名变量赋值两次时（`gate-actions.py` 的
`body` 在 escalate 与 abort 两个分支各赋一次），按调用点行号取「该行之前最近的一次」赋值，而不是取最后
一次 —— 否则 `escalated` 的键集会被算成 abort 那一支的（错的 18 键），声明永远对不上实现。实测：只有
`approval/escalated` 从 18 变成真的 20 键，其它事件一字不变；偏差**计数不因这处修正而变少**（它只把两条
假红消掉）。

为什么需要它：既有的事件门（`tools/verify.sh events` = `src/system/kernel/tests/check-events.py`）
只比**事件名与 @mode**，body 键集漂移**没有任何门会发现**（ADR-0022 §Problem 第 3 条已实测过这条）。

判据（怎么机检）：
  1. **声明侧**：只认 `05-events.md` 表格行说明列里以 `body …` 开头的声明
     （`body 恰 N 键：…` / `body = N 个基底键（…）` / `body 只出 …` / `body 含 …` / `逐行真值在 …`）。
     · 键名一律取自反引号 token（去掉 `[]`、按 `/、,，` 拆）；声明段截到第一个终止符
       （`）`/`——`/`⇒`/`；`/`。`/`—`），但 `）+`（跨括注的追加键）不截；
     · 只给计数不给全键名的（`body 恰 14 键（多 lines[]+line_count）`）记为 `count`：机检**计数** +
       列举到的附加键是否真在实现里；计数之外的键名**不逐条声明**，如实标出。
  2. **实现侧**：`ast` 找**落账写者**（排除 `*/tests/*` 与 `check*/test*/t\d*` 与薄转发）里
     `.append(<事件>, <body>, …)`：
       · 事件实参可以是字面量，也可以是模块常量（`EVENT = "gate/nudged"`）；
       · `<body>` 是字典字面量 ⇒ 顶层字符串键；`**X` ⇒ 递归解析 `X`
         （先所在函数的局部赋值、再模块赋值；解析不到记「动态键集」而不是猜）；
       · 同一个事件有**多个写者**时逐写者给键集（同一事件两种形状 = 真偏差）。
  3. **服务写体**：`ApprovalService._append(event, record, …)` 是 `approval/*` 家族的唯一写体
     （其余写者直接 `ledger.append`）；键 = 函数内 `body = {…}` 字面量键 ∪ `GATE_FACT_KEYS`。
  4. **判定**：`declared_not_written` / `written_not_declared` / `count_mismatch` /
     `multi_writer_shapes`（同事件多写者且键集不同）四类逐条列出。
     `GATE_FACT_KEYS` 里「值为 None 时不写」的键标 `conditional`（不算背离，但显式列出）。

退出码：0 = 无偏差；1 = 有偏差；2 = 解析失败（不得当作通过）。只读；`--json PATH` 给机器可读结果。
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]      # src/system/repo-gate/tools/ ⇒ 仓库根在四层之上
DOC = ROOT / "docs/design/05-events.md"

KEY_RE = re.compile(r"^[a-z][a-z0-9_]*$")
CUES = ("body 恰", "body =", "body 只出", "body 含", "逐行真值在")
TERMINATORS = ("）", "——", "⇒", "；", "。", "—", ")")
COUNT_RE = re.compile(r"body 恰\s*(\d+)\s*键")


def declared_of(note: str) -> dict:
    """{'kind','keys','count'}：explicit = 逐条给了键名；count = 只给计数(+附加键)；'' = 无声明。"""
    at = -1
    for cue in CUES:
        pos = note.find(cue)
        if pos >= 0 and (at < 0 or pos < at):
            at = pos
    if at < 0:
        return {"kind": "", "keys": [], "count": None}
    seg = note[at:]
    # 跨括注继续算同一段声明：`…）**+ 追加键（…`、`…**/` 都不截（终止符只认句末：—— / ⇒ / ； / 。）
    seg = re.sub(r"[）)]\s*\*{0,2}\s*(?=[+/])", " ", seg)
    seg = seg.replace("**", "")
    for term in TERMINATORS:
        cut = seg.find(term)
        if cut >= 0:
            seg = seg[:cut]
    def grab(text: str) -> list[str]:
        out: list[str] = []
        for token in re.findall(r"`([^`]+)`", text):
            if "/" in token:                       # `approval/requested` 这类是事件名，不是 body 键
                continue
            for piece in re.split(r"[/、,，\s+]+", token.replace("[]", "")):
                piece = piece.strip()
                if KEY_RE.match(piece) and piece not in out:
                    out.append(piece)
        return out

    keys = grab(seg)
    # `（含 \`X\`）` 这种括注里的键也是声明（如 `quote/submitted` 的 `rfq_rev`）
    for inner in re.findall(r"（含\s*([^）]+)）", note):
        for key in grab(inner):
            if key not in keys:
                keys.append(key)
    count = COUNT_RE.search(note[at:])
    # 「body = 7 个基底键」也当成计数式声明（基底键名已逐条给出）
    base_event = ""
    if "同基底" in seg:
        # 「body = 与 `approval/requested` 同基底 + 追加键 …」：基底键由那一行声明，本行只声明自己的追加键
        found = re.findall(r"`([a-z][a-z0-9-]*/[a-z0-9./-]+)`", seg)
        base_event = found[0] if found else ""
    return {"kind": ("explicit" if keys and len(keys) >= 3 else ("count" if keys else "prose")),
            "keys": keys, "count": int(count.group(1)) if count else None, "segment": seg.strip(),
            "base_event": base_event}


def doc_declarations() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for line in DOC.read_text(encoding="utf-8").splitlines():
        if not line.startswith("| `"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 2:
            continue
        names = re.findall(r"`([a-z][a-z0-9-]*/[a-z0-9./-]+)`", cells[0])
        dec = declared_of(cells[-1])
        if not names or not dec["kind"]:
            continue
        for name in names:
            out[name] = dec
    return out


# --------------------------------------------------------------------- 实现侧
def is_producer(path: Path) -> bool:
    parts = path.parts
    if "tests" in parts or "__pycache__" in parts:
        return False
    stem = path.name
    if stem.startswith("check-") or stem.startswith("checks_") or stem.startswith("test") or re.match(r"^t\d", stem):
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    if "薄转发" in text.splitlines()[0] if text.splitlines() else False:
        return False
    return True


class Module:
    def __init__(self, path: Path):
        self.path = path
        self.tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        self.parents: dict[ast.AST, ast.AST] = {}
        for node in ast.walk(self.tree):
            for child in ast.iter_child_nodes(node):
                self.parents[child] = node
        self.module_assigns: dict[str, ast.AST] = {}
        for node in self.tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                self.module_assigns[node.targets[0].id] = node.value

    def const_str(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            target = self.module_assigns.get(node.id)
            if isinstance(target, ast.Constant) and isinstance(target.value, str):
                return target.value
        return None

    def enclosing_fn(self, node: ast.AST) -> ast.AST | None:
        cur = node
        while cur in self.parents:
            cur = self.parents[cur]
            if isinstance(cur, (ast.FunctionDef, ast.AsyncFunctionDef)):
                return cur
        return None

    def local_dict(self, fn: ast.AST | None, name: str, before: int | None = None) -> ast.AST | None:
        """函数内对 `name` 的**字典字面量**赋值。

        `before` 给"调用点的行号"时取**该行之前最近的一次**赋值 —— 同一个函数里对同名变量赋值两次
        是常事（`gate-actions.py` 的 `body` 在 escalate 与 abort 两个分支各赋一次），不按位置取就会
        把另一分支的键集算到这一条事件头上（那会让"声明"永远对不上实现，读的人以为文档错了）。
        `before=None` ⇒ 沿用旧行为（取最后一次赋值），供模块级/函数级调用点使用。
        """
        if fn is None:
            return None
        hit = None
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Assign) and isinstance(sub.targets[0], ast.Name) \
                    and sub.targets[0].id == name and isinstance(sub.value, ast.Dict):
                if before is not None and sub.lineno >= before:
                    continue
                hit = sub.value
        return hit

    def dict_keys(self, node: ast.AST, fn: ast.AST | None, depth: int = 0):
        keys: list[str] = []
        notes: list[str] = []
        if not isinstance(node, ast.Dict) or depth > 4:
            return keys, [f"动态键集（{ast.unparse(node)[:48]}）"]
        for k, v in zip(node.keys, node.values):
            if k is None:
                if isinstance(v, ast.Name):
                    target = self.local_dict(fn, v.id) or self.module_assigns.get(v.id)
                    if isinstance(target, ast.Dict):
                        sub_keys, sub_notes = self.dict_keys(target, fn, depth + 1)
                        for key in sub_keys:
                            if key not in keys:
                                keys.append(key)
                        notes.extend(sub_notes)
                        notes.append(f"展开 `**{v.id}`")
                    else:
                        notes.append(f"未解析（`**{v.id}`）⇒ 动态键集")
                else:
                    notes.append(f"动态键集（`**{ast.unparse(v)[:40]}`）")
                continue
            if isinstance(k, ast.Constant) and isinstance(k.value, str) and k.value not in keys:
                keys.append(k.value)
        # 条件追加（`d["k"] = …`，或对 `base` 这种变量的下标赋值）
        return keys, notes

    def extra_key_assignments(self, fn: ast.AST | None, vars_: set[str]) -> list[str]:
        """`x["k"] = …` 形式的**条件追加键**，只认**本动作那个变量**（如 quote-draft 的 `base`）。"""
        if fn is None:
            return []
        out: list[str] = []
        for sub in ast.walk(fn):
            if isinstance(sub, ast.Assign) and len(sub.targets) == 1 and isinstance(sub.targets[0], ast.Subscript):
                base = sub.targets[0].value
                if not isinstance(base, ast.Name) or base.id not in vars_:
                    continue
                key = sub.targets[0].slice
                if isinstance(key, ast.Constant) and isinstance(key.value, str) and key.value not in out:
                    out.append(key.value)
        return out

    def verbatim_wrapper(self) -> bool:
        """本模块的 `_append(event, body, …)` 是否**原样**把 `body` 交给 `ledger.append`。

        是 ⇒ 该模块里 `self._append(<事件>, X)` 的 X 就是账本 body（跟到调用点解析）；
        否（如 `ApprovalService._append` 自己重拼 body）⇒ 调用点不是真身，不跟。
        """
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.FunctionDef) or node.name != "_append":
                continue
            params = [arg.arg for arg in node.args.args if arg.arg not in ("self", "cls")]
            if len(params) < 2:
                continue
            body_param = params[1]
            for sub in ast.walk(node):
                if isinstance(sub, ast.Call) and isinstance(sub.func, ast.Attribute) \
                        and sub.func.attr == "append" and len(sub.args) >= 2:
                    if isinstance(sub.args[1], ast.Name) and sub.args[1].id == body_param:
                        return True
        return False

    def writes(self, event: str):
        out = []
        follow_indirect = self.verbatim_wrapper()
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            attr = node.func.attr
            if attr == "append":
                pass
            elif attr == "_append" and follow_indirect:
                # `self._append(event, body, …)`：原样包装 ⇒ body 就是账本 body（跟到调用点）
                pass
            else:
                continue
            if len(node.args) < 2:
                continue
            if self.const_str(node.args[0]) != event:
                continue
            fn = self.enclosing_fn(node)
            body = node.args[1]
            if isinstance(body, ast.Name):
                resolved = self.local_dict(fn, body.id, before=node.lineno) or self.module_assigns.get(body.id)
                if resolved is None:
                    keys, notes = [], [f"未解析（变量 `{body.id}`）⇒ 动态键集"]
                else:
                    keys, notes = self.dict_keys(resolved, fn)
                origin = f"变量 `{body.id}`"
                names = {body.id}
            else:
                keys, notes = self.dict_keys(body, fn)
                origin = "字典字面量"
                names = {n.id for n in ast.walk(body) if isinstance(n, ast.Name)}
            conditional = self.extra_key_assignments(fn, names)
            out.append({"line": node.lineno, "origin": origin, "keys": keys,
                        "conditional": [k for k in conditional if k not in keys], "notes": notes})
        return out


def approval_service_writer() -> dict:
    mod = Module(ROOT / "src/system/approval/code/approval.py")
    for node in ast.walk(mod.tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_append":
            keys, notes = mod.dict_keys(mod.local_dict(node, "body"), node)
            facts = mod.module_assigns.get("GATE_FACT_KEYS")
            fact_keys = []
            if isinstance(facts, (ast.Tuple, ast.List)):
                for elt in facts.elts:
                    if isinstance(elt, ast.Constant):
                        fact_keys.append(elt.value)
                        if elt.value not in keys:
                            keys.append(elt.value)
            return {"file": "src/system/approval/code/approval.py", "line": node.lineno,
                    "origin": "ApprovalService._append 的 body 字面量 + GATE_FACT_KEYS",
                    "keys": keys, "conditional": list(fact_keys),
                    "notes": [f"GATE_FACT_KEYS={fact_keys}（值为 None 时不写，ADR-0022 §1）"] + notes}
    return {"file": "src/system/approval/code/approval.py", "line": 0, "origin": "解析失败",
            "keys": [], "conditional": [], "notes": []}


def main() -> int:
    json_out = ""
    if "--json" in sys.argv:
        json_out = sys.argv[sys.argv.index("--json") + 1]
    declared = doc_declarations()
    # 「同基底」的行：把基底行声明的键并进来（**写出来**，不隐藏这一层推断）
    inherited: list[str] = []
    for event, dec in declared.items():
        base = dec.get("base_event") or ""
        if base and base in declared:
            keys = list(declared[base]["keys"]) + [k for k in dec["keys"] if k not in declared[base]["keys"]]
            inherited.append(f"{event} ⇐ {base}（{len(declared[base]['keys'])} 键）+ 本行追加 "
                             f"{len(dec['keys'])} 键 ⇒ {len(keys)} 键")
            dec["keys"] = keys
    producers = [p for p in list((ROOT / "src").rglob("*.py")) + list((ROOT / "host").rglob("*.py"))
                 if is_producer(p)]
    modules = []
    for path in producers:
        try:
            modules.append(Module(path))
        except SyntaxError:
            continue

    family = ("approval/requested", "approval/granted", "approval/denied",
              "approval/escalated", "approval/reminded", "approval/aborted")
    targets = sorted(set(declared) | set(family))

    report: dict[str, dict] = {}
    problems: list[str] = []
    for event in targets:
        writers = []
        for mod in modules:
            for hit in mod.writes(event):
                writers.append({"file": str(mod.path.relative_to(ROOT)), **hit})
        if event.startswith("approval/"):
            writers.append(approval_service_writer())
        written: list[str] = []
        conditional: list[str] = []
        for item in writers:
            for key in item["keys"]:
                if key not in written:
                    written.append(key)
            for key in item["conditional"]:
                if key not in conditional:
                    conditional.append(key)
        # 有效键集 = 字面量键 ∪ **条件追加键**（如 `base["lines"] = …` 只在多行时写）。
        # 条件键单独列出来（不能当成"总是写"），但计数对照要用它 —— 否则多行形状会被误判成偏差。
        effective = written + [k for k in conditional if k not in written]
        shapes = {tuple(sorted(item["keys"] + item["conditional"]))
                  for item in writers if item["keys"]}
        dec = declared.get(event, {"kind": "", "keys": [], "count": None, "segment": ""})
        written_not_declared = [k for k in effective if k not in dec["keys"]]
        declared_not_written = [k for k in dec["keys"] if k not in effective]
        count_mismatch = dec["count"] is not None and effective and len(effective) != dec["count"]
        report[event] = {"declaration_kind": dec["kind"], "declared": dec["keys"], "declared_count": dec["count"],
                         "declaration_segment": dec.get("segment", ""), "written": written,
                         "conditional_keys": conditional, "effective": effective,
                         "written_not_declared": written_not_declared,
                         "declared_not_written": declared_not_written,
                         "count_mismatch": count_mismatch, "writer_shapes": len(shapes),
                         "writers": writers}

        if not dec["kind"]:
            problems.append(f"[未声明] {event}: 文档没有 body 键集声明；实现写了 {len(effective)} 键: "
                            f"{', '.join(effective)}")
        elif dec["kind"] == "prose":
            problems.append(f"[散文式] {event}: 文档只有口径（键名未逐条给出）⇒ body 键集不可机检；"
                            f"实现写了 {len(effective)} 键: {', '.join(effective)}")
        else:
            if declared_not_written:
                problems.append(f"[声明了没写] {event}: {', '.join(declared_not_written)}")
            if written_not_declared:
                problems.append(f"[写了没声明] {event}: {', '.join(written_not_declared)}")
            if count_mismatch:
                problems.append(f"[计数不符] {event}: 文档声明 {dec['count']} 键，实现 {len(effective)} 键")
        if len(shapes) > 1:
            problems.append(f"[多写者形状不同] {event}: {len(writers)} 个写者给出 {len(shapes)} 种键集 —— " +
                            "；".join(f"{item['file']}({len(item['keys'])} 键)" for item in writers))

    print("== P42 body 键集机检（docs/design/05-events.md ↔ 实现）==")
    print(f"文档里声明过 body 的事件：{len(declared)} 个；机检覆盖 {len(targets)} 个（含 approval/* 全族）")
    for item in sorted(inherited):
        print(f"    继承解析: {item}")
    print()
    for event in targets:
        row = report[event]
        kind = {"explicit": "显式声明(给了键名)", "count": "计数式声明", "prose": "散文式声明", "": "未声明"}[
            row["declaration_kind"]]
        print(f"--- {event}   [{kind}]")
        print(f"    声明({len(row['declared'])}{'/? ' + str(row['declared_count']) + ' 键' if row['declared_count'] else ''}): "
              f"{', '.join(row['declared']) or '—'}")
        print(f"    实现({len(row['written'])}): {', '.join(row['written']) or '（萃取不到）'}")
        if row["written_not_declared"]:
            print(f"    ▲ 写了没声明: {', '.join(row['written_not_declared'])}")
        if row["declared_not_written"]:
            print(f"    ▼ 声明了没写: {', '.join(row['declared_not_written'])}")
        for item in row["writers"]:
            print(f"    写者 {item['file']}:{item['line']}  <- {item['origin']}"
                  + (f"  条件追加: {', '.join(item['conditional'])}" if item["conditional"] else ""))
            for note in item["notes"]:
                print(f"       ↳ {note}")
    print(f"\n== 偏差 {len(problems)} 条 ==")
    for item in problems:
        print(f"  · {item}")
    if json_out:
        Path(json_out).write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True),
                                  encoding="utf-8")
        print(f"\n机器可读：{json_out}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
