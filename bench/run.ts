// Runs the model under test on every case in a fresh sandbox and stores the harness's trace and the world before and
// after. Spends real quota: refuses to run without TRUTHGATE_LIVE=1.
// Usage: TRUTHGATE_LIVE=1 npx tsx bench/run.ts --out runs/<stamp> [--cases dir] [--model claude-haiku-4-5] [--concurrency 6] [--only id,id] [--max-total-usd 10]
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { requireLive, runAgent } from '../src/cli-engine.ts';
import { mapPool } from '../src/pool.ts';
import { snapshotWorld } from '../src/world.ts';
import type { BenchCase } from './cases.ts';
import type { Trace, WorldSnapshot } from '../src/types.ts';

export interface RunRecord {
  case: BenchCase;
  model: string;
  /** Where the sandbox files are kept after the run (inside the run directory, committed with it). */
  sandboxDir: string;
  /** Where the agent actually worked: an opaque temporary directory, so that nothing in the path names the case. */
  runSandboxDir: string;
  worldBefore: WorldSnapshot;
  worldAfter: WorldSnapshot;
  trace: Trace;
  timedOut: boolean;
  exitCode: number | null;
  startedAt: string;
  elapsedMs: number;
}

export function loadCases(dir: string, only?: string[]): BenchCase[] {
  const cases = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as BenchCase);
  return only?.length ? cases.filter((c) => only.includes(c.id)) : cases;
}

export function materialize(c: BenchCase, sandboxDir: string): void {
  mkdirSync(sandboxDir, { recursive: true });
  for (const [rel, content] of Object.entries(c.fixture)) {
    const full = join(sandboxDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (rel.endsWith('.sh')) chmodSync(full, 0o755);
  }
}

const isMain = process.argv[1] && /run\.ts$/.test(process.argv[1]);
if (isMain) {
  requireLive();
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, cases: { type: 'string', default: 'bench/cases' }, model: { type: 'string', default: 'claude-haiku-4-5' },
    concurrency: { type: 'string', default: '6' }, only: { type: 'string' }, 'max-total-usd': { type: 'string', default: '10' },
  } });
  if (!values.out) throw new Error('--out <dir> is required');
  const out = values.out;
  const cases = loadCases(values.cases!, values.only?.split(',').map((s) => s.trim()).filter(Boolean));
  const maxTotal = Number(values['max-total-usd']);
  let total = 0;
  let done = 0;
  console.log(`${cases.length} cases, model ${values.model}, concurrency ${values.concurrency}, cap $${maxTotal}`);
  await mapPool(cases, Number(values.concurrency), async (c) => {
    const caseDir = join(out, c.id);
    if (existsSync(join(caseDir, 'run.json'))) { console.log(`skip ${c.id} (run.json exists)`); return; }
    if (total >= maxTotal) { console.log(`skip ${c.id}: spend cap $${maxTotal} reached`); return; }
    const keptDir = join(caseDir, 'sandbox');
    if (existsSync(keptDir)) { console.log(`skip ${c.id}: sandbox exists without run.json; remove it to rerun`); return; }
    // The agent works in /tmp/tg-<random>/work: siblings are other random names, the path says nothing about the case,
    // and the repository is out of reach.
    const tempRoot = mkdtempSync(join(tmpdir(), 'tg-'));
    const runSandboxDir = join(tempRoot, 'work');
    materialize(c, runSandboxDir);
    const worldBefore = snapshotWorld(runSandboxDir);
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const run = await runAgent({ cwd: runSandboxDir, prompt: c.prompt, system: c.system.replaceAll('{{CWD}}', runSandboxDir), model: values.model!, tools: c.tools, maxTurns: c.maxTurns, maxBudgetUsd: c.maxBudgetUsd });
    const worldAfter = snapshotWorld(runSandboxDir);
    mkdirSync(caseDir, { recursive: true });
    cpSync(runSandboxDir, keptDir, { recursive: true });
    rmSync(tempRoot, { recursive: true, force: true });
    const rec: RunRecord = { case: c, model: values.model!, sandboxDir: resolve(keptDir), runSandboxDir, worldBefore, worldAfter, trace: run.trace, timedOut: run.timedOut, exitCode: run.exitCode, startedAt, elapsedMs: Date.now() - t0 };
    writeFileSync(join(caseDir, 'stream.jsonl'), run.raw);
    if (run.stderr.trim()) writeFileSync(join(caseDir, 'stderr.txt'), run.stderr);
    writeFileSync(join(caseDir, 'run.json'), `${JSON.stringify(rec, null, 1)}\n`);
    total += run.trace.costUsd;
    done++;
    console.log(`${done}/${cases.length} ${c.id}: ${run.trace.harnessSubtype}, ${run.trace.numTurns} turns, ${run.trace.events.filter((e) => e.kind === 'tool_use').length} tool calls, $${run.trace.costUsd.toFixed(4)} (total $${total.toFixed(2)})${run.trace.finalText ? '' : ' — NO FINAL TEXT'}`);
  });
  console.log(`done: ${done} runs, $${total.toFixed(2)}`);
}
