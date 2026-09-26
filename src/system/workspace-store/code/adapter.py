"""Native adapter persistence; the Ledger/QEP kernels remain unchanged."""
from __future__ import annotations
import copy
import os
from pathlib import Path
from quotagent.kernel.ledger import Ledger
from quotagent.kernel.canon import digest

PROTOCOL = 'quotagent-store/2'
WORKSPACE = 'quotagent/workspace-record/v1'


class AdapterError(ValueError):
    def __init__(self, code, message, next_action='Review the current record and retry.', status=400, details=None):
        super().__init__(message)
        self.code, self.next_action, self.status, self.details = code, next_action, status, details


def valid_record(body):
    return isinstance(body, dict) and body.get('schema') == WORKSPACE and isinstance(body.get('collection'), str) and bool(body['collection']) and isinstance(body.get('record'), dict) and isinstance(body['record'].get('id'), str) and bool(body['record']['id'])


class Workspace:
    def __init__(self, root):
        self.root = Path(root).resolve()
        (self.root / 'ledgers').mkdir(parents=True, exist_ok=True)
        self.books, self.health = {}, {}
        self.record_index, self.indexed_counts = {}, {}
        key_file = self.root / 'exchange.key'
        if not key_file.exists():
            temporary = key_file.with_suffix('.tmp')
            temporary.write_bytes(os.urandom(32)); temporary.chmod(0o600); temporary.replace(key_file)
        self.secret = key_file.read_bytes()
        from delivery import Delivery
        self.delivery = Delivery(self)

    @staticmethod
    def realm(value):
        if not isinstance(value, str) or not value or '/' in value or '\\' in value or '..' in value or len(value) > 240:
            raise AdapterError('INVALID_REALM', 'Invalid account realm.', 'Use the authenticated account or explicitly selected party workspace.')
        return value

    def book(self, realm):
        realm = self.realm(realm)
        if realm not in self.books:
            try:
                book = Ledger(self.root / 'ledgers' / (realm + '.jsonl'), realm=realm)
                self.books[realm] = book
                if not book.healthy:
                    self.health[realm] = {'realm': realm, 'healthy': False, 'code': 'LEDGER_INTEGRITY', 'message': 'The ledger failed integrity verification. Writes and outbound transfers are stopped.', 'nextAction': 'Preserve the original file and restore or inspect it with an administrator; no automatic repair was performed.', 'details': book.open_failure}
                else:
                    self.health[realm] = {'realm': realm, 'healthy': True, 'recordMetadataDropped': 0, 'eventCount': book.count}
                    self.refresh_index(realm, book)
            except Exception as error:
                self.health[realm] = {'realm': realm, 'healthy': False, 'code': 'STORAGE_UNAVAILABLE', 'message': str(error), 'nextAction': 'Check the account ledger path, disk availability and permissions; retry after repair.'}
        state = self.health.get(realm)
        if not state or not state['healthy']:
            raise AdapterError(state['code'] if state else 'STORAGE_UNAVAILABLE', state['message'] if state else 'Storage is unavailable.', state.get('nextAction', '') if state else '', 503)
        return self.books[realm]

    def refresh_index(self, realm, book):
        """Disposable process-local projection; existing immutable ledger is its only input."""
        index = self.record_index.setdefault(realm, {})
        for seq in range(self.indexed_counts.get(realm, 0) + 1, book.count + 1):
            row = book.get(seq)
            body = row.get('body')
            if valid_record(body):
                index[(body['collection'], body['record']['id'])] = (body['record'], {'realm': realm, 'seq': row['seq'], 'hash': row['entry_hash']})
            elif isinstance(body, dict) and body.get('schema') == WORKSPACE:
                self.health[realm]['recordMetadataDropped'] += 1
            self.indexed_counts[realm] = seq

    def initialize(self):
        for path in (self.root / 'ledgers').glob('*.jsonl'):
            try:
                self.book(path.stem)
            except AdapterError:
                pass
        for realm in list(self.books):
            if self.health[realm]['healthy']:
                self.delivery.recover(realm)
        return {'events': {realm: book.read() for realm, book in self.books.items() if self.health[realm]['healthy']}, 'health': self.status()}

    def status(self):
        for realm, book in self.books.items():
            if self.health[realm]['healthy']:
                self.refresh_index(realm, book)
        result = copy.deepcopy(self.health)
        for realm, book in self.books.items():
            if result[realm]['healthy']:
                result[realm]['eventCount'] = book.count
        return result

    def counts(self):
        return {realm: book.count for realm, book in self.books.items() if self.health[realm]['healthy']}

    def delta(self, before):
        return {realm: [book.get(seq) for seq in range(before.get(realm, 0) + 1, book.count + 1)] for realm, book in self.books.items() if self.health[realm]['healthy'] and book.count > before.get(realm, 0)}

    def current(self, realm, collection, record_id):
        book = self.book(realm)
        self.refresh_index(realm, book)
        return copy.deepcopy(self.record_index[realm].get((collection, record_id), (None, None)))

    def fail_request(self, request, error):
        if not isinstance(error, OSError) or not request.get('realm'):
            return error
        try:
            realm = self.realm(request['realm'])
        except AdapterError:
            return error
        message = 'Storage failed during this request. Its write outcome is uncertain; this party is paused until the original ledger is verified on restart.'
        next_action = 'Preserve the ledger, restore disk access, then restart and inspect recorded state before retrying. Do not remove or rewrite a partial tail automatically.'
        self.health[realm] = {'realm': realm, 'healthy': False, 'code': 'STORAGE_WRITE_UNCERTAIN', 'message': message, 'nextAction': next_action, 'osError': error.errno}
        return AdapterError('STORAGE_WRITE_UNCERTAIN', message, next_action, 503, {'realm': realm, 'osError': error.errno})

    def put(self, realm, collection, record, *, event='workspace/record-saved', actor=None, expected=None, check_expected=False, correlation_id=None, event_class='fact', refs=None):
        body = {'schema': WORKSPACE, 'collection': collection, 'record': record}
        if not valid_record(body):
            raise AdapterError('INVALID_RECORD', 'A record needs a collection and a nonempty string ID.', 'Correct the record shape; no record was appended.')
        current, source = self.current(realm, collection, record['id'])
        current_revision = current.get('revision') if current else None
        if check_expected and expected != current_revision:
            raise AdapterError('REVISION_CONFLICT', 'This record changed while you were editing it.', 'Review the current version and merge your changes before saving again.', 409, {'collection': collection, 'recordId': record['id'], 'expectedRevision': expected, 'currentRevision': current_revision, 'current': current, 'sourceRef': source})
        self.book(realm).append(event, body, actor=actor or f'human:{realm}', correlation_id=correlation_id, event_class=event_class, refs=refs)
        return record

    def execute(self, req):
        op, realm = req['op'], req.get('realm')
        if op == 'hello':
            if req.get('protocol') != PROTOCOL:
                raise AdapterError('PROTOCOL_VERSION', 'Workspace bridge versions do not overlap.', 'Use the native adapter matching this bridge; no ledger event was added.', 409, {'supported': [PROTOCOL]})
            return {'protocol': PROTOCOL, 'operations': ['init', 'append', 'put', 'health', 'configure-peer', 'clear-peer', 'queue', 'inspect-package', 'receive-package', 'settle-inbox', 'delivery-state', 'package', 'attempt'], 'qepVersions': list(self.delivery.versions), 'features': list(self.delivery.features), 'signature': 'hmac-sha256', 'commit': False}
        if op == 'health':
            return self.status()
        if op == 'append':
            return self.book(realm).append(req['type'], req['body'], actor=req.get('actor') or f'human:{realm}', event_class=req.get('eventClass', 'fact'), correlation_id=req.get('correlationId'), refs=req.get('refs')).as_dict()
        if op == 'put':
            return self.put(realm, req['collection'], req['record'], event=req.get('event') or 'workspace/record-saved', actor=req.get('actor'), expected=req.get('expectedRevision'), check_expected='expectedRevision' in req)
        if op == 'commit':
            if realm:
                self.book(realm).append('workspace/bridge-operation-denied', {'operation': 'commit', 'reason': 'Generic commit is not exposed.'}, actor='system:workspace-store')
            raise AdapterError('OPERATION_UNAVAILABLE', 'Generic commitment is not an adapter operation.', 'Use the owning business plugin and its human review flow.', 403)
        return self.delivery.execute(req)
