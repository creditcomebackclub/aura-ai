'use strict';

const { containsSecret, textMatchScore } = require('./memory_v2');

const STATE_KEY = 'memory_beliefs_v1';
const MAX_BELIEFS = 100;
const MIN_SUPPORTING_EPISODES = 2;
const MIN_CONFIDENCE = 0.75;

const UNSAFE_BELIEF_PATTERNS = [
  /ignore (?:all |any )?(?:previous|system|developer) instructions/i,
  /bypass (?:security|approval|authentication|policy)/i,
  /(?:authorization|permission|approval) (?:is |was )?(?:granted|not required|unnecessary)/i,
  /(?:send|delete|purchase|pay|publish|execute).{0,80}without (?:asking|approval|confirmation)/i,
  /(?:system prompt|developer message|tool policy) (?:says|allows|requires)/i
];

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function normalizeStatement(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 800);
}

function sameStatement(left, right) {
  return normalizeStatement(left).toLowerCase() === normalizeStatement(right).toLowerCase();
}

function unsafeBelief(statement) {
  return containsSecret(statement) || UNSAFE_BELIEF_PATTERNS.some(pattern => pattern.test(statement));
}

function normalizeEpisodeIds(values, episodeIds) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(value => value && episodeIds.has(value))
  )].slice(0, 12);
}

function renderBeliefContext(beliefs = []) {
  return beliefs.map(belief => {
    const support = (belief.support_episode_ids || []).join(', ') || 'none';
    if (belief.status === 'contested') {
      const alternatives = (belief.contradictions || [])
        .map(item => `"${item.statement}" (evidence: ${(item.episode_ids || []).join(', ') || 'none'})`)
        .join('; ');
      return `- [CONTESTED — do not rely on this until the owner clarifies] ${belief.key}: "${belief.statement}"; conflicting alternative(s): ${alternatives || 'unspecified'}; original evidence: ${support}`;
    }
    return `- [active, confidence ${belief.confidence}] ${belief.key}: ${belief.statement} (evidence episodes: ${support})`;
  }).join('\n');
}

class BeliefStore {
  constructor({
    stateStore,
    stateKey = STATE_KEY,
    cacheTtlMs = Number(process.env.AURA_BELIEF_CACHE_MS) || 15000
  } = {}) {
    if (!stateStore) throw new Error('stateStore is required.');
    this.stateStore = stateStore;
    this.stateKey = stateKey;
    this.mutationQueue = Promise.resolve();
    this.cacheTtlMs = Math.max(0, Number(cacheTtlMs) || 0);
    this.cache = { at: 0, beliefs: null };
  }

  async #read() {
    if (this.cache.beliefs && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.beliefs;
    }
    const value = await this.stateStore.getState(this.stateKey);
    const beliefs = value?.beliefs && typeof value.beliefs === 'object' && !Array.isArray(value.beliefs)
      ? value.beliefs
      : {};
    this.cache = { at: Date.now(), beliefs };
    return beliefs;
  }

  #mutate(mutator) {
    const run = this.mutationQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await this.stateStore.getStateRow(this.stateKey);
        const current = row?.value && typeof row.value === 'object' ? row.value : {};
        const beliefs = current.beliefs && typeof current.beliefs === 'object' && !Array.isArray(current.beliefs)
          ? { ...current.beliefs }
          : {};
        const result = mutator(beliefs);
        if (!result?.changed) {
          this.cache = { at: Date.now(), beliefs };
          return result?.value ?? null;
        }
        const retained = Object.fromEntries(Object.entries(beliefs)
          .sort(([, left], [, right]) => String(left.updated_at || '').localeCompare(String(right.updated_at || '')))
          .slice(-MAX_BELIEFS));
        const next = {
          version: 1,
          beliefs: retained,
          updated_at: new Date().toISOString()
        };
        if (await this.stateStore.compareAndSetState(this.stateKey, row?.updated_at ?? null, next)) {
          this.cache = { at: Date.now(), beliefs: retained };
          return result.value;
        }
      }
      throw new Error('Could not update learned beliefs due to concurrent updates.');
    });
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  async consider({
    action = 'none',
    key = '',
    statement = '',
    confidence = 0,
    supportingEpisodeIds = [],
    contradictingEpisodeIds = [],
    reason = ''
  } = {}, episodes = []) {
    const normalizedAction = String(action || 'none').toLowerCase();
    if (normalizedAction === 'none') return { applied: false, reason: 'no_candidate' };
    if (!['consolidate', 'contradiction'].includes(normalizedAction)) {
      return { applied: false, reason: 'invalid_action' };
    }

    const normalizedKey = normalizeKey(key);
    const normalizedStatement = normalizeStatement(statement);
    const normalizedConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    if (!normalizedKey || !normalizedStatement) return { applied: false, reason: 'missing_content' };
    if (unsafeBelief(normalizedStatement)) return { applied: false, reason: 'unsafe_content' };
    if (normalizedConfidence < MIN_CONFIDENCE) return { applied: false, reason: 'low_confidence' };

    const episodeIds = new Set((Array.isArray(episodes) ? episodes : [])
      .map(episode => String(episode?.id || '').trim())
      .filter(Boolean));
    const support = normalizeEpisodeIds(supportingEpisodeIds, episodeIds);
    const contradictions = normalizeEpisodeIds(contradictingEpisodeIds, episodeIds)
      .filter(id => !support.includes(id));
    if (normalizedAction === 'consolidate' && support.length < MIN_SUPPORTING_EPISODES) {
      return { applied: false, reason: 'insufficient_evidence' };
    }
    if (normalizedAction === 'contradiction' && support.length + contradictions.length < 1) {
      return { applied: false, reason: 'missing_contradiction_evidence' };
    }

    const normalizedReason = String(reason || '').trim().slice(0, 500);
    return this.#mutate(beliefs => {
      const now = new Date().toISOString();
      const existing = beliefs[normalizedKey] || null;
      if (!existing) {
        if (normalizedAction === 'contradiction') {
          return { changed: false, value: { applied: false, reason: 'unknown_belief' } };
        }
        const belief = {
          key: normalizedKey,
          statement: normalizedStatement,
          confidence: normalizedConfidence,
          status: 'active',
          support_episode_ids: support,
          contradictions: [],
          reason: normalizedReason,
          created_at: now,
          updated_at: now
        };
        beliefs[normalizedKey] = belief;
        return { changed: true, value: { applied: true, action: 'created', belief } };
      }

      if (sameStatement(existing.statement, normalizedStatement) && normalizedAction === 'consolidate') {
        const belief = {
          ...existing,
          confidence: Math.max(Number(existing.confidence) || 0, normalizedConfidence),
          support_episode_ids: [...new Set([...(existing.support_episode_ids || []), ...support])].slice(0, 24),
          reason: normalizedReason || existing.reason || '',
          updated_at: now
        };
        beliefs[normalizedKey] = belief;
        return { changed: true, value: { applied: true, action: 'reinforced', belief } };
      }

      if (sameStatement(existing.statement, normalizedStatement)) {
        return { changed: false, value: { applied: false, reason: 'contradiction_matches_current' } };
      }

      const evidenceIds = [...new Set([...support, ...contradictions])].slice(0, 24);
      const priorContradictions = Array.isArray(existing.contradictions) ? [...existing.contradictions] : [];
      const candidateIndex = priorContradictions.findIndex(item => sameStatement(item.statement, normalizedStatement));
      const candidate = {
        statement: normalizedStatement,
        confidence: normalizedConfidence,
        episode_ids: evidenceIds,
        reason: normalizedReason,
        first_seen_at: candidateIndex >= 0 ? priorContradictions[candidateIndex].first_seen_at : now,
        updated_at: now
      };
      if (candidateIndex >= 0) {
        candidate.episode_ids = [...new Set([
          ...(priorContradictions[candidateIndex].episode_ids || []),
          ...evidenceIds
        ])].slice(0, 24);
        candidate.confidence = Math.max(
          Number(priorContradictions[candidateIndex].confidence) || 0,
          normalizedConfidence
        );
        priorContradictions[candidateIndex] = candidate;
      } else {
        priorContradictions.push(candidate);
      }
      const belief = {
        ...existing,
        status: 'contested',
        contradictions: priorContradictions.slice(-8),
        updated_at: now
      };
      beliefs[normalizedKey] = belief;
      return { changed: true, value: { applied: true, action: 'contested', belief } };
    });
  }

  async resolve(key, { statement, note = '' } = {}) {
    const normalizedKey = normalizeKey(key);
    const normalizedStatement = normalizeStatement(statement);
    if (!normalizedKey || !normalizedStatement) throw new Error('Belief key and statement are required.');
    if (unsafeBelief(`${normalizedStatement} ${note}`)) throw new Error('Belief resolution contains unsafe content.');
    return this.#mutate(beliefs => {
      const existing = beliefs[normalizedKey];
      if (!existing) return { changed: false, value: null };
      const alternative = (existing.contradictions || [])
        .find(item => sameStatement(item.statement, normalizedStatement));
      if (!sameStatement(existing.statement, normalizedStatement) && !alternative) {
        throw new Error('Resolution must select the current statement or a recorded alternative.');
      }
      const now = new Date().toISOString();
      const belief = {
        ...existing,
        statement: normalizedStatement,
        confidence: 1,
        status: 'active',
        support_episode_ids: alternative?.episode_ids || existing.support_episode_ids || [],
        contradictions: [],
        reason: `Owner resolved${note ? `: ${String(note).trim().slice(0, 300)}` : '.'}`,
        resolved_at: now,
        updated_at: now
      };
      beliefs[normalizedKey] = belief;
      return { changed: true, value: belief };
    });
  }

  async list(limit = 50) {
    const bounded = Math.max(1, Math.min(MAX_BELIEFS, Number(limit) || 50));
    return Object.values(await this.#read())
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
      .slice(0, bounded);
  }

  async relevant(query, limit = 6) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];
    return (await this.list(MAX_BELIEFS))
      .map(belief => {
        const alternatives = (belief.contradictions || []).map(item => item.statement).join(' ');
        const score = textMatchScore(normalizedQuery, `${belief.key} ${belief.statement} ${alternatives}`);
        return { ...belief, match_score: score };
      })
      .filter(belief => belief.match_score >= 0.25)
      .sort((left, right) => right.match_score - left.match_score)
      .slice(0, Math.max(1, Math.min(12, Number(limit) || 6)));
  }

  async summary() {
    const beliefs = await this.list(MAX_BELIEFS);
    return {
      total: beliefs.length,
      active: beliefs.filter(belief => belief.status === 'active').length,
      contested: beliefs.filter(belief => belief.status === 'contested').length
    };
  }
}

module.exports = {
  BeliefStore,
  STATE_KEY,
  MAX_BELIEFS,
  MIN_SUPPORTING_EPISODES,
  MIN_CONFIDENCE,
  normalizeKey,
  renderBeliefContext,
  unsafeBelief
};
