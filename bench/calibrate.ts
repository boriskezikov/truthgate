// Calibration: for every rule (or level, in records written before rules had ids) and confidence bin, how often a
// finding against a claim was right, measured against the gold labels of a runs directory. No model call.
// Writes calibration.json next to the runs; the audit can carry that table to annotate judge findings with the
// precision measured for their bin (src/calibration.ts).
// Usage: npx tsx bench/calibrate.ts --runs <dir> [--out <file>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BINS, binOf, type CalibrationTable } from '../src/calibration.ts';
import { wilson } from '../src/score.ts';
import { recordedReport } from './audit.ts';
import type { GoldRecord } from './label.ts';

const { values } = parseArgs({ options: { runs: { type: 'string' }, out: { type: 'string' } } });
if (!values.runs) throw new Error('--runs <dir> is required');
const dir = values.runs;

interface Row { rule: string; level: string; verdict: string; confidence: number; gold: 'TRUE' | 'FALSE' | 'UNKNOWN' }
const rows: Row[] = [];
const configs = new Set<string>();
let reports = 0;
for (const id of readdirSync(dir).sort()) {
  const reportFile = join(dir, id, 'report.json'), goldFile = join(dir, id, 'gold.json');
  if (!existsSync(reportFile) || !existsSync(goldFile)) continue;
  // The judge's answers were produced under the recorded configuration: a rescored report carries another rule set
  // in its deterministic verdicts, so the as-recorded audit is the source when one was kept.
  const rec = recordedReport(join(dir, id)).record;
  const gold = JSON.parse(readFileSync(goldFile, 'utf8')) as GoldRecord;
  reports++;
  const v = rec.report.version;
  configs.add(JSON.stringify({ judgeModel: rec.judgeModel, votes: rec.votes, rules: v?.rules ?? 'pre-1', prompts: v?.prompts ?? 'pre-1' }));
  for (const verdict of rec.report.verdicts) {
    const g = gold.claims.find((x) => x.claimId === verdict.claimId)?.label;
    if (!g) continue;
    rows.push({ rule: verdict.rule ?? `${verdict.level}.*`, level: verdict.level, verdict: verdict.verdict, confidence: verdict.confidence, gold: g });
  }
}
if (configs.size !== 1) throw new Error(`the runs mix ${configs.size} judge configurations: ${[...configs].join(' | ')}`);
const config = JSON.parse([...configs][0]!) as { judgeModel: string; votes: number; rules: string; prompts: string };

const table: CalibrationTable = { schema: 'truthgate.calibration.v1', measuredOn: dir, reports, ...config, findings: [], supports: [] };
const keys = [...new Set(rows.map((r) => r.rule))].sort();
const md: string[] = [`# Calibration — ${dir}`, '', `Judge ${config.judgeModel}, votes ${config.votes}, rules ${config.rules}, prompts ${config.prompts}; ${reports} gold-labeled reports, ${rows.length} labeled claims.`, '', '## Findings (CONTRADICTED or UNGROUNDED): share that is gold FALSE', '', '| rule | bin | findings | gold FALSE | precision | 95% CI |', '|---|---|---|---|---|---|'];
for (const rule of keys) {
  for (const bin of BINS) {
    const f = rows.filter((r) => r.rule === rule && (r.verdict === 'CONTRADICTED' || r.verdict === 'UNGROUNDED') && binOf(r.confidence) === bin.id && r.gold !== 'UNKNOWN');
    if (!f.length) continue;
    const k = f.filter((r) => r.gold === 'FALSE').length;
    const [lo, hi] = wilson(k, f.length);
    table.findings.push({ rule, bin: bin.id, n: f.length, right: k, precision: k / f.length, ci95: [lo, hi] });
    md.push(`| ${rule} | ${bin.label} | ${f.length} | ${k} | ${(100 * k / f.length).toFixed(0)}% | ${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}% |`);
  }
}
md.push('', '## SUPPORTED: share that is gold TRUE', '', '| rule | bin | supported | gold TRUE | precision | 95% CI |', '|---|---|---|---|---|---|');
for (const rule of keys) {
  for (const bin of BINS) {
    const s = rows.filter((r) => r.rule === rule && r.verdict === 'SUPPORTED' && binOf(r.confidence) === bin.id && r.gold !== 'UNKNOWN');
    if (!s.length) continue;
    const k = s.filter((r) => r.gold === 'TRUE').length;
    const [lo, hi] = wilson(k, s.length);
    table.supports.push({ rule, bin: bin.id, n: s.length, right: k, precision: k / s.length, ci95: [lo, hi] });
    md.push(`| ${rule} | ${bin.label} | ${s.length} | ${k} | ${(100 * k / s.length).toFixed(0)}% | ${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}% |`);
  }
}
const unknown = rows.filter((r) => r.gold === 'UNKNOWN').length;
md.push('', `Claims the gold labeler could not decide (UNKNOWN), excluded above: ${unknown}.`, '');
const out = values.out ?? join(dir, 'calibration.json');
writeFileSync(out, `${JSON.stringify(table, null, 1)}\n`);
writeFileSync(out.replace(/\.json$/, '.md'), `${md.join('\n')}\n`);
console.log(md.join('\n'));
console.log(`written ${out}`);
