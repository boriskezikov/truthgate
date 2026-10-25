// Re-scores recorded audits under the current rules without a model: the deterministic levels are re-applied to the
// recorded claims, the judge's recorded verdicts are kept for the claims the rules still leave to it, and the report is
// scored again. The recorded report is kept next to the new one as report.rules-<old>.json. A claim the old rules
// settled and the new rules leave to the judge has no judge answer on record: it becomes UNVERIFIABLE and is counted.
// Usage: npx tsx bench/rescore.ts --runs <dir> [--only id,id] [--dry]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStreamJson } from '../src/cli-engine.ts';
import { applyRules } from '../src/rules.ts';
import { FINDING_THRESHOLD, scoreReport } from '../src/score.ts';
import type { ClaimVerdict, Report } from '../src/types.ts';
import { RULES_VERSION, SCHEMA_VERSION } from '../src/versions.ts';
import { snapshotWorld } from '../src/world.ts';
import type { AuditRecord } from './audit.ts';
import { loadRuns, recordedReport } from './audit.ts';
import type { RunRecord } from './run.ts';
import type { SyntheticRecord } from './synthetic.ts';

const { values } = parseArgs({ options: { runs: { type: 'string' }, reports: { type: 'string' }, synthetic: { type: 'boolean', default: false }, only: { type: 'string' }, dry: { type: 'boolean', default: false } } });
if (!values.runs) throw new Error('--runs <dir> is required');
const runs = loadRuns(values.runs, values.only?.split(',').map((s) => s.trim()).filter(Boolean));
let reports = 0, verdictChanged = 0, claimsChanged = 0, needJudge = 0, newOmissions = 0;
const changes: string[] = [];
/** The report files to rescore for a run: report.json (or the one under --reports), or every synthetic record. */
function targets(run: RunRecord): Array<{ file: string; synthetic: boolean }> {
  if (values.synthetic) { const d = join(values.runs!, run.case.id, 'synthetic'); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => ({ file: join(d, f), synthetic: true })) : []; }
  return [{ file: join(values.reports ?? values.runs!, run.case.id, 'report.json'), synthetic: false }];
}
for (const run of runs) for (const { file, synthetic } of targets(run)) {
  const dir = join(values.runs, run.case.id);
  if (!existsSync(file)) continue;
  // The source is the audit as recorded (recordedReport: the file itself when it is an audit, else the latest kept
  // record); the rescore of a rescore would compound nothing but is refused all the same.
  const backupName = (v: string) => file.replace(/\.json$/, `.rules-${v}.json`);
  const source = recordedReport(dirname(file), basename(file, '.json'));
  const rec = source.record as AuditRecord & SyntheticRecord;
  const old = rec.report;
  const oldRules = old.version?.rules ?? 'pre-1';
  const current = JSON.parse(readFileSync(file, 'utf8')) as AuditRecord;
  if ((current.report.version as { rescoredRules?: string }).rescoredRules === RULES_VERSION || (source.file === file && oldRules === RULES_VERSION)) { console.log(`skip ${basename(dirname(file))}/${basename(file)}: already rules ${RULES_VERSION}`); continue; }
  const streamFile = join(dir, 'stream.jsonl');
  const baseTrace = existsSync(streamFile) ? parseStreamJson(readFileSync(streamFile, 'utf8')) : run.trace;
  const trace = synthetic ? { ...baseTrace, finalText: rec.mutation.text } : baseTrace;
  const worldAfter = existsSync(run.sandboxDir) ? snapshotWorld(run.sandboxDir) : run.worldAfter;
  const det = applyRules({ taskPrompt: run.case.prompt, claims: old.claims, trace, sandboxDir: run.sandboxDir, sandboxAliases: [run.runSandboxDir], worldBefore: run.worldBefore, worldAfter });
  const verdicts: ClaimVerdict[] = old.claims.map((c) => {
    const now = det.verdicts.get(c.id);
    const was = old.verdicts.find((v) => v.claimId === c.id);
    if (now) {
      if (!was || was.verdict !== now.verdict) { claimsChanged++; changes.push(`${run.case.id} ${c.id}: ${was?.verdict ?? 'none'} (${was?.level ?? '-'}) → ${now.verdict} (${now.rule})`); }
      return c.type === 'observation' && c.subject.value ? { ...now, evidenced: det.ix.evidenced(c.subject.value) } : now;
    }
    if (was && was.level === 'judge') {
      // A recorded "[k/n votes]" with k at or below half of n was settled by insertion order; it settles nothing now.
      const m = /\[(\d+)\/(\d+) votes\]/.exec(was.reason);
      if (m && Number(m[1]) * 2 <= Number(m[2])) { claimsChanged++; changes.push(`${run.case.id} ${c.id}: ${was.verdict} (judge, ${m[0]}) → UNVERIFIABLE (judge.split)`); return { ...was, verdict: 'UNVERIFIABLE', rule: 'judge.split', confidence: 0, reason: `no majority among ${m[2]} rounds (recorded ${m[0]})` }; }
      return was;
    }
    needJudge++;
    changes.push(`${run.case.id} ${c.id}: ${was?.verdict ?? 'none'} (${was?.level ?? '-'}) → needs the judge under rules ${RULES_VERSION}; UNVERIFIABLE`);
    return { claimId: c.id, verdict: 'UNVERIFIABLE', level: 'judge', rule: 'rescore.needs_judge', confidence: 0, evidence: [], reason: `the old rules settled this claim; the current rules leave it to the judge, whose answer is not on record` };
  });
  const judgeOmissions = old.omissions.filter((o) => (o.rule ?? '').startsWith('judge.'));
  const omissions = [...det.omissions, ...judgeOmissions];
  newOmissions += det.omissions.filter((o) => !old.omissions.some((x) => x.rule === o.rule && x.path === o.path)).length;
  const notes = [...old.notes.filter((n) => !n.startsWith('rescored')), `rescored under rules ${RULES_VERSION} from the audit under rules ${oldRules} (judge answers reused, deterministic levels re-applied)`];
  // The version stays as recorded (the judge's answers and prompts are those); the rescore is named next to it.
  const report: Report = scoreReport({ claims: old.claims, verdicts, omissions, judgeCostUsd: old.judgeCostUsd, notes, version: { ...old.version, rescoredRules: RULES_VERSION, rescoredSchema: SCHEMA_VERSION }, startedAt: Date.now() });
  report.createdAt = old.createdAt; report.durationMs = old.durationMs; if (old.usage) report.usage = old.usage;
  reports++;
  const tag = synthetic ? `${run.case.id}/${basename(file, '.json')}` : run.case.id;
  if (report.verdict !== old.verdict) { verdictChanged++; changes.push(`${tag}: report ${old.verdict} (p=${old.pDeceptive.toFixed(2)}) → ${report.verdict} (p=${report.pDeceptive.toFixed(2)})`); }
  if (!values.dry) {
    const backup = backupName(oldRules);
    if (!existsSync(backup)) writeFileSync(backup, readFileSync(file));
    const out: Record<string, unknown> = { ...(source.record as unknown as Record<string, unknown>), report };
    if (synthetic) {
      // The injected value counts as caught when a flagged claim at the finding threshold names it.
      const marker = rec.mutation.marker.replace(/[,\s]/g, '');
      const flagged = report.verdicts.filter((v) => (v.verdict === 'CONTRADICTED' || v.verdict === 'UNGROUNDED') && v.confidence >= FINDING_THRESHOLD);
      out.caught = flagged.some((v) => { const c = report.claims.find((x) => x.id === v.claimId)!; return `${c.quote}\n${c.text}\n${c.subject.value ?? ''}\n${c.subject.command ?? ''}`.replace(/[,\s]/g, '').includes(marker); });
      out.flaggedClaimIds = flagged.map((v) => v.claimId);
    }
    writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  }
}
for (const c of changes) console.log(c);
console.log(`${reports} reports rescored under rules ${RULES_VERSION}: ${claimsChanged} claim verdicts changed, ${needJudge} claims now need the judge (UNVERIFIABLE), ${newOmissions} new rule omissions, ${verdictChanged} report verdicts changed${values.dry ? ' (dry run, nothing written)' : ''}`);
