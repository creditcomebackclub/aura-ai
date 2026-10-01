# Offline retrieval benchmark

## Question and setup

Does AURA’s production hybrid memory ranker beat vector-only recall? This deterministic, offline fixture contains 180 fictional memories and 84 fictional queries (35 dev / 49 test), with a fixed clock of 2026-09-01T12:00:00.000Z. All headline values are test-split estimates; CIs are 2,000-resample query bootstraps. Retrieval metrics exclude no-answer questions, which are measured separately.

## Headline test results

| config | R@1 | R@3 | R@4 | P@4 | MRR | nDCG@4 | No-answer acc. | Distractor FP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| full | 0.512 [0.369, 0.667] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.736 [0.649, 0.827] | 0.801 [0.736, 0.870] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| vector_only | 0.702 [0.560, 0.833] | 0.905 [0.810, 0.976] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.847 [0.762, 0.925] | 0.873 [0.808, 0.930] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| lexical_only | 0.571 [0.429, 0.714] | 0.738 [0.595, 0.857] | 0.786 [0.667, 0.905] | 0.214 [0.173, 0.250] | 0.679 [0.548, 0.798] | 0.702 [0.579, 0.818] | 0.857 [0.571, 1.000] | 0.286 [0.000, 0.571] |
| entity_only | 0.417 [0.274, 0.571] | 0.690 [0.560, 0.821] | 0.798 [0.679, 0.905] | 0.220 [0.185, 0.256] | 0.593 [0.478, 0.710] | 0.642 [0.530, 0.748] | 1.000 [1.000, 1.000] | 0.286 [0.000, 0.571] |
| vector_lexical | 0.655 [0.512, 0.786] | 0.905 [0.810, 0.976] | 0.976 [0.929, 1.000] | 0.268 [0.244, 0.298] | 0.817 [0.724, 0.899] | 0.845 [0.767, 0.911] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_recency | 0.512 [0.357, 0.667] | 0.869 [0.762, 0.952] | 0.976 [0.929, 1.000] | 0.268 [0.244, 0.298] | 0.724 [0.631, 0.817] | 0.786 [0.708, 0.860] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_confidence | 0.488 [0.345, 0.655] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.720 [0.631, 0.812] | 0.789 [0.722, 0.859] | 0.714 [0.429, 1.000] | 0.429 [0.143, 0.714] |
| full_no_filter | 0.488 [0.345, 0.643] | 0.893 [0.798, 0.964] | 1.000 [1.000, 1.000] | 0.274 [0.256, 0.298] | 0.724 [0.637, 0.815] | 0.793 [0.728, 0.861] | 0.000 [0.000, 0.000] | 0.429 [0.143, 0.714] |

![Recall@4 and MRR](/eval/retrieval/results/recall_by_config.svg)

## Paired full vs vector-only

- MRR difference: -0.111 [-0.190, -0.040]
- nDCG@4 difference: -0.071 [-0.126, -0.021]

On this test fixture, full ranks worse than vector-only on both MRR and nDCG@4; both paired confidence intervals exclude zero.

## Why hybrid loses

On 16 labeled test queries, full and vector-only put a different memory first. Full was better on 1, vector-only on 10, and 5 were ties. Every one of the 16 disagreements was decided by the entity signal.

The mechanism is a scale mismatch inside `max(vector, lexical × 0.95, entity × 0.85)`. `entityMatchScore` saturates at 1.0 on a single shared name, so any memory mentioning the same person or organization scores **0.85**. Cosine similarity from `text-embedding-3-small` lives lower: relevant query–memory pairs in this fixture have a median of **0.570**, a 90th percentile of 0.679, and a maximum of 0.768. A memory that merely names the right entity therefore outranks the memory that actually answers the question. The scores are combined as if they shared a scale; they don't.

| query | category | better | full winner decided by | vector | lexical×0.95 | entity×0.85 | vector-only top-1 cosine |
| --- | --- | --- | --- | --- | --- | --- | --- |
| para-09 | paraphrase | tie | entity | 0.514 | 0.190 | 0.850 | 0.555 |
| term-07 | exact_term | vector_only | entity | 0.461 | 0.633 | 0.850 | 0.648 |
| entity-06 | named_entity | vector_only | entity | 0.334 | 0.380 | 0.850 | 0.768 |
| entity-09 | named_entity | tie | entity | 0.454 | 0.475 | 0.850 | 0.520 |
| entity-10 | named_entity | vector_only | entity | 0.473 | 0.475 | 0.850 | 0.520 |
| entity-11 | named_entity | vector_only | entity | 0.491 | 0.713 | 0.850 | 0.569 |
| entity-12 | named_entity | vector_only | entity | 0.477 | 0.570 | 0.850 | 0.665 |
| spoken-11 | spoken | vector_only | entity | 0.397 | 0.317 | 0.425 | 0.438 |
| time-06 | temporal | full | entity | 0.396 | 0.237 | 0.425 | 0.422 |
| time-07 | temporal | tie | entity | 0.290 | 0.158 | 0.850 | 0.494 |
| time-09 | temporal | vector_only | entity | 0.604 | 0.317 | 0.850 | 0.682 |
| time-10 | temporal | tie | entity | 0.370 | 0.190 | 0.850 | 0.496 |
| time-12 | temporal | tie | entity | 0.448 | 0.190 | 0.850 | 0.512 |
| dist-06 | distractor | vector_only | entity | 0.545 | 0.475 | 0.850 | 0.580 |
| dist-07 | distractor | vector_only | entity | 0.412 | 0.317 | 0.850 | 0.661 |
| dist-10 | distractor | vector_only | entity | 0.469 | 0.237 | 0.850 | 0.643 |

## Full configuration by category

| category | R@1 | R@3 | R@4 | P@4 | MRR | nDCG@4 | No-answer acc. | Distractor FP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| distractor | 0.429 [0.143, 0.714] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.286 [0.250, 0.357] | 0.714 [0.571, 0.857] | 0.775 [0.640, 0.895] | — | 0.429 [0.143, 0.714] |
| exact_term | 0.714 [0.425, 1.000] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.821 [0.571, 1.000] | 0.866 [0.679, 1.000] | — | — |
| named_entity | 0.286 [0.000, 0.571] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.583 [0.393, 0.786] | 0.689 [0.546, 0.842] | — | — |
| no_answer | — | — | — | — | — | — | 0.714 [0.429, 1.000] | — |
| paraphrase | 0.714 [0.425, 1.000] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.286 [0.250, 0.357] | 0.833 [0.619, 1.000] | 0.875 [0.711, 1.000] | — | — |
| spoken | 0.571 [0.143, 0.861] | 0.857 [0.571, 1.000] | 1.000 [1.000, 1.000] | 0.250 [0.250, 0.250] | 0.750 [0.500, 0.930] | 0.813 [0.626, 0.949] | — | — |
| temporal | 0.357 [0.071, 0.714] | 0.929 [0.786, 1.000] | 1.000 [1.000, 1.000] | 0.321 [0.250, 0.393] | 0.714 [0.571, 0.929] | 0.790 [0.684, 0.947] | — | — |

## Threshold sweep

Production MemoryStore.search() uses vector threshold 0.35; isRelevantRetrieval() defaults to 0.32. The dev-only sweep chose 0.32 (tie-break: no-answer accuracy, then distance to 0.35).

| dev threshold | Recall@4 | No-answer accuracy |
| --- | --- | --- |
| 0.20 | 0.967 | 0.000 |
| 0.22 | 0.967 | 0.000 |
| 0.24 | 1.000 | 0.200 |
| 0.26 | 1.000 | 0.400 |
| 0.28 | 1.000 | 0.600 |
| 0.30 | 1.000 | 0.600 |
| 0.32 | 1.000 | 0.800 |
| 0.34 | 0.967 | 0.800 |
| 0.36 | 0.967 | 0.800 |
| 0.38 | 0.967 | 0.800 |
| 0.40 | 0.933 | 0.800 |
| 0.42 | 0.917 | 0.800 |
| 0.44 | 0.917 | 0.800 |
| 0.46 | 0.883 | 0.800 |
| 0.48 | 0.883 | 0.800 |
| 0.50 | 0.850 | 0.800 |

| Test evaluation | Recall@4 | No-answer accuracy |
| --- | --- | --- |
| Production 0.35 | 1.000 | 0.714 |
| Dev-selected 0.32 | 1.000 | 0.714 |

## What the ablations say

Vector-only MRR is 0.847 versus 0.736 for full; lexical-only (0.679) and entity-only (0.593) do not recover that gap. Removing recency changes full MRR to 0.724; removing confidence changes it to 0.720. These fixture-specific ablations are diagnostic evidence, not a production-change authorization.

## Limitations

This is synthetic data with machine-generated labels, a small sample, and a 200-row candidate cap that the 180-row corpus does not stress. Recall@4 is saturated (1.000) for most configurations, so this fixture discriminates on ordering (R@1, MRR, nDCG) rather than on recall; harder queries with more relevant memories per query would be needed to test recall. Cached embeddings are rounded to six decimals. The fixture is a regression benchmark, not a representative sample of private owner memories or a proof of real-world retrieval quality.

## Recommendations — not implemented in this PR

Do not claim hybrid scoring beats vector-only from this fixture. The diagnosis points at entity saturation, so candidate fixes to evaluate (on this benchmark first, then on owner-reviewed retrieval traces) are: cap or rescale the entity contribution below typical relevant cosines, use entity overlap as a tie-breaker rather than a competitor inside max(), or learn combination weights on the dev split. None is implemented here.
