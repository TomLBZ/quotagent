"""Read-only native evidence operations over unchanged kernel helpers."""
from pathlib import Path
import base64
import json
import sys
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'src'))
from quotagent.kernel.ledger import Ledger
from quotagent.kernel.evidence import export, verify, inclusion_proof, verify_inclusion
from quotagent.kernel.canon import canonical_bytes, digest


def execute(request):
    if request['op'] == 'export':
        ledger = Ledger(Path(request['path']), realm=request['realm'])
        first, last = int(request.get('fromSeq') or 1), int(request.get('toSeq') or ledger.count)
        if first < 1 or last < first or last > ledger.count or last - first + 1 > 20000:
            raise ValueError('Choose an existing nonempty ledger range of at most 20,000 events.')
        pack = export(ledger, from_seq=first, to_seq=last, scope=request.get('scope'), generated_at=request['generatedAt'])
        chosen = request.get('proofSeqs') or sorted(set([first, (first + last) // 2, last]))
        proofs = [inclusion_proof(pack, int(seq)) for seq in chosen]
        return {'payloadBase64': base64.b64encode(canonical_bytes(pack)).decode(), 'manifest': pack['manifest'], 'proofs': proofs, 'scope': pack['scope']}
    if request['op'] == 'verify':
        raw = base64.b64decode(request['payloadBase64'], validate=True)
        pack = json.loads(raw)
        if pack.get('kind') != 'quotagent/evidence-pack' or not isinstance(pack.get('events'), list) or not pack['events']:
            raise ValueError('The evidence payload needs its original event slice.')
        report = verify(pack)
        # The native outer Ed25519 signature owns identity. The inner historical
        # pack is deliberately unsigned; do not relabel signature presence as a pass.
        labels = ['Event and body hash chain', 'Merkle root', 'Event leaf list', 'Manifest event count', 'Manifest sequence boundaries', 'Manifest digest', 'Payload pack digest', 'Manifest leaves and root']
        checks = [{**check, 'name': labels[index]} for index, check in enumerate(report['checks'][:8])]
        proofs = request.get('proofs') or []
        expected = request.get('proofSeqs') or []
        by_seq = {event['seq']: event for event in pack['events']}
        proofs_ok = bool(proofs) and sorted(item.get('seq') for item in proofs) == sorted(expected)
        for proof in proofs:
            event = by_seq.get(proof.get('seq'))
            proofs_ok = proofs_ok and bool(event) and proof.get('index') == next((index for index, row in enumerate(pack['events']) if row['seq'] == proof.get('seq')), None) and proof.get('leaf') == event['entry_hash'] and proof.get('merkle_root') == pack['merkle_root'] and verify_inclusion(proof)
        checks.append({'name': 'Required event inclusion proofs', 'ok': bool(proofs_ok), 'detail': f'{len(proofs)} proofs checked against the signed slice'})
        return {'ok': all(check['ok'] for check in checks), 'checks': checks, 'manifest': pack['manifest'], 'scope': pack['scope']}
    raise ValueError('Unknown read-only evidence operation.')


try:
    value = execute(json.load(sys.stdin))
    print(json.dumps({'ok': True, 'value': value}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
