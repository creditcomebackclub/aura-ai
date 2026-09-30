# Offline retrieval benchmark

## Question and setup

Does AURA’s production hybrid memory ranker beat vector-only recall? This deterministic, offline fixture contains 180 fictional memories and 84 fictional queries (35 dev / 49 test), with a fixed clock of 2026-09-01T12:00:00.000Z. All headline values are test-split estimates; CIs are 2,000-resample query bootstraps. Retrieval metrics exclude no-answer questions, which are measured separately.

## Headline test results

| config | R@1 | R@3 | R@4 | P@4 | MRR | nDCG@4 | No-answer acc. | Distractor FP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | 0.488 [0.345, 0.643] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.720 [0.631, 0.810] | 0.789 [0.720, 0.856] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| vector_only | 0.702 [0.560, 0.833] | 0.905 [0.810, 0.976] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.847 [0.762, 0.925] | 0.873 [0.808, 0.930] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| lexical_only | 0.571 [0.429, 0.714] | 0.738 [0.595, 0.857] | 0.786 [0.667, 0.905] | 0.214 [0.173, 0.250] | 0.679 [0.548, 0.798] | 0.702 [0.579, 0.818] | 0.857 [0.571, 1.000] | 0.286 [0.000, 0.571] |
| entity_only | 0.369 [0.238, 0.524] | 0.619 [0.476, 0.750] | 0.702 [0.560, 0.833] | 0.196 [0.155, 0.238] | 0.524 [0.405, 0.651] | 0.566 [0.445, 0.688] | 1.000 [1.000, 1.000] | 0.286 [0.000, 0.571] |
| vector_lexical | 0.655 [0.512, 0.786] | 0.905 [0.810, 0.976] | 0.976 [0.929, 1.000] | 0.268 [0.244, 0.298] | 0.817 [0.724, 0.899] | 0.845 [0.767, 0.911] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_recency | 0.488 [0.345, 0.643] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.720 [0.631, 0.810] | 0.789 [0.720, 0.856] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_confidence | 0.488 [0.345, 0.643] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.720 [0.631, 0.810] | 0.789 [0.720, 0.856] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_filter | 0.464 [0.321, 0.619] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.708 [0.619, 0.800] | 0.781 [0.713, 0.848] | 0.000 [0.000, 0.000] | 0.429 [0.143, 0.714] |

![Recall@4 and MRR](/eval/retrieval/results/recall_by_config.svg)

## Paired full vs vector-only

- MRR difference: -0.127 [-0.212, -0.050]
- nDCG@4 difference: -0.083 [-0.141, -0.029]

On this test fixture, full ranks worse than vector-only on both MRR and nDCG@4; both paired confidence intervals exclude zero.

## Full configuration by category

| category | R@1 | R@3 | R@4 | P@4 | MRR | nDCG@4 | No-answer acc. | Distractor FP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| distractor | 0.429 [0.143, 0.714] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.286 [0.250, 0.357] | 0.714 [0.571, 0.857] | 0.775 [0.640, 0.895] | — | 0.429 [0.143, 0.714] |
| exact_term | 0.714 [0.425, 1.000] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.821 [0.571, 1.000] | 0.866 [0.679, 1.000] | — | — |
| named_entity | 0.286 [0.000, 0.571] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.583 [0.393, 0.786] | 0.689 [0.546, 0.842] | — | — |
| no_answer | — | — | — | — | — | — | 0.714 [0.429, 1.000] | — |
| paraphrase | 0.714 [0.425, 1.000] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.286 [0.250, 0.357] | 0.833 [0.619, 1.000] | 0.875 [0.711, 1.000] | — | — |
| spoken | 0.429 [0.000, 0.857] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.655 [0.429, 0.893] | 0.742 [0.570, 0.919] | — | — |
| temporal | 0.357 [0.071, 0.714] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.321 [0.250, 0.393] | 0.714 [0.571, 0.929] | 0.790 [0.684, 0.947] | — | — |

## Threshold sweep

Production MemoryStore.search() uses vector threshold 0.35; isRelevantRetrieval() defaults to 0.32. The dev-only sweep chose 0.34 (tie-break: no-answer accuracy, then distance to 0.35).

| dev threshold | Recall@4 | No-answer accuracy |
| --- | --- | --- |
| 0.20 | 0.967 | 0.000 |
| 0.22 | 0.967 | 0.000 |
| 0.24 | 1.000 | 0.200 |
| 0.26 | 1.000 | 0.400 |
| 0.28 | 1.000 | 0.600 |
| 0.30 | 1.000 | 0.600 |
| 0.32 | 1.000 | 0.800 |
| 0.34 | 1.000 | 0.800 |
| 0.36 | 1.000 | 0.800 |
| 0.38 | 1.000 | 0.800 |
| 0.40 | 0.967 | 0.800 |
| 0.42 | 0.967 | 0.800 |
| 0.44 | 0.967 | 0.800 |
| 0.46 | 0.933 | 0.800 |
| 0.48 | 0.933 | 0.800 |
| 0.50 | 0.933 | 0.800 |

| Test evaluation | Recall@4 | No-answer accuracy |
| --- | --- | --- |
| Production 0.35 | 1.000 | 0.714 |
| Dev-selected 0.34 | 1.000 | 0.714 |

## What the ablations say

Vector-only MRR is 0.847 versus 0.720 for full; lexical-only (0.679) and entity-only (0.524) do not recover that gap. Removing recency changes full MRR to 0.720; removing confidence changes it to 0.720. These fixture-specific ablations are diagnostic evidence, not a production-change authorization.

## Limitations

This is synthetic data with machine-generated labels, a small sample, and a 200-row candidate cap that the 180-row corpus does not stress. Cached embeddings are rounded to six decimals. The fixture is a regression benchmark, not a representative sample of private owner memories or a proof of real-world retrieval quality.

## Recommendations — not implemented in this PR

Do not claim hybrid scoring beats vector-only from this fixture; collect owner-reviewed retrieval traces before changing production scoring.
