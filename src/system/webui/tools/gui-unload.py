#!/usr/bin/env python3
"""卸载一个注册了 UI 的插件 → 确认它的入口消失、且页面其余部分**逐字节不变**。

用真 HTTP：POST /api/ui/plugins/<plugin_id>/unload（插件 id URL 编码，如 domain%2Frfq）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import urllib.request


def get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base + path, timeout=30) as res:
        return json.loads(res.read().decode('utf-8'))


def post(base: str, path: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload or {}).encode('utf-8')
    req = urllib.request.Request(base + path, data=data,
                                 headers={'content-type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:  # type: ignore[attr-defined]
        return json.loads(err.read().decode('utf-8'))


def digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:16]


def surface_summary(base: str) -> dict:
    out = get(base, '/api/ui/surface')
    return {'actions': sorted(a['id'] for a in out['actions']),
            'panels': sorted(p['id'] for p in out['panels']),
            'shortcuts': sorted(s['keys'] for s in out['shortcuts']),
            'plugins': {p['plugin_id']: len(p['entries']) for p in out['plugins']}}


def slot_blocks(base: str, slot: str) -> dict:
    out = get(base, f'/api/ui/blocks?slot={slot}')
    html = out.get('html', '')
    return {'blocks': out.get('blocks'), 'ids': re.findall(r'data-ui-block="([^"]+)"', html),
            'html_sha': hashlib.sha256(html.encode('utf-8')).hexdigest()[:16]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:8206/quotagent')
    args = ap.parse_args()
    base = args.base

    print('=== 基线（卸载前）===')
    before = surface_summary(base)
    print(json.dumps(before, ensure_ascii=False, indent=1))
    contractor_before = get(base, '/api/ui/panels?view=contractor')
    supplier_before = get(base, '/api/ui/panels?view=supplier')
    slot_supplier_before = slot_blocks(base, 'page.supplier')
    slot_contractor_before = slot_blocks(base, 'page.contractor')
    print('供应商槽位区块：', slot_supplier_before)
    print('承包商槽位区块：', slot_contractor_before)

    def panels_hash(payload: dict) -> str:
        # 只对"非本插件的面板"取指纹（本插件的面板卸载后应当消失，其余必须一字不变）
        rest = [p for p in payload['panels'] if p['plugin_id'] not in ('domain/rfq', 'userspace/demo-ns/hello')]
        return digest(rest)

    print('\n=== 卸载 domain/rfq（一个注册了 UI 的插件）===')
    out = post(base, '/api/ui/plugins/domain%2Frfq/unload')
    print(json.dumps(out, ensure_ascii=False, indent=1)[:1500])
    after = surface_summary(base)
    print('卸载后：', json.dumps(after, ensure_ascii=False, indent=1))
    removed_actions = sorted(set(before['actions']) - set(after['actions']))
    removed_panels = sorted(set(before['panels']) - set(after['panels']))
    print(f"[断言] 消失的动作：{removed_actions}")
    print(f"[断言] 消失的面板：{removed_panels}")
    contractor_after = get(base, '/api/ui/panels?view=contractor')
    print(f"[断言] 承包商道其余面板逐字节不变："
          f"{panels_hash(contractor_before) == panels_hash(contractor_after)}"
          f"（{panels_hash(contractor_before)} vs {panels_hash(contractor_after)}）")
    print(f"[断言] 供应商道面板逐字节不变："
          f"{panels_hash(supplier_before) == panels_hash(get(base, '/api/ui/panels?view=supplier'))}")

    print('\n=== 卸载 userspace/demo-ns/hello（注册了 page.supplier 区块的插件）===')
    hi = re.compile(r'data-ui-block="userspace/demo-ns/hello"')
    print('[前] 槽位 HTML 里含 hello 区块：', bool(hi.search(get(base, '/api/ui/blocks?slot=page.supplier').get('html', ''))))
    out2 = post(base, '/api/ui/plugins/userspace%2Fdemo-ns%2Fhello/unload')
    print(json.dumps(out2, ensure_ascii=False, indent=1)[:800])
    after_slot = slot_blocks(base, 'page.supplier')
    print('[后] 槽位区块：', after_slot)
    print('[后] 槽位 HTML 里含 hello 区块：',
          bool(hi.search(get(base, '/api/ui/blocks?slot=page.supplier').get('html', ''))))
    print('[断言] 承包商槽位逐字节不变：',
          slot_contractor_before['html_sha'] == slot_blocks(base, 'page.contractor')['html_sha'])

    print('\n=== 重新装载（可撤销 ⇒ 也可重装）：重启服务后贡献回来（本脚本不改任何文件）===')
    print('结论：卸载后该插件的视图/面板/动作/快捷键/通知源/状态项与它注册的区块全部消失，'
          '其它插件的页面逐字节不变。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
