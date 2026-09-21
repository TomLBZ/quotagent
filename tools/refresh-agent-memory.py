"""tools/refresh-agent-memory.py —— **项目记忆 = 账本的可重建投影**（Python 侧只读重放）。

分工（ADR-0012）：Python 侧读账本产**确定性快照**（本脚本），宿主 `agent-memory` 只读该快照/或由宿主
用同样的行集 `rebuild()`；**宿主不读账本、不写文件**（H1）。本脚本**只读账本**，永不追加。

为什么要有它：记忆插件不得成为**第二条事实写路径**。"项目记忆"必须能从账本重放出来，
且**丢缓存不丢事实**（删掉快照重建后逐字节一致）。

用法：
    python3 tools/refresh-agent-memory.py --ledger <账本> --out <快照路径> [--realm contractor]
    python3 tools/refresh-agent-memory.py --ledger <账本> --check        # 重放两次比字节（确定性自证）
退出码：0 = 一致/已写；2 = 账本不可读或重放不一致（**拒绝给出假绿**）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 1
# 只有这些事件是"项目记忆"的来源（闭合集合：多一类都要显式加进来，不许静默扩大）
PROJECT_KINDS = ('rfq/published', 'rfq/amended', 'quote/submitted', 'quote/human-approved',
                  'approval/granted', 'negotiate/closed', 'award/committed', 'change/approved',
                  'clarification/answered', 'faq/entry-published', 'userplugin/created')


def _body(row: dict) -> dict:
    """行的 body，非对象一律当空对象（不猜内容）。"""
    value = row.get('body')
    return value if isinstance(value, dict) else {}


def _row_key(row: dict) -> str:
    body = _body(row)
    for candidate in ('rfq_id', 'quote_id', 'id', 'ns', 'thread_id'):
        if isinstance(body.get(candidate), str) and body[candidate]:
            return f"{row.get('type')}:{body[candidate]}"
    return f"{row.get('type')}:seq{row.get('seq')}"


def project_rows(rows: list[dict], realm: str) -> dict:
    """把账本行投影成项目记忆（**确定性**：按 seq 升序、键稳定、无墙钟、无随机）。"""
    items = []
    for row in sorted(rows, key=lambda r: int(r.get('seq') or 0)):
        typ = str(row.get('type') or '')
        if typ not in PROJECT_KINDS:
            continue
        # realm 是**前缀口径**：`contractor:con-B` 属于 `contractor`；行里没有 realm 字段的按本 realm 处理
        row_realm = str(row.get('realm') or realm)
        if realm and not (row_realm == realm or row_realm.startswith(realm + ':')):
            continue
        body = _body(row)
        items.append({
            'key': _row_key(row),
            'kind': typ,
            'seq': int(row.get('seq') or 0),
            # 引用：每一条项目记忆都指回账本行（`citations` 纪律：无引用不进记忆）
            'citations': [{'seq': int(row.get('seq') or 0),
                           'entry_hash': str(row.get('entry_hash') or '')[:32]}],
            'text': json.dumps({k: body[k] for k in sorted(body) if k not in ('private', 'body', 'subject')},
                               ensure_ascii=False, sort_keys=True)[:512],
        })
    payload = {'schema': SCHEMA, 'realm': realm, 'counts': {'items': len(items)},
               'items': items}
    digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                       separators=(',', ':')).encode('utf-8')).hexdigest()
    payload['digest'] = 'sha256:' + digest
    return payload


def render(rows: list[dict], realm: str) -> bytes:
    return (json.dumps(project_rows(rows, realm), ensure_ascii=False, sort_keys=True,
                       indent=2) + '\n').encode('utf-8')


def read_ledger(path: Path) -> list[dict]:
    if not path.is_file():
        raise FileNotFoundError(str(path))
    out = []
    for line in path.read_text(encoding='utf-8').splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description='把账本重放成项目记忆快照（只读；确定性）')
    ap.add_argument('--ledger', required=True)
    ap.add_argument('--out', default='')
    ap.add_argument('--realm', default='contractor')
    ap.add_argument('--check', action='store_true', help='重放两次比字节（确定性自证），不写文件')
    args = ap.parse_args(argv)

    try:
        rows = read_ledger(Path(args.ledger))
    except Exception as exc:  # noqa: BLE001 读不出来就**拒绝**，不报零
        print(json.dumps({'ok': False, 'code': 'ledger-unreadable', 'reason': str(exc)[:200]},
                         ensure_ascii=False))
        return 2

    first = render(rows, args.realm)
    second = render(rows, args.realm)
    deterministic = first == second
    payload = project_rows(rows, args.realm)
    report = {'ok': deterministic, 'deterministic': deterministic, 'bytes': len(first),
              'items': payload['counts']['items'], 'digest': payload['digest'],
              'kinds': sorted({i['kind'] for i in payload['items']}),
              'missing_citations': sum(1 for i in payload['items'] if not i['citations'])}
    if not deterministic:
        report['code'] = 'projection-nondeterministic'
        print(json.dumps(report, ensure_ascii=False)); return 2
    if args.out and not args.check:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(first)
        report['written'] = str(out)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
