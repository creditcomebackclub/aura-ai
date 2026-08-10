'use strict';

const STOP_WORDS = new Set([
  'a', 'about', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'did', 'do', 'for',
  'from', 'have', 'how', 'i', 'in', 'is', 'it', 'know', 'me', 'memory', 'my',
  'of', 'on', 'or', 'remember', 'said', 'tell', 'that', 'the', 'their', 'them',
  'this', 'to', 'us', 'was', 'we', 'what', 'when', 'where', 'who', 'with', 'you'
]);

const ENTITY_STOP_WORDS = new Set([
  ...STOP_WORDS,
  'account', 'assistant', 'business', 'calendar', 'client', 'clients', 'conversation',
  'email', 'meeting', 'preference', 'preferences', 'profile', 'report', 'status',
  'task', 'today', 'tomorrow', 'workflow'
]);

function tokenize(value) {
  return [...new Set((String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(token => !STOP_WORDS.has(token)))];
}

function entityMatchScore(query, candidate) {
  const named = (String(query || '').match(/\b[A-Z][a-z0-9]{2,}\b/g) || [])
    .map(value => value.toLowerCase())
    .filter(token => !ENTITY_STOP_WORDS.has(token));
  const entities = (named.length ? named : tokenize(query))
    .filter(token => token.length >= 4 && !ENTITY_STOP_WORDS.has(token));
  if (!entities.length) return 0;
  const candidateTokens = new Set(tokenize(candidate));
  const matches = entities.filter(token => candidateTokens.has(token)).length;
  if (!matches) return 0;
  // A direct match on one named entity is meaningful even when the rest of the
  // question contains verbs that do not appear in the stored memory.
  return Math.min(1, matches / Math.min(2, entities.length));
}

function ageDays(value, now = Date.now()) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now - timestamp) / 86400000);
}

function recencyBoost(value, now = Date.now(), halfLifeDays = 90) {
  const age = ageDays(value, now);
  if (age == null) return { age_days: null, boost: 0 };
  return {
    age_days: Number(age.toFixed(2)),
    boost: Number((0.05 * Math.exp(-age / Math.max(1, halfLifeDays))).toFixed(4))
  };
}

function scoreMemoryRetrieval({
  query,
  content,
  kind = 'fact',
  confidence = 0.8,
  vectorScore = 0,
  lexicalScore = 0,
  updatedAt = null,
  createdAt = null,
  now = Date.now()
} = {}) {
  const entityScore = entityMatchScore(query, content);
  const vector = Math.max(0, Math.min(1, Number(vectorScore) || 0));
  const lexical = Math.max(0, Math.min(1, Number(lexicalScore) || 0));
  const entity = Math.max(0, Math.min(1, Number(entityScore) || 0));
  const baseScore = Math.max(vector, lexical * 0.95, entity * 0.85);
  const recency = recencyBoost(updatedAt || createdAt, now);
  // Confidence is an importance proxy: it can refine a relevant result but
  // never turn an unrelated memory into a hit because filtering uses baseScore.
  const confidenceBoost = Number((0.04 * Math.max(0, Math.min(1, Number(confidence) || 0))).toFixed(4));
  const score = Math.min(1, baseScore + recency.boost + confidenceBoost);
  const matchedBy = [];
  if (vector > 0) matchedBy.push('semantic');
  if (lexical > 0) matchedBy.push('lexical');
  if (entity > 0) matchedBy.push('entity');
  if (kind === 'episode') matchedBy.push('episodic');
  if (kind === 'belief') matchedBy.push('belief');
  return {
    base_score: Number(baseScore.toFixed(4)),
    final_score: Number(score.toFixed(4)),
    vector_score: Number(vector.toFixed(4)),
    lexical_score: Number(lexical.toFixed(4)),
    entity_score: Number(entity.toFixed(4)),
    recency_boost: recency.boost,
    confidence_boost: confidenceBoost,
    age_days: recency.age_days,
    matched_by: matchedBy
  };
}

function isRelevantRetrieval(trace, { threshold = 0.32, lexicalThreshold = 0.34 } = {}) {
  return trace.vector_score >= threshold ||
    trace.lexical_score >= lexicalThreshold ||
    trace.entity_score >= 0.6;
}

module.exports = {
  ageDays,
  entityMatchScore,
  isRelevantRetrieval,
  recencyBoost,
  scoreMemoryRetrieval,
  tokenize
};
