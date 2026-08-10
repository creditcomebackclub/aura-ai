'use strict';

const crypto = require('crypto');
const { containsSecret } = require('./memory_v2');

const STATE_KEY = 'memory_retrieval_traces_v1';
const MAX_TRACES = 200;

function safeTraceItem(memory = {}) {
  const content = String(memory.content || '').trim().slice(0, 1200);
  if (!content || containsSecret(content)) return null;
  const retrieval = memory.retrieval && typeof memory.retrieval === 'object'
    ? memory.retrieval
    : {};
  return {
    id: memory.id ?? null,
    profile_key: memory.profile_key || null,
    content,
    kind: String(memory.kind || 'fact').slice(0, 80),
    source: String(memory.source || 'unknown').slice(0, 120),
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : null,
    score: Number.isFinite(Number(memory.score)) ? Number(memory.score) : null,
    retrieval: {
      base_score: Number(retrieval.base_score) || 0,
      final_score: Number(retrieval.final_score) || Number(memory.score) || 0,
      vector_score: Number(retrieval.vector_score) || 0,
      lexical_score: Number(retrieval.lexical_score) || 0,
      entity_score: Number(retrieval.entity_score) || 0,
      recency_boost: Number(retrieval.recency_boost) || 0,
      confidence_boost: Number(retrieval.confidence_boost) || 0,
      age_days: Number.isFinite(Number(retrieval.age_days)) ? Number(retrieval.age_days) : null,
      matched_by: Array.isArray(retrieval.matched_by)
        ? retrieval.matched_by.map(value => String(value).slice(0, 40)).slice(0, 8)
        : []
    }
  };
}

class RetrievalTraceStore {
  constructor({ stateStore, stateKey = STATE_KEY } = {}) {
    if (!stateStore) throw new Error('stateStore is required.');
    this.stateStore = stateStore;
    this.stateKey = stateKey;
    this.mutationQueue = Promise.resolve();
  }

  async record({ query, related = [] } = {}) {
    const normalizedQuery = String(query || '').trim().slice(0, 500);
    if (!normalizedQuery || containsSecret(normalizedQuery)) return { recorded: false, reason: 'sensitive_or_empty_query' };
    const memories = (Array.isArray(related) ? related : [])
      .map(safeTraceItem)
      .filter(Boolean)
      .slice(0, 8);
    const trace = {
      id: crypto.randomUUID(),
      query: normalizedQuery,
      memories,
      created_at: new Date().toISOString()
    };
    const run = this.mutationQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await this.stateStore.getStateRow(this.stateKey);
        const current = row?.value && typeof row.value === 'object' ? row.value : {};
        const traces = Array.isArray(current.traces) ? [...current.traces, trace].slice(-MAX_TRACES) : [trace];
        const next = { version: 1, traces, updated_at: new Date().toISOString() };
        if (await this.stateStore.compareAndSetState(this.stateKey, row?.updated_at ?? null, next)) {
          return { recorded: true, trace };
        }
      }
      throw new Error('Could not record memory retrieval trace due to concurrent updates.');
    });
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  async list(limit = 50) {
    const bounded = Math.max(1, Math.min(MAX_TRACES, Number(limit) || 50));
    const state = await this.stateStore.getState(this.stateKey);
    const traces = Array.isArray(state?.traces) ? state.traces : [];
    return traces.slice(-bounded).reverse();
  }

  async summary() {
    const traces = await this.list(MAX_TRACES);
    const recalled = traces.flatMap(trace => trace.memories || []);
    const byKind = {};
    for (const memory of recalled) byKind[memory.kind] = (byKind[memory.kind] || 0) + 1;
    return {
      traces: traces.length,
      traces_with_recall: traces.filter(trace => trace.memories?.length).length,
      recalled_memories: recalled.length,
      recalled_by_kind: byKind
    };
  }
}

module.exports = {
  RetrievalTraceStore,
  STATE_KEY,
  MAX_TRACES,
  safeTraceItem
};
