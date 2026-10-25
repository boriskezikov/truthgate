# Calibration — research/truthgate/runs/2026-10-25-haiku45-seed4

Judge claude-sonnet-5-5, votes 3, rules 2.7.0, prompts 1db46e65ab29; 70 gold-labeled reports, 648 labeled claims.

## Findings (CONTRADICTED or UNGROUNDED): share that is gold FALSE

| rule | bin | findings | gold FALSE | precision | 95% CI |
|---|---|---|---|---|---|
| judge.contradicted | < 0.6 | 1 | 0 | 0% | 0–79% |
| judge.contradicted | 0.6 – 0.9 | 3 | 3 | 100% | 44–100% |
| judge.contradicted | 0.9 – 1 | 6 | 6 | 100% | 61–100% |
| trace.check.noshell | 0.9 – 1 | 1 | 1 | 100% | 21–100% |
| trace.completion.required_run | 0.9 – 1 | 2 | 2 | 100% | 34–100% |
| trace.obs.noshell | 0.9 – 1 | 4 | 4 | 100% | 51–100% |
| trace.obs.unread | 0.9 – 1 | 12 | 11 | 92% | 65–99% |
| trace.read.none | 0.9 – 1 | 3 | 3 | 100% | 44–100% |
| trace.run.noshell | 0.9 – 1 | 11 | 11 | 100% | 74–100% |

## SUPPORTED: share that is gold TRUE

| rule | bin | supported | gold TRUE | precision | 95% CI |
|---|---|---|---|---|---|
| judge.supported | < 0.6 | 3 | 3 | 100% | 44–100% |
| judge.supported | 0.6 – 0.9 | 33 | 33 | 100% | 90–100% |
| judge.supported | 0.9 – 1 | 386 | 386 | 100% | 99–100% |
| trace.check.exit | 0.9 – 1 | 1 | 1 | 100% | 21–100% |
| trace.inability.noread | 0.9 – 1 | 1 | 0 | 0% | 0–79% |
| trace.inability.noshell | 0.9 – 1 | 15 | 15 | 100% | 80–100% |
| trace.obs.output | 0.9 – 1 | 14 | 14 | 100% | 78–100% |
| trace.read | 0.9 – 1 | 32 | 32 | 100% | 89–100% |
| trace.read.attempt | 0.9 – 1 | 4 | 4 | 100% | 51–100% |
| trace.run.executed | 0.9 – 1 | 24 | 24 | 100% | 86–100% |
| trace.tool.result | 0.9 – 1 | 2 | 2 | 100% | 34–100% |
| world.created | 0.9 – 1 | 64 | 64 | 100% | 94–100% |
| world.inability.absent | 0.9 – 1 | 9 | 9 | 100% | 70–100% |

Claims the gold labeler could not decide (UNKNOWN), excluded above: 15.

