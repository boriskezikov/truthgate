// A calibration table: what a verdict's confidence meant on a gold-labeled benchmark, per rule and confidence bin.
// Measured by bench/calibrate.ts; an audit that carries a table annotates its judge findings with the measured
// precision of their bin. The annotation never changes a verdict; it tells the reader how often that kind of
// finding was right when it was measured, under which judge model, vote count, rules and prompts.
import type { ClaimVerdict } from './types.ts';

export interface CalibrationBin { id: string; label: string; lo: number; hi: number }
/** Bins follow the thresholds: below review, review band, finding band, unanimous or deterministic. */
export const BINS: CalibrationBin[] = [
  { id: 'lt0.6', label: '< 0.6', lo: 0, hi: 0.6 },
  { id: '0.6-0.9', label: '0.6 – 0.9', lo: 0.6, hi: 0.9 },
  { id: '0.9-1', label: '0.9 – 1', lo: 0.9, hi: 1.000001 },
];
export function binOf(confidence: number): string | null { return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? (BINS.find((b) => confidence >= b.lo && confidence < b.hi) ?? BINS[BINS.length - 1]!).id : null; }

export interface CalibrationCell { rule: string; bin: string; n: number; right: number; precision: number; ci95: [number, number] }
export interface CalibrationTable {
  schema: 'truthgate.calibration.v1';
  measuredOn: string;
  reports: number;
  judgeModel: string;
  votes: number;
  rules: string;
  prompts: string;
  findings: CalibrationCell[];
  supports: CalibrationCell[];
}

export interface CalibratedPrecision { precision: number; ci95: [number, number]; n: number; measuredOn: string }

/** The measured precision for this verdict's rule and bin, or null when the table has no cell for it or was measured
 *  under another judge configuration (a table never speaks for a judge it did not measure). */
export function calibratedPrecision(v: ClaimVerdict, table: CalibrationTable | undefined, judgeModel: string, votes: number, rules?: string, prompts?: string): CalibratedPrecision | null {
  if (!table || table.judgeModel !== judgeModel || table.votes !== votes) return null;
  if ((rules !== undefined && table.rules !== rules) || (prompts !== undefined && table.prompts !== prompts)) return null;
  if (v.level !== 'judge') return null;
  const cells = v.verdict === 'SUPPORTED' ? table.supports : v.verdict === 'CONTRADICTED' || v.verdict === 'UNGROUNDED' ? table.findings : [];
  const bin = binOf(v.confidence);
  if (!bin) return null;
  const cell = cells.find((c) => c.rule === v.rule && c.bin === bin) ?? cells.find((c) => c.rule === 'judge.*' && c.bin === bin);
  return cell ? { precision: cell.precision, ci95: cell.ci95, n: cell.n, measuredOn: table.measuredOn } : null;
}
