"""Native NDJSON adapter; existing Ledger and QEP kernels are reused unchanged."""
from __future__ import annotations
import json
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'src'))
from adapter import Workspace, AdapterError
workspace = Workspace(sys.argv[1])
handshaken = False
for line in sys.stdin:
    req, before = {}, workspace.counts()
    try:
        req = json.loads(line)
        if req.get('op') == 'hello':
            value = workspace.execute(req); handshaken = True
            out = {'id': req.get('rpcId', req.get('id')), 'ok': True, 'value': value}
        elif not handshaken:
            raise AdapterError('HANDSHAKE_REQUIRED', 'The bridge capability handshake is required.', 'Call hello with a supported protocol before using the adapter.', 409)
        elif req.get('op') == 'init':
            out = {'id': req.get('rpcId', req.get('id')), 'ok': True, **workspace.initialize()}
        else:
            value = workspace.execute(req)
            out = {'id': req.get('rpcId', req.get('id')), 'ok': True, 'value': value, 'events': workspace.delta(before), 'health': workspace.status()}
    except Exception as exc:
        out = {'id': req.get('rpcId', req.get('id')), 'ok': False, 'error': str(exc), 'code': getattr(exc, 'code', 'ADAPTER_ERROR'), 'nextAction': getattr(exc, 'next_action', 'Inspect the delivery or record, correct the reported problem and retry.'), 'status': getattr(exc, 'status', 400), 'details': getattr(exc, 'details', None), 'events': workspace.delta(before), 'health': workspace.status()}
    print(json.dumps(out, ensure_ascii=False), flush=True)
