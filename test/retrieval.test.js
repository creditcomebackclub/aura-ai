'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  entityMatchScore,
  isRelevantRetrieval,
  scoreMemoryRetrieval
} = require('../retrieval_scoring');
const { RetrievalTraceStore } = require('../retrieval_trace_store');

function createStateStore() {
  const rows = new Map();
  let revision = 0;
  return {
    async getState(key) { return rows.get(key)?.value ?? null; },
    async getStateRow(key) { return rows.get(key) || null; },
    async compareAndSetState(key, expectedUpdatedAt, value) {
      const current = rows.get(key) || null;
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
      rows.set(key, { value, updated_at: String(++revision) });
      return true;
    }
  };
}

test('retrieval score boosts recent confident matches without admitting unrelated memories', () => {
  const now = Date.parse('2026-08-10T00:00:00.000Z');
  const recent = scoreMemoryRetrieval({
    query: 'What is the client status?',
    content: 'Client status must be verified before reporting.',
    confidence: 0.9,
    lexicalScore: 0.5,
    updatedAt: '2026-08-09T00:00:00.000Z',
    now
  });
  const old = scoreMemoryRetrieval({
    query: 'What is the client status?',
    content: 'Client status must be verified before reporting.',
    confidence: 0.4,
    lexicalScore: 0.5,
    updatedAt: '2025-01-01T00:00:00.000Z',
    now
  });
  assert.ok(recent.final_score > old.final_score);
  assert.equal(isRelevantRetrieval(recent, { lexicalThreshold: 0.34 }), true);
  const unrelated = scoreMemoryRetrieval({
    query: 'What is the client status?',
    content: 'Chris likes coffee.',
    confidence: 1,
    updatedAt: '2026-08-10T00:00:00.000Z',
    now
  });
  assert.equal(isRelevantRetrieval(unrelated), false);
});

test('entity-aware scoring recalls named context when lexical overlap is sparse', () => {
  assert.equal(entityMatchScore('What did Sarah decide?', 'Sarah is the owner\'s vendor contact.'), 1);
  const trace = scoreMemoryRetrieval({
    query: 'What did Sarah decide?',
    content: 'Sarah is the owner\'s vendor contact.',
    kind: 'relationship',
    confidence: 0.8,
    lexicalScore: 0.25
  });
  assert.equal(trace.matched_by.includes('entity'), true);
  assert.equal(isRelevantRetrieval(trace), true);
});

test('retrieval traces retain explainable private recall and omit secrets', async () => {
  const store = new RetrievalTraceStore({ stateStore: createStateStore() });
  const saved = await store.record({
    query: 'What did Sarah decide?',
    related: [{
      id: 'memory-1',
      content: 'Sarah chose the concise morning brief.',
      kind: 'episode',
      source: 'learning_review',
      confidence: 0.9,
      score: 0.87,
      retrieval: {
        final_score: 0.87,
        entity_score: 1,
        age_days: 2,
        matched_by: ['entity', 'episodic']
      }
    }]
  });
  assert.equal(saved.recorded, true);
  assert.equal((await store.list())[0].memories[0].retrieval.entity_score, 1);
  const rejected = await store.record({
    query: 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456.',
    related: []
  });
  assert.equal(rejected.recorded, false);
  assert.equal((await store.summary()).recalled_by_kind.episode, 1);
});
