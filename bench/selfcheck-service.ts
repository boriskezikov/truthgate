// Self-check of the service: starts it in-process on an ephemeral loopback port with the fake judge and a token, and
// drives every status path with fetch. No model, no network beyond loopback, no file outside os.tmpdir(). Also checks
// the validator against every committed run record and the engine's child environment. Prints one line per check
// and exits non-zero on any failure.
// Usage: npx tsx bench/selfcheck-service.ts
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunRecord } from '../src/adapters/validate.ts';
import type { ModelClient, StructuredCall } from '../src/model.ts';
import { RULES_VERSION, SCHEMA_VERSION } from '../src/versions.ts';
import type { ServiceConfig } from '../service/server.ts';
import type { RunRecord } from './run.ts';

// A stub `claude` on TRUTHGATE_CLAUDE_BIN: if any model call bypassed the judge client and reached the CLI, the stub
// would answer `claude -p --json-schema` with a canned structured_output instead of a real model, and the last check
// counts such spawns (it must be 0). With TRUTHGATE_MODEL_PATH=fake the service passes the fake client as `judge`, so
// no real model runs either way. cli-engine.ts reads TRUTHGATE_CLAUDE_BIN when it loads, so the engine is imported
// after this.
const stubDir = mkdtempSync(join(tmpdir(), 'tg-selfcheck-'));
const stubBin = join(stubDir, 'claude');
const stubLog = join(stubDir, 'calls.log');
writeFileSync(stubBin, `#!/bin/sh
# Stub claude CLI for the TruthGate service self-check: a canned structured_output chosen by the schema; no model.
schema=""
while [ $# -gt 0 ]; do if [ "$1" = "--json-schema" ]; then schema="$2"; shift; fi; shift; done
cat >/dev/null
echo "call" >> "${stubLog}"
sleep 0.3
case "$schema" in
  *'"claims"'*) out='{"claims":[]}';;
  *'"verdicts"'*) out='{"verdicts":[],"failures":[]}';;
  *) printf '{"type":"result","subtype":"error","is_error":true,"result":"stub claude: no canned answer for this schema"}\\n'; exit 1;;
esac
printf '{"type":"result","subtype":"success","is_error":false,"structured_output":%s,"total_cost_usd":0,"num_turns":1}\\n' "$out"
`);
chmodSync(stubBin, 0o755);
process.env.TRUTHGATE_CLAUDE_BIN = stubBin;
process.env.TRUTHGATE_LIVE = '1'; // only the stub can be spawned: TRUTHGATE_CLAUDE_BIN is an absolute path
const { childEnv } = await import('../src/cli-engine.ts');
const { fakeModelClient } = await import('../src/model-api.ts');
const { BODY_LIMIT, configFromEnv, createServer, TMP_PREFIX } = await import('../service/server.ts');

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpCount = () => readdirSync(tmpdir()).filter((n) => n.startsWith(TMP_PREFIX)).length;
const stubCalls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).length : 0);

const TOKEN = 'selfcheck-token';
const VERDICTS = new Set(['HONEST', 'DECEPTIVE', 'NEEDS_REVIEW', 'UNVERIFIED']);
const BASE_ENV: NodeJS.ProcessEnv = { TRUTHGATE_MODEL_PATH: 'fake', TRUTHGATE_API_TOKEN: TOKEN, TRUTHGATE_PORT: '0', TRUTHGATE_HOST: '127.0.0.1' };

/** One Write tool call with its result, a final report, the file it created. */
const RECORD = {
  taskPrompt: 'Create a.txt containing alpha.',
  trace: {
    events: [
      { seq: 0, kind: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/work/a.txt', content: 'alpha' } },
      { seq: 1, kind: 'tool_result', id: 'toolu_1', name: 'Write', content: 'File created successfully at: /work/a.txt', isError: false, exitCode: null, looksLikeFailure: false },
      { seq: 2, kind: 'text', text: 'Created a.txt.' },
    ],
    finalText: 'Created a.txt.', model: 'claude-haiku-4-5', cliVersion: '2.1.310', toolsAvailable: ['Write'], numTurns: 2, costUsd: 0.001,
    harnessSubtype: 'success', harnessIsError: false, harnessResultText: 'Created a.txt.', permissionDenials: [],
  },
  worldBefore: { files: {} },
  files: { 'a.txt': 'alpha' },
  sandboxAliases: ['/work'],
};

interface Started { base: string; logs: Record<string, unknown>[]; close(): Promise<void> }
async function start(overrides: Partial<ServiceConfig> = {}, env: NodeJS.ProcessEnv = BASE_ENV): Promise<Started> {
  const logs: Record<string, unknown>[] = [];
  const handle = createServer({ ...configFromEnv(env), log: (l) => { logs.push(l); }, ...overrides });
  const { port } = await handle.listen();
  return { base: `http://127.0.0.1:${port}`, logs, close: () => handle.close() };
}
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (base: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}/v1/audit`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth, ...headers }, body });
const metricValue = (text: string, line: string): number => { const m = new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+)$`, 'm').exec(text); return m ? Number(m[1]) : NaN; };

/** The fake judge, slowed down: for the queue and timeout checks when audit() consults `judge`. */
function slowJudge(ms: number): ModelClient {
  const fake = fakeModelClient('claude-sonnet-5-5');
  return { model: fake.model, path: fake.path, async structured<T>(call: StructuredCall) { await sleep(ms); return fake.structured<T>(call); } };
}

// ---------- configuration refusals ----------
const refuses = (env: NodeJS.ProcessEnv, needle: string) => { try { configFromEnv(env); return false; } catch (e) { return (e as Error).message.includes(needle); } };
check('config: no token on a public host is refused', refuses({ TRUTHGATE_MODEL_PATH: 'fake', TRUTHGATE_HOST: '0.0.0.0' }, 'TRUTHGATE_API_TOKEN'));
check('config: no token with TRUTHGATE_ALLOW_ANONYMOUS=1 on 127.0.0.1 is accepted', !refuses({ TRUTHGATE_MODEL_PATH: 'fake', TRUTHGATE_ALLOW_ANONYMOUS: '1' }, ''));
check('config: no token with TRUTHGATE_ALLOW_ANONYMOUS=1 on a public host is refused', refuses({ TRUTHGATE_MODEL_PATH: 'fake', TRUTHGATE_ALLOW_ANONYMOUS: '1', TRUTHGATE_HOST: '0.0.0.0' }, 'TRUTHGATE_API_TOKEN'));
check('config: TRUTHGATE_MODEL_PATH unset is refused', refuses({ TRUTHGATE_API_TOKEN: TOKEN }, 'TRUTHGATE_MODEL_PATH'));
check('config: api without ANTHROPIC_API_KEY is refused', refuses({ TRUTHGATE_API_TOKEN: TOKEN, TRUTHGATE_MODEL_PATH: 'api' }, 'ANTHROPIC_API_KEY'));
check('config: cli without TRUTHGATE_LIVE=1 is refused', refuses({ TRUTHGATE_API_TOKEN: TOKEN, TRUTHGATE_MODEL_PATH: 'cli' }, 'TRUTHGATE_LIVE'));
check('config: a non-integer TRUTHGATE_VOTES is refused', refuses({ ...BASE_ENV, TRUTHGATE_VOTES: 'three' }, 'TRUTHGATE_VOTES'));

// ---------- the main server ----------
const tmpBefore = tmpCount();
const s = await start();

{
  const r = await fetch(`${s.base}/health`);
  const h = await r.json() as { status: string; versions: { schema: string; rules: string }; judgeModel: string; modelPath: string; votes: number };
  check('GET /health is 200 without a token', r.status === 200, String(r.status));
  check('health carries status, versions, judgeModel, modelPath, votes', h.status === 'ok' && h.versions.schema === SCHEMA_VERSION && h.versions.rules === RULES_VERSION && h.judgeModel === 'claude-sonnet-5-5' && h.modelPath === 'fake' && h.votes === 3, JSON.stringify(h));
}
{
  const r = await fetch(`${s.base}/v1/audit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(RECORD) });
  const b = await r.json() as { error: { code: string } };
  check('POST /v1/audit without the token is 401', r.status === 401 && b.error.code === 'unauthorized', `${r.status} ${JSON.stringify(b)}`);
  const wrong = await fetch(`${s.base}/v1/audit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: JSON.stringify(RECORD) });
  check('POST /v1/audit with a wrong token is 401', wrong.status === 401, String(wrong.status));
  const m = await fetch(`${s.base}/metrics`);
  check('GET /metrics without the token is 401', m.status === 401, String(m.status));
}
{
  const r = await post(s.base, `{"x":"${'a'.repeat(BODY_LIMIT)}"}`);
  const b = await r.json() as { error: { code: string } };
  check('a body over 8 MB is 413', r.status === 413 && b.error.code === 'payload_too_large', `${r.status} ${JSON.stringify(b)}`);
}
{
  const r = await post(s.base, '{');
  const b = await r.json() as { error: { code: string; message: string } };
  check('a body that is not JSON is 400', r.status === 400 && b.error.code === 'invalid_json', `${r.status} ${JSON.stringify(b)}`);
}
{
  const r = await post(s.base, JSON.stringify({ ...RECORD, files: { '../x': 'a' } }));
  const b = await r.json() as { error: { code: string; errors: string[] } };
  check('a record with ../x in files is 422 with the list', r.status === 422 && b.error.code === 'invalid_record' && b.error.errors.some((e) => e.startsWith('record.files["../x"]') && e.includes('..')), `${r.status} ${JSON.stringify(b)}`);
  const empty = await post(s.base, '{}');
  const eb = await empty.json() as { error: { errors: string[] } };
  check('an empty record names every missing field', empty.status === 422 && ['record.taskPrompt', 'record.trace', 'record.files'].every((p) => eb.error.errors.some((e) => e.startsWith(p))), JSON.stringify(eb));
  const abs = await post(s.base, JSON.stringify({ ...RECORD, files: { '/etc/passwd': 'x' }, sandboxAliases: ['relative'] }));
  const ab = await abs.json() as { error: { errors: string[] } };
  check('an absolute file path and a relative alias are both named', abs.status === 422 && ab.error.errors.some((e) => e.includes('leading /')) && ab.error.errors.some((e) => e.includes('sandboxAliases[0]')), JSON.stringify(ab));
  {
    const foreign = JSON.parse(JSON.stringify(RECORD)) as { trace: { toolRoles?: unknown; events: Array<Record<string, unknown>> } };
    foreign.trace.toolRoles = { shell: ['shell'], read: ['read_file'], write: [], edit: [] };
    foreign.trace.events = [{ seq: 1, kind: 'tool_use', id: 't1', name: 'shell', input: { cmd: './validate.sh' } }, { seq: 2, kind: 'tool_result', id: 't1', name: 'shell', content: 'ok', isError: false, exitCode: 0, looksLikeFailure: false }];
    const r = await post(s.base, JSON.stringify(foreign));
    const b = await r.json() as { error: { errors: string[] } };
    check('a shell tool whose line is not under "command" is refused at the boundary, not audited', r.status === 422 && b.error.errors.some((x) => /must carry its command line under "command"/.test(x)), `${r.status} ${JSON.stringify(b).slice(0, 200)}`);
  }
}
let audits = 0;
let verdict = '';
{
  const r = await post(s.base, JSON.stringify(RECORD));
  const b = await r.json() as { requestId: string; report: { version: { schema: string }; verdict: string; judgeCostUsd: number }; notes: string[] };
  const ok = r.status === 200 && typeof b.requestId === 'string' && b.report?.version?.schema === SCHEMA_VERSION && VERDICTS.has(b.report?.verdict);
  check('a minimal valid record is 200 with a Report (version, verdict)', ok, `${r.status} ${JSON.stringify(b).slice(0, 400)}`);
  if (ok) { audits++; verdict = b.report.verdict; }
  check('the response carries notes (empty with worldBefore)', Array.isArray(b.notes) && b.notes.length === 0, JSON.stringify(b.notes));
  check('x-request-id header equals requestId', r.headers.get('x-request-id') === b.requestId);
}
{
  const { worldBefore: _omit, ...withoutBefore } = RECORD;
  void _omit;
  const r = await post(s.base, JSON.stringify(withoutBefore));
  const b = await r.json() as { report?: { verdict: string }; notes?: string[] };
  const ok = r.status === 200 && (b.notes ?? []).some((n) => n.includes('creation claims cannot be settled'));
  check('without worldBefore the response says creation claims cannot be settled', ok, `${r.status} ${JSON.stringify(b).slice(0, 300)}`);
  {
    // The one claim the fake extractor cannot make is injected through a judge that extracts it: a creation claim over a
    // record without worldBefore must reach the judge, never a confident CONTRADICTED against an empty "before".
    const extracting: ModelClient = { model: 'fake', path: 'fake', async structured<T>(call: StructuredCall) { const props = Object.keys((call.schema as { properties?: Record<string, unknown> }).properties ?? {}); if (props.includes('claims')) return { output: { claims: [{ type: 'action', text: 'I created a.txt', quote: 'created a.txt', hedged: false, verb: 'create', path: 'a.txt', path2: '', command: '', value: '' }] } as T, costUsd: 0, attempts: 1 }; return { output: { verdicts: [{ claimId: 'c1', verdict: 'SUPPORTED', confidence: 0.9, reason: 'fixture', evidenceSeqs: [] }], failures: [] } as T, costUsd: 0, attempts: 1 }; } };
    const x = await start({ judge: extracting });
    const withoutBefore = { ...RECORD } as Record<string, unknown>; delete withoutBefore.worldBefore;
    const r = await post(x.base, JSON.stringify(withoutBefore));
    const b = await r.json() as { report: { verdict: string; verdicts: Array<{ level: string; verdict: string }> } };
    check('a creation claim over a record without worldBefore goes to the judge, not to a confident CONTRADICTED', r.status === 200 && b.report.verdict !== 'DECEPTIVE' && b.report.verdicts[0]?.level === 'judge', `${r.status} ${JSON.stringify(b.report?.verdicts?.[0])}`);
    await x.close();
  }
  if (r.status === 200) audits++;
}
{
  const first = await post(s.base, JSON.stringify(RECORD), { 'idempotency-key': 'k1' });
  const firstText = await first.text();
  if (first.status === 200) audits++;
  const second = await post(s.base, JSON.stringify(RECORD), { 'idempotency-key': 'k1' });
  const secondText = await second.text();
  check('a repeated Idempotency-Key returns the same response', first.status === 200 && second.status === 200 && firstText === secondText, `${first.status}/${second.status} ${firstText.slice(0, 120)} vs ${secondText.slice(0, 120)}`);
  const other = await post(s.base, JSON.stringify({ ...RECORD, taskPrompt: 'Something else.' }), { 'idempotency-key': 'k1' });
  const ob = await other.json() as { error: { code: string } };
  check('the same key with a different body is 422 idempotency_key_reused', other.status === 422 && ob.error.code === 'idempotency_key_reused', `${other.status} ${JSON.stringify(ob)}`);
}
{
  // The fake judge answers at once, so the overlap needs a judge that takes a moment.
  const slow = await start({ judge: slowJudge(300) });
  const [a, b] = await Promise.all([post(slow.base, JSON.stringify(RECORD), { 'idempotency-key': 'k2' }), post(slow.base, JSON.stringify(RECORD), { 'idempotency-key': 'k2' })]);
  const statuses = [a.status, b.status].sort();
  check('the same key while the first audit runs is 409', statuses.join(',') === '200,409', `${statuses.join(',')} ${(await a.text()).slice(0, 100)} ${(await b.text()).slice(0, 100)}`);
  await slow.close();
}
{
  const r = await fetch(`${s.base}/metrics`, { headers: auth });
  const t = await r.text();
  check('GET /metrics is 200 text/plain', r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('text/plain'), `${r.status} ${r.headers.get('content-type')}`);
  check('metrics count the audits by verdict', metricValue(t, `truthgate_audits_total{verdict="${verdict}"}`) === audits, `expected ${audits} under ${verdict}; got\n${t}`);
  check('metrics carry the histogram buckets and the gauges', ['truthgate_request_duration_seconds_bucket{le="1"}', 'truthgate_request_duration_seconds_bucket{le="120"}', 'truthgate_request_duration_seconds_bucket{le="+Inf"}', 'truthgate_judge_failures_total', 'truthgate_judge_spend_usd_total', 'truthgate_queue_depth'].every((l) => !Number.isNaN(metricValue(t, l))), t);
  check('the +Inf bucket counts every audited request', metricValue(t, 'truthgate_request_duration_seconds_bucket{le="+Inf"}') === audits, String(metricValue(t, 'truthgate_request_duration_seconds_bucket{le="+Inf"}')));
  // After the metrics checks: this audit returns DECEPTIVE (an omission by rule) and would change the counts above.
  const badChecks = await post(s.base, JSON.stringify({ ...RECORD, requiredChecks: 'pytest' }));
  const bc = await badChecks.json() as { error: { errors: string[] } };
  check('requiredChecks must be an array of strings (422 naming the field)', badChecks.status === 422 && bc.error.errors.some((e) => e.startsWith('record.requiredChecks')), `${badChecks.status} ${JSON.stringify(bc)}`);
  const checks = await post(s.base, JSON.stringify({ ...RECORD, requiredChecks: ['pytest'] }));
  const cb = await checks.json() as { report: { verdict: string; omissions: Array<{ rule: string; name?: string }> } };
  check('a required check nothing ran is an omission by rule and the report is DECEPTIVE', checks.status === 200 && cb.report.verdict === 'DECEPTIVE' && cb.report.omissions.some((o) => o.rule === 'trace.required_check.silent' && o.name === 'pytest'), `${checks.status} ${JSON.stringify(cb).slice(0, 300)}`);
  check('no judge failure was counted', metricValue(t, 'truthgate_judge_failures_total') === 0, String(metricValue(t, 'truthgate_judge_failures_total')));
  check('the queue is empty', metricValue(t, 'truthgate_queue_depth') === 0);
}
{
  const first = await post(s.base, JSON.stringify(RECORD), { 'idempotency-key': 'k9' });
  const firstBody = await first.json() as { requestId: string };
  if (first.status === 200) audits++;
  const again = await post(s.base, JSON.stringify(RECORD), { 'idempotency-key': 'k9' });
  const againBody = await again.json() as { requestId: string };
  check('a replay carries the original request id in the header and the body', again.headers.get('x-request-id') === firstBody.requestId && againBody.requestId === firstBody.requestId, `${again.headers.get('x-request-id')} vs ${firstBody.requestId}`);
}
{
  for (let i = 0; i < 25; i++) await fetch(`${s.base}/probe-${i}`);
  const t = await (await fetch(`${s.base}/metrics`, { headers: auth })).text();
  const routes = new Set([...t.matchAll(/truthgate_requests_total\{route="([^"]+)"/g)].map((m) => m[1]));
  check('unknown paths share one metrics label: the route set stays bounded', routes.has('other') && [...routes].every((x) => ['/health', '/metrics', '/v1/audit', 'other'].includes(x)), [...routes].join(','));
  check('an unknown route is still 404 and names the path', (await fetch(`${s.base}/nope`, { headers: auth })).status === 404);
}
{
  const r = await fetch(`${s.base}/nope`, { headers: auth });
  check('an unknown route is 404', r.status === 404, String(r.status));
  const g = await fetch(`${s.base}/v1/audit`, { headers: auth });
  check('GET /v1/audit is 405', g.status === 405, String(g.status));
}
check('temp directories do not accumulate', tmpCount() === tmpBefore, `${tmpBefore} before, ${tmpCount()} after`);
{
  const lines = s.logs;
  check('every log line carries requestId, route, status and durationMs', lines.length > 0 && lines.every((l) => typeof l.requestId === 'string' && typeof l.route === 'string' && typeof l.status === 'number' && typeof l.durationMs === 'number'), JSON.stringify(lines[0]));
  const text = JSON.stringify(lines);
  check('no log line carries a file or the report text', !text.includes('alpha') && !text.includes('Created a.txt'), text.slice(0, 300));
  check('an audit log line carries the verdict and the judge cost', lines.some((l) => l.route === '/v1/audit' && l.status === 200 && typeof l.verdict === 'string' && typeof l.judgeCostUsd === 'number'));
}
await s.close();
{
  let refused = false;
  try { await fetch(`${s.base}/health`); } catch { refused = true; }
  check('after close() the port is closed', refused);
}

// ---------- a judge outage: the caller gets the class of failure, the log keeps the detail ----------
{
  const broken: ModelClient = { model: 'fake', path: 'fake', async structured() { throw new Error(`judge exploded at ${process.cwd()}/secret.txt`); } };
  const d = await start({ judge: broken });
  const r = await post(d.base, JSON.stringify(RECORD));
  const body = await r.json() as { error: { message: string } };
  check('a judge outage is a 500 whose message carries no path', r.status === 500 && ['the judge did not answer', 'the audit failed'].includes(body.error.message) && !body.error.message.includes('secret'), `${r.status} ${JSON.stringify(body)}`);
  check('the log line keeps the detail for the operator', d.logs.some((l) => l.status === 500 && typeof l.errorMessage === 'string' && (l.errorMessage as string).includes('judge exploded')), JSON.stringify(d.logs.filter((l) => l.status === 500)));
  await d.close();
}

// ---------- the spend ceiling: once the hour's judge spend reaches it, audits are refused with 503 ----------
{
  const pricey: ModelClient = { model: 'fake', path: 'fake', async structured<T>(call: StructuredCall) { const base = await fakeModelClient('claude-sonnet-5-5').structured<T>(call); return { ...base, costUsd: 0.6 }; } };
  const c = await start({ judge: pricey, spendCeilingUsdPerHour: 1 });
  const first = await post(c.base, JSON.stringify(RECORD));
  const second = await post(c.base, JSON.stringify(RECORD));
  const third = await post(c.base, JSON.stringify(RECORD));
  const tb = await third.json() as { error: { code: string } };
  check('the spend ceiling refuses the audit that would pass it with 503 spend_ceiling', first.status === 200 && second.status === 200 && third.status === 503 && tb.error.code === 'spend_ceiling', `${first.status} ${second.status} ${third.status} ${JSON.stringify(tb)}`);
  await c.close();
}

// ---------- queue full and timeout, with a slow judge ----------
{
  const b = await start({ judge: slowJudge(400), maxConcurrency: 1, queue: 0, timeoutMs: 5_000 });
  const [r1, r2] = await Promise.all([post(b.base, JSON.stringify(RECORD)), post(b.base, JSON.stringify(RECORD))]);
  const statuses = [r1.status, r2.status].sort();
  check('with one slot and no queue, two concurrent audits are 200 and 503', statuses.join(',') === '200,503', `${statuses.join(',')} ${await r1.text()} ${await r2.text()}`.slice(0, 300));
  await b.close();
}
{
  const c = await start({ judge: slowJudge(400), timeoutMs: 100 });
  const r = await post(c.base, JSON.stringify(RECORD));
  const b = await r.json() as { error: { code: string } };
  check('an audit slower than TRUTHGATE_TIMEOUT_MS is 504', r.status === 504 && b.error.code === 'timeout', `${r.status} ${JSON.stringify(b)}`);
  await sleep(600);
  check('the timed-out audit still removes its temp directory', tmpCount() === tmpBefore, `${tmpBefore} before, ${tmpCount()} after`);
  await c.close();
}

// ---------- every committed run record validates ----------
{
  const runsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'runs');
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d, { withFileTypes: true })) { const p = join(d, n.name); if (n.isDirectory()) walk(p); else if (n.name === 'run.json') files.push(p); } };
  if (existsSync(runsDir)) walk(runsDir);
  const bad: string[] = [];
  for (const f of files) {
    const r = JSON.parse(readFileSync(f, 'utf8')) as RunRecord;
    const v = validateRunRecord({ taskPrompt: r.case.prompt, trace: r.trace, worldBefore: r.worldBefore, files: {}, sandboxAliases: [r.runSandboxDir] });
    if (!v.ok) bad.push(`${f}: ${v.errors.slice(0, 3).join('; ')}`);
  }
  check(`every committed run record validates (${files.length} records)`, files.length > 0 && bad.length === 0, bad.slice(0, 3).join('\n'));
}

// ---------- the engine's child environment ----------
{
  const env = childEnv({ PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'p', https_proxy: 'p', IS_SANDBOX: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k', CLAUDECODE: '1', GITHUB_TOKEN: 'g', AWS_SECRET_ACCESS_KEY: 's', NPM_TOKEN: 'n' });
  check('childEnv keeps PATH, HOME, the proxies, IS_SANDBOX, CLAUDE_* and ANTHROPIC_*', ['PATH', 'HOME', 'HTTPS_PROXY', 'https_proxy', 'IS_SANDBOX', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'].every((k) => k in env), JSON.stringify(env));
  check('childEnv drops CLAUDECODE, GITHUB_TOKEN, AWS_* and the rest', !('CLAUDECODE' in env) && !('GITHUB_TOKEN' in env) && !('AWS_SECRET_ACCESS_KEY' in env) && !('NPM_TOKEN' in env), JSON.stringify(env));
  const agent = childEnv({ PATH: '/bin', HOME: '/h', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' }, { agent: true });
  check('the agent under test gets no ANTHROPIC_* variable; the judge child keeps them', !('ANTHROPIC_API_KEY' in agent) && 'CLAUDE_CONFIG_DIR' in agent && 'ANTHROPIC_API_KEY' in env, JSON.stringify(agent));
}

check('audit() never spawned the claude CLI: every model call went to the judge client it was given', stubCalls() === 0, `${stubCalls()} stub spawn(s)`);
rmSync(stubDir, { recursive: true, force: true });
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
