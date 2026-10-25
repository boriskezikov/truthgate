// A compact, bounded rendering of a trace for a model to read: every tool call in order with the raw result it got.
import type { Trace, TraceEvent } from './types.ts';

export function excerpt(s: string, max = 400): string { return s.length > max ? `${s.slice(0, max)}…[${s.length - max} more chars]` : s; }

/** Head and tail of a long text: the last lines of a command's output carry its errors. */
export function excerptEnds(s: string, max: number): string {
  if (s.length <= max) return s;
  const tail = Math.floor(max * 0.3), head = max - tail;
  return `${s.slice(0, head)}…[${s.length - max} chars cut]…${s.slice(s.length - tail)}`;
}

const COMMAND_CHARS = 4000;

/** `focus(u)` names the calls whose results matter for the claims at hand: those are shown up to `focusChars`, and
 *  their command lines in full; every other result is cut in the middle, never at the end. */
/** The whole digest stays under this many characters: what does not fit is counted, not shown. */
export const DIGEST_BUDGET = 400_000;

export function digestTrace(trace: Trace, resultChars = 2500, focus?: (u: Extract<TraceEvent, { kind: 'tool_use' }>) => boolean, focusChars = 60_000, budget = DIGEST_BUDGET): string {
  const results = new Map<string, Extract<TraceEvent, { kind: 'tool_result' }>>();
  for (const e of trace.events) if (e.kind === 'tool_result') results.set(e.id, e);
  const lines: string[] = [];
  let used = 0, dropped = 0;
  for (const u of trace.events) {
    if (u.kind !== 'tool_use') continue;
    if (used >= budget) { dropped++; continue; }
    const r = results.get(u.id);
    // Runs of whitespace are the one cheap way to pad a line past the cut: collapsed before the excerpt.
    const input = (typeof u.input.command === 'string' ? u.input.command : JSON.stringify(u.input)).replace(/[ \t]{3,}/g, '  ');
    const focused = !!focus?.(u);
    const chars = focused ? focusChars : resultChars;
    const line = `[${u.seq}] ${u.name} ${excerptEnds(input, focused ? focusChars : COMMAND_CHARS)} → ${r ? `${r.isError ? 'ERROR' : r.looksLikeFailure ? `exit ${r.exitCode}` : 'ok'} [${r.seq}]: ${excerptEnds(r.content, Math.min(chars, Math.max(200, budget - used)))}` : 'no result recorded'}`;
    lines.push(line);
    used += line.length;
  }
  if (dropped) lines.push(`… ${dropped} further tool call(s) not shown: the digest budget of ${budget} characters is spent`);
  return lines.length ? lines.join('\n') : '(no tool calls at all)';
}
