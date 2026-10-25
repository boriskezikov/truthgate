// The calculation level: an arithmetic statement in a report ("100 + 75 = 175") is checked by recomputing it. Numbers
// only, four operations, usual precedence; anything else is not a calculation. Dates (2024-03-01), ranges ("lines
// 10 - 20") and decimal commas are left alone, and a rounded result ("22400 / 12 = 1866.67") is right.
const NUM = String.raw`-?\d[\d,]*(?:\.\d+)?`;
const OP = String.raw`[+\-*/×÷]`;
const EXPR = new RegExp(String.raw`(?<![\w.])(${NUM}(?:\s*${OP}\s*${NUM}){1,12})\s*=\s*(${NUM})(?![\d%]|[.,]\d)`, 'g');
const MAX_TEXT = 4000;
const RANGE_WORDS = /\b(from|between|lines?|rows?|pages?|range|days?|through|to)\b[^=]{0,30}$/i;

export interface Calculation { expression: string; operands: number[]; claimed: number; actual: number; tolerance: number; matches: boolean }

/** "1,250" is a thousands separator; "12,5" is a decimal comma. */
function num(s: string): number { return Number(/^-?\d+,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '')); }

function decimals(s: string): number { const m = /[.,](\d+)$/.exec(s); return m && !/^-?\d+,\d{3}$/.test(s) ? m[1]!.length : 0; }

/** Left-to-right with * / before + -; returns null when a token is not a number or a division by zero occurs. */
function evaluate(expr: string): { value: number; operands: number[]; ops: string[] } | null {
  const tokens = expr.match(new RegExp(`${NUM}|${OP}`, 'g'));
  if (!tokens || tokens.length < 3 || tokens.length % 2 === 0) return null;
  const operands: number[] = [];
  const values: number[] = [];
  const ops: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (i % 2 === 0) { const v = num(tokens[i]!); if (!Number.isFinite(v)) return null; values.push(v); operands.push(v); }
    else ops.push(tokens[i]!);
  }
  const v2: number[] = [values[0]!];
  const o2: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!, rhs = values[i + 1]!;
    if (op === '*' || op === '×') v2[v2.length - 1] = v2[v2.length - 1]! * rhs;
    else if (op === '/' || op === '÷') { if (rhs === 0) return null; v2[v2.length - 1] = v2[v2.length - 1]! / rhs; }
    else { o2.push(op); v2.push(rhs); }
  }
  let value = v2[0]!;
  for (let i = 0; i < o2.length; i++) value = o2[i] === '+' ? value + v2[i + 1]! : value - v2[i + 1]!;
  return { value, operands, ops };
}

/** Every arithmetic statement in the text, recomputed. */
export function findCalculations(text: string): Calculation[] {
  const t = text.slice(0, MAX_TEXT).replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, ' ');
  const out: Calculation[] = [];
  for (const m of t.matchAll(EXPR)) {
    const ev = evaluate(m[1]!);
    if (!ev) continue;
    // "lines 10 - 20 = 11 lines": a range, not a subtraction.
    if (ev.ops.every((o) => o === '-') && RANGE_WORDS.test(t.slice(Math.max(0, m.index! - 30), m.index!))) continue;
    const claimed = num(m[2]!);
    if (!Number.isFinite(claimed)) continue;
    const tolerance = Math.max(1e-9, Math.abs(ev.value) * 1e-9, 0.5 * 10 ** -decimals(m[2]!) + 1e-9);
    out.push({ expression: m[0]!.trim(), operands: ev.operands, claimed, actual: ev.value, tolerance, matches: Math.abs(ev.value - claimed) <= tolerance });
  }
  return out;
}

/** The first arithmetic statement, for callers that want one. */
export function findCalculation(text: string): Calculation | null { return findCalculations(text)[0] ?? null; }
