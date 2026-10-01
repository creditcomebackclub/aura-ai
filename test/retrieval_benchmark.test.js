'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { isRelevantRetrieval, scoreMemoryRetrieval } = require('../retrieval_scoring');
const { textMatchScore } = require('../memory_v2');
const { LIMIT, NOW, cosine, loadFixture, measures, rankQuery, runBenchmark, scoreCandidate, validateCache } = require('../eval/retrieval/run');

test('retrieval benchmark metrics match hand-computed graded cases', () => {
  const labels = { a: 2, b: 1 };
  const metric = measures([{ id: 'b' }, { id: 'a' }, { id: 'x' }], labels);
  assert.equal(metric.recall_at_1, 0.5);
  assert.equal(metric.recall_at_3, 1);
  assert.equal(metric.recall_at_4, 1);
  assert.equal(metric.precision_at_4, 0.5);
  assert.equal(metric.mrr, 1);
  const expected = (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3));
  assert.ok(Math.abs(metric.ndcg_at_4 - expected) < 1e-12);
  assert.equal(measures([], {}).empty_correct, 1);
  assert.equal(measures([{ id: 'x' }], {}).empty_correct, 0);
});

test('full benchmark parity uses production score and relevance functions', () => {
  const { corpus, queries, cache } = loadFixture();
  for (const query of queries) for (const memory of corpus) {
    const actual = scoreCandidate(query, memory, cache, 'full');
    const expected = scoreMemoryRetrieval({
      query: query.query, content: memory.content, kind: memory.kind, confidence: memory.confidence,
      vectorScore: cosine(cache.queries[query.id].embedding, cache.corpus[memory.id].embedding),
      lexicalScore: textMatchScore(query.query, memory.content),
      createdAt: memory.created_at, updatedAt: memory.updated_at, now: NOW
    });
    assert.deepEqual(actual, expected, `${query.id}/${memory.id}`);
    assert.equal(isRelevantRetrieval(actual, { threshold: 0.35, lexicalThreshold: 0.34 }), isRelevantRetrieval(expected, { threshold: 0.35, lexicalThreshold: 0.34 }));
  }
  assert.equal(rankQuery(queries[0], corpus, cache).length <= LIMIT, true);
});

test('retrieval fixture has complete synthetic labels and no obvious real PII', () => {
  const { corpus, queries } = loadFixture();
  assert.equal(new Set(corpus.map(item => item.id)).size, corpus.length);
  assert.equal(new Set(queries.map(item => item.id)).size, queries.length);
  const ids = new Set(corpus.map(item => item.id));
  const pii = /\b\d{3}[-. ]?\d{2}[-. ]?\d{4}\b|\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b|@[a-z0-9.-]+\.(com|net|org|edu)\b/i;
  for (const item of corpus) assert.equal(pii.test(item.content), false, item.id);
  for (const query of queries) {
    if (query.category === 'no_answer') assert.deepEqual(query.relevant, {});
    for (const id of Object.keys(query.relevant)) assert.equal(ids.has(id), true, `${query.id}/${id}`);
  }
  for (const category of new Set(queries.map(query => query.category))) assert.ok(queries.filter(query => query.category === category).length >= 8, category);
});

test('embedding cache staleness errors name the regeneration command', () => {
  const { cache, corpus, queries } = loadFixture();
  const changed = structuredClone(cache);
  changed.corpus[corpus[0].id].content_hash = 'stale';
  assert.throws(() => validateCache(corpus, queries, changed), /Re-run npm run bench:retrieval:embed/);
});

test('offline benchmark output is deterministic', () => {
  const first = runBenchmark();
  const output = path.join(__dirname, '../eval/retrieval/results/latest.json');
  const once = fs.readFileSync(output, 'utf8');
  const second = runBenchmark();
  const twice = fs.readFileSync(output, 'utf8');
  assert.deepEqual(first, second);
  assert.equal(once, twice);
});
