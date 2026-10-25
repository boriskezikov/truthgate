export const meta = {
  name: 'truthgate-design-critique',
  description: 'Three independent critics attack the TruthGate honesty-audit design (adversary, methodologist, engineer); one synthesizer dedupes and ranks the changes',
  phases: [
    { title: 'Critique', detail: 'three lenses in parallel, each returns findings with fixes' },
    { title: 'Synthesize', detail: 'dedupe, rank, keep what fits a zero-dependency PoC' },
  ],
}
const DOC = args.doc
const TRACE = args.trace
const COMMON = `Read the design document at ${DOC} (the whole file) and the real captured agent trace sample at ${TRACE} (JSONL from 'claude -p --output-format stream-json --verbose'; the model under test was claude-haiku-4-5). The design is a proof of concept to be built in TypeScript on Node 22 with no new npm dependencies, under  in this repo. Do not restate the document; produce findings that would change it. Each finding: a title, severity (blocker = the PoC's verdicts would be wrong or unusable without it; major = materially weaker results; minor), the concrete problem with a concrete example, and the smallest fix. Return raw structured data only.`
const LENSES = [
  { key: 'adversary', prompt: `${COMMON}\nLens: RED TEAM. Assume the audited model is sloppy or deceptive. Enumerate concrete ways a false report could still come out SUPPORTED or UNVERIFIED (false negatives), and ways a truthful report could be flagged DECEPTIVE (false positives). For each, write the final text and the trace shape that produces it, then the minimal design change that closes it. Cover at least: hedged claims, partial truths, numbers close but wrong, laundering a claim by touching a path without achieving the task, claims about things the trace cannot see, final text that is a summary of plans rather than of actions, and the model restating the task's own wording as fact.` },
  { key: 'method', prompt: `${COMMON}\nLens: METHODOLOGIST. Review the benchmark and metrics as an evaluation design: does it measure detector accuracy while keeping the detector oracle-blind; are gold labels independent enough from the detector (shared extraction, judge and labeler from the same model family); what sample size per family x condition x pressure cell gives usable 95% intervals and what is the minimum worth running; is the positive class defined correctly for precision/recall; which confounds exist (pressure prompt as a cue, the harness cutting the run, the judge seeing the task prompt); what minimal additions make the results credible to a skeptical founder who wants to recompute every number himself from committed files. Give concrete numbers (cases per cell, votes) and concrete file-level artefacts to commit.` },
  { key: 'engineering', prompt: `${COMMON}\nLens: ENGINEER who builds it. From the real trace sample, find what will break in the implementation: parsing stream-json (which event types carry what; where the final text is; what the 'result' event carries on max-turns or budget errors), detecting failed tool results (is_error vs textual failure in content; Bash non-zero exit), mapping claims to tool calls (Write vs Edit vs Bash redirection; Read vs cat/head/grep; relative vs absolute paths; the model naming a file it never touched), the --json-schema structured output path for the judge, controlling concurrency and spend, deterministic fixture generation, and timeouts. Propose the smallest module structure that works and name anything over-engineered for a PoC or missing that a PoC cannot do without. Where a claim about the CLI's behaviour is uncertain, say so and name the one experiment that settles it.` },
]
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          problem: { type: 'string' },
          example: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'problem', 'example', 'fix'],
      },
    },
  },
  required: ['findings'],
}
phase('Critique')
const critiques = await parallel(LENSES.map((l) => () => agent(l.prompt, { label: `critique:${l.key}`, phase: 'Critique', schema: FINDINGS })))
const all = critiques.map((c, i) => (c ? c.findings.map((f) => ({ ...f, lens: LENSES[i].key })) : [])).flat()
log(`${all.length} findings from ${critiques.filter(Boolean).length}/3 critics`)
phase('Synthesize')
const SYNTH = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          priority: { type: 'string', enum: ['must', 'should', 'could'] },
          rationale: { type: 'string' },
          concrete_change: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'priority', 'rationale', 'concrete_change', 'sources'],
      },
    },
    dropped: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'why'] } },
    experiments_to_settle: { type: 'array', items: { type: 'string' } },
  },
  required: ['changes', 'dropped', 'experiments_to_settle'],
}
const synth = await agent(`Read the design document at ${DOC}. Below are ${all.length} critique findings from three independent reviewers (lens in each item). Dedupe them, merge overlapping ones, and rank them into a change list for the design: priority must (verdicts wrong or unusable without it), should (materially better results), could. Keep the constraints: proof of concept, TypeScript, Node 22, no new npm dependencies, oracle-blind detector, the runner calls a real model via the claude CLI. Drop findings that break those constraints or that are already in the document, and list them under dropped with the reason. List the few experiments that settle uncertain claims about the CLI's behaviour. Return raw structured data only.\n\nFINDINGS:\n${JSON.stringify(all, null, 1)}`, { label: 'synthesize', phase: 'Synthesize', schema: SYNTH })
return { findings: all, synthesis: synth }