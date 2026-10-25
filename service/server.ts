// TruthGate as a service: POST a run record, get a Report. node:http only; the audit is `audit()` in src.
//   POST /v1/audit  the ServiceRecord (src/adapters/validate.ts) → { requestId, report, notes }
//   GET  /health    liveness, versions and the judge configuration (no token needed)
//   GET  /metrics   Prometheus text (token needed)
// The caller's files are written into a fresh temporary directory (0o700, files 0o600), audited, and removed again,
// also when the audit fails. Logs are one JSON line per request on stdout and never carry the report or a file.
// Usage: TRUTHGATE_API_TOKEN=... TRUTHGATE_MODEL_PATH=api|openai|cli|fake npx tsx service/server.ts
// Configuration: every TRUTHGATE_* variable is listed in service/README.md.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateRunRecord } from '../src/adapters/validate.ts';
import type { ServiceRecord } from '../src/adapters/validate.ts';
import type { CalibrationTable } from '../src/calibration.ts';
import { modelClientFromEnv } from '../src/model-env.ts';
import type { ModelClient } from '../src/model.ts';
import { audit } from '../src/truthgate.ts';
import type { Report } from '../src/types.ts';
import { RULES_VERSION, SCHEMA_VERSION } from '../src/versions.ts';
import { snapshotWorld } from '../src/world.ts';

export interface ServiceConfig {
  host: string;
  port: number;
  /** Required in `Authorization: Bearer`; absent only when bound to a loopback address with allowAnonymous. */
  apiToken: string | undefined;
  allowAnonymous: boolean;
  judgeModel: string;
  votes: number;
  /** The TRUTHGATE_MODEL_PATH value, for /health. */
  modelPath: string;
  judge: ModelClient;
  maxConcurrency: number;
  queue: number;
  /** Per request, from arrival: queue wait plus audit. */
  timeoutMs: number;
  /** Judge spend allowed per rolling hour; past it /v1/audit answers 503 until the hour turns. */
  spendCeilingUsdPerHour: number;
  attestationPublicKeyPem?: string;
  /** A calibration table (bench/calibrate.ts output) to annotate judge verdicts with; applied only when it matches
   *  the judge model, votes, rules and prompts of this service. */
  calibration?: CalibrationTable;
  /** Where JSON log lines go; stdout by default. */
  log?: (line: Record<string, unknown>) => void;
}

export interface ServiceHandle {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  /** Stops accepting, waits for in-flight audits (at most timeoutMs), then closes every connection. */
  close(): Promise<void>;
}

export const BODY_LIMIT = 8 * 1024 * 1024;
export const IDEMPOTENCY_MAX = 1_000;
export const IDEMPOTENCY_TTL_MS = 3_600_000;
export const TMP_PREFIX = 'truthgate-';
const BUCKETS = [1, 5, 15, 30, 60, 120];
const MIN_TOKEN_CHARS = 32;
const VERDICTS: Report['verdict'][] = ['HONEST', 'DECEPTIVE', 'NEEDS_REVIEW', 'UNVERIFIED'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULTS = { host: '127.0.0.1', port: 8790, judgeModel: 'claude-sonnet-5-5', votes: 3, maxConcurrency: 4, queue: 16, timeoutMs: 300_000, spendCeilingUsdPerHour: 50 };
const KEY_MAX = 200;
const ERROR_LOG_CHARS = 200;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer of at least ${min}, not ${JSON.stringify(v)}`);
  return n;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const host = env.TRUTHGATE_HOST || DEFAULTS.host;
  const apiToken = env.TRUTHGATE_API_TOKEN || undefined;
  const allowAnonymous = env.TRUTHGATE_ALLOW_ANONYMOUS === '1';
  if (!apiToken && !(allowAnonymous && LOOPBACK.has(host))) {
    throw new Error(`TRUTHGATE_API_TOKEN is not set; set it, or bind to 127.0.0.1 with TRUTHGATE_ALLOW_ANONYMOUS=1 (TRUTHGATE_HOST is ${JSON.stringify(host)})`);
  }
  const judgeModel = env.TRUTHGATE_JUDGE_MODEL || DEFAULTS.judgeModel;
  const modelPath = env.TRUTHGATE_MODEL_PATH ?? '';
  const judge = modelClientFromEnv(judgeModel, env);
  if (modelPath === 'cli' && env.TRUTHGATE_LIVE !== '1') throw new Error('TRUTHGATE_MODEL_PATH=cli calls the claude CLI and spends quota; set TRUTHGATE_LIVE=1 to allow it');
  // The fake judge extracts nothing and answers UNVERIFIED for every record: a self-check tool, never a service on a
  // public address unless the operator says so.
  if (modelPath === 'fake' && !LOOPBACK.has(host) && env.TRUTHGATE_ALLOW_FAKE !== '1') throw new Error('TRUTHGATE_MODEL_PATH=fake answers UNVERIFIED for everything; on a public address it needs TRUTHGATE_ALLOW_FAKE=1');
  if (apiToken && !LOOPBACK.has(host) && apiToken.length < MIN_TOKEN_CHARS) throw new Error(`TRUTHGATE_API_TOKEN must be at least ${MIN_TOKEN_CHARS} characters on a public address`);
  let calibration: CalibrationTable | undefined;
  if (env.TRUTHGATE_CALIBRATION_FILE) {
    const parsed = JSON.parse(readFileSync(env.TRUTHGATE_CALIBRATION_FILE, 'utf8')) as CalibrationTable;
    if (parsed?.schema !== 'truthgate.calibration.v1') throw new Error('TRUTHGATE_CALIBRATION_FILE is not a truthgate.calibration.v1 table');
    calibration = parsed;
  }
  return {
    host, port: intEnv(env, 'TRUTHGATE_PORT', DEFAULTS.port, 0), apiToken, allowAnonymous, judgeModel, votes: intEnv(env, 'TRUTHGATE_VOTES', DEFAULTS.votes, 1), modelPath, judge,
    maxConcurrency: intEnv(env, 'TRUTHGATE_MAX_CONCURRENCY', DEFAULTS.maxConcurrency, 1), queue: intEnv(env, 'TRUTHGATE_QUEUE', DEFAULTS.queue, 0),
    timeoutMs: intEnv(env, 'TRUTHGATE_TIMEOUT_MS', DEFAULTS.timeoutMs, 1), attestationPublicKeyPem: env.TRUTHGATE_ATTESTATION_PUBLIC_KEY_PEM || undefined, calibration,
    spendCeilingUsdPerHour: intEnv(env, 'TRUTHGATE_SPEND_CEILING_USD_PER_HOUR', DEFAULTS.spendCeilingUsdPerHour, 0),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

type Body = { text: string } | { tooLarge: true };

function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > BODY_LIMIT;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; }
      if (size > 4 * BODY_LIMIT) req.destroy(); // a body that keeps coming after the refusal is not drained forever
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', reject);
  });
}

function materialise(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), TMP_PREFIX)); // 0o700
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
      writeFileSync(full, content, { mode: 0o600, flag: 'wx' });
    }
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return dir;
}

const ROUTES = new Set(['/health', '/metrics', '/v1/audit']);

interface IdemEntry { bodyHash: string; expiresAt: number; pending: boolean; status?: number; body?: unknown; requestId?: string }

export function createServer(config: ServiceConfig): ServiceHandle {
  const log = config.log ?? ((line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); });
  // The duration histogram is kept as bucket counters, never as a list that grows with the requests.
  const metrics = { audits: Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<string, number>, judgeFailures: 0, spendUsd: 0, durationBuckets: BUCKETS.map(() => 0), durationCount: 0, durationSum: 0, judgeRounds: { asked: 0, answered: 0 }, requests: new Map<string, number>() };
  // Judge spend per rolling hour: the audits of the last hour, pruned as they age out.
  const spend: Array<{ at: number; usd: number }> = [];
  const spentThisHour = () => { const cutoff = Date.now() - 3_600_000; while (spend.length && spend[0]!.at < cutoff) spend.shift(); return spend.reduce((s, x) => s + x.usd, 0); };
  const observeDuration = (seconds: number) => { BUCKETS.forEach((b, i) => { if (seconds <= b) metrics.durationBuckets[i]!++; }); metrics.durationCount++; metrics.durationSum += seconds; };
  const idem = new Map<string, IdemEntry>();
  let active = 0;
  let inFlight = 0;
  let shuttingDown = false;
  let onDrained: (() => void) | null = null;
  const waiting: Array<{ grant: () => void; drop: () => void }> = [];

  const acquire = (deadline: number): Promise<void> => {
    if (active < config.maxConcurrency) { active++; return Promise.resolve(); }
    if (waiting.length >= config.queue) return Promise.reject(new HttpError(503, 'queue_full', `${active} audits running and ${waiting.length} waiting; try again later`));
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => { clearTimeout(timer); active++; resolve(); },
        drop: () => { clearTimeout(timer); reject(new HttpError(504, 'timeout', `the request waited ${config.timeoutMs} ms in the queue`)); },
      };
      const timer = setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); entry.drop(); }, Math.max(0, deadline - Date.now()));
      waiting.push(entry);
    });
  };
  const release = () => {
    active--;
    inFlight--;
    waiting.shift()?.grant();
    if (inFlight === 0 && onDrained) onDrained();
  };

  const runAudit = async (record: ServiceRecord, deadline: number): Promise<{ report: Report; notes: string[] }> => {
    const dir = materialise(record.files);
    try {
      const worldAfter = snapshotWorld(dir);
      const notes: string[] = [];
      let worldBefore = record.worldBefore;
      if (!worldBefore) {
        worldBefore = worldAfter;
        notes.push('no worldBefore in the record: files created during the run cannot be told from files that were already there, so creation claims cannot be settled');
      }
      const report = await audit({
        taskPrompt: record.taskPrompt, trace: record.trace, sandboxDir: dir, sandboxAliases: record.sandboxAliases, worldBefore, worldAfter,
        // Without a before-snapshot the rules must not contradict a creation claim against an empty "before".
        worldBeforeKnown: !!record.worldBefore, requiredChecks: record.requiredChecks,
        judgeModel: config.judgeModel, judge: config.judge, votes: config.votes, deadline, calibration: config.calibration,
        attestations: record.attestations, attestationPublicKeyPem: config.attestationPublicKeyPem, executionId: record.executionId,
      });
      return { report, notes };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const authorised = (req: IncomingMessage): boolean => {
    if (!config.apiToken) return true; // anonymous is allowed only on a loopback address (configFromEnv)
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return false;
    const given = Buffer.from(h.slice('Bearer '.length));
    const want = Buffer.from(config.apiToken);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const sweepIdempotency = () => {
    const now = Date.now();
    for (const [k, v] of idem) if (v.expiresAt <= now) idem.delete(k);
    while (idem.size > IDEMPOTENCY_MAX) { const oldest = idem.keys().next().value; if (oldest === undefined) break; idem.delete(oldest); }
  };

  const auditRoute = async (req: IncomingMessage, requestId: string, arrivedAt: number): Promise<{ status: number; body: unknown; replayed?: boolean; report?: Report; audited?: boolean; requestId?: string }> => {
    const key = req.headers['idempotency-key'];
    if (Array.isArray(key) || (key !== undefined && (key === '' || key.length > KEY_MAX))) throw new HttpError(422, 'invalid_idempotency_key', `Idempotency-Key must be one header of 1 to ${KEY_MAX} characters`);
    const body = await readBody(req);
    if ('tooLarge' in body) throw new HttpError(413, 'payload_too_large', `the body must be at most ${BODY_LIMIT} bytes`);
    const bodyHash = createHash('sha256').update(body.text).digest('hex');
    if (key) {
      sweepIdempotency();
      const hit = idem.get(key);
      if (hit) {
        if (hit.bodyHash !== bodyHash) throw new HttpError(422, 'idempotency_key_reused', 'this Idempotency-Key was used with a different body');
        if (hit.pending) throw new HttpError(409, 'in_flight', 'a request with this Idempotency-Key is still being audited');
        return { status: hit.status!, body: hit.body, replayed: true, requestId: hit.requestId };
      }
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body.text); } catch (e) { throw new HttpError(400, 'invalid_json', `the body is not JSON: ${(e as Error).message}`); }
    const v = validateRunRecord(parsed);
    if (!v.ok) {
      const out = { status: 422, body: { error: { code: 'invalid_record', message: `${v.errors.length} error(s) in the record`, errors: v.errors } } };
      if (key) idem.set(key, { bodyHash, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS, pending: false, ...out });
      return out;
    }
    if (shuttingDown) throw new HttpError(503, 'shutting_down', 'the service is shutting down');
    if (config.spendCeilingUsdPerHour > 0 && spentThisHour() >= config.spendCeilingUsdPerHour) throw new HttpError(503, 'spend_ceiling', `the judge spend ceiling of $${config.spendCeilingUsdPerHour} per hour is reached; try again later`);
    if (key) idem.set(key, { bodyHash, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS, pending: true });
    const deadline = arrivedAt + config.timeoutMs;
    try {
      await acquire(deadline);
    } catch (e) {
      if (key) idem.delete(key);
      throw e;
    }
    inFlight++;
    const work = runAudit(v.record, deadline).finally(release);
    work.catch(() => { /* reported below while awaited; a timed-out audit's late failure has no reader */ });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(504, 'timeout', `the audit did not finish within ${config.timeoutMs} ms; it keeps running but its result is dropped`)), Math.max(0, deadline - Date.now())); });
    try {
      const { report, notes } = await Promise.race([work, timeout]);
      const out = { status: 200, body: { requestId, report, notes }, report, audited: true };
      if (key) idem.set(key, { bodyHash, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS, pending: false, status: out.status, body: out.body, requestId });
      return out;
    } catch (e) {
      if (key) idem.delete(key);
      if (e instanceof HttpError) throw Object.assign(e, { audited: true });
      metrics.judgeFailures++;
      // The caller gets the class of failure; the message, which may carry a server path or a file name, stays in the log.
      const msg = (e as Error).message;
      const kind = /ENAMETOOLONG|ENOENT|EACCES|EISDIR|ENOTDIR|EEXIST|EMFILE|ENOSPC/.test(msg) ? 'the record could not be materialised' : /judge did not answer|judge round|extractor/.test(msg) ? 'the judge did not answer' : 'the audit failed';
      throw Object.assign(new HttpError(500, 'audit_failed', kind), { audited: true, detail: msg });
    } finally {
      clearTimeout(timer);
    }
  };

  const health = () => ({ status: shuttingDown ? 'draining' : 'ok', versions: { schema: SCHEMA_VERSION, rules: RULES_VERSION }, judgeModel: config.judgeModel, modelPath: config.modelPath, votes: config.votes, active, queued: waiting.length });

  const metricsText = (): string => {
    const lines: string[] = [];
    lines.push('# HELP truthgate_audits_total Audits that returned a report, by verdict.', '# TYPE truthgate_audits_total counter');
    for (const v of VERDICTS) lines.push(`truthgate_audits_total{verdict="${v}"} ${metrics.audits[v]}`);
    lines.push('# HELP truthgate_judge_failures_total Audits that failed before a report (the judge did not answer, or the audit threw).', '# TYPE truthgate_judge_failures_total counter', `truthgate_judge_failures_total ${metrics.judgeFailures}`);
    lines.push('# HELP truthgate_judge_spend_usd_total Judge spend of the audits that returned a report, in USD.', '# TYPE truthgate_judge_spend_usd_total counter', `truthgate_judge_spend_usd_total ${metrics.spendUsd}`);
    lines.push('# HELP truthgate_request_duration_seconds Duration of /v1/audit requests that reached the audit stage.', '# TYPE truthgate_request_duration_seconds histogram');
    BUCKETS.forEach((b, i) => lines.push(`truthgate_request_duration_seconds_bucket{le="${b}"} ${metrics.durationBuckets[i]}`));
    lines.push(`truthgate_request_duration_seconds_bucket{le="+Inf"} ${metrics.durationCount}`, `truthgate_request_duration_seconds_sum ${metrics.durationSum}`, `truthgate_request_duration_seconds_count ${metrics.durationCount}`);
    lines.push('# HELP truthgate_judge_rounds_total Judge rounds asked and answered; a gap means audits degraded to fewer votes.', '# TYPE truthgate_judge_rounds_total counter', `truthgate_judge_rounds_total{outcome="asked"} ${metrics.judgeRounds.asked}`, `truthgate_judge_rounds_total{outcome="answered"} ${metrics.judgeRounds.answered}`);
    lines.push('# HELP truthgate_queue_depth Requests waiting for an audit slot.', '# TYPE truthgate_queue_depth gauge', `truthgate_queue_depth ${waiting.length}`);
    lines.push('# HELP truthgate_requests_total Requests by route and status.', '# TYPE truthgate_requests_total counter');
    for (const [k, n] of metrics.requests) { const [route, status] = k.split(' '); lines.push(`truthgate_requests_total{route="${route}",status="${status}"} ${n}`); }
    return `${lines.join('\n')}\n`;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const arrivedAt = Date.now();
    const requestId = randomUUID();
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Metrics and logs name only the known routes: an unauthenticated caller must not grow the label set.
    const route = ROUTES.has(path) ? path : 'other';
    res.setHeader('x-request-id', requestId);
    const finish = (status: number, body: string | object, extra: Record<string, unknown> = {}, contentType = 'application/json') => {
      const durationMs = Date.now() - arrivedAt;
      metrics.requests.set(`${route} ${status}`, (metrics.requests.get(`${route} ${status}`) ?? 0) + 1);
      if (!res.headersSent) {
        res.statusCode = status;
        res.setHeader('content-type', contentType);
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      }
      log({ ts: new Date(arrivedAt).toISOString(), requestId, route, method, status, durationMs, ...extra });
    };
    const error = (e: HttpError) => finish(e.status, { error: { code: e.code, message: e.message, ...e.extra } }, { error: e.code, ...(e.status >= 500 ? { errorMessage: ((e as HttpError & { detail?: string }).detail ?? e.message).slice(0, ERROR_LOG_CHARS) } : {}) });
    try {
      if (route === '/health') {
        if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', `${route} takes GET`);
        return finish(shuttingDown ? 503 : 200, health());
      }
      if (!authorised(req)) { req.resume(); throw new HttpError(401, 'unauthorized', 'send Authorization: Bearer <TRUTHGATE_API_TOKEN>'); }
      if (route === '/metrics') {
        if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', `${route} takes GET`);
        return finish(200, metricsText(), {}, 'text/plain; version=0.0.4; charset=utf-8');
      }
      if (route === '/v1/audit') {
        if (method !== 'POST') { req.resume(); throw new HttpError(405, 'method_not_allowed', `${route} takes POST`); }
        try {
          const out = await auditRoute(req, requestId, arrivedAt);
          if (out.replayed && out.requestId) res.setHeader('x-request-id', out.requestId);
          if (out.audited) observeDuration((Date.now() - arrivedAt) / 1000);
          if (out.report && !out.replayed) { metrics.audits[out.report.verdict] = (metrics.audits[out.report.verdict] ?? 0) + 1; metrics.spendUsd += out.report.judgeCostUsd; spend.push({ at: Date.now(), usd: out.report.judgeCostUsd }); if (out.report.usage) { metrics.judgeRounds.asked += out.report.usage.judgeRounds.asked; metrics.judgeRounds.answered += out.report.usage.judgeRounds.answered; } }
          return finish(out.status, out.body as object, { ...(out.report ? { verdict: out.report.verdict, judgeCostUsd: out.report.judgeCostUsd, claims: out.report.claims.length, ...(out.report.usage ? { judgeRounds: out.report.usage.judgeRounds, inputTokens: out.report.usage.inputTokens, outputTokens: out.report.usage.outputTokens } : {}) } : {}), ...(out.replayed ? { replayed: true } : {}) });
        } catch (e) {
          if (e instanceof HttpError && (e as HttpError & { audited?: boolean }).audited) observeDuration((Date.now() - arrivedAt) / 1000);
          throw e;
        }
      }
      req.resume();
      throw new HttpError(404, 'not_found', `no route ${method} ${path}`);
    } catch (e) {
      if (e instanceof HttpError) return error(e);
      return error(new HttpError(500, 'internal', (e as Error).message));
    }
  };

  const server = createHttpServer((req, res) => { void handle(req, res); });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        const a = server.address();
        resolve(typeof a === 'object' && a ? { host: a.address, port: a.port } : { host: config.host, port: config.port });
      });
    }),
    close: async () => {
      shuttingDown = true;
      server.close();
      server.closeIdleConnections();
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, config.timeoutMs);
          onDrained = () => { clearTimeout(timer); resolve(); };
        });
      }
      server.closeAllConnections();
    },
  };
}

export async function main(): Promise<void> {
  const config = configFromEnv();
  const log = (line: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(line)}\n`); };
  const handle = createServer({ ...config, log });
  const { host, port } = await handle.listen();
  log({ ts: new Date().toISOString(), event: 'listening', host, port, judgeModel: config.judgeModel, modelPath: config.modelPath, votes: config.votes, maxConcurrency: config.maxConcurrency, queue: config.queue, timeoutMs: config.timeoutMs, anonymous: !config.apiToken });
  const stop = (signal: string) => {
    log({ ts: new Date().toISOString(), event: 'shutdown', signal });
    handle.close().then(() => process.exit(0), (e: Error) => { log({ ts: new Date().toISOString(), event: 'shutdown_failed', errorMessage: e.message.slice(0, ERROR_LOG_CHARS) }); process.exit(1); });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

const isMain = process.argv[1] && /server\.ts$/.test(process.argv[1]);
if (isMain) await main();
