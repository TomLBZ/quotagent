"""Durable product transfer state layered on existing QEP endpoints."""
from __future__ import annotations
import copy
import hashlib
import json
import os
import re
from quotagent.kernel.qep import KeyStore, QepEndpoint, SUPPORTED_QEP_VERSIONS, SUPPORTED_FEATURES, RECEIPT_TYPE
from quotagent.kernel.canon import canonical_bytes, digest, ZERO_HASH
from quotagent.kernel.ledger import utc_now
from adapter import AdapterError, valid_record
TRANSFER = 'quotagent/qep-workspace-transfer/v1'
PACKAGE = 'quotagent/qep-package/v1'


class ChannelLedger:
    def __init__(self, target, participant):
        self.target, self.participant = target, participant
    def read(self, **kwargs):
        rows = self.target.read(**kwargs)
        return [row for row in rows if row['actor'] == self.participant] if kwargs.get('type') == 'kernel/qep-sent' else rows
    def __getattr__(self, name):
        return getattr(self.target, name)


class Delivery:
    def __init__(self, workspace):
        self.store = workspace
        self.keys, self.endpoints, self.peer_secrets = KeyStore(), {}, {}
        self.versions, self.features = SUPPORTED_QEP_VERSIONS, SUPPORTED_FEATURES

    def recover(self, realm):
        """Rebuild a missing adapter index after a crash immediately after send."""
        existing = {row['id'] for row in self.records(realm, 'exchange-outbox')}
        for event in self.store.book(realm).read(type='kernel/qep-sent'):
            envelope = event['body'].get('envelope') or {}
            body = envelope.get('body') or {}
            if envelope.get('msg_id') in existing:
                continue
            if body.get('schema') == TRANSFER:
                record, channel, target = body['record'], body['channel'], body['to']
                identity = digest({'from': realm, 'to': target, 'channel': channel, 'collection': body['collection'], 'record': record})
                row = {'id': envelope['msg_id'], 'identity': identity, 'to': target, 'channel': channel, 'collection': body['collection'], 'recordId': record['id'], 'recordRevision': record.get('revision'), 'title': record.get('title') or record.get('supplierName') or record['id'], 'eventClass': envelope['class'], 'type': envelope['type'], 'seq': envelope['seq'], 'bodyHash': envelope['body_hash'], 'recordHash': body['recordHash'], 'envelope': envelope, 'status': 'queued', 'attempts': 0, 'received': False, 'error': 'Recovered signed delivery after interruption.'}
            elif envelope.get('type') == RECEIPT_TYPE and body.get('outcome'):
                recipient = envelope['recipients'][0]
                target = recipient.split(':to:')[0].removeprefix('account:')
                channel = recipient.split(':via:')[-1] if ':via:' in recipient else 'local'
                row = {'id': envelope['msg_id'], 'to': target, 'channel': channel, 'seq': envelope['seq'], 'bodyHash': envelope['body_hash'], 'envelope': envelope, 'type': RECEIPT_TYPE, 'control': True, 'status': 'receipt', 'received': False, 'attempts': 0, 'acks': body['msg_id'], 'title': 'Receipt for ' + body['msg_id']}
            else:
                continue
            self.save(realm, 'exchange-outbox', row, 'delivery-recovered')
            existing.add(row['id'])

    def participant(self, realm, peer, channel='local'):
        self.store.realm(realm); self.store.realm(peer)
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}', channel):
            raise AdapterError('INVALID_CHANNEL', 'Choose a channel ID using letters, digits, dot, underscore or hyphen.')
        return f'account:{realm}:to:{peer}' + ('' if channel == 'local' else ':via:' + channel)

    def endpoint(self, realm, peer, channel='local'):
        key = (realm, peer, channel)
        if key not in self.endpoints:
            participant = self.participant(realm, peer, channel)
            material = self.store.secret if channel == 'local' else self.peer_secrets.get(key)
            if not material:
                raise AdapterError('PAIRING_REQUIRED', 'This peer channel has no configured pairing secret.', 'Both parties must configure the same explicit pairing secret and channel ID.', 409)
            for sender, receiver in [(realm, peer), (peer, realm)]:
                identity = self.participant(sender, receiver, channel)
                self.keys.add(identity, secret=hashlib.sha256(material + identity.encode()).digest(), realm=sender)
            ep = QepEndpoint(participant=participant, kind='participant', realm=realm, keystore=self.keys, ledger=ChannelLedger(self.store.book(realm), participant), receipts=False)
            for row in self.store.book(realm).read(type='kernel/qep-received'):
                if row['actor'] == participant:
                    body = row['body']
                    ep._expected_seq[body['from']] = max(ep._expected_seq.get(body['from'], 1), body['seq'] + 1)
                    ep._seen_msg_ids.add(body['msg_id'])
            self.endpoints[key] = ep
        return self.endpoints[key]

    def records(self, realm, collection):
        rows = {}
        for event in self.store.book(realm).read():
            body = event['body']
            if valid_record(body) and body['collection'] == collection:
                rows[body['record']['id']] = body['record']
        return list(rows.values())

    def save(self, realm, collection, record, event, actor='system:exchange'):
        previous, _ = self.store.current(realm, collection, record['id'])
        value = {**copy.deepcopy(record), 'ownerId': realm, 'revision': (previous or {}).get('revision', 0) + 1, 'createdAt': (previous or {}).get('createdAt', utc_now()), 'updatedAt': utc_now()}
        self.store.put(realm, collection, value, event='exchange/' + event, actor=actor)
        return value

    def wrap(self, envelope, channel):
        return {'schema': PACKAGE, 'channel': channel, 'envelope': envelope}

    def outbox(self, realm, msg_id):
        record, _ = self.store.current(realm, 'exchange-outbox', msg_id)
        if not record:
            raise AdapterError('DELIVERY_NOT_FOUND', 'This delivery is not in the account outbox.', status=404)
        return record

    def package(self, realm, msg_id):
        row = self.outbox(realm, msg_id)
        package = self.wrap(row['envelope'], row['channel'])
        directory = self.store.root / 'exchange-packages' / realm
        directory.mkdir(parents=True, exist_ok=True)
        name = re.sub(r'[^A-Za-z0-9_.-]', '_', msg_id)[:100] + '.' + row['bodyHash'].split(':')[-1][:16] + '.qep.json'
        path, temporary = directory / name, directory / (name + '.tmp')
        with temporary.open('wb') as stream:
            stream.write(canonical_bytes(package)); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(path)
        return {'package': package, 'filename': name}

    def queue(self, req):
        realm, target, collection, record = req['realm'], req['to'], req['collection'], req['record']
        channel, metadata = req.get('channel', 'local'), copy.deepcopy(req.get('metadata') or {})
        ep = self.endpoint(realm, target, channel)
        record_hash = digest(record)
        identity = digest({'from': realm, 'to': target, 'channel': channel, 'collection': collection, 'record': record})
        existing = next((row for row in self.records(realm, 'exchange-outbox') if row.get('identity') == identity), None)
        if existing:
            return {**existing, 'duplicate': True}
        approvals = metadata.get('approvals') or []
        if metadata.get('eventClass') == 'commitment' and not approvals:
            raise AdapterError('APPROVAL_REQUIRED', 'A commitment transfer needs its recorded human approval.', 'Return to the business review and sign the exact current record.', 409)
        for approval in approvals:
            source = approval.get('sourceRef') or {}
            event = next((row for row in self.store.book(realm).read() if row['seq'] == source.get('seq') and row['entry_hash'] == source.get('hash')), None)
            if source.get('realm') != realm or not event or event['type'] not in ('procurement/human-approved', 'attachments/human-approved', 'actions/signed', 'actions/approved', 'exchange/conflict-approved'):
                raise AdapterError('APPROVAL_SOURCE', 'Approval proof does not name a recorded human decision in the sending realm.', status=409)
            decision_body = event['body'].get('record', event['body'])
            decision_id = decision_body.get('humanId') or decision_body.get('decision', {}).get('actorId') or event['actor'].removeprefix('human:')
            if approval.get('by') != 'human:' + decision_id or not approval.get('at') or event['body'].get('approvedAt') and approval['at'] != event['body']['approvedAt'] or not isinstance(approval.get('scope'), dict):
                raise AdapterError('APPROVAL_BINDING', 'Approval actor, time or scope does not match its recorded decision.', status=409)
            approval['scope']['recordHash'] = record_hash
        metadata['approvals'] = approvals
        # Either direction can establish the most recent shared public base.
        # A confirmation received from the peer supersedes our earlier proposal.
        base = None
        for event in self.store.book(realm).read():
            value = event.get('body') or {}
            if not valid_record(value):
                continue
            row = value['record']
            if row.get('channel') != channel or row.get('collection') != collection or row.get('recordId') != record['id']:
                continue
            if value['collection'] == 'exchange-outbox' and row.get('to') == target and row.get('status') == 'delivered':
                base = row['envelope']['body']['record']
            elif value['collection'] == 'exchange-inbox' and row.get('from') == target and row.get('status') == 'applied' and not row.get('control'):
                base = row['package']['envelope']['body']['record']
        body = {'schema': TRANSFER, 'from': realm, 'to': target, 'channel': channel, 'collection': collection, 'record': record, 'recordHash': record_hash, 'base': base, 'baseHash': digest(base), 'metadata': metadata, 'capabilities': ep.capabilities()}
        envelope = ep.envelope(metadata.get('type') or 'workspace/record-transferred', metadata.get('eventClass', 'fact'), body, refs={**metadata.get('refs', {}), 'record_hash': record_hash}, recipients=[self.participant(target, realm, channel)], approvals=approvals, correlation_id='transfer:' + identity)
        sent = ep.send(envelope)
        row = self.save(realm, 'exchange-outbox', {'id': sent['msg_id'], 'identity': identity, 'to': target, 'channel': channel, 'collection': collection, 'recordId': record['id'], 'recordRevision': record.get('revision'), 'title': record.get('title') or record.get('supplierName') or record['id'], 'eventClass': envelope['class'], 'type': envelope['type'], 'seq': envelope['seq'], 'bodyHash': envelope['body_hash'], 'recordHash': record_hash, 'envelope': sent['envelope'], 'status': 'queued', 'attempts': 0, 'received': False, 'error': None}, 'queued', req.get('actor') or 'system:exchange')
        self.package(realm, row['id'])
        return row

    def inspect(self, realm, package):
        if not isinstance(package, dict) or package.get('schema') != PACKAGE or not isinstance(package.get('envelope'), dict):
            raise AdapterError('PACKAGE_SHAPE', 'Choose an exported QEP package.', 'Upload the original .qep.json file without editing it.')
        envelope, channel = package['envelope'], package.get('channel', 'local')
        source = (envelope.get('sender') or {}).get('realm')
        ep = self.endpoint(realm, source, channel)
        report = ep.validate(envelope, require_signature=True)
        if not report['ok'] or not ep.verify(envelope):
            self.store.book(realm).append('exchange/package-rejected', {'msgId': envelope.get('msg_id'), 'reason': 'Signature or envelope validation failed.', 'errors': report['errors']}, actor=ep.participant)
            raise AdapterError('PACKAGE_VERIFICATION', 'The package signature, body hash or protocol version is invalid.', 'Ask the sender to export the original current package; no business record was applied.', 400, {'errors': report['errors']})
        if envelope['sender']['participant_id'] != self.participant(source, realm, channel) or envelope.get('recipients') != [ep.participant]:
            raise AdapterError('RECIPIENT_MISMATCH', 'This signed package names a different recipient or pairing.', 'Open the intended recipient account; do not edit the signed package.', 403)
        body = envelope['body']
        if envelope['type'] == RECEIPT_TYPE:
            return {'from': source, 'to': realm, 'channel': channel, 'control': True, 'envelope': envelope}
        if body.get('schema') != TRANSFER or body.get('from') != source or body.get('to') != realm or body.get('channel') != channel or digest(body.get('record')) != body.get('recordHash') or digest(body.get('base')) != body.get('baseHash'):
            raise AdapterError('TRANSFER_BINDING', 'The signed record, base or party binding is invalid.', status=409)
        if body['metadata'].get('eventClass', 'fact') != envelope['class'] or body['metadata'].get('approvals', []) != envelope.get('approvals', []):
            raise AdapterError('TRANSFER_BINDING', 'The envelope class or approvals do not match the transfer metadata.', status=409)
        for approval in envelope.get('approvals', []):
            if approval.get('scope', {}).get('recordHash') != body['recordHash']:
                raise AdapterError('APPROVAL_BINDING', 'Approval proof is bound to another record hash.', status=409)
        negotiated = ep.negotiate(body.get('capabilities') or {})
        if not negotiated['ok']:
            raise AdapterError('PEER_VERSION', 'The peer version or mandatory features are incompatible.', 'Use a compatible QEP version; mandatory approval/signature/version binding cannot be disabled.', 409, negotiated)
        local, source_ref = self.store.current(realm, body['collection'], body['record']['id'])
        return {**copy.deepcopy(body), 'local': local, 'localHash': digest(local), 'sourceRef': source_ref, 'envelope': envelope, 'negotiated': negotiated}

    def receive(self, req):
        realm, package = req['realm'], req['package']
        inspected = self.inspect(realm, package)
        source, channel, envelope = inspected['from'], inspected['channel'], inspected['envelope']
        ep = self.endpoint(realm, source, channel)
        existing, _ = self.store.current(realm, 'exchange-inbox', envelope['msg_id'])
        if existing and existing['status'] in ('applied', 'rejected', 'conflict'):
            return {**existing, 'duplicate': True}
        expected = ep._expected_seq.get(envelope['sender']['participant_id'], 1)
        if envelope['seq'] == expected:
            previous = [row for row in self.store.book(realm).read(type='kernel/qep-received') if row['actor'] == ep.participant and row['body'].get('from') == envelope['sender']['participant_id'] and row['body'].get('seq') == expected - 1]
            predecessor = previous[-1]['body']['body_hash'] if previous else ZERO_HASH
            if envelope.get('prev_hash') != predecessor:
                self.store.book(realm).append('exchange/package-rejected', {'msgId': envelope['msg_id'], 'reason': 'Stream predecessor hash differs.', 'expectedSeq': expected}, actor=ep.participant)
                raise AdapterError('STREAM_FORK', 'This sequence is not bound to the preceding accepted package.', 'Ask the sender to restore the original stream; do not skip the predecessor.', 409)
        result = ep.receive(canonical_bytes(envelope))
        # Kernel holds validated envelopes in memory; the adapter owns their durable
        # policy-aware replay so an automatic drain cannot bypass domain validation.
        ep.held.clear()
        if inspected.get('control'):
            if not result.get('received') and not result.get('duplicate'):
                return self.save(realm, 'exchange-inbox', {'id': envelope['msg_id'], 'from': source, 'channel': channel, 'package': package, 'status': 'held', 'missing': result.get('missing', []), 'control': True}, 'receipt-held')
            body = envelope['body']; outbox = self.outbox(realm, body.get('msg_id'))
            if outbox['to'] != source or outbox['channel'] != channel or outbox['bodyHash'] != body.get('body_hash') or outbox['seq'] != body.get('seq'):
                raise AdapterError('RECEIPT_BINDING', 'The signed receipt names a different message, peer or body hash.', status=409)
            outcome = body.get('outcome', 'applied')
            updated = self.save(realm, 'exchange-outbox', {**outbox, 'received': True, 'status': {'applied': 'delivered', 'rejected': 'rejected', 'conflict': 'conflict'}.get(outcome, 'delivered'), 'receipt': package, 'error': body.get('message'), 'receivedAt': body.get('at')}, 'receipt-recorded')
            self.save(realm, 'exchange-inbox', {'id': envelope['msg_id'], 'from': source, 'channel': channel, 'package': package, 'status': 'applied', 'control': True}, 'control-received')
            return {'control': True, 'status': 'applied', 'delivery': updated}
        if not result.get('received') and not result.get('duplicate') and not result.get('held'):
            raise AdapterError('QEP_REJECTED', 'The QEP kernel rejected this delivery.', details=result)
        status = 'held' if result.get('held') else 'received'
        return self.save(realm, 'exchange-inbox', {'id': envelope['msg_id'], 'from': source, 'channel': channel, 'collection': inspected['collection'], 'recordId': inspected['record']['id'], 'title': inspected['record'].get('title') or inspected['record'].get('supplierName') or inspected['record']['id'], 'package': package, 'status': status, 'missing': result.get('missing', []), 'eventClass': envelope['class'], 'seq': envelope['seq']}, 'inbox-' + status)

    def receipt(self, realm, inbox, outcome, message=None):
        if inbox.get('receipt') and inbox['receipt']['envelope']['body'].get('outcome') == outcome:
            return inbox['receipt']
        recovered = next((row for row in reversed(self.records(realm, 'exchange-outbox')) if row.get('acks') == inbox['id'] and row['envelope']['body'].get('outcome') == outcome), None)
        if recovered:
            return self.wrap(recovered['envelope'], recovered['channel'])
        ep = self.endpoint(realm, inbox['from'], inbox['channel'])
        received = inbox['package']['envelope']
        envelope = ep.envelope(RECEIPT_TYPE, 'intent', {'msg_id': inbox['id'], 'seq': received['seq'], 'body_hash': received['body_hash'], 'ack_by': ep.participant, 'at': utc_now(), 'outcome': outcome, 'message': message}, recipients=[received['sender']['participant_id']], correlation_id='receipt:' + inbox['id'] + ':' + outcome)
        sent = ep.send(envelope)
        row = self.save(realm, 'exchange-outbox', {'id': sent['msg_id'], 'to': inbox['from'], 'channel': inbox['channel'], 'seq': envelope['seq'], 'bodyHash': envelope['body_hash'], 'envelope': sent['envelope'], 'type': RECEIPT_TYPE, 'control': True, 'status': 'receipt', 'received': False, 'attempts': 0, 'acks': inbox['id'], 'title': 'Receipt for ' + inbox['id']}, 'receipt-prepared')
        return self.wrap(row['envelope'], row['channel'])

    def settle(self, req):
        realm = req['realm']; inbox, _ = self.store.current(realm, 'exchange-inbox', req['id'])
        if not inbox:
            raise AdapterError('INBOX_NOT_FOUND', 'The account has no such received package.', status=404)
        if inbox['status'] in ('applied', 'rejected', 'conflict') and not req.get('resolve'):
            return inbox
        if inbox['status'] not in ('received', 'conflict'):
            raise AdapterError('SEQUENCE_HELD', 'Earlier QEP messages must be received before this record can advance.', status=409)
        body = inbox['package']['envelope']['body']
        local, _ = self.store.current(realm, body['collection'], body['record']['id'])
        if digest(local) != req.get('expectedHash'):
            raise AdapterError('REVISION_CONFLICT', 'The local record changed during reconciliation.', 'Recheck this received package against the current local version.', 409, {'current': local, 'currentHash': digest(local)})
        outcome = req.get('outcome', 'applied')
        if outcome == 'applied':
            # The signed original and accepted effective projection remain distinct.
            applied = any(row.get('refs', {}).get('exchange_msg_id') == inbox['id'] for row in self.store.book(realm).read())
            if not applied:
                self.store.put(realm, body['collection'], req['record'], event='exchange/record-applied', actor=inbox['package']['envelope']['sender']['participant_id'], correlation_id='applied:' + inbox['id'], event_class=inbox['eventClass'], refs={'exchange_msg_id': inbox['id'], 'body_hash': inbox['package']['envelope']['body_hash']})
        receipt = self.receipt(realm, inbox, outcome, req.get('message'))
        return self.save(realm, 'exchange-inbox', {**inbox, 'status': outcome, 'receipt': receipt, 'conflicts': req.get('conflicts', []), 'decisions': req.get('decisions', []), 'message': req.get('message'), 'resolvedBy': req.get('resolvedBy')}, 'inbox-' + outcome)

    def execute(self, req):
        op, realm = req['op'], req.get('realm')
        if op == 'clear-peer':
            peer, channel = req['peer'], req.get('channel', 'portable')
            for left, right in [(realm, peer), (peer, realm)]:
                self.peer_secrets.pop((left, right, channel), None)
                self.endpoints.pop((left, right, channel), None)
                self.keys._entries.pop(self.participant(left, right, channel), None)
            return {'configured': False, 'channel': channel, 'peer': peer}
        if op == 'configure-peer':
            peer, channel = req['peer'], req.get('channel', 'portable')
            self.participant(realm, peer, channel)
            secret = req.get('secret')
            if channel == 'local' or not isinstance(secret, str) or len(secret) < 16:
                raise AdapterError('PAIRING_SECRET', 'Use a nonlocal channel ID and a shared pairing secret of at least 16 characters.', 'Configure the exact same secret privately on both peers.')
            for left, right in [(realm, peer), (peer, realm)]:
                self.peer_secrets[(left, right, channel)] = secret.encode(); self.endpoints.pop((left, right, channel), None)
            return {'configured': True, 'channel': channel, 'peer': peer, 'signature': 'hmac-sha256'}
        if op == 'queue':
            return self.queue(req)
        if op == 'inspect-package':
            return self.inspect(realm, req['package'])
        if op == 'receive-package':
            return self.receive(req)
        if op == 'settle-inbox':
            return self.settle(req)
        if op == 'package':
            return self.package(realm, req['id'])
        if op == 'delivery-state':
            return {'outbox': self.records(realm, 'exchange-outbox'), 'inbox': self.records(realm, 'exchange-inbox')}
        if op == 'attempt':
            row = self.outbox(realm, req['id'])
            return self.save(realm, 'exchange-outbox', {**row, 'status': req.get('status', 'queued'), 'attempts': row.get('attempts', 0) + int(req.get('started', False)), 'lastAttemptAt': utc_now(), 'error': req.get('error'), 'nextAction': req.get('nextAction'), 'nextAttemptAt': req.get('nextAttemptAt')}, 'delivery-attempt')
        raise AdapterError('OPERATION_UNAVAILABLE', 'This workspace adapter operation is not available.', 'Use a declared capability from the bridge handshake.', 404)
