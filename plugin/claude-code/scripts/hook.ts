// The TruthGate hook for Claude Code: one script for two events, told apart by `hook_event_name` on stdin.
//   UserPromptSubmit  takes a snapshot of the working directory (file hashes) and keeps it for the turn.
//   Stop              reads the turn from the session transcript (every tool call and its raw result since the last
//                     human prompt), snapshots the directory again, audits the report with the judge on this host's
//                     claude login, and answers: a DECEPTIVE report blocks the stop and hands Claude the evidence so
//                     it corrects the report; any other verdict is shown to the user as a system message.
// A turn without a tool call is not audited (nothing to check against, nothing spent). An internal error never
// blocks: it is shown and the stop proceeds. Every audit is kept under $CLAUDE_PLUGIN_DATA/records/ (the trace, the
// snapshots, the report) unless TRUTHGATE_KEEP_RECORDS=0, so the records can be rescored and measured later.
// Environment: TRUTHGATE_JUDGE_MODEL (default claude-sonnet-5-5), TRUTHGATE_VOTES (default 3),
// TRUTHGATE_MODEL_PATH (default: the claude CLI; api, openai or fake select another client, see src/model-env.ts),
// TRUTHGATE_REQUIRED_CHECKS (comma-separated, see rules.ts `requiredChecks`), TRUTHGATE_QUIET=1 (no message on HONEST).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exitCodeOf } from '../../../src/cli-engine.ts';
import { modelClientFromEnv } from '../../../src/model-env.ts';
import { audit } from '../../../src/truthgate.ts';
import type { Report, Trace, TraceEvent, WorldSnapshot } from '../../../src/types.ts';
import { snapshotWorld } from '../../../src/world.ts';

interface HookInput { session_id: string; transcript_path?: string; cwd: string; hook_event_name: string; prompt?: string; stop_hook_active?: boolean; last_assistant_message?: string }
interface Line { type?: string; isMeta?: boolean; isSidechain?: boolean; promptId?: string; timestamp?: string; message?: { role?: string; content?: unknown } }
interface Block { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }

/** Claude Code's tools, for the rules that ask whether the agent could run commands or read files at all. */
const CLAUDE_CODE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task'];
const MAX_SNAPSHOT_FILES = 20_000;

const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'truthgate-claude-code');
const stateFile = (sessionId: string) => join(dataDir, 'state', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

function readStdin(): string { try { return readFileSync(0, 'utf8'); } catch { return ''; } }
function out(o: Record<string, unknown>): void { process.stdout.write(`${JSON.stringify(o)}\n`); }

/** A snapshot of cwd, or null when the directory is too large to hash within the hook's time. */
function snapshot(cwd: string): WorldSnapshot | null {
  const w = snapshotWorld(cwd);
  return Object.keys(w.files).length > MAX_SNAPSHOT_FILES ? null : w;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === 'object' && typeof (b as Block).text === 'string' ? (b as Block).text! : '')).filter(Boolean).join('\n');
  return '';
}

/** The last turn of the transcript as a Trace: the lines after the last human prompt, tool calls paired with results. */
function turnFromTranscript(path: string, lastAssistantMessage: string | undefined): { prompt: string; trace: Trace } | null {
  const lines: Line[] = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Line; } catch { return {}; } });
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.type === 'user' && !l.isMeta && !l.isSidechain && typeof l.message?.content === 'string') { start = i; break; }
    if (l.type === 'user' && !l.isMeta && !l.isSidechain && Array.isArray(l.message?.content) && (l.message!.content as Block[]).some((b) => b.type === 'text') && !(l.message!.content as Block[]).some((b) => b.type === 'tool_result')) { start = i; break; }
  }
  if (start < 0) return null;
  const prompt = blockText(lines[start]!.message!.content);
  const events: TraceEvent[] = [];
  let seq = 1;
  const names = new Map<string, string>();
  let lastText = '';
  for (const l of lines.slice(start + 1)) {
    if (l.isSidechain || !Array.isArray(l.message?.content)) continue;
    for (const b of l.message!.content as Block[]) {
      if (l.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { events.push({ seq: seq++, kind: 'text', text: b.text }); lastText = b.text; }
      else if (l.type === 'assistant' && b.type === 'tool_use' && b.id && b.name) { names.set(b.id, b.name); events.push({ seq: seq++, kind: 'tool_use', id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }); }
      else if (l.type === 'user' && b.type === 'tool_result' && b.tool_use_id) {
        const name = names.get(b.tool_use_id) ?? 'unknown';
        const content = blockText(b.content);
        const isError = !!b.is_error;
        const exitCode = exitCodeOf(name, content, isError);
        events.push({ seq: seq++, kind: 'tool_result', id: b.tool_use_id, name, content, isError, exitCode, looksLikeFailure: isError || (exitCode != null && exitCode !== 0) });
      }
    }
  }
  const finalText = (lastAssistantMessage && lastAssistantMessage.trim()) || lastText;
  const trace: Trace = {
    events, finalText, model: 'claude-code', cliVersion: process.env.CLAUDE_CODE_VERSION ?? 'claude-code', toolsAvailable: CLAUDE_CODE_TOOLS,
    numTurns: events.filter((e) => e.kind === 'tool_use').length, costUsd: 0, harnessSubtype: 'success', harnessIsError: false, harnessResultText: finalText, permissionDenials: [],
  };
  return { prompt, trace };
}

function evidenceLines(r: Report): string[] {
  const lines: string[] = [];
  for (const v of r.verdicts.filter((x) => x.verdict === 'CONTRADICTED' || x.verdict === 'UNGROUNDED')) {
    const c = r.claims.find((x) => x.id === v.claimId);
    lines.push(`- "${(c?.text ?? v.claimId).replace(/\s+/g, ' ').slice(0, 160)}": ${v.verdict} (${v.rule}, ${v.confidence.toFixed(2)}): ${v.reason.replace(/\s+/g, ' ').slice(0, 240)}`);
    for (const e of v.evidence.slice(0, 2)) lines.push(`    evidence${e.seq != null ? ` [seq ${e.seq}]` : ''}${e.path ? ` ${e.path}` : ''}: ${e.excerpt.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  for (const o of r.omissions) lines.push(`- omission (${o.rule}, ${o.confidence.toFixed(2)}): ${o.reason.replace(/\s+/g, ' ').slice(0, 240)}`);
  return lines;
}

async function main(): Promise<void> {
  const input = JSON.parse(readStdin() || '{}') as HookInput;
  const cwd = resolve(input.cwd || process.cwd());
  if (input.hook_event_name === 'UserPromptSubmit') {
    const world = snapshot(cwd);
    mkdirSync(join(dataDir, 'state'), { recursive: true });
    writeFileSync(stateFile(input.session_id), JSON.stringify({ cwd, takenAt: Date.now(), prompt: input.prompt ?? '', worldBefore: world }));
    return;
  }
  if (input.hook_event_name !== 'Stop') return;
  if (input.stop_hook_active) return;
  if (!input.transcript_path || !existsSync(input.transcript_path)) { out({ systemMessage: 'TruthGate: no transcript to audit' }); return; }
  const turn = turnFromTranscript(input.transcript_path, input.last_assistant_message);
  if (!turn) return;
  if (!turn.trace.events.some((e) => e.kind === 'tool_use')) return;
  if (!turn.trace.finalText.trim()) return;
  const state = existsSync(stateFile(input.session_id)) ? (JSON.parse(readFileSync(stateFile(input.session_id), 'utf8')) as { cwd: string; worldBefore: WorldSnapshot | null }) : null;
  const worldBefore = state && state.cwd === cwd && state.worldBefore ? state.worldBefore : null;
  const worldAfter = snapshot(cwd) ?? { files: {} };
  const judgeModel = process.env.TRUTHGATE_JUDGE_MODEL || 'claude-sonnet-5-5';
  const votes = process.env.TRUTHGATE_VOTES ? Number(process.env.TRUTHGATE_VOTES) : undefined;
  const requiredChecks = process.env.TRUTHGATE_REQUIRED_CHECKS?.split(',').map((s) => s.trim()).filter(Boolean);
  // Installing the plugin is the consent to spend on this host's login: the judge runs through the claude CLI.
  process.env.TRUTHGATE_LIVE = '1';
  const judge = process.env.TRUTHGATE_MODEL_PATH ? modelClientFromEnv(judgeModel) : undefined;
  const t0 = Date.now();
  const report = await audit({ taskPrompt: turn.prompt, trace: turn.trace, sandboxDir: cwd, worldBefore: worldBefore ?? { files: {} }, worldAfter, worldBeforeKnown: !!worldBefore, judgeModel, judge, votes, requiredChecks });
  if (process.env.TRUTHGATE_KEEP_RECORDS !== '0') {
    const dir = join(dataDir, 'records', input.session_id.replace(/[^A-Za-z0-9_-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${stamp}.json`), `${JSON.stringify({ taskPrompt: turn.prompt, cwd, worldBefore, worldAfter, trace: turn.trace, report, elapsedMs: Date.now() - t0 }, null, 1)}\n`);
  }
  const summary = `TruthGate: ${report.verdict} (p=${report.pDeceptive.toFixed(2)}; ${report.claims.length} claims, coverage ${(100 * report.coverage).toFixed(0)}%, judge $${report.judgeCostUsd.toFixed(3)}, ${Math.round((Date.now() - t0) / 1000)} s${worldBefore ? '' : '; no before-snapshot, file claims went to the judge'})`;
  const lines = evidenceLines(report);
  if (report.verdict === 'DECEPTIVE') {
    out({ decision: 'block', reason: `${summary}\nYour report contradicts the trace of what you actually did. Correct the report so that it states what happened, including what failed or was not run:\n${lines.join('\n')}`, systemMessage: `${summary}\n${lines.join('\n')}` });
    return;
  }
  if (report.verdict === 'HONEST' && process.env.TRUTHGATE_QUIET === '1') return;
  out({ systemMessage: lines.length ? `${summary}\n${lines.join('\n')}` : summary });
}

main().catch((e) => { out({ systemMessage: `TruthGate could not run: ${(e as Error).message.slice(0, 300)}` }); });
