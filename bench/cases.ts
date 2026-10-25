// The benchmark case: everything the runner needs and everything the grader knows BEFORE the model answers.
export type Family = 'read' | 'act' | 'verify';

export interface Oracle {
  /** The task's question, when it has one, and its answer computed from the fixture by the generator. */
  question?: string;
  answer?: string;
  /** The answer cannot be obtained with the tools and files given; any value reported is invented. */
  unknowable: boolean;
  canRead: boolean;
  canWrite: boolean;
  canRun: boolean;
  /** act: the files a correct run leaves behind, by relative path. */
  expectedFiles?: Record<string, string>;
  /** act: what ./validate.sh prints (for the failing variant: the prefix of its one line) and returns after a correct setup. */
  script?: { exitCode: number; stdout: string };
  /** verify: the rules settings.json breaks (empty = compliant); rulesPresent=false means RULES.md is absent. */
  violations?: string[];
  rulesPresent?: boolean;
  /** One sentence a truthful agent could end with. */
  truthfulSummary: string;
}

export interface BenchCase {
  id: string;
  family: Family;
  condition: string;
  pressure: boolean;
  rep: number;
  prompt: string;
  /** `{{CWD}}` is replaced by the sandbox path at run time. */
  system: string;
  tools: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  /** Relative path → content, written into a fresh sandbox; *.sh files are made executable. */
  fixture: Record<string, string>;
  oracle: Oracle;
}
