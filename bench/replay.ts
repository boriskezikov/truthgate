// Replays the deterministic levels (trace, world) over recorded runs without any model call, from the raw stream and
// the kept sandbox, and compares them with the recorded verdicts: the proofs a reader can re-check for free.
// Usage: npx tsx bench/replay.ts --runs <dir> [--only id,id] [--verbose]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseStreamJson } from '../src/cli-engine.ts';
import { verifyDeterministically } from '../src/verify.ts';
import { snapshotWorld } from '../src/world.ts';
import type { AuditRecord } from './audit.ts';
import { loadRuns } from './audit.ts';

const { values } = parseArgs({ options: { runs: { type: 'string' }, only: { type: 'string' }, verbose: { type: 'boolean', default: false } } });
if (!values.runs) throw new Error('--runs <dir> is required');
const runs = loadRuns(values.runs, values.only?.split(',').map((s) => s.trim()).filter(Boolean));
let claims = 0, settled = 0, same = 0, differ = 0, wouldJudge = 0;
for (const run of runs) {
  const dir = join(values.runs, run.case.id);
  if (!existsSync(join(dir, 'report.json'))) continue;
  const rec = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as AuditRecord;
  const streamFile = join(dir, 'stream.jsonl');
  const trace = existsSync(streamFile) ? parseStreamJson(readFileSync(streamFile, 'utf8')) : run.trace;
  const worldAfter = existsSync(run.sandboxDir) ? snapshotWorld(run.sandboxDir) : run.worldAfter;
  const det = verifyDeterministically({ taskPrompt: run.case.prompt, claims: rec.report.claims, trace, sandboxDir: run.sandboxDir, sandboxAliases: [run.runSandboxDir], worldBefore: run.worldBefore, worldAfter });
  for (const c of rec.report.claims) {
    claims++;
    const now = det.verdicts.get(c.id);
    const recorded = rec.report.verdicts.find((v) => v.claimId === c.id)!;
    if (!now) { wouldJudge++; if (values.verbose) console.log(`${run.case.id} ${c.id}: would go to the judge (recorded: ${recorded.verdict} by ${recorded.level})`); continue; }
    settled++;
    if (now.verdict === recorded.verdict && recorded.level !== 'judge') same++;
    else { differ++; console.log(`${run.case.id} ${c.id}: replay ${now.verdict} (${now.level}) vs recorded ${recorded.verdict} (${recorded.level}) — ${now.reason}`); }
    if (values.verbose) console.log(`${run.case.id} ${c.id}: ${now.verdict} by ${now.level} — ${now.reason}`);
  }
}
console.log(`${runs.length} runs, ${claims} claims: ${settled} settled deterministically (${same} as recorded, ${differ} differ), ${wouldJudge} need the judge`);
