"""Runs TrustGate v0.4 (the ChatGPT-built filter, Python) over TruthGate's recorded runs, in three evidence settings,
and scores its HOLD decision against the same gold labels. TrustGate itself is deterministic and spends nothing.

Usage: python3 -I trustgate_v04.py --trustgate <dir with trustgate/ package> --runs <runs dir> [--out <json>]

Settings:
  strict      : the answer alone, mode strict (what the OpenAI-compatible proxy does).
  evidence    : mode evidence; sources = the files in the sandbox after the run and the raw tool results the agent
                received (TrustGate takes at most 15 sources of 10..7000 characters each).
  receipts    : evidence + explicit claims (TrustGate's own sentence split, so coverage is complete) + Ed25519-signed
                create_file receipts issued by an adapter that attests a sentence only when it names a file the
                before/after hashes show created or modified. This is the most TrustGate's receipt design can get
                from a file-system agent: its operations are send_email, create_file, make_payment, and a receipt
                binds to a claim sentence, not to a file name.
"""
import argparse, base64, hashlib, json, os, re, sys, tempfile, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--trustgate', required=True)
ap.add_argument('--runs', required=True)
ap.add_argument('--out')
args = ap.parse_args()
sys.path.insert(0, args.trustgate)
from trustgate.engine import TrustGate, SPLIT, ACTION, ACTION_OP  # noqa: E402
from trustgate.proofs import canonical  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402

key = Ed25519PrivateKey.generate()
tmp = tempfile.mkdtemp()
pem = Path(tmp) / 'adapter-public.pem'
pem.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
gate = TrustGate(public_key_path=str(pem))

def sources_for(run):
    out = []
    sandbox = Path(run['sandboxDir'])
    for rel in sorted(run['worldAfter']['files']):
        p = sandbox / rel
        if p.is_file():
            text = p.read_text(encoding='utf8', errors='replace')
            if len(text) >= 10:
                out.append({'id': f'file:{rel}', 'text': text[:7000]})
    for e in run['trace']['events']:
        if e['kind'] == 'tool_result' and len(e['content']) >= 10:
            out.append({'id': f'result:{e["seq"]}', 'text': e['content'][:7000]})
    return out[:15]

def changed_files(run):
    before, after = run['worldBefore']['files'], run['worldAfter']['files']
    return {p for p in after if p not in before or before[p]['sha256'] != after[p]['sha256']}

def names_changed_file(sentence, changed):
    return any(re.search(r'(^|[\s/`\'"(,;:])' + re.escape(os.path.basename(p)) + r'($|[\s`\'"),;:.])', sentence) for p in changed)

def receipt_for(sentence, case_id, request_id):
    now = int(time.time())
    body = {'schema': 'trustgate.action.v2', 'issuer': 'trusted-action-adapter', 'tenant': 'bench', 'execution_id': case_id,
            'operation': 'create_file', 'request_id': request_id, 'state': 'completed', 'event_id': f'evt-{request_id}',
            'provider_confirmation_id': f'harness-{request_id}', 'claim_sha256': hashlib.sha256(sentence.strip().encode('utf8')).hexdigest(),
            'issued_at': now, 'expires_at': now + 300}
    body['signature'] = base64.b64encode(key.sign(canonical(body))).decode()
    return body

results = {}
runs_dir = Path(args.runs)
for case_dir in sorted(runs_dir.iterdir()):
    rf = case_dir / 'run.json'
    if not rf.exists():
        continue
    run = json.loads(rf.read_text(encoding='utf8'))
    answer = run['trace']['finalText']
    case_id = run['case']['id']
    rec = {'caseId': case_id}
    if not answer.strip():
        rec['noReport'] = True
        results[case_id] = rec
        continue
    answer = answer[:30000]
    sources = sources_for(run)
    settings = {}
    settings['strict'] = gate.audit({'answer': answer, 'mode': 'strict'})
    settings['evidence'] = gate.audit({'answer': answer, 'mode': 'evidence', 'sources': sources})
    # explicit claims = TrustGate's own split; action sentences about files get an operation binding and, when the
    # adapter can attest them, a signed receipt
    pieces = [s.strip() for s in SPLIT.split(answer) if s.strip()][:100]
    changed = changed_files(run)
    claims, receipts = [], []
    for i, text in enumerate(pieces):
        if ACTION.search(text) and ACTION_OP['create_file'].search(text):
            rid = f'req-{i}'
            claims.append({'text': text, 'kind': 'action', 'action': {'operation': 'create_file', 'request_id': rid}})
            if names_changed_file(text, changed):
                receipts.append(receipt_for(text, case_id, rid))
        else:
            claims.append({'text': text, 'kind': 'auto'})
    try:
        settings['receipts'] = gate.audit({'answer': answer, 'mode': 'evidence', 'sources': sources, 'claims': claims,
                                           'receipts': receipts[:30], 'context': {'tenant': 'bench', 'execution_id': case_id}})
    except ValueError as exc:
        settings['receipts'] = {'release': 'ERROR', 'error': str(exc), 'claim_counts': {}, 'checks': []}
    rec['receiptsIssued'] = len(receipts)
    rec['settings'] = {name: {'release': r['release'], 'claim_counts': r.get('claim_counts', {}), 'error': r.get('error'),
                              'checks': [{'text': c['text'][:160], 'kind': c.get('kind'), 'status': c['status'], 'reason': c['reason']} for c in r.get('checks', [])]}
                       for name, r in settings.items()}
    results[case_id] = rec
    (case_dir / 'trustgate-v04.json').write_text(json.dumps(rec, ensure_ascii=False, indent=1) + '\n', encoding='utf8')

out = args.out or str(runs_dir / 'trustgate-v04-summary.json')
Path(out).write_text(json.dumps(results, ensure_ascii=False, indent=1) + '\n', encoding='utf8')
n = len(results)
for name in ('strict', 'evidence', 'receipts'):
    rel = [r['settings'][name]['release'] for r in results.values() if 'settings' in r]
    counts = {}
    for r in results.values():
        for k, v in r.get('settings', {}).get(name, {}).get('claim_counts', {}).items():
            counts[k] = counts.get(k, 0) + v
    print(f'{name}: HOLD {rel.count("HOLD")}, PASS {rel.count("PASS_WITH_LIMITATIONS")}, ERROR {rel.count("ERROR")} of {len(rel)}; claim statuses {counts}')
print(f'{n} cases written to {out}')
