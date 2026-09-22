#!/usr/bin/env python3
"""GUI 双闭环 HTTP 走查（在**真实服务**上跑；只发 HTTP 请求，不碰账本——账本由唯一写者落）。

它**只读 HTTP + 只发动作请求**：不写账本、不改文件；证据 = 每一步的原始响应 + `gui-readback.py` 的账本回读。

用法：python3 tmp/gui-walkthrough.py --base http://127.0.0.1:8200/quotagent
输出：每一步的原始响应（JSON）与账本回读（由 tmp/gui-readback.py 单独做）。
"""
from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request


def call(base: str, method: str, path: str, payload: dict | None = None) -> tuple[int, dict | str]:
    url = base + path
    data = None
    headers = {'accept': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['content-type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            body = res.read().decode('utf-8')
            try:
                return res.status, json.loads(body)
            except ValueError:
                return res.status, body
    except urllib.error.HTTPError as err:
        body = err.read().decode('utf-8')
        try:
            return err.code, json.loads(body)
        except ValueError:
            return err.code, body


def show(label: str, code: int, out: dict | str, keys: list[str] | None = None) -> dict:
    print(f"\n### {label}\nHTTP {code}")
    if isinstance(out, dict):
        if keys:
            print(json.dumps({k: out.get(k) for k in keys}, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(out, ensure_ascii=False, indent=2)[:4000])
        return out
    print(str(out)[:1500])
    return {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:8200/quotagent')
    ap.add_argument('--signature', default='human:liangzi')
    ap.add_argument('--supplier-signature', default='human:zhang')
    ap.add_argument('--now', default='2026-09-22T10:00:00Z')
    args = ap.parse_args()
    base = args.base
    results = {}

    def action(action_id: str, view: str, inp: dict) -> dict:
        code, out = call(base, 'POST', f'/api/action/{action_id}', {'view': view, 'input': inp})
        print(f"\n### 动作 {action_id}（视图 {view}）\nHTTP {code}")
        print(json.dumps(out, ensure_ascii=False, indent=2)[:2500])
        return out if isinstance(out, dict) else {}

    # ---------------------------------------------------------------- 起手：注册面自述
    show('注册面自述 /api/ui/surface（截断）', *call(base, 'GET', '/api/ui/surface'),
         keys=['ok', 'views', 'shell_shortcuts'])

    # ================================================================ 承包商侧闭环
    results['publish'] = action('rfq.publish', 'contractor', {
        'package_id': 'pkg-gui', 'subject': '厂区给排水管道更换（GUI 走查）', 'currency': 'CNY',
        'quote_by': '2026-09-30T00:00:00Z', 'clarify_by': '2026-09-25T00:00:00Z',
        'items': 'L-001,DN100 管道,m,120\nL-002,管支架,kg,480',
        'invited': 'supplier:g1', 'note': '现场条件见附件', 'actor': args.signature, 'confirm_ack': '1'})

    show('承包商道：已发布的包（页面回读）', *call(base, 'GET', '/api/ui/panels?view=contractor'),
         keys=['ok', 'view'])

    panel = call(base, 'GET', '/api/ui/panels?view=contractor')[1]
    for item in panel.get('panels', []):
        if item['id'] == 'rfq.published':
            print(json.dumps(item['data'], ensure_ascii=False, indent=2)[:1200])
    results['contractor_panels'] = panel

    # ================================================================ 供应商侧闭环
    supplier = call(base, 'GET', '/api/ui/panels?view=supplier')[1]
    for item in supplier.get('panels', []):
        if item['id'] == 'quote.package':
            print('\n### 供应商看到的包（只出自己那份；可编辑列已标出）')
            print(json.dumps({k: item['data'].get(k) for k in ['kind', 'counts', 'note', 'editable_action',
                                                              'editable_defaults']}, ensure_ascii=False, indent=2))
            print(json.dumps(item['data'].get('rows'), ensure_ascii=False, indent=2)[:900])
    results['supplier_package'] = supplier

    results['draft'] = action('quote.draft', 'supplier', {
        'rfq_id': 'pkg-gui', 'prepared_by': args.supplier_signature, 'currency': 'CNY',
        'rows': [{'item_id': 'L-001', 'unit_price_cents': 8600, 'lead_time_days': 10},
                 {'item_id': 'L-002', 'unit_price_cents': 1150, 'lead_time_days': 10}]})

    drafts = call(base, 'GET', '/api/ui/panels?view=supplier')[1]
    draft_ids = []
    for item in drafts.get('panels', []):
        if item['id'] == 'quote.drafts':
            print('\n### 供应商草稿（页面回读）')
            print(json.dumps(item['data'], ensure_ascii=False, indent=2)[:900])
            draft_ids = [row['quote_draft_id'] for row in item['data'].get('rows', [])]
    results['drafts'] = drafts

    results['submit'] = action('quote.submit', 'supplier', {
        'draft_id': draft_ids[0] if draft_ids else '', 'signature': args.supplier_signature,
        'comment': 'GUI 走查提交（第一条行项目）', 'timeout_policy': 'remind', 'confirm_ack': '1'})
    results['submit2'] = action('quote.submit', 'supplier', {
        'draft_id': draft_ids[1] if len(draft_ids) > 1 else '', 'signature': args.supplier_signature,
        'comment': 'GUI 走查提交（第二条行项目）', 'timeout_policy': 'remind', 'confirm_ack': '1'})
    # 第二名候选：就同一条行项目再备一份**改价**的草稿并人签提交（比价要有两家以上才看得见权重的作用）
    results['draft_alt'] = action('quote.draft', 'supplier', {
        'rfq_id': 'pkg-gui', 'prepared_by': args.supplier_signature, 'currency': 'CNY',
        'rows': [{'item_id': 'L-001', 'unit_price_cents': 9400, 'lead_time_days': 6}]})
    alt = call(base, 'GET', '/api/ui/panels?view=supplier')[1]
    alt_ids = []
    for item in alt.get('panels', []):
        if item['id'] == 'quote.drafts':
            alt_ids = [row['quote_draft_id'] for row in item['data'].get('rows', [])
                       if row.get('status') == '待签署']
    results['submit_alt'] = action('quote.submit', 'supplier', {
        'draft_id': alt_ids[0] if alt_ids else '', 'signature': args.supplier_signature,
        'comment': 'GUI 走查：第二家候选（改价）', 'timeout_policy': 'remind', 'confirm_ack': '1'})

    # 供应商侧：提交结果回读
    after = call(base, 'GET', '/api/ui/panels?view=supplier')[1]
    for item in after.get('panels', []):
        if item['id'] == 'quote.submitted':
            print('\n### 供应商提交结果（页面回读）')
            print(json.dumps({k: item['data'].get(k) for k in ['kind', 'degraded', 'counts', 'note']},
                             ensure_ascii=False, indent=2))
            print(json.dumps(item['data'].get('rows'), ensure_ascii=False, indent=2)[:1200])
    results['submitted_panel'] = after

    # ================================================================ 承包商侧：比价（权重可调）
    results['rank_default'] = action('compare.rank', 'contractor', {
        'package_id': 'pkg-gui', 'w_price': 0.6, 'w_delivery': 0.15, 'w_payment': 0.1,
        'w_warranty': 0.05, 'w_deviation': 0.1})
    results['rank_price_only'] = action('compare.rank', 'contractor', {
        'package_id': 'pkg-gui', 'w_price': 1, 'w_delivery': 0, 'w_payment': 0,
        'w_warranty': 0, 'w_deviation': 0})
    ranking = call(base, 'GET', '/api/ui/panels?view=contractor')[1]
    for item in ranking.get('panels', []):
        if item['id'] == 'compare.ranking':
            print('\n### 比价面板（页面回读）')
            print(json.dumps(item['data'], ensure_ascii=False, indent=2)[:1200])

    # ================================================================ 授标链
    results['propose'] = action('award.propose', 'contractor', {
        'package_id': 'pkg-gui', 'quote_id': results['submit'].get('result', {}).get('quote_id', ''),
        'item_id': 'L-001', 'qty': 120, 'unit_price_cents': 8600, 'reason': 'GUI 走查授标意向'})
    intent_id = results['propose'].get('result', {}).get('intent_id', '')

    supplier2 = call(base, 'GET', '/api/ui/panels?view=supplier')[1]
    for item in supplier2.get('panels', []):
        if item['id'] == 'award.inbox':
            print('\n### 供应商收到的授标意向（只出自己那份）')
            print(json.dumps(item['data'], ensure_ascii=False, indent=2)[:900])
    results['award_inbox'] = supplier2

    results['confirm'] = action('award.confirm', 'supplier', {
        'intent_id': intent_id, 'signature': args.supplier_signature, 'note': '同意按此授标', 'confirm_ack': '1'})

    results['commit'] = action('award.commit', 'contractor', {
        'intent_id': intent_id, 'signature': args.signature, 'reason': 'GUI 走查人工批准',
        'comment': '同意授标', 'confirm_ack': '1'})
    award_id = results['commit'].get('result', {}).get('award_id', '')

    results['po'] = action('po.issue', 'contractor', {
        'award_id': award_id, 'signature': args.signature, 'reason': 'GUI 走查发 PO',
        'comment': '同意发 PO', 'confirm_ack': '1'})

    chain = call(base, 'GET', '/api/ui/panels?view=contractor')[1]
    for item in chain.get('panels', []):
        if item['id'] == 'award.chain':
            print('\n### 授标链面板（页面回读）')
            print(json.dumps(item['data'], ensure_ascii=False, indent=2)[:1500])
    results['award_chain'] = chain

    # 负控：无署名（agent 代签）必须被拒
    results['human_gate'] = action('award.commit', 'contractor', {
        'intent_id': intent_id, 'signature': 'agent:bot', 'confirm_ack': '1'})

    # 负控：无署名（agent 代签）必须被拒 —— 打印字段级错误作为证据
    print('\n### 负控：award.commit 用 agent 署名（应被拒）')
    print(json.dumps(results['human_gate'].get('errors'), ensure_ascii=False, indent=2))
    show('通知中心 /api/ui/notifications', *call(base, 'GET', '/api/ui/notifications'),
         keys=['ok'])
    show('状态栏 /api/ui/status', *call(base, 'GET', '/api/ui/status'), keys=['ok'])

    with open('tmp/gui-walkthrough-result.json', 'w', encoding='utf-8') as fh:
        json.dump(results, fh, ensure_ascii=False, indent=2)
    print('\n[walkthrough] 原始响应已落 tmp/gui-walkthrough-result.json')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
