"""tools/userplugin-elevate.py —— 提权（用户空间插件 → 系统级插件）的**唯一写树/写账本**一方。

分工（ADR-0016 / FR-USERPLUG-010 ⑤）：
  · 宿主管理面 `user-plugin-manager.elevateRequest()` 只产**待办载荷**（校验人工门引用形状 + 影子哈希一致，
    **零写面**）；
  · 本脚本消费待办载荷：复核哈希 → 写入晋升目标 → 落 `userplugin/elevated` → 待办件移入 `applied/`。

拒绝码（每条都不写树、不写账本 —— 由 `AC-USERPLUG-010` 的负控断言）：
  `packet-invalid` / `elevate-needs-approval` / `approval-ref-malformed` / `approval-ref-not-human`
  / `shadow-hash-mismatch` / `target-outside-promote-dir` / `target-name-mismatch` / `target-exists`
  / `user-space-outside-ns`

约定：
  · `approval_ref` 形状 `ap-NNNN`；`--actor` 必须是 `human:<id>`（**人工门**：agent 不能自己给插件提权）；
  · 影子哈希 = **现在**重算用户空间产物（含 `plugin.json`）的 sha256，必须等于载荷里的 `manifest_sha256`
    —— 载荷是旧的、或产物被改过，一律拒绝（不许用陈旧证据晋升）；
  · 目标必须恰是 `<promote-dir>/<manifest.name>.mjs`，且**已存在即拒绝**（不覆盖已在树里的模块）。
  · `--promote-dir` 默认 `host/modules`；仅供夹具/测试指向临时目录（写入面不变：越界即拒）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROMOTE_DIR = ROOT / 'host' / 'modules'
NAME_RE = r'^[a-z][a-z0-9-]{0,40}$'
APPROVAL_RE = r'^ap-\d{4}$'


def emit(payload: dict, rc: int) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return rc


def sha256_text(text: str) -> str:
    return 'sha256:' + hashlib.sha256(text.encode('utf-8')).hexdigest()


def artifact_hash(plugin_dir: Path) -> tuple[str, int]:
    """产物哈希 —— **与宿主同一口径**：`sha256(清单里 artifact 指向的那个文件)`。

    宿主的 `scan()` 比的是 `manifest.sha256`（等于产物文件的 sha256），所以两侧必须逐字节同构：
    口径不一致会让"影子哈希一致"永远不成立（线上第一次提权就是这样被拒的，见 D-065）。
    """
    try:
        manifest = json.loads((plugin_dir / 'plugin.json').read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return '', 0
    artifact = manifest.get('artifact') if isinstance(manifest, dict) else None
    name = artifact if isinstance(artifact, str) and artifact else 'index.mjs'
    f = plugin_dir / name
    if not f.is_file():
        return '', 0
    data = f.read_bytes()
    return 'sha256:' + hashlib.sha256(data).hexdigest(), len(data)


def legacy_artifact_hash(plugin_dir: Path) -> str:
    """**旧口径**（index.mjs + plugin.json 拼接）—— 只用来识别"口径变更前记下的记录"，
    避免把"口径改了"误报成"内容变了"（那会往账本里写一条假的 `upgraded`）。"""
    blobs = []
    for name in ('index.mjs', 'plugin.json'):
        f = plugin_dir / name
        if not f.is_file():
            return ''
        blobs.append(f.read_bytes())
    return 'sha256:' + hashlib.sha256(b''.join(blobs)).hexdigest()


def norm(value: object) -> str:
    s = str(value or '').strip().lower()
    return s.split(':', 1)[1] if s.startswith('sha256:') else s


def read_packets(inbox: Path) -> list[dict]:
    out: list[dict] = []
    for f in sorted(inbox.glob('*.json')):
        try:
            out.append({**json.loads(f.read_text(encoding='utf-8')), '_file': f})
        except Exception:  # noqa: BLE001 坏载荷 → 判 packet-invalid（不猜内容）
            out.append({'kind': '', '_file': f, '_broken': True})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='提权：用户空间插件 → 系统级插件（人工门 + 影子哈希）')
    ap.add_argument('--requests', required=True, help='提权待办件目录（0600 载荷）')
    ap.add_argument('--user-space', required=True, help='用户空间根目录')
    ap.add_argument('--ledger', required=True, help='账本路径（本脚本是唯一写者）')
    ap.add_argument('--promote-dir', default=str(DEFAULT_PROMOTE_DIR),
                    help='晋升目标目录（默认 host/modules；夹具可指临时目录）')
    ap.add_argument('--actor', default='', help='必须是 human:<id>（人工门）')
    ap.add_argument('--now', default='', help='时间戳（可复现）')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args(argv)

    sys.path.insert(0, str(ROOT / 'src'))
    from quotagent.kernel.ledger import Ledger  # noqa: PLC0415

    inbox = Path(args.requests)
    user_space = Path(args.user_space)
    promote_dir = Path(args.promote_dir)
    ledger = Ledger(Path(args.ledger))

    applied: list[dict] = []
    refused: list[dict] = []
    for packet in read_packets(inbox):
        label = Path(str(packet.get('_file'))).name

        def refuse(code: str, why: str, extra: dict | None = None) -> None:
            refused.append({'file': label, 'code': code, 'reason': why, **(extra or {})})
            if not args.dry_run:
                ledger.append('userplugin/refused', {'ns': str(packet.get('ns') or ''),
                                                     'plugin': str(packet.get('plugin') or ''),
                                                     'code': code, 'schema': 1},
                              correlation_id=f'upe-refuse-{label}-{code}')

        if packet.get('_broken') or packet.get('kind') != 'plugin-elevation-request':
            refuse('packet-invalid', '载荷不是提权待办件或不是合法 JSON')
            continue
        ns, plugin = str(packet.get('ns') or ''), str(packet.get('plugin') or '')
        import re
        if not re.match(NAME_RE, ns) or not re.match(NAME_RE, plugin):
            refuse('user-space-outside-ns', f'命名空间或插件名非法：{ns}/{plugin}')
            continue
        ref = str(packet.get('approval_ref') or '').strip()
        if ref == '':
            refuse('elevate-needs-approval', '载荷里没有人工门引用')
            continue
        if not re.match(APPROVAL_RE, ref):
            refuse('approval-ref-malformed', f'人工门引用形状不对：{ref}')
            continue
        actor = args.actor.strip()
        if not actor.startswith('human:'):
            refuse('approval-ref-not-human', f'提权必须由人类 actor 发起（当前 actor={actor or "空"}）')
            continue

        pdir = user_space / ns / plugin
        if not pdir.is_dir():
            refuse('plugin-not-found', f'用户空间里没有 {ns}/{plugin}')
            continue
        try:
            manifest = json.loads((pdir / 'plugin.json').read_text(encoding='utf-8'))
        except Exception:  # noqa: BLE001
            refuse('manifest-invalid', 'plugin.json 读不动或不是合法 JSON')
            continue
        module_name = str(manifest.get('name') or plugin)
        if not re.match(NAME_RE, module_name):
            refuse('target-name-mismatch', f'清单里的 name 非法：{module_name}')
            continue

        cur_hash, nbytes = artifact_hash(pdir)
        if cur_hash == '' or norm(cur_hash) != norm(packet.get('manifest_sha256')):
            refuse('shadow-hash-mismatch',
                   f'影子哈希不一致（载荷 {str(packet.get("manifest_sha256"))[:20]}… vs 现算 {cur_hash[:20]}…）：'
                   '载荷是旧的或产物被改过 → 需要重新申请')
            continue

        target = (promote_dir / f'{module_name}.mjs').resolve()
        if promote_dir.resolve() not in target.parents:
            refuse('target-outside-promote-dir', f'目标越出晋升目录：{target}')
            continue
        if target.is_file():
            refuse('target-exists', f'目标已存在（不覆盖树里的模块）：{target.name}')
            continue

        if not args.dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pdir / 'index.mjs', target)
            ledger.append('userplugin/elevated',
                          {'ns': ns, 'plugin': plugin, 'module': module_name,
                           'target': f'{promote_dir.name}/{target.name}',
                           'artifact_sha256': cur_hash, 'shadow_sha256': norm(packet.get('manifest_sha256')),
                           'approval_ref': ref, 'actor': actor, 'bytes': nbytes, 'schema': 1},
                          correlation_id=f'upe-elevate-{ns}-{plugin}-{ref}')
        applied.append({'file': label, 'ns': ns, 'plugin': plugin, 'module': module_name,
                        'target': str(target), 'artifact_sha256': cur_hash, 'approval_ref': ref,
                        'next_actions': ['补 docs/design/14-plugin-inventory.md 登记行',
                                         '按需挂进 profile/CLI（模块要真正被使用）',
                                         '跑 tools/verify.sh modules plugins webui']})

    if not args.dry_run and applied:
        done = inbox / 'applied'
        done.mkdir(parents=True, exist_ok=True)
        for item in applied:
            src = inbox / item['file']
            if src.is_file():
                shutil.move(str(src), str(done / item['file']))

    ok = bool(refused) is False
    return emit({'ok': ok, 'applied': applied, 'refused': refused,
                 'ledger_added': 0 if args.dry_run else len(applied),
                 'dry_run': bool(args.dry_run), 'promote_dir': str(promote_dir)}, 0 if ok else 1)


if __name__ == '__main__':
    raise SystemExit(main())
