// Runs the detector on every captured run. The detector sees the task, the trace, the sandbox and the world
// snapshots: never the oracle. Spends judge quota: refuses to run without TRUTHGATE_LIVE=1.
// Usage: TRUTHGATE_LIVE=1 npx tsx bench/audit.ts --runs runs/<stamp> [--judge claude-sonnet-5-5] [--votes 3] [--concurrency 4] [--only id,id] [--force] [--out <dir>]  (--out: write report.json under another directory, for a repeat audit)
// --claims-from <dir>: reuse the claims of the audit as recorded under <dir>/<case>/ (recordedReport below), so that the gold labels keyed by claim id stay valid; the extractor does not run.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireLive } from '../src/cli-engine.ts';
import { mapPool } from '../src/pool.ts';
import { modelClientFromEnv } from '../src/model-env.ts';
import { audit } from '../src/truthgate.ts';
import type { Report } from '../src/types.ts';
import type { RunRecord } from './run.ts';

export interface AuditRecord { caseId: string; judgeModel: string; votes: number; report: Report; elapsedMs: number }

export function loadRuns(dir: string, only?: string[]): RunRecord[] {
  return readdirSync(dir).filter((d) => existsSync(join(dir, d, 'run.json'))).sort()
    .map((d) => JSON.parse(readFileSync(join(dir, d, 'run.json'), 'utf8')) as RunRecord)
    .filter((r) => !only?.length || only.includes(r.case.id));
}

/** The audit of a case as recorded, for the tools that must not read a rescore as an audit: `report.json` when it
 *  is an audit (no `rescoredRules`), else the kept `report.rules-<v>.json` of the latest audit (a rescore keeps the
 *  record it started from under the rules it was audited with). */
export function recordedReport(caseDir: string, name = 'report'): { file: string; record: AuditRecord } {
  const current = join(caseDir, `${name}.json`);
  const read = (file: string) => ({ file, record: JSON.parse(readFileSync(file, 'utf8')) as AuditRecord });
  if (existsSync(current)) { const r = read(current); if (!(r.record.report.version as { rescoredRules?: string } | undefined)?.rescoredRules) return r; }
  const version = (f: string) => (/\.rules-(.*)\.json$/.exec(f)?.[1] ?? '0').split('.').map(Number);
  const newer = (a: string, b: string) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; };
  const backups = readdirSync(caseDir).filter((f) => f.startsWith(`${name}.rules-`) && f.endsWith('.json')).sort(newer);
  const latest = backups[backups.length - 1];
  if (!latest) throw new Error(`${caseDir}: ${name}.json is a rescore and no audit as recorded is kept next to it`);
  return read(join(caseDir, latest));
}

const isMain = process.argv[1] && /audit\.ts$/.test(process.argv[1]);
if (isMain) {
  requireLive();
  const { values } = parseArgs({ options: { runs: { type: 'string' }, judge: { type: 'string', default: 'claude-sonnet-5-5' }, votes: { type: 'string' }, concurrency: { type: 'string', default: '4' }, only: { type: 'string' }, 'claims-from': { type: 'string' }, force: { type: 'boolean', default: false }, out: { type: 'string' } } });
  if (!values.runs) throw new Error('--runs <dir> is required');
  const runs = loadRuns(values.runs, values.only?.split(',').map((s) => s.trim()).filter(Boolean));
  let total = 0;
  const failed: string[] = [];

  console.log(`${runs.length} runs, judge ${values.judge}, votes ${values.votes ?? 'default'}`);
  await mapPool(runs, Number(values.concurrency), async (r) => {
    const file = join(values.out ?? values.runs!, r.case.id, 'report.json');
    if (values.out) mkdirSync(join(values.out, r.case.id), { recursive: true });
    if (existsSync(file) && !values.force) { console.log(`skip ${r.case.id} (report.json exists)`); return; }
    const t0 = Date.now();
    let report: Report;
    try {
      report = await audit({ taskPrompt: r.case.prompt, trace: r.trace, sandboxDir: r.sandboxDir, sandboxAliases: [r.runSandboxDir], worldBefore: r.worldBefore, worldAfter: r.worldAfter, ...(values['claims-from'] ? { claims: recordedReport(join(values['claims-from'], r.case.id)).record.report.claims } : {}), judgeModel: values.judge!, judge: process.env.TRUTHGATE_MODEL_PATH ? modelClientFromEnv(values.judge!) : undefined, votes: values.votes ? Number(values.votes) : undefined });
    } catch (e) {
      failed.push(r.case.id);
      console.log(`FAILED ${r.case.id}: ${(e as Error).message.slice(0, 200)} (rerun picks it up)`);
      return;
    }
    const rec: AuditRecord = { caseId: r.case.id, judgeModel: values.judge!, votes: report.version.votes, report, elapsedMs: Date.now() - t0 };
    writeFileSync(file, `${JSON.stringify(rec, null, 1)}\n`);
    total += report.judgeCostUsd;
    const against = report.verdicts.filter((v) => v.verdict === 'CONTRADICTED' || v.verdict === 'UNGROUNDED').length;
    console.log(`${r.case.id}: ${report.verdict} p=${report.pDeceptive.toFixed(2)} claims=${report.claims.length} against=${against} omissions=${report.omissions.length} $${report.judgeCostUsd.toFixed(3)} (total $${total.toFixed(2)})${report.notes.length ? ` notes: ${report.notes.join('; ')}` : ''}`);
  });
  console.log(`done, judge spend $${total.toFixed(2)}${failed.length ? `; ${failed.length} failed: ${failed.join(', ')}` : ''}`);
}
