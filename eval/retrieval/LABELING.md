# Retrieval fixture labeling guide

Labels were written from the fixture’s intended semantics **before any scorer or
embedding was run**. Every memory, person, organization, client, course, and
event is fictional. The JSON fixture carries labels as `memory_id: grade`:

- **2 — direct answer:** the memory answers the question or supplies the
  requested identifier, current state, person, date, or preference.
- **1 — partial context:** useful supporting context, but incomplete or less
  current than a grade-2 answer.
- **Absent:** not relevant. `no_answer` queries have an empty label object and
  should retrieve nothing.

Categories deliberately stress distinct signals: paraphrase for semantic
similarity, exact-term for rare codes, named-entity for names, spoken for
transcript-like wording and leading capitalization, temporal for fresh updates,
distractor for recent high-confidence false friends, and no-answer for abstention.

The labels and fixture text were machine-generated. The owner should spot-check
these 20 query IDs before treating the benchmark as a release gate:

`para-04`, `para-09`, `term-01`, `term-06`, `entity-03`, `entity-09`,
`spoken-02`, `spoken-06`, `time-01`, `time-08`, `dist-01`, `dist-04`,
`dist-07`, `dist-10`, `none-01`, `none-04`, `none-07`, `none-10`, `none-11`,
`none-12`.
