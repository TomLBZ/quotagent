"""Controlled OS faults over actual temporary ledgers; no production disk changes."""
import errno
import json
import sys
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / 'src'), str(ROOT / 'src/system/workspace-store/code')]
from adapter import Workspace, AdapterError
import quotagent.kernel.ledger as ledger_module

root = Path(tempfile.mkdtemp(prefix='store-io-', dir=ROOT / 'tmp'))
checks = []

def request(workspace, body):
    try:
        return workspace.execute(body)
    except Exception as error:
        raise workspace.fail_request(body, error)

def put(realm, value):
    return {'op': 'put', 'realm': realm, 'collection': 'fault-fixture', 'record': {'id': 'item', 'value': value}}

for name, number, partial, full in [('disk-full', errno.ENOSPC, False, False), ('permission-denied', errno.EACCES, False, False), ('partial-tail', errno.ENOSPC, True, False), ('fsync-uncertain', errno.EIO, False, True)]:
    directory = root / name
    workspace = Workspace(directory)
    request(workspace, put('affected', 1))
    target = directory / 'ledgers/affected.jsonl'
    before = target.read_bytes()
    original_open = open

    class PartialFile:
        def __enter__(self):
            self.file = original_open(target, 'a', encoding='utf-8')
            return self
        def write(self, text):
            self.file.write(text[:len(text)//2])
            self.file.flush()
            raise OSError(number, 'Controlled partial write')
        def __exit__(self, *_):
            self.file.close()

    def failed_open(path, mode='r', *args, **kwargs):
        if Path(path) == target and mode == 'a':
            if partial:
                return PartialFile()
            raise OSError(number, 'Controlled ledger open failure')
        return original_open(path, mode, *args, **kwargs)

    fault = patch.object(ledger_module.os, 'fsync', side_effect=OSError(number, 'Controlled fsync failure')) if full else patch('builtins.open', side_effect=failed_open)
    with fault:
        try:
            request(workspace, put('affected', 2))
            raise AssertionError('The injected storage fault was hidden')
        except AdapterError as error:
            assert error.status == 503 and error.code == 'STORAGE_WRITE_UNCERTAIN'
    after = target.read_bytes()
    assert (after == before) == (not partial and not full)
    try:
        request(workspace, put('affected', 3))
        raise AssertionError('An uncertain realm accepted another write')
    except AdapterError as error:
        assert error.code == 'STORAGE_WRITE_UNCERTAIN'
    assert target.read_bytes() == after
    request(workspace, put('healthy', 7))
    assert workspace.current('healthy', 'fault-fixture', 'item')[0]['value'] == 7
    restarted = Workspace(directory)
    restarted.initialize()
    if partial:
        assert restarted.status()['affected']['healthy'] is False
        assert target.read_bytes() == after
    else:
        assert restarted.current('affected', 'fault-fixture', 'item')[0]['value'] == (2 if full else 1)
    checks.append({'fault': name, 'code': 'STORAGE_WRITE_UNCERTAIN', 'laterWriteRefused': True, 'healthyRealmContinues': True, 'reopen': 'quarantined unchanged partial bytes' if partial else 'valid complete uncertain append recovered' if full else 'original record recovered'})

bridge = ROOT / 'src/system/workspace-store/code/bridge.py'
wrapper = '''import os,sys,runpy,errno
original=os.fsync
pending=True
def fault(fd):
 global pending
 original(fd)
 if pending:
  pending=False
  raise OSError(errno.EIO,'Controlled one-time uncertain fsync')
os.fsync=fault
sys.path.insert(0,str(__import__('pathlib').Path(sys.argv[1]).parent))
sys.argv=sys.argv[1:]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
process = subprocess.Popen([sys.executable, '-c', wrapper, str(bridge), str(root / 'ndjson')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
def call(body):
    process.stdin.write(json.dumps(body) + '\n')
    process.stdin.flush()
    return json.loads(process.stdout.readline())
try:
    assert call({'op': 'hello', 'protocol': 'quotagent-store/2'})['ok']
    assert call({'op': 'init'})['ok']
    result = call(put('affected', 1))
    assert result['ok'] is False and result['status'] == 503 and result['code'] == 'STORAGE_WRITE_UNCERTAIN'
    assert result['health']['affected']['healthy'] is False
    assert call(put('affected', 2))['ok'] is False
    assert call(put('healthy', 7))['ok'] is True
finally:
    process.stdin.close()
    assert process.wait(timeout=10) == 0, process.stderr.read()
checks.append({'fault': 'actual-ndjson-fsync', 'code': 'STORAGE_WRITE_UNCERTAIN', 'laterWriteRefused': True, 'healthyRealmContinues': True, 'wireStatus': 503})
report = {'ok': True, 'root': str(root), 'groups': len(checks), 'checks': checks, 'scope': 'Injected Python OS errors around real temporary ledger writes and actual NDJSON bridge. Full fsync failure leaves complete bytes; partial write leaves an actual malformed tail. Not a production disk exhaustion test.'}
(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
