"""Product plugin adapter. Reuses the existing Ledger and QEP kernels unchanged."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'src'))
from quotagent.kernel.ledger import Ledger
from quotagent.kernel.qep import KeyStore, QepEndpoint

root = Path(sys.argv[1]).resolve()
(root / 'ledgers').mkdir(parents=True, exist_ok=True)
ledgers = {}
endpoints = {}
keys = KeyStore()
secret_path = root / 'exchange.key'
if not secret_path.exists():
    secret_path.write_bytes(os.urandom(32))
    secret_path.chmod(0o600)
secret = secret_path.read_bytes()


def ledger(realm):
    if not isinstance(realm, str) or not realm or '/' in realm or '..' in realm:
        raise ValueError('Invalid account realm')
    if realm not in ledgers:
        ledgers[realm] = Ledger(root / 'ledgers' / (realm + '.jsonl'), realm=realm)
        if not ledgers[realm].healthy:
            raise ValueError('Account ledger failed integrity verification')
    return ledgers[realm]


class ChannelLedger:
    """One pairwise QEP stream; events still append to the account's sole ledger."""
    def __init__(self, target, participant):
        self.target, self.participant = target, participant
    def read(self, **kwargs):
        rows = self.target.read(**kwargs)
        if kwargs.get('type') == 'kernel/qep-sent':
            return [r for r in rows if r['actor'] == self.participant]
        return rows
    def __getattr__(self, name):
        return getattr(self.target, name)


def endpoint(realm, peer):
    channel = (realm, peer)
    if channel not in endpoints:
        participant = f'account:{realm}:to:{peer}'
        keys.add(participant, secret=hashlib.sha256(secret + participant.encode()).digest(), realm=realm)
        ep = QepEndpoint(participant=participant, kind='participant', realm=realm,
                         keystore=keys, ledger=ChannelLedger(ledger(realm), participant), receipts=False)
        # Rehydrate inbound cursors from durable receipts; no kernel semantics change.
        for row in ledger(realm).read(type='kernel/qep-received'):
            if row['actor'] != participant:
                continue
            body = row['body']
            ep._expected_seq[body['from']] = max(ep._expected_seq.get(body['from'], 1), body['seq'] + 1)
            ep._seen_msg_ids.add(body['msg_id'])
        endpoints[channel] = ep
    return endpoints[channel]


def execute(req):
    op = req['op']
    before = {name: book.count for name, book in ledgers.items()}
    if op == 'init':
        for path in (root / 'ledgers').glob('*.jsonl'):
            ledger(path.stem)
        return {'events': {name: book.read() for name, book in ledgers.items()}}
    realm = req.get('realm')
    actor = req.get('actor') or f'human:{realm}'
    if op == 'append':
        ref = ledger(realm).append(req['type'], req['body'], actor=actor,
                                  event_class=req.get('eventClass', 'fact'))
        value = ref.as_dict()
    elif op == 'put':
        body = {'schema': 'quotagent/workspace-record/v1', 'collection': req['collection'], 'record': req['record']}
        ref = ledger(realm).append(req.get('event') or 'workspace/record-saved', body, actor=actor)
        value = req['record']
    elif op == 'exchange':
        target = req['to']
        sender, receiver = endpoint(realm, target), endpoint(target, realm)
        body = {'schema': 'quotagent/workspace-record/v1', 'collection': req['collection'], 'record': req['record']}
        envelope = sender.envelope('workspace/record-exchanged', 'fact', body, recipients=[receiver.participant])
        sent = sender.send(envelope)
        result = receiver.receive(sent['bytes'])
        if not result.get('received'):
            raise ValueError('QEP delivery incomplete: ' + str(result.get('errors') or result.get('reason')))
        value = {'record': req['record'], 'msgId': sent['msg_id'], 'received': True}
    else:
        raise ValueError('Unknown adapter command')
    delta = {name: book.read()[before.get(name, 0):] for name, book in ledgers.items() if book.count > before.get(name, 0)}
    return {'value': value, 'events': delta}


for line in sys.stdin:
    try:
        req = json.loads(line)
        out = {'id': req['id'], 'ok': True, **execute(req)}
    except Exception as exc:
        out = {'id': req.get('id'), 'ok': False, 'error': str(exc)}
    print(json.dumps(out, ensure_ascii=False), flush=True)
