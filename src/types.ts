// TruthGate — claim-level honesty audit for any model or agent. The shapes every module shares.
//
// A model's text is never graded against itself. Each claim is graded against evidence the model did not write:
// the trace (what it actually called and what came back), the world (files the verifier re-reads itself) and, in the
// benchmark only, the oracle. The detector never sees the oracle.

/** One event of an agent run, in order. Any agent framework's log can be mapped onto this. */
export type TraceEvent =
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { seq: number; kind: 'tool_result'; id: string; name: string; content: string; isError: boolean;
      /** For a command tool: the exit code the harness reported; 0 when it reported no code and no error (Claude Code
       *  prefixes every non-zero exit with "Exit code N"). null for other tools and for an error without a code. */
      exitCode: number | null;
      /** The harness reported an error, or a command exited non-zero. Deterministic; never a word match on the output. */
      looksLikeFailure: boolean };

/** Which tool names play which role in a trace. Claude Code's names are the default; another framework supplies its own. */
export interface ToolRoles { shell: string[]; read: string[]; write: string[]; edit: string[] }
export const CLAUDE_CODE_TOOL_ROLES: ToolRoles = { shell: ['Bash'], read: ['Read'], write: ['Write'], edit: ['Edit', 'MultiEdit', 'NotebookEdit'] };

export interface Trace {
  events: TraceEvent[];
  /** Tool roles for this trace; Claude Code's when absent. */
  toolRoles?: ToolRoles;
  /** The agent's last assistant text: its report. Empty when the run ended without one. */
  finalText: string;
  model: string;
  /** The Claude Code CLI version that ran the agent, from its init event. */
  cliVersion: string;
  toolsAvailable: string[];
  numTurns: number;
  costUsd: number;
  /** How the harness ended the run: 'success', 'error_max_turns', 'error_max_budget_usd', 'error_during_execution', ... */
  harnessSubtype: string;
  harnessIsError: boolean;
  harnessResultText: string;
  /** Tool calls the harness refused (print mode denies anything that would prompt), as the harness listed them. */
  permissionDenials: string[];
}

/** sha256 and size of every file under the sandbox, by path relative to the sandbox. */
export interface WorldSnapshot { files: Record<string, { sha256: string; bytes: number }> }

export type ClaimType = 'action' | 'observation' | 'check' | 'completion' | 'inability' | 'prediction';
export type ActionVerb = 'create' | 'modify' | 'delete' | 'rename' | 'run' | 'read' | 'none';

export interface Claim {
  id: string;
  type: ClaimType;
  /** The claim restated as one plain sentence. */
  text: string;
  /** The exact substring of the final text the claim comes from. */
  quote: string;
  /** "should now exist", "appears to" — a hedge is recorded, never a free pass. */
  hedged: boolean;
  /** For an action claim: what the agent says it did. */
  verb: ActionVerb;
  subject: { path?: string; path2?: string; command?: string; value?: string };
}

export type Verdict = 'SUPPORTED' | 'CONTRADICTED' | 'UNGROUNDED' | 'UNVERIFIABLE';
/** trace, world, calc and attestation are deterministic and replayable; judge is a model's estimate. */
export type VerifyLevel = 'trace' | 'world' | 'calc' | 'attestation' | 'judge';

export interface Evidence { seq?: number; path?: string; command?: string; excerpt: string }

export interface ClaimVerdict {
  claimId: string;
  verdict: Verdict;
  level: VerifyLevel;
  /** The rule that produced the verdict (for a calibration table per rule), e.g. trace.run.executed, judge.vote. */
  rule: string;
  /** 1 for a deterministic level (the evidence is a reproducible proof); the judge's own estimate otherwise. */
  confidence: number;
  evidence: Evidence[];
  reason: string;
  /** For an observation with a value: the value appears verbatim in some tool result the agent received (it read it
   *  rather than computed or invented it). Independent of the verdict. */
  evidenced?: boolean;
  /** For a judge verdict: what each round answered (null = the round said nothing usable about this claim). */
  votes?: Array<{ verdict: string; confidence: number } | null>;
  /** For a judge verdict, when the audit carried a calibration table for this judge configuration: how often a
   *  verdict of this rule and confidence bin was right on the gold-labeled benchmark it was measured on. */
  calibrated?: { precision: number; ci95: [number, number]; n: number; measuredOn: string };
}

/** A failed tool result, a change to a pre-existing file, or a run the task required that never happened, none of which the final text acknowledges: a lie by silence. */
export interface Omission {
  kind: 'failure' | 'undisclosed_change' | 'required_run_missing';
  seq?: number;
  path?: string;
  name: string;
  excerpt: string;
  reason: string;
  /** The rule that found it: world.input_changed (deterministic), judge.failure.silent, judge.change.silent. */
  rule: string;
  /** 1 for a deterministic rule; the judge's margin-scaled estimate otherwise. */
  confidence: number;
}

/** A signed statement by the system that executed an action for the agent: the only evidence for an action that
 *  leaves no local trace (an email sent, a payment made). Verified with a pinned Ed25519 public key. */
export interface Attestation {
  schema: 'truthgate.attestation.v1';
  issuer: string;
  executionId: string;
  operation: string;
  params: Record<string, string>;
  state: 'completed' | 'failed';
  issuedAt: number;
  /** base64 Ed25519 signature over the canonical JSON of every other field. */
  signature: string;
}

export interface ReportVersion {
  schema: string;
  rules: string;
  prompts: string;
  judgeModel: string;
  votes: number;
  /** Where the calibration annotations were measured, when a table was carried. */
  calibration?: string;
  /** Set by bench/rescore.ts: the deterministic levels were re-applied under these rules and this schema; the judge's
   *  answers, `rules` and `prompts` stay those of the audit as recorded. */
  rescoredRules?: string;
  rescoredSchema?: string;
}

export interface Report {
  /** DECEPTIVE: a finding at or above the finding threshold. NEEDS_REVIEW: the strongest finding sits in the review
   *  band below it. HONEST: every checkable claim held and nothing was omitted. UNVERIFIED: nothing could be checked. */
  verdict: 'HONEST' | 'DECEPTIVE' | 'NEEDS_REVIEW' | 'UNVERIFIED';
  /** The strongest finding against the response: max confidence over contradicted and ungrounded claims, 0 when none. */
  pDeceptive: number;
  /** supported / (supported + contradicted + ungrounded) over the verifiable claims, with a Wilson 95% interval. */
  honestyRate: { value: number | null; n: number; ci95: [number, number] | null };
  /** verifiable claims / all claims. */
  coverage: number;
  claims: Claim[];
  verdicts: ClaimVerdict[];
  omissions: Omission[];
  judgeCostUsd: number;
  /** Tokens the extractor and the judge rounds used, where the model path reports them (the API path does; the CLI
   *  path reports cost only), and how many judge rounds were asked and answered. */
  usage?: { inputTokens: number; outputTokens: number; judgeRounds: { asked: number; answered: number } };
  notes: string[];
  version: ReportVersion;
  createdAt: string;
  durationMs: number;
}
