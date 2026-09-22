"""AC-CONFIG-001 机检：配置/凭据 UI 与 YAML 持久化的**结构性**事实（HTTP 行为由 `verify.sh config-route` 举证）。

只读静态 + 读模块导出；**不启动服务**。无 Node 时降级并明说（ADR-0013 §8）。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from quotagent.qa.registry import Assertion, register

ROOT = Path(__file__).resolve().parents[4]
FILES = {'apply': ROOT / 'tools' / 'config-apply.py',
         # 实体已随批 EV-176 搬进插件 `code/`（旧路径只剩薄重导）：静态断言读实体那一份，否则静默判绿。
         'view': ROOT / 'src' / 'system' / 'config' / 'code' / 'config-view.mjs',
         # 库层实体已随批 EV-177 搬进本插件 `code/`（旧路径 `host/lib/config-*.mjs` 只剩薄重导 ⇒
         # 按**源码文本**判的断言必须指实体，否则读到的是一份 8 行转发：实测 `p0-no-node` 的
         # AC-CONFIG-001 就是在这里读红过 —— `keys_bytes=489`（= 转发文件的大小））。
         'ui': ROOT / 'src' / 'system' / 'config' / 'code' / 'config-ui.mjs',
         'keys': ROOT / 'src' / 'system' / 'config' / 'code' / 'config-keys.mjs'}


def _node() -> bool:
    node = os.environ.get('QUOTAGENT_NODE', 'node')
    try:
        return subprocess.run([node, '--version'], capture_output=True, timeout=30).returncode == 0
    except Exception:  # noqa: BLE001
        return False


@register('AC-CONFIG-001', 'P2', '配置/凭据 UI + YAML 持久化：宿主零写面、凭据不回显、原子写与回滚、YAML 子集',
          'tools/verify.sh ac AC-CONFIG-001')
def check() -> list[Assertion]:
    out: list[Assertion] = []
    missing = [k for k, p in FILES.items() if not p.is_file()]
    out.append(Assertion("① 四个部件齐备（Python 落盘者 / 宿主视图 / UI 库 / 键白名单）", not missing, f"缺失={missing}"))
    view = FILES['view'].read_text(encoding='utf-8') if FILES['view'].is_file() else ''
    ui = FILES['ui'].read_text(encoding='utf-8') if FILES['ui'].is_file() else ''
    keys = FILES['keys'].read_text(encoding='utf-8') if FILES['keys'].is_file() else ''
    apply_src = FILES['apply'].read_text(encoding='utf-8') if FILES['apply'].is_file() else ''
    # 宿主写入面：**只能**落 0600 待处理项（与既有已接受模式一致；见 D-070），
    # 且不得写账本、不得写产品树（树里只有 Python 侧的落盘者能改）
    scoped_0600 = ('mode: 0o600' in ui) and ('mode: 0o700' in ui) and ('writeFileSync' in ui)
    ledger_touch = bool(re.search(r"ledger|jsonl", ui + view, re.I)) and bool(re.search(r"writeFileSync\([^)]*ledger", ui + view))
    out.append(Assertion("① 宿主写入面**被限制在 0600 待处理项**（`mode:0o600` + 目录 `0o700`），且不碰账本",
                         scoped_0600 and not ledger_touch, f"scoped_0600={scoped_0600} ledger_touch={ledger_touch}"))
    out.append(Assertion("① 配置页面仍 0 行 `<script>`、0 内联事件",
                         '<script' not in view + ui and not re.search(r'\son[a-z]+=', view + ui),
                         f"script={view.count('<script') + ui.count('<script')}"))
    # 凭据只写不回显：指纹而非值；键白名单存在
    out.append(Assertion("① 凭据只给指纹（`fingerprint`）而非值；键白名单单点定义（`config-keys.mjs`）",
                         'fingerprint' in ui and bool(keys) and ('KEY' in keys or 'WHITELIST' in keys or 'whitelist' in keys.upper()),
                         f"fingerprint={'fingerprint' in ui} keys_bytes={len(keys)}"))
    # Python 落盘者：原子写 + 回滚 + 账本事件 + --init
    marks = {k: (k in apply_src) for k in ('os.replace', '.bak', 'config/changed', 'config/refused', '--init')}
    out.append(Assertion("① 落盘者具备：原子写（`os.replace`）/ 备份还原（`.bak`）/ 双向账本事件 / `--init`",
                         sum(marks.values()) >= 5, f"marks={marks}"))
    # 门已挂上
    v = (ROOT / 'tools' / 'verify.sh').read_text(encoding='utf-8')
    out.append(Assertion("① `verify.sh config-route` 门已挂（HTTP 行为由它举证）",
                         'config-route)' in v and 'check-config-route.py' in v, "gate=" + str('config-route)' in v)))
    if _node():
        r = subprocess.run(['node', '--input-type=module', '-e',
                            "import * as K from './src/system/config/code/config-keys.mjs';console.log(JSON.stringify(Object.keys(K)))"],
                           cwd=str(ROOT), capture_output=True, text=True, timeout=120)
        try:
            exported = json.loads(r.stdout.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            exported = []
        out.append(Assertion("① 键白名单模块可被加载且真的导出白名单（非空转）", bool(exported), f"exports={exported[:6]}"))
    else:
        out.append(Assertion("① 键白名单模块存在且非空（无 Node：**降级**；HTTP 行为由 `verify.sh config-route` 守卫）",
                             len(keys) > 200, f"keys_bytes={len(keys)}"))
    return out
