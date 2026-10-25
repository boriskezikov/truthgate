// The service's trust boundary: a run record arrives as JSON from a caller and nothing in it is believed until it
// has been checked against the shapes in types.ts. Every defect is reported with its path and the rule it broke;
// the first error does not stop the walk. Limits are bytes, not characters.
import { CLAUDE_CODE_TOOL_ROLES } from '../types.ts';
import type { Attestation, ToolRoles, Trace, TraceEvent, WorldSnapshot } from '../types.ts';

/** What the service audits: the record of `src/cli.ts` with the files of the working directory in place of a path
 *  on the caller's disk, which the service never reads. */
export interface ServiceRecord {
  taskPrompt: string;
  trace: Trace;
  /** The file hashes before the run; without them creation claims cannot be settled (the service says so). */
  worldBefore?: WorldSnapshot;
  /** The agent's working directory after the run: relative path → text content. */
  files: Record<string, string>;
  /** Absolute paths that meant the working directory while the agent ran, so that paths in the trace resolve. */
  sandboxAliases?: string[];
  attestations?: Attestation[];
  executionId?: string;
  /** Checks the owner requires the agent to have run (a program such as `pytest`, or a script path); see rules.ts. */
  requiredChecks?: string[];
}

export type ValidationResult = { ok: true; record: ServiceRecord } | { ok: false; errors: string[] };

const KB = 1024;
const MB = 1024 * KB;
export const LIMITS = {
  files: 200,
  filesBytes: 4 * MB,
  path: 1024,
  taskPrompt: 64 * KB,
  finalText: 100 * KB,
  textEvent: 200 * KB,
  toolInput: 1 * MB,
  toolResult: 2 * MB,
  events: 5_000,
  shortString: 200,
  harnessResultText: 200 * KB,
  toolsAvailable: 200,
  permissionDenials: 1_000,
  permissionDenial: 4 * KB,
  aliases: 20,
  alias: 4096,
  requiredChecks: 20,
  requiredCheck: 200,
  attestations: 100,
  attestationParams: 50,
  attestationValue: 4 * KB,
  worldFiles: 10_000,
  errors: 50,
} as const;

const RECORD_KEYS = new Set(['taskPrompt', 'trace', 'worldBefore', 'files', 'sandboxAliases', 'attestations', 'executionId', 'requiredChecks']);
const TRACE_KEYS = new Set(['events', 'toolRoles', 'finalText', 'model', 'cliVersion', 'toolsAvailable', 'numTurns', 'costUsd', 'harnessSubtype', 'harnessIsError', 'harnessResultText', 'permissionDenials']);
const EVENT_KEYS: Record<TraceEvent['kind'], Set<string>> = {
  text: new Set(['seq', 'kind', 'text']),
  tool_use: new Set(['seq', 'kind', 'id', 'name', 'input']),
  tool_result: new Set(['seq', 'kind', 'id', 'name', 'content', 'isError', 'exitCode', 'looksLikeFailure']),
};
const ROLE_KEYS = ['shell', 'read', 'write', 'edit'] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ATTESTATION_KEYS = new Set(['schema', 'issuer', 'executionId', 'operation', 'params', 'state', 'issuedAt', 'signature']);
const SHA256 = /^[0-9a-f]{64}$/;

class Errors {
  readonly list: string[] = [];
  add(path: string, message: string): false {
    if (this.list.length < LIMITS.errors) this.list.push(`${path}: ${message}`);
    else if (this.list.length === LIMITS.errors) this.list.push(`... more errors not shown (first ${LIMITS.errors} listed)`);
    return false;
  }
}

function isRecord(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function bytes(s: string): number { return Buffer.byteLength(s, 'utf8'); }

function checkKeys(e: Errors, obj: Record<string, unknown>, path: string, allowed: Set<string>): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) e.add(`${path}.${k}`, 'unknown field');
}

function checkString(e: Errors, v: unknown, path: string, max: number, opts: { nonEmpty?: boolean } = {}): v is string {
  if (typeof v !== 'string') return e.add(path, `must be a string, not ${describe(v)}`);
  if (v.includes('\0')) return e.add(path, 'must not contain NUL');
  if (opts.nonEmpty && v.trim() === '') return e.add(path, 'must not be empty');
  if (bytes(v) > max) return e.add(path, `must be at most ${max} bytes (it is ${bytes(v)})`);
  return true;
}

function checkStringList(e: Errors, v: unknown, path: string, maxItems: number, maxItem: number): v is string[] {
  if (!Array.isArray(v)) return e.add(path, `must be an array of strings, not ${describe(v)}`);
  if (v.length > maxItems) return e.add(path, `must have at most ${maxItems} entries (it has ${v.length})`);
  let ok = true;
  v.forEach((s, i) => { if (!checkString(e, s, `${path}[${i}]`, maxItem)) ok = false; });
  return ok;
}

function checkInteger(e: Errors, v: unknown, path: string, min: number): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return e.add(path, `must be an integer, not ${describe(v)}`);
  if (v < min) return e.add(path, `must be at least ${min} (it is ${v})`);
  return true;
}

function checkBoolean(e: Errors, v: unknown, path: string): v is boolean {
  return typeof v === 'boolean' ? true : e.add(path, `must be true or false, not ${describe(v)}`);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') return `a string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v)}`;
  return typeof v === 'object' ? 'an object' : `${typeof v} ${String(v)}`;
}

/** The rule for a path inside the working directory: relative, no `..`, no `.`, no empty segment, no NUL. */
export function pathError(p: string): string | null {
  if (p === '') return 'must not be empty';
  if (p.includes('\0')) return 'must not contain NUL';
  if (p.startsWith('/')) return 'must be relative (no leading /)';
  if (bytes(p) > LIMITS.path) return `must be at most ${LIMITS.path} bytes`;
  for (const seg of p.split('/')) {
    if (seg === '') return 'must not contain an empty segment (// or a trailing /)';
    if (seg === '..') return 'must not contain ..';
    if (seg === '.') return 'must not contain a . segment';
  }
  return null;
}

function checkFiles(e: Errors, v: unknown, path: string): Record<string, string> | null {
  if (!isRecord(v)) { e.add(path, `must be an object of path → text content, not ${describe(v)}`); return null; }
  const entries = Object.entries(v);
  if (entries.length > LIMITS.files) { e.add(path, `must have at most ${LIMITS.files} files (it has ${entries.length})`); return null; }
  let total = 0;
  let ok = true;
  const dirs = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const [p, content] of entries) {
    const at = `${path}[${JSON.stringify(p)}]`;
    const bad = pathError(p);
    if (bad) { e.add(at, bad); ok = false; continue; }
    if (typeof content !== 'string') { e.add(at, `content must be a string (text), not ${describe(content)}`); ok = false; continue; }
    if (content.includes('\0')) { e.add(at, 'content must not contain NUL (binary files are not accepted)'); ok = false; continue; }
    total += bytes(content);
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    out.push([p, content]);
  }
  if (total > LIMITS.filesBytes) { e.add(path, `must total at most ${LIMITS.filesBytes} bytes (they total ${total})`); ok = false; }
  for (const [p] of out) if (dirs.has(p)) { e.add(`${path}[${JSON.stringify(p)}]`, 'is a file and also a directory of another file'); ok = false; }
  return ok ? Object.fromEntries(out) : null;
}

function checkWorld(e: Errors, v: unknown, path: string): WorldSnapshot | null {
  if (!isRecord(v)) { e.add(path, `must be an object { files }, not ${describe(v)}`); return null; }
  checkKeys(e, v, path, new Set(['files']));
  if (!isRecord(v.files)) { e.add(`${path}.files`, `must be an object of path → { sha256, bytes }, not ${describe(v.files)}`); return null; }
  const entries = Object.entries(v.files);
  if (entries.length > LIMITS.worldFiles) { e.add(`${path}.files`, `must have at most ${LIMITS.worldFiles} entries (it has ${entries.length})`); return null; }
  let ok = true;
  const out: Array<[string, { sha256: string; bytes: number }]> = [];
  for (const [p, f] of entries) {
    const at = `${path}.files[${JSON.stringify(p)}]`;
    const bad = pathError(p);
    if (bad) { e.add(at, bad); ok = false; continue; }
    if (!isRecord(f)) { e.add(at, `must be { sha256, bytes }, not ${describe(f)}`); ok = false; continue; }
    checkKeys(e, f, at, new Set(['sha256', 'bytes']));
    if (typeof f.sha256 !== 'string' || !SHA256.test(f.sha256)) { e.add(`${at}.sha256`, 'must be 64 lower-case hex characters'); ok = false; }
    if (!checkInteger(e, f.bytes, `${at}.bytes`, 0)) ok = false;
    if (ok) out.push([p, { sha256: f.sha256 as string, bytes: f.bytes as number }]);
  }
  return ok ? { files: Object.fromEntries(out) } : null;
}

function checkEvents(e: Errors, v: unknown, path: string): TraceEvent[] | null {
  if (!Array.isArray(v)) { e.add(path, `must be an array of events, not ${describe(v)}`); return null; }
  if (v.length > LIMITS.events) { e.add(path, `must have at most ${LIMITS.events} events (it has ${v.length})`); return null; }
  let ok = true;
  let prevSeq = -1;
  const uses = new Map<string, string>(); // tool_use id → name
  const answered = new Set<string>();
  const out: TraceEvent[] = [];
  v.forEach((ev, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(ev)) { e.add(at, `must be an object, not ${describe(ev)}`); ok = false; return; }
    const kind = ev.kind;
    if (kind !== 'text' && kind !== 'tool_use' && kind !== 'tool_result') { e.add(`${at}.kind`, `must be text, tool_use or tool_result, not ${describe(kind)}`); ok = false; return; }
    checkKeys(e, ev, at, EVENT_KEYS[kind]);
    if (!checkInteger(e, ev.seq, `${at}.seq`, 0)) { ok = false; return; }
    if (ev.seq <= prevSeq) { e.add(`${at}.seq`, `must be greater than the previous seq (${prevSeq}); it is ${ev.seq}`); ok = false; }
    prevSeq = ev.seq;
    if (kind === 'text') {
      if (!checkString(e, ev.text, `${at}.text`, LIMITS.textEvent)) { ok = false; return; }
      out.push({ seq: ev.seq, kind, text: ev.text });
    } else if (kind === 'tool_use') {
      let good = checkString(e, ev.id, `${at}.id`, LIMITS.shortString, { nonEmpty: true });
      if (good && uses.has(ev.id as string)) good = e.add(`${at}.id`, `duplicates the tool_use id ${JSON.stringify(ev.id)}`);
      if (!checkString(e, ev.name, `${at}.name`, LIMITS.shortString, { nonEmpty: true })) good = false;
      if (!isRecord(ev.input)) good = e.add(`${at}.input`, `must be an object, not ${describe(ev.input)}`);
      else if (bytes(JSON.stringify(ev.input)) > LIMITS.toolInput) good = e.add(`${at}.input`, `must be at most ${LIMITS.toolInput} bytes as JSON`);
      if (!good) { ok = false; return; }
      uses.set(ev.id as string, ev.name as string);
      out.push({ seq: ev.seq, kind, id: ev.id as string, name: ev.name as string, input: ev.input as Record<string, unknown> });
    } else {
      let good = checkString(e, ev.id, `${at}.id`, LIMITS.shortString, { nonEmpty: true });
      if (good && !uses.has(ev.id as string)) good = e.add(`${at}.id`, `references no earlier tool_use (${JSON.stringify(ev.id)})`);
      else if (good && answered.has(ev.id as string)) good = e.add(`${at}.id`, `is a second result for the tool_use ${JSON.stringify(ev.id)}`);
      if (!checkString(e, ev.name, `${at}.name`, LIMITS.shortString, { nonEmpty: true })) good = false;
      else if (good && ev.name !== uses.get(ev.id as string)) good = e.add(`${at}.name`, `must equal the tool_use's name ${JSON.stringify(uses.get(ev.id as string))}; it is ${JSON.stringify(ev.name)}`);
      if (!checkString(e, ev.content, `${at}.content`, LIMITS.toolResult)) good = false;
      if (!checkBoolean(e, ev.isError, `${at}.isError`)) good = false;
      if (ev.exitCode !== null && !checkInteger(e, ev.exitCode, `${at}.exitCode`, 0)) good = false;
      if (!checkBoolean(e, ev.looksLikeFailure, `${at}.looksLikeFailure`)) good = false;
      if (good) {
        const expected = (ev.isError as boolean) || (ev.exitCode !== null && ev.exitCode !== 0);
        if (ev.looksLikeFailure !== expected) good = e.add(`${at}.looksLikeFailure`, `must be ${expected} for isError ${String(ev.isError)} and exitCode ${String(ev.exitCode)} (types.ts: it is derived from them, never from the words)`);
      }
      if (!good) { ok = false; return; }
      answered.add(ev.id as string);
      out.push({ seq: ev.seq, kind, id: ev.id as string, name: ev.name as string, content: ev.content as string, isError: ev.isError as boolean, exitCode: ev.exitCode as number | null, looksLikeFailure: ev.looksLikeFailure as boolean });
    }
  });
  return ok ? out : null;
}

function checkToolRoles(e: Errors, v: unknown, path: string): ToolRoles | null {
  if (!isRecord(v)) { e.add(path, `must be an object { shell, read, write, edit }, not ${describe(v)}`); return null; }
  checkKeys(e, v, path, new Set(ROLE_KEYS));
  let ok = true;
  for (const k of ROLE_KEYS) if (!checkStringList(e, v[k], `${path}.${k}`, LIMITS.toolsAvailable, LIMITS.shortString)) ok = false;
  return ok ? { shell: v.shell as string[], read: v.read as string[], write: v.write as string[], edit: v.edit as string[] } : null;
}

function checkTrace(e: Errors, v: unknown, path: string): Trace | null {
  if (!isRecord(v)) { e.add(path, `must be an object, not ${describe(v)}`); return null; }
  checkKeys(e, v, path, TRACE_KEYS);
  const events = checkEvents(e, v.events, `${path}.events`);
  const toolRoles = v.toolRoles === undefined ? undefined : checkToolRoles(e, v.toolRoles, `${path}.toolRoles`);
  let ok = events !== null && (v.toolRoles === undefined || toolRoles !== null);
  if (!checkString(e, v.finalText, `${path}.finalText`, LIMITS.finalText)) ok = false;
  for (const k of ['model', 'cliVersion', 'harnessSubtype'] as const) if (!checkString(e, v[k], `${path}.${k}`, LIMITS.shortString)) ok = false;
  if (!checkStringList(e, v.toolsAvailable, `${path}.toolsAvailable`, LIMITS.toolsAvailable, LIMITS.shortString)) ok = false;
  if (!checkInteger(e, v.numTurns, `${path}.numTurns`, 0)) ok = false;
  if (typeof v.costUsd !== 'number' || !Number.isFinite(v.costUsd) || v.costUsd < 0) { e.add(`${path}.costUsd`, `must be a non-negative number, not ${describe(v.costUsd)}`); ok = false; }
  if (!checkBoolean(e, v.harnessIsError, `${path}.harnessIsError`)) ok = false;
  if (!checkString(e, v.harnessResultText, `${path}.harnessResultText`, LIMITS.harnessResultText)) ok = false;
  if (!checkStringList(e, v.permissionDenials, `${path}.permissionDenials`, LIMITS.permissionDenials, LIMITS.permissionDenial)) ok = false;
  // Strings the judge prompt shows as harness facts: no newline or control character may rewrite the prompt's shape.
  if (ok) {
    if (CONTROL.test(v.harnessSubtype as string)) { e.add(`${path}.harnessSubtype`, 'must not contain control characters'); ok = false; }
    (v.toolsAvailable as string[]).forEach((t, i) => { if (CONTROL.test(t)) { e.add(`${path}.toolsAvailable[${i}]`, 'must not contain control characters'); ok = false; } });
  }
  // A tool the record says runs commands must carry its line under `command`; a read, write or edit tool its path
  // under `file_path`, `path` or `notebook_path`: the rules read nothing else, so a record that names the role but
  // not the key is refused rather than audited into a false verdict.
  if (ok) {
    const roles = toolRoles ?? CLAUDE_CODE_TOOL_ROLES;
    for (const ev of events!) {
      if (ev.kind !== 'tool_use') continue;
      if (roles.shell.includes(ev.name) && typeof ev.input.command !== 'string') { e.add(`${path}.events[seq ${ev.seq}].input.command`, `the shell tool ${JSON.stringify(ev.name)} must carry its command line under "command"`); ok = false; }
      if ([...roles.read, ...roles.write, ...roles.edit].includes(ev.name) && !['file_path', 'path', 'notebook_path'].some((k) => typeof ev.input[k] === 'string')) { e.add(`${path}.events[seq ${ev.seq}].input`, `the file tool ${JSON.stringify(ev.name)} must carry its path under "file_path", "path" or "notebook_path"`); ok = false; }
    }
  }
  if (!ok) return null;
  return {
    events: events!, ...(toolRoles ? { toolRoles } : {}), finalText: v.finalText as string, model: v.model as string, cliVersion: v.cliVersion as string,
    toolsAvailable: v.toolsAvailable as string[], numTurns: v.numTurns as number, costUsd: v.costUsd as number, harnessSubtype: v.harnessSubtype as string,
    harnessIsError: v.harnessIsError as boolean, harnessResultText: v.harnessResultText as string, permissionDenials: v.permissionDenials as string[],
  };
}

function checkAttestations(e: Errors, v: unknown, path: string): Attestation[] | null {
  if (!Array.isArray(v)) { e.add(path, `must be an array, not ${describe(v)}`); return null; }
  if (v.length > LIMITS.attestations) { e.add(path, `must have at most ${LIMITS.attestations} entries (it has ${v.length})`); return null; }
  let ok = true;
  const out: Attestation[] = [];
  v.forEach((a, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(a)) { e.add(at, `must be an object, not ${describe(a)}`); ok = false; return; }
    checkKeys(e, a, at, ATTESTATION_KEYS);
    let good = true;
    if (a.schema !== 'truthgate.attestation.v1') good = e.add(`${at}.schema`, `must be "truthgate.attestation.v1", not ${describe(a.schema)}`);
    for (const k of ['issuer', 'executionId', 'operation', 'signature'] as const) if (!checkString(e, a[k], `${at}.${k}`, LIMITS.attestationValue, { nonEmpty: true })) good = false;
    if (a.state !== 'completed' && a.state !== 'failed') good = e.add(`${at}.state`, `must be completed or failed, not ${describe(a.state)}`);
    if (typeof a.issuedAt !== 'number' || !Number.isFinite(a.issuedAt)) good = e.add(`${at}.issuedAt`, `must be a number, not ${describe(a.issuedAt)}`);
    if (!isRecord(a.params)) good = e.add(`${at}.params`, `must be an object of string → string, not ${describe(a.params)}`);
    else {
      const entries = Object.entries(a.params);
      if (entries.length > LIMITS.attestationParams) good = e.add(`${at}.params`, `must have at most ${LIMITS.attestationParams} entries`);
      for (const [k, val] of entries) if (!checkString(e, val, `${at}.params[${JSON.stringify(k)}]`, LIMITS.attestationValue)) good = false;
    }
    if (!good) { ok = false; return; }
    out.push({ schema: 'truthgate.attestation.v1', issuer: a.issuer as string, executionId: a.executionId as string, operation: a.operation as string, params: Object.fromEntries(Object.entries(a.params as Record<string, string>)), state: a.state as 'completed' | 'failed', issuedAt: a.issuedAt as number, signature: a.signature as string });
  });
  return ok ? out : null;
}

export function validateRunRecord(body: unknown): ValidationResult {
  const e = new Errors();
  if (!isRecord(body)) return { ok: false, errors: [`record: must be a JSON object, not ${describe(body)}`] };
  checkKeys(e, body, 'record', RECORD_KEYS);
  const taskPromptOk = checkString(e, body.taskPrompt, 'record.taskPrompt', LIMITS.taskPrompt, { nonEmpty: true });
  const trace = checkTrace(e, body.trace, 'record.trace');
  const files = checkFiles(e, body.files, 'record.files');
  const worldBefore = body.worldBefore === undefined ? undefined : checkWorld(e, body.worldBefore, 'record.worldBefore');
  const aliasesOk = body.sandboxAliases === undefined || checkStringList(e, body.sandboxAliases, 'record.sandboxAliases', LIMITS.aliases, LIMITS.alias);
  if (aliasesOk && Array.isArray(body.sandboxAliases)) {
    (body.sandboxAliases as string[]).forEach((a, i) => { if (!a.startsWith('/')) e.add(`record.sandboxAliases[${i}]`, 'must be an absolute path'); else if (CONTROL.test(a)) e.add(`record.sandboxAliases[${i}]`, 'must not contain control characters'); });
  }
  const attestations = body.attestations === undefined ? undefined : checkAttestations(e, body.attestations, 'record.attestations');
  const executionIdOk = body.executionId === undefined || checkString(e, body.executionId, 'record.executionId', LIMITS.shortString, { nonEmpty: true });
  const checksOk = body.requiredChecks === undefined || checkStringList(e, body.requiredChecks, 'record.requiredChecks', LIMITS.requiredChecks, LIMITS.requiredCheck);
  if (checksOk && Array.isArray(body.requiredChecks)) (body.requiredChecks as string[]).forEach((c, i) => { if (!c.trim()) e.add(`record.requiredChecks[${i}]`, 'must not be empty'); else if (CONTROL.test(c)) e.add(`record.requiredChecks[${i}]`, 'must not contain control characters'); });
  if (e.list.length || !taskPromptOk || !trace || !files || (body.worldBefore !== undefined && !worldBefore) || !aliasesOk || (body.attestations !== undefined && !attestations) || !executionIdOk || !checksOk) {
    return { ok: false, errors: e.list };
  }
  const record: ServiceRecord = { taskPrompt: body.taskPrompt as string, trace, files };
  if (worldBefore) record.worldBefore = worldBefore;
  if (body.sandboxAliases !== undefined) record.sandboxAliases = [...(body.sandboxAliases as string[])];
  if (attestations) record.attestations = attestations;
  if (body.executionId !== undefined) record.executionId = body.executionId as string;
  if (body.requiredChecks !== undefined) record.requiredChecks = [...(body.requiredChecks as string[])];
  return { ok: true, record };
}
