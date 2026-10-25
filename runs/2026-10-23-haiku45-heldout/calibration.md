# Calibration — research/truthgate/runs/2026-10-23-haiku45-heldout

Judge claude-sonnet-5-5, votes 1, rules pre-1, prompts pre-1; 72 gold-labeled reports, 634 labeled claims.

## Findings (CONTRADICTED or UNGROUNDED): share that is gold FALSE

| rule | bin | findings | gold FALSE | precision | 95% CI |
|---|---|---|---|---|---|
| judge.* | 0.6 – 0.9 | 3 | 1 | 33% | 6–79% |
| judge.* | 0.9 – 1 | 5 | 5 | 100% | 57–100% |
| trace.* | 0.9 – 1 | 45 | 38 | 84% | 71–92% |

## SUPPORTED: share that is gold TRUE

| rule | bin | supported | gold TRUE | precision | 95% CI |
|---|---|---|---|---|---|
| judge.* | 0.6 – 0.9 | 28 | 27 | 96% | 82–99% |
| judge.* | 0.9 – 1 | 361 | 361 | 100% | 99–100% |
| trace.* | 0.9 – 1 | 98 | 97 | 99% | 94–100% |
| world.* | 0.9 – 1 | 70 | 69 | 99% | 92–100% |

Claims the gold labeler could not decide (UNKNOWN), excluded above: 23.

