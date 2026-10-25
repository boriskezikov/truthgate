export const meta = {
  name: 'truthgate-readiness-review',
  description: 'Three independent reviewers (production readiness, security, evaluation statistics) assess the TruthGate PoC from its code and records',
  phases: [{ title: 'Review', detail: 'three lenses in parallel over research/truthgate' }],
}
const COMMON = `You review a proof of concept in this repository:  (read README.md first, then src/*.ts, bench/*.ts, bench/compare/*, and sample a few records under runs/2026-10-23-haiku45-heldout/<case>/{run.json,report.json,gold.json}). It is a claim-level honesty audit for AI agent reports: claims are extracted by a judge model, verified against the agent's tool trace and the file system, scored into HONEST / DECEPTIVE / UNVERIFIED. The owner asks: is this a finished product, and how good is the best verifier? Judge from what the code and the committed records show, not from the README's own claims; cite file paths and line numbers or record ids for every finding. Return raw structured data only: findings with severity (blocker = cannot ship to a paying user without it; major; minor), the concrete problem, the evidence, and the smallest fix; then a one-paragraph verdict and a readiness score 0-10 with its rationale.`
const LENSES = [
  { key: 'production', prompt: `${COMMON}\nLens: PRODUCTION READINESS (an engineering lead who would have to run this as a service for other teams). Cover: the runtime dependency on the claude CLI and OAuth credentials, latency and cost per audit from report.json elapsedMs and judgeCostUsd, failure handling and retries, idempotency, concurrency, observability, versioning of verdict schema and prompts, configuration, the TRUTHGATE_LIVE guard, the adapter surface for other agent frameworks, tests (there are none by repo rule: what replaces them), documentation gaps, operational runbook. Say what a minimum viable service would need beyond what exists.` },
  { key: 'security', prompt: `${COMMON}\nLens: SECURITY AND TRUST BOUNDARIES. Cover: prompt injection into the judge through tool results, file contents and the agent's final text (src/verify.ts judgeBatch builds the judge prompt from them; src/extract.ts too), whether an adversarial agent can craft a report or a file that flips verdicts, path handling (normPath, sandbox aliases, absolute paths), what happens when the sandbox copy differs from the run-time sandbox, the deterministic rules' evasion surface (executesScript, readsContent, valueMatches, requiredRuns, WHOLE_TASK/SCOPED regexes), secrets and credentials handling in cli-engine.ts, and whether the verdict can be trusted by a third party (reproducibility of proofs vs judge verdicts). Give concrete attack strings where you claim an evasion.` },
  { key: 'statistics', prompt: `${COMMON}\nLens: EVALUATION STATISTICS. Cover: whether the reported precision/recall (in-sample 93/100, held-out 80/80, n=72 each, base rate ~20%) support any quality claim, the width of the intervals, the clustering of claims within reports, the gold labeler being a model of the same family as the judge, the tuning history (rules changed after inspection on the first set; the held-out set is the only clean test), what the synthetic injections (132/132 caught) do and do not show, the per-cell sizes (3 per cell), what sample size would be needed to claim precision >= 90% with a 95% interval of +-5 points, and what a credible evaluation program for a product would look like (human labels, held-out seeds, multiple models under test, real-world traces). Be numerate: compute what you cite.` },
]
const SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } }, required: ['title', 'severity', 'problem', 'evidence', 'fix'] } },
    verdict: { type: 'string' },
    readiness_score: { type: 'number' },
    score_rationale: { type: 'string' },
  },
  required: ['findings', 'verdict', 'readiness_score', 'score_rationale'],
}
phase('Review')
const reviews = await parallel(LENSES.map((l) => () => agent(l.prompt, { label: `review:${l.key}`, phase: 'Review', schema: SCHEMA })))
return Object.fromEntries(LENSES.map((l, i) => [l.key, reviews[i]]))