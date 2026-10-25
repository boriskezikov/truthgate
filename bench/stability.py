"""Verdict stability: the same recorded runs audited again, compared with the original report.json; a third directory
(e.g. an audit with another vote count) is optional. Usage: python3 -I stability.py --original <runs dir> --repeat <dir> [--votes3 <dir>]"""
import argparse, json
from pathlib import Path
ap = argparse.ArgumentParser(); ap.add_argument('--original', required=True); ap.add_argument('--repeat', required=True); ap.add_argument('--votes3'); a = ap.parse_args()
def load(d):
    out = {}
    for c in Path(d).iterdir():
        f = c / 'report.json'
        if f.exists(): out[c.name] = json.loads(f.read_text())['report']
    return out
orig, rep = load(a.original), load(a.repeat); v3 = load(a.votes3) if a.votes3 else rep
ids = sorted(set(rep) & set(v3) & set(orig))
def flips(a_, b_):
    same = sum(1 for i in ids if a_[i]['verdict'] == b_[i]['verdict']); return same, len(ids)
def claim_stats(x):
    n = sum(len(r['claims']) for r in x.values()); return n
print(f'{len(ids)} reports audited three times (original, repeat, 3-vote)')
s, n = flips(orig, rep); print(f'- report verdict identical, original vs repeat: {s}/{n}')
s, n = flips(orig, v3); print(f'- report verdict identical, original vs 3-vote: {s}/{n}')
print(f'- claims extracted: original {sum(len(orig[i]["claims"]) for i in ids)}, repeat {sum(len(rep[i]["claims"]) for i in ids)}, 3-vote {sum(len(v3[i]["claims"]) for i in ids)}')
diff = [(i, orig[i]['verdict'], rep[i]['verdict'], v3[i]['verdict']) for i in ids if len({orig[i]['verdict'], rep[i]['verdict'], v3[i]['verdict']}) > 1]
print('- reports whose verdict changed between runs:', diff or 'none')
# p(deceptive) spread
import statistics
d = [abs(orig[i]['pDeceptive'] - rep[i]['pDeceptive']) for i in ids]; print(f'- |Δ p(deceptive)| original vs repeat: mean {statistics.mean(d):.2f}, max {max(d):.2f}')
# judge-level verdict agreement on matching claim texts
agree = tot = 0
for i in ids:
    o = {c['text']: v for c, v in zip(orig[i]['claims'], orig[i]['verdicts'])}
    for c, v in zip(v3[i]['claims'], v3[i]['verdicts']):
        if c['text'] in o and (o[c['text']]['level'] == 'judge' or v['level'] == 'judge'):
            tot += 1; agree += o[c['text']]['verdict'] == v['verdict']
print(f'- judge-level claims with identical text across original and 3-vote: {tot}, same verdict {agree}')
