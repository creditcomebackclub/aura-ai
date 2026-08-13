'use strict';

// Connects an inbound signal (email, new calendar attendee) to the owner's open
// goals.
//
// Two tiers, cheapest first:
//
//   1. Deterministic — canonical entity intersection. A sender domain of
//      identityiq.com and a goal reading "setup partnership with identity iq"
//      both canonicalize to `identityiq`, so the link needs no model at all.
//   2. Semantic — cosine similarity between cached goal embeddings and the
//      signal embedding, blended with lexical and named-entity overlap through
//      the same scorer used for memory retrieval (retrieval_scoring.js), so the
//      score breakdown is inspectable in exactly the same shape.
//
// The orchestrator only pays for a signal embedding when tier 1 comes up empty,
// which keeps the common case free.

const {
  extractGoalEntities,
  extractSignalEntities,
  signalText
} = require('./entity_extraction');
const { scoreMemoryRetrieval, tokenize } = require('./retrieval_scoring');

const DEFAULT_MIN_CONFIDENCE = 0.55;
// Above this a deterministic hit is trusted outright and no embedding is bought.
const DETERMINISTIC_SHORTCUT_CONFIDENCE = 0.8;
const MAX_MATCHES = 3;
const MAX_EVIDENCE = 4;

// How much a canonical collision is worth, by the entity types on each side.
// Key is `signalType:goalType`. A sending domain matching text the owner wrote
// into the goal is the motivating case and scores near the top.
const ENTITY_PAIR_WEIGHTS = {
  'domain:domain': 0.96,
  'domain:organization': 0.94,
  'organization:domain': 0.94,
  'organization:organization': 0.94,
  'domain:phrase': 0.88,
  'phrase:domain': 0.88,
  'organization:phrase': 0.86,
  'phrase:organization': 0.86,
  'person:person': 0.82,
  'person:phrase': 0.8,
  'phrase:person': 0.8,
  'person:domain': 0.7,
  'domain:person': 0.7,
  'phrase:phrase': 0.62
};

function wordCount(value) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

// A long, multi-word collision is far better evidence than a short single
// token, so the pair weight is discounted for thin matches.
function specificityFactor(entity) {
  const canonicalLength = String(entity?.canonical || '').length;
  const lengthFactor = canonicalLength >= 9 ? 1 : canonicalLength >= 7 ? 0.94 : canonicalLength >= 5 ? 0.86 : 0.78;
  const multiWord = wordCount(entity?.value) > 1 ? 1 : 0.92;
  return lengthFactor * multiWord;
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  const score = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

// Recall-oriented on purpose: what fraction of the (short) goal shows up in the
// (longer) signal. Dividing by the signal length would punish long emails.
function lexicalOverlap(goalTextValue, signalTextValue) {
  const goalTokens = tokenize(goalTextValue);
  if (!goalTokens.length) return 0;
  const signalTokens = new Set(tokenize(signalTextValue));
  if (!signalTokens.size) return 0;
  const hits = goalTokens.filter(token => signalTokens.has(token)).length;
  return Math.max(0, Math.min(1, hits / goalTokens.length));
}

function deterministicMatch(signalEntities, goalEntities) {
  const byCanonical = new Map();
  for (const goalEntity of goalEntities) {
    if (!byCanonical.has(goalEntity.canonical)) byCanonical.set(goalEntity.canonical, goalEntity);
  }
  const evidence = [];
  for (const signalEntity of signalEntities) {
    const goalEntity = byCanonical.get(signalEntity.canonical);
    if (!goalEntity) continue;
    const pairKey = `${signalEntity.type}:${goalEntity.type}`;
    const base = ENTITY_PAIR_WEIGHTS[pairKey] ?? ENTITY_PAIR_WEIGHTS['phrase:phrase'];
    const weight = Number((base * specificityFactor(signalEntity)).toFixed(4));
    evidence.push({
      canonical: signalEntity.canonical,
      signal_value: signalEntity.value,
      signal_type: signalEntity.type,
      signal_source: signalEntity.source,
      goal_value: goalEntity.value,
      goal_type: goalEntity.type,
      goal_source: goalEntity.source,
      weight
    });
  }
  evidence.sort((left, right) => right.weight - left.weight);
  return {
    score: evidence.length ? evidence[0].weight : 0,
    evidence: evidence.slice(0, MAX_EVIDENCE)
  };
}

// Scores one goal against one signal. Pure and synchronous — `signalEmbedding`
// is supplied by the caller so the matcher never performs I/O.
function scoreGoalAgainstSignal(goalEntry, signal, {
  signalEmbedding = null,
  signalTextValue = null,
  now = Date.now()
} = {}) {
  const text = signalTextValue ?? signalText(signal);
  const goalEntities = Array.isArray(goalEntry?.entities) && goalEntry.entities.length
    ? goalEntry.entities
    : extractGoalEntities({ description: goalEntry?.text || '' });
  const signalEntities = Array.isArray(signal?.entities) && signal.entities.length
    ? signal.entities
    : extractSignalEntities(signal);

  const deterministic = deterministicMatch(signalEntities, goalEntities);
  const vector = cosineSimilarity(signalEmbedding, goalEntry?.embedding);
  const lexical = lexicalOverlap(goalEntry?.text, text);

  // Same scorer the memory pipeline uses, so `scores` reads identically to a
  // retrieval trace and the two systems stay comparable.
  const retrieval = scoreMemoryRetrieval({
    query: text,
    content: goalEntry?.text || '',
    kind: 'goal',
    confidence: 0.8,
    vectorScore: vector,
    lexicalScore: lexical,
    createdAt: goalEntry?.indexed_at || null,
    now
  });

  const semantic = retrieval.base_score;
  let confidence = Math.max(deterministic.score, semantic);
  // Independent tiers agreeing is worth a little more than either alone.
  if (deterministic.score > 0 && semantic >= 0.4) confidence = Math.min(1, confidence + 0.04);

  const matchedBy = [];
  for (const item of deterministic.evidence) {
    const label = item.signal_type === 'domain' ? 'domain' : item.signal_type;
    if (!matchedBy.includes(label)) matchedBy.push(label);
  }
  if (vector > 0) matchedBy.push('semantic');
  if (lexical > 0) matchedBy.push('lexical');
  if (retrieval.entity_score > 0 && !matchedBy.length) matchedBy.push('entity');

  return {
    goal_id: goalEntry?.goal_id || null,
    goal_text: goalEntry?.text || '',
    due_at: goalEntry?.due_at || null,
    confidence: Number(confidence.toFixed(4)),
    tier: deterministic.score >= semantic ? 'deterministic' : 'semantic',
    matched_by: matchedBy,
    evidence: deterministic.evidence,
    scores: {
      deterministic: Number(deterministic.score.toFixed(4)),
      semantic: Number(semantic.toFixed(4)),
      vector_score: retrieval.vector_score,
      lexical_score: retrieval.lexical_score,
      entity_score: retrieval.entity_score,
      final_score: Number(confidence.toFixed(4))
    }
  };
}

// Ranks every indexed goal against one signal. Pure; see resolveSignalMatches
// for the version that buys an embedding when it needs one.
function matchSignalToGoals(signal, goalEntries = [], {
  signalEmbedding = null,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  limit = MAX_MATCHES,
  now = Date.now()
} = {}) {
  const text = signalText(signal);
  const signalEntities = extractSignalEntities(signal);
  const enrichedSignal = { ...signal, entities: signalEntities };
  return (Array.isArray(goalEntries) ? goalEntries : [])
    .map(entry => scoreGoalAgainstSignal(entry, enrichedSignal, {
      signalEmbedding,
      signalTextValue: text,
      now
    }))
    .filter(match => match.confidence >= minConfidence)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, Math.max(1, limit));
}

// Deterministic first; only reach for an embedding when the cheap tier misses.
async function resolveSignalMatches({
  signal,
  goalEntries = [],
  embed = null,
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  limit = MAX_MATCHES,
  now = Date.now(),
  logger = console
} = {}) {
  const entries = Array.isArray(goalEntries) ? goalEntries : [];
  if (!entries.length) return { matches: [], embedded: false, errors: [] };

  const deterministicMatches = matchSignalToGoals(signal, entries, { minConfidence, limit, now });
  if (deterministicMatches.some(match => match.confidence >= DETERMINISTIC_SHORTCUT_CONFIDENCE)) {
    return { matches: deterministicMatches, embedded: false, errors: [] };
  }

  const embeddable = entries.some(entry => Array.isArray(entry.embedding) && entry.embedding.length);
  if (typeof embed !== 'function' || !embeddable) {
    return { matches: deterministicMatches, embedded: false, errors: [] };
  }

  let signalEmbedding = null;
  const errors = [];
  try {
    signalEmbedding = await embed(signalText(signal));
  } catch (error) {
    const message = error?.message || String(error);
    errors.push(`embed:${message}`);
    logger.warn?.('[Goal match] Signal embedding failed:', message);
    return { matches: deterministicMatches, embedded: false, errors };
  }

  return {
    matches: matchSignalToGoals(signal, entries, { signalEmbedding, minConfidence, limit, now }),
    embedded: true,
    errors
  };
}

module.exports = {
  DEFAULT_MIN_CONFIDENCE,
  DETERMINISTIC_SHORTCUT_CONFIDENCE,
  ENTITY_PAIR_WEIGHTS,
  MAX_EVIDENCE,
  MAX_MATCHES,
  cosineSimilarity,
  deterministicMatch,
  lexicalOverlap,
  matchSignalToGoals,
  resolveSignalMatches,
  scoreGoalAgainstSignal,
  specificityFactor
};
