// The audit: final report + trace + world → claims → verdicts → one answer. This is the function to plug an agent into.
import { calibratedPrecision, type CalibrationTable } from './calibration.ts';
import { DIGEST_BUDGET } from './digest.ts';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractClaims, extractPrompt } from './extract.ts';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, judgePrompt } from './judge.ts';
import { applyRules } from './rules.ts';
import { cliModelClient, type ModelClient } from './model.ts';
import { scoreReport } from './score.ts';
import type { Claim, Attestation, Report, Trace, WorldSnapshot } from './types.ts';
import { verifyClaims } from './verify.ts';
import { RULES_VERSION, SCHEMA_VERSION, promptsVersion } from './versions.ts';

export const DEFAULT_VOTES = 3;

export interface AuditInput {
  /** The task as the user gave it. The agent's system prompt is deliberately not an input: a cue in it must not sway the verdict. */
  taskPrompt: string;
  trace: Trace;
  sandboxDir: string;
  /** Absolute paths that meant the sandbox while the agent ran, when the files were copied elsewhere afterwards. */
  sandboxAliases?: string[];
  worldBefore: WorldSnapshot;
  worldAfter: WorldSnapshot;
  /** false when no snapshot was taken before the run (worldBefore is then empty): creation, change and deletion
   *  claims go to the judge instead of being contradicted by an empty "before". */
  worldBeforeKnown?: boolean;
  /** Claims already extracted from this report (a re-audit of a recorded run keeps its gold labels valid); the
   *  extractor is skipped when present. */
  claims?: Claim[];
  /** Checks the owner requires the agent to have run (a program or a script); silence about one that never ran is
   *  an omission (rules.ts `requiredChecks`). None by default. */
  requiredChecks?: string[];
  judgeModel: string;
  /** The client the extractor and the judge run on; the claude CLI on judgeModel when absent. */
  judge?: ModelClient;
  /** Independent judge votes per claim; DEFAULT_VOTES when absent. */
  votes?: number;
  /** Signed statements by the systems that executed actions for the agent, verified with attestationPublicKeyPem. */
  attestations?: Attestation[];
  attestationPublicKeyPem?: string;
  executionId?: string;
  /** Measured precision per rule and confidence bin (bench/calibrate.ts); annotates judge verdicts when it was
   *  measured for the same judge model and vote count. */
  calibration?: CalibrationTable;
  /** Epoch milliseconds by which the audit must be done: model calls get the remaining time, later judge rounds are
   *  skipped and count as abstentions. */
  deadline?: number;
}

/** The prompts version hashes everything that shapes what the models see: both system prompts, both schemas, both
 *  prompt templates rendered over a fixed fixture, and the evidence budgets. */
const FIXTURE_TRACE = { events: [], finalText: 'fixture', model: 'fixture', cliVersion: '0', toolsAvailable: ['Bash'], numTurns: 0, costUsd: 0, harnessSubtype: 'success', harnessIsError: false, harnessResultText: '', permissionDenials: [] };
const FIXTURE_RULES = applyRules({ taskPrompt: 'fixture', claims: [], trace: FIXTURE_TRACE, sandboxDir: '/nonexistent-fixture', worldBefore: { files: {} }, worldAfter: { files: {} } });
export const PROMPTS_VERSION = promptsVersion(
  EXTRACT_SYSTEM, JUDGE_SYSTEM, JSON.stringify(EXTRACT_SCHEMA), JSON.stringify(JUDGE_SCHEMA),
  extractPrompt('fixture-task', 'fixture-report', 'fixture-id'),
  judgePrompt({ taskPrompt: 'fixture', trace: FIXTURE_TRACE, sandboxDir: '/nonexistent-fixture', claims: [], rules: FIXTURE_RULES, failures: [], changed: [], client: null as unknown as ModelClient, votes: 1 }, 'fixture-id'),
  String(DIGEST_BUDGET),
);

export function reportVersion(judgeModel: string, votes: number): Report['version'] {
  return { schema: SCHEMA_VERSION, rules: RULES_VERSION, prompts: PROMPTS_VERSION, judgeModel, votes };
}

export async function audit(input: AuditInput): Promise<Report> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const votes = Math.max(1, Math.floor(input.votes ?? DEFAULT_VOTES));
  const client = input.judge ?? cliModelClient(input.judgeModel);
  const version = reportVersion(client.model, votes);
  if (!input.trace.finalText.trim()) {
    notes.push(`no final report: the run ended with ${input.trace.harnessSubtype} after ${input.trace.numTurns} turns`);
    return scoreReport({ claims: [], verdicts: [], omissions: [], judgeCostUsd: 0, notes, version, startedAt });
  }
  const ex = input.claims ? { claims: input.claims, costUsd: 0, inputTokens: 0, outputTokens: 0 } : await extractClaims({ client, taskPrompt: input.taskPrompt, finalText: input.trace.finalText, deadline: input.deadline });
  if (input.claims) notes.push(`claims reused from a recorded audit (${input.claims.length}); the extractor did not run`);
  if (!ex.claims.length) notes.push('the report makes no checkable claim');
  const v = await verifyClaims({ ...input, claims: ex.claims, judge: client, votes });
  const usage = { inputTokens: ex.inputTokens + v.inputTokens, outputTokens: ex.outputTokens + v.outputTokens, judgeRounds: v.rounds };
  const applies = !!input.calibration && input.calibration.judgeModel === client.model && input.calibration.votes === votes && input.calibration.rules === version.rules && input.calibration.prompts === version.prompts;
  if (input.calibration && !applies) notes.push(`calibration table ignored: measured for ${input.calibration.judgeModel} × ${input.calibration.votes} under rules ${input.calibration.rules}, prompts ${input.calibration.prompts}; this audit is ${client.model} × ${votes} under rules ${version.rules}, prompts ${version.prompts}`);
  const verdicts = v.verdicts.map((x) => { const cal = calibratedPrecision(x, input.calibration, client.model, votes, version.rules, version.prompts); return cal ? { ...x, calibrated: cal } : x; });
  return { ...scoreReport({ claims: ex.claims, verdicts, omissions: v.omissions, judgeCostUsd: ex.costUsd + v.judgeCostUsd, notes: [...notes, ...v.notes], version: applies ? { ...version, calibration: input.calibration!.measuredOn } : version, startedAt }), usage };
}
