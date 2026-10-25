// The one place TruthGate touches a real model: the Claude Code CLI in headless mode (`claude -p`).
//
// `runAgent` runs the model UNDER TEST with tools in a sandbox and returns the harness's own event stream as a
// Trace (`--output-format stream-json`): the tool calls it made and the raw results it received, which the model
// cannot edit. `runJudge` runs a different model with no tools and a JSON schema and returns the structured output.
//
// Both call a real model and spend real quota, so both refuse to run unless TRUTHGATE_LIVE=1 is set (CLAUDE.md:
// a script that needs a real model says so explicitly).
import { spawn } from 'node:child_process';
import type { Trace, TraceEvent } from './types.ts';

const BIN = process.env.TRUTHGATE_CLAUDE_BIN ?? 'claude';

/** Flags shared by every call: no MCP servers, no skills, no settings files, nothing persisted. */
const COMMON_ARGS = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence', '--setting-sources', ''];

export function requireLive(): void {
  if (process.env.TRUTHGATE_LIVE !== '1') {
    throw new Error('TruthGate calls a real model through the claude CLI and spends quota; set TRUTHGATE_LIVE=1 to allow it.');
  }
}

interface Spawned { stdout: string; stderr: string; code: number | null; timedOut: boolean }

/** What the child may see: enough to run and to authenticate, never the host's other credentials (GITHUB_TOKEN,
 *  AWS_* and the like). CLAUDECODE has no underscore and is therefore not copied: a nested session is refused when it
 *  is set. */
const CHILD_ENV_NAMES = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'SHELL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'IS_SANDBOX']);
const CHILD_ENV_PREFIXES = ['CLAUDE_', 'ANTHROPIC_'];

export function childEnv(source: NodeJS.ProcessEnv = process.env, o: { agent?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // The agent under test gets no ANTHROPIC_* variable: the CLI authenticates with its own login files, and a model
  // with a shell must not find an API key in its environment. The judge child keeps them.
  for (const [k, v] of Object.entries(source)) if (CHILD_ENV_NAMES.has(k) || CHILD_ENV_PREFIXES.some((p) => k.startsWith(p) && !(o.agent && p === 'ANTHROPIC_'))) env[k] = v;
  return env;
}

function runClaude(args: string[], stdin: string, cwd: string, timeoutMs: number, agent = false): Promise<Spawned> {
  return new Promise((resolve) => {
    const env = childEnv(process.env, { agent });
    // Its own process group, so that a timeout also ends a command the agent left running.
    const child = spawn(BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const killGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code, timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ stdout, stderr: `${stderr}\n${String(e)}`, code: -1, timedOut }); });
    child.stdin.on('error', () => { /* the child closed stdin first; the close event still reports the result */ });
    child.stdin.end(stdin);
  });
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : typeof (b as Block).text === 'string' ? (b as Block).text! : JSON.stringify(b))).join('\n');
  return content == null ? '' : JSON.stringify(content);
}

/** The exit code a command tool's result carries. Claude Code prefixes every non-zero exit with "Exit code N" and
 *  marks it an error; a Bash result with neither is a success, so it is 0. null for a tool that is not a command, and
 *  for an error that carries no code (the failure then shows through isError). */
export function exitCodeOf(toolName: string, content: string, isError: boolean): number | null {
  if (toolName !== 'Bash') return null;
  const m = /^(?:Error: )?Exit code (\d+)/.exec(content.trimStart());
  if (m) return Number(m[1]);
  return isError ? null : 0;
}

/** Maps the CLI's stream-json lines onto a Trace. Exported so a recorded stream can be re-parsed without a model. */
export function parseStreamJson(raw: string): Trace {
  const events: TraceEvent[] = [];
  const toolNames = new Map<string, string>();
  let seq = 0;
  let model = '';
  let toolsAvailable: string[] = [];
  let cliVersion = '';
  // One API message arrives as several assistant events that share message.id; the report is the whole last message.
  let lastMsgId = '';
  let lastAssistantTexts: string[] = [];
  let lastAssistantHadToolUse = false;
  let numTurns = 0, costUsd = 0;
  let harnessSubtype = 'no_result', harnessIsError = true, harnessResultText = '';
  let permissionDenials: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const message = e.message as { content?: unknown } | undefined;
    if (e.type === 'system' && e.subtype === 'init') {
      model = typeof e.model === 'string' ? e.model : '';
      toolsAvailable = Array.isArray(e.tools) ? (e.tools as string[]) : [];
      cliVersion = typeof e.claude_code_version === 'string' ? e.claude_code_version : '';
    } else if (e.type === 'assistant') {
      const msgId = typeof (message as { id?: unknown } | undefined)?.id === 'string' ? (message as { id: string }).id : `#${seq}`;
      if (msgId !== lastMsgId) { lastMsgId = msgId; lastAssistantTexts = []; lastAssistantHadToolUse = false; }
      for (const b of blocksOf(message?.content)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) { lastAssistantTexts.push(b.text); events.push({ seq: seq++, kind: 'text', text: b.text }); }
        else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
          lastAssistantHadToolUse = true;
          toolNames.set(b.id, b.name);
          events.push({ seq: seq++, kind: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
        }
      }
    } else if (e.type === 'user') {
      for (const b of blocksOf(message?.content)) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const content = flattenContent(b.content);
          const name = toolNames.get(b.tool_use_id) ?? '?';
          const isError = b.is_error === true;
          const exitCode = exitCodeOf(name, content, isError);
          events.push({ seq: seq++, kind: 'tool_result', id: b.tool_use_id, name, content, isError, exitCode, looksLikeFailure: isError || (exitCode != null && exitCode !== 0) });
        }
      }
    } else if (e.type === 'result') {
      harnessSubtype = typeof e.subtype === 'string' ? e.subtype : '';
      harnessIsError = e.is_error === true;
      harnessResultText = typeof e.result === 'string' ? e.result : '';
      costUsd = typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0;
      numTurns = typeof e.num_turns === 'number' ? e.num_turns : 0;
      permissionDenials = Array.isArray(e.permission_denials) ? (e.permission_denials as unknown[]).map((d) => (typeof d === 'string' ? d : JSON.stringify(d))) : [];
    }
  }
  // The report is the last assistant message only when that message ended the turn with text. A message that still
  // calls a tool was cut off by the harness: a plan is not a report.
  let finalText = lastAssistantHadToolUse ? '' : lastAssistantTexts.join('\n').trim();
  if (!finalText && harnessSubtype === 'success' && !harnessIsError && harnessResultText.trim()) finalText = harnessResultText.trim();
  return { events, finalText, model, cliVersion, toolsAvailable, numTurns, costUsd, harnessSubtype, harnessIsError, harnessResultText, permissionDenials };
}

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  system: string;
  model: string;
  /** Built-in tool names the agent may use ("Read", "Write", "Edit", "Bash"); empty = no tools at all. */
  tools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs?: number;
}

export interface AgentRun { trace: Trace; raw: string; stderr: string; timedOut: boolean; exitCode: number | null }

export async function runAgent(o: AgentRunOptions): Promise<AgentRun> {
  requireLive();
  const toolList = o.tools.join(',');
  const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--max-turns', String(o.maxTurns), '--tools', toolList, '--system-prompt', o.system, '--max-budget-usd', String(o.maxBudgetUsd), ...COMMON_ARGS];
  if (toolList) args.push('--allowedTools', toolList);
  const r = await runClaude(args, o.prompt, o.cwd, o.timeoutMs ?? 600_000, true);
  return { trace: parseStreamJson(r.stdout), raw: r.stdout, stderr: r.stderr, timedOut: r.timedOut, exitCode: r.code };
}

export interface JudgeOptions { model: string; system: string; prompt: string; schema: object; maxBudgetUsd?: number; timeoutMs?: number; cwd?: string }

export interface JudgeResult<T> { output: T; costUsd: number; attempts: number }

/** One no-tools call that must return data matching `schema`. Retried once on a harness or API error. */
export async function runJudge<T>(o: JudgeOptions): Promise<JudgeResult<T>> {
  requireLive();
  // Three turns, not one: the model sometimes writes a sentence before it calls the structured-output tool.
  const args = ['-p', '--model', o.model, '--output-format', 'json', '--max-turns', '3', '--tools', '', '--system-prompt', o.system, '--json-schema', JSON.stringify(o.schema), '--max-budget-usd', String(o.maxBudgetUsd ?? 1), ...COMMON_ARGS];
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await runClaude(args, o.prompt, o.cwd ?? process.cwd(), o.timeoutMs ?? 300_000);
    const start = r.stdout.indexOf('{');
    let e: Record<string, unknown> | null = null;
    try { e = start >= 0 ? (JSON.parse(r.stdout.slice(start)) as Record<string, unknown>) : null; } catch { e = null; }
    if (e && e.is_error !== true && e.structured_output != null) {
      return { output: e.structured_output as T, costUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : 0, attempts: attempt };
    }
    lastError = e ? `${String(e.subtype)}: ${String(e.result).slice(0, 300)}` : `no JSON result (exit ${r.code}, timedOut=${r.timedOut}): ${r.stderr.slice(0, 300)}`;
  }
  throw new Error(`judge call failed twice: ${lastError}`);
}
