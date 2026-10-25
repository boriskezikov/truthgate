// Step 2: every claim climbs a ladder and stops at the first level that yields a definite verdict.
//   trace, world, calc, attestation — deterministic rules (rules.ts), replayable without a model.
//   judge — a skeptic model with the evidence excerpts (judge.ts), for everything the rules cannot settle.
// Step 3 (omissions) is decided here too: a changed task input is an omission by rule; the rest the judge weighs.
import { judgeClaims } from './judge.ts';
import type { ModelClient } from './model.ts';
import { applyRules, verdict, type RulesInput, type RulesOutput } from './rules.ts';
import type { ClaimVerdict, Omission } from './types.ts';

export { JUDGE_SYSTEM } from './judge.ts';
export { currentContent, executesScript, mentionsFile, normPath, requiredRuns, TraceIndex, valueMatches } from './rules.ts';
export type { RulesInput as DeterministicInput, RulesOutput as DeterministicOutput } from './rules.ts';

export interface VerifyInput extends RulesInput {
  judge: ModelClient;
  /** Independent judge votes for the claims that reach the judge; majority wins. */
  votes?: number;
  deadline?: number;
}

export interface VerifyOutput { verdicts: ClaimVerdict[]; omissions: Omission[]; judgeCostUsd: number; notes: string[]; rounds: { asked: number; answered: number }; inputTokens: number; outputTokens: number }

/** The deterministic levels only: replayable without a model. */
export function verifyDeterministically(input: RulesInput): RulesOutput { return applyRules(input); }

export async function verifyClaims(input: VerifyInput): Promise<VerifyOutput> {
  const det = applyRules(input);
  const { verdicts, ix } = det;
  const notes = [...det.notes];
  // The rules' own omissions need no judge: a task input changed in silence, a required run never performed and never mentioned.
  const omissions: Omission[] = [...det.omissions];
  const openFailures = det.failures.filter((f) => !det.acknowledgedSeqs.has(f.seq));
  const forJudge = input.claims.filter((c) => !verdicts.has(c.id));
  const changedForJudge = det.changed.filter((p) => !det.taskInputsChanged.includes(p));
  const j = await judgeClaims({ taskPrompt: input.taskPrompt, trace: input.trace, sandboxDir: input.sandboxDir, sandboxAliases: input.sandboxAliases, claims: forJudge, rules: det, failures: openFailures, changed: changedForJudge, client: input.judge, votes: Math.max(1, input.votes ?? 3), deadline: input.deadline });
  for (const v of j.verdicts) verdicts.set(v.claimId, v);
  omissions.push(...j.omissions);
  notes.push(...j.notes);
  if (input.trace.harnessSubtype !== 'success') notes.push(`the run ended with ${input.trace.harnessSubtype}; the report may be missing or cut`);
  if (input.trace.permissionDenials.length) notes.push(`the harness refused ${input.trace.permissionDenials.length} tool call(s)`);
  const changedInputs = [...det.diff.modified, ...det.diff.deleted];
  if (changedInputs.length) notes.push(`pre-existing files changed during the run: ${changedInputs.join(', ')}`);
  const out = input.claims.map((c) => {
    const v = verdicts.get(c.id) ?? verdict(c, 'UNVERIFIABLE', 'judge', 'judge.silent', 0, [], 'not verified');
    return c.type === 'observation' && c.subject.value ? { ...v, evidenced: ix.evidenced(c.subject.value) } : v;
  });
  return { verdicts: out, omissions, judgeCostUsd: j.costUsd, notes, rounds: j.rounds, inputTokens: j.inputTokens, outputTokens: j.outputTokens };
}
