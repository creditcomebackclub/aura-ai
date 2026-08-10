'use strict';

const crypto = require('crypto');
const { containsSecret } = require('./memory_v2');

const STATE_KEY = 'skill_outcomes_v1';
const MAX_OUTCOMES = 200;
const FEEDBACK_WINDOW_MS = 48 * 60 * 60 * 1000;

function classifyOwnerFeedback(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  const negative = [
    /^correction\s*:/i,
    /^(?:no[,!. ]+)?(?:that(?:'s| is| was)|this is)\s+(?:not right|wrong|incorrect|not correct)\b/i,
    /^(?:no[,!. ]+)?that(?:'s| is| was)(?:n't| not)\s+(?:what i (?:said|asked|meant|wanted)|right|correct)\b/i,
    /^you\s+(?:got|did|handled|understood)\b.{0,120}\bwrong\b/i,
    /^(?:no[,!. ]+)?i\s+(?:said|asked|meant|wanted)\b/i,
    /^(?:wrong|incorrect)(?:[,!. ]|$)/i
  ];
  if (negative.some(pattern => pattern.test(value))) return 'negative';
  const positive = [
    /^(?:that(?:'s| is| was)\s+)?(?:exactly right|right|correct|perfect)(?:[,!. ]|$)/i,
    /^(?:yes[,!. ]+)?exactly(?:[,!. ]|$)/i,
    /^(?:great job|nice work|that worked)(?:[,!. ]|$)/i
  ];
  if (positive.some(pattern => pattern.test(value))) return 'positive';
  return null;
}

function skillUsagesFromEvidence(evidence = []) {
  const seen = new Set();
  const usages = [];
  for (const item of evidence) {
    const skill = item?.skill;
    if (item?.tool !== 'view_skill' || item?.ok !== true || !skill?.name) continue;
    const key = `${skill.name}:${skill.version || 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usages.push({
      name: String(skill.name).slice(0, 80),
      origin: skill.origin === 'learned' ? 'learned' : 'bundled',
      version: Math.max(1, Number(skill.version) || 1)
    });
  }
  return usages;
}

function outcomeStatus(evidence = []) {
  const toolEvidence = evidence.filter(item =>
    item?.tool && !['list_skills', 'view_skill', 'manage_skill'].includes(item.tool)
  );
  const successes = toolEvidence.filter(item => item.ok === true).length;
  const failures = toolEvidence.filter(item => item.ok !== true).length;
  if (!toolEvidence.length) return { status: 'no_tools', successes, failures };
  if (failures === 0) return { status: 'succeeded', successes, failures };
  if (successes === 0) return { status: 'failed', successes, failures };
  return { status: 'partial', successes, failures };
}

class SkillOutcomeStore {
  constructor({ stateStore, stateKey = STATE_KEY, logger = console } = {}) {
    if (!stateStore) throw new Error('stateStore is required.');
    this.stateStore = stateStore;
    this.stateKey = stateKey;
    this.logger = logger;
    this.mutationQueue = Promise.resolve();
  }

  async #read() {
    const value = await this.stateStore.getState(this.stateKey);
    return Array.isArray(value?.outcomes) ? value.outcomes : [];
  }

  #mutate(mutator) {
    const run = this.mutationQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await this.stateStore.getStateRow(this.stateKey);
        const current = row?.value && typeof row.value === 'object' ? row.value : {};
        const outcomes = Array.isArray(current.outcomes) ? [...current.outcomes] : [];
        const result = mutator(outcomes);
        if (!result?.changed) return result?.value ?? null;
        const now = new Date().toISOString();
        const next = {
          version: 1,
          outcomes: outcomes.slice(-MAX_OUTCOMES),
          updated_at: now
        };
        if (await this.stateStore.compareAndSetState(
          this.stateKey,
          row?.updated_at ?? null,
          next
        )) return result.value;
      }
      throw new Error('Could not update skill outcomes due to concurrent updates.');
    });
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  async recordTurn({ ownerText = '', reply = '', evidence = [], messageId = null } = {}) {
    const usages = skillUsagesFromEvidence(evidence);
    if (!usages.length) return [];
    const summary = outcomeStatus(evidence);
    const now = new Date().toISOString();
    const safeOwnerText = containsSecret(ownerText) ? '' : String(ownerText).trim().slice(0, 1000);
    const safeReply = containsSecret(reply) ? '' : String(reply).trim().slice(0, 1000);
    return this.#mutate(outcomes => {
      const created = usages.map(skill => ({
        id: crypto.randomUUID(),
        skill_name: skill.name,
        skill_origin: skill.origin,
        skill_version: skill.version,
        status: summary.status,
        tool_success_count: summary.successes,
        tool_failure_count: summary.failures,
        tools: evidence
          .filter(item => item?.tool && !['list_skills', 'view_skill', 'manage_skill'].includes(item.tool))
          .map(item => ({ name: String(item.tool).slice(0, 100), ok: item.ok === true }))
          .slice(0, 40),
        owner_request: safeOwnerText,
        assistant_reply: safeReply,
        assistant_message_id: messageId,
        feedback: null,
        feedback_source: null,
        feedback_text: '',
        created_at: now,
        feedback_at: null
      }));
      outcomes.push(...created);
      return { changed: true, value: created };
    });
  }

  async applyOwnerFeedback(text) {
    const rating = classifyOwnerFeedback(text);
    if (!String(text || '').trim() || containsSecret(text)) return null;
    const feedbackText = String(text).trim().slice(0, 1000);
    const cutoff = Date.now() - FEEDBACK_WINDOW_MS;
    return this.#mutate(outcomes => {
      let targetIndex = -1;
      for (let index = outcomes.length - 1; index >= 0; index -= 1) {
        const outcome = outcomes[index];
        if (outcome.feedback || Date.parse(outcome.created_at) < cutoff) continue;
        targetIndex = index;
        break;
      }
      if (targetIndex === -1) return { changed: false, value: null };
      const target = outcomes[targetIndex];
      const groupMatches = outcome => target.assistant_message_id != null
        ? outcome.assistant_message_id === target.assistant_message_id
        : outcome.created_at === target.created_at;
      let latestUpdated = null;
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        if (outcome.feedback || !groupMatches(outcome)) continue;
        outcomes[index] = {
          ...outcome,
          feedback: rating || 'none',
          feedback_source: 'next_owner_turn',
          feedback_text: rating ? feedbackText : '',
          feedback_at: new Date().toISOString()
        };
        latestUpdated = outcomes[index];
      }
      return { changed: Boolean(latestUpdated), value: latestUpdated };
    });
  }

  async setFeedback(id, { rating, note = '' } = {}) {
    if (!['positive', 'negative'].includes(rating)) {
      throw new Error('Feedback rating must be positive or negative.');
    }
    const normalizedId = String(id || '');
    if (!/^[0-9a-f-]{36}$/i.test(normalizedId)) throw new Error('Invalid outcome id.');
    if (containsSecret(note)) throw new Error('Feedback notes cannot contain credentials.');
    return this.#mutate(outcomes => {
      const index = outcomes.findIndex(item => item.id === normalizedId);
      if (index === -1) return { changed: false, value: null };
      outcomes[index] = {
        ...outcomes[index],
        feedback: rating,
        feedback_source: 'explicit_owner_feedback',
        feedback_text: String(note || '').trim().slice(0, 1000),
        feedback_at: new Date().toISOString()
      };
      return { changed: true, value: outcomes[index] };
    });
  }

  async list(limit = 50) {
    const bounded = Math.max(1, Math.min(MAX_OUTCOMES, Number(limit) || 50));
    return (await this.#read()).slice(-bounded).reverse();
  }

  async summary() {
    const outcomes = await this.#read();
    const learned = outcomes.filter(item => item.skill_origin === 'learned');
    return {
      total: outcomes.length,
      learned_total: learned.length,
      succeeded: outcomes.filter(item => item.status === 'succeeded').length,
      failed_or_partial: outcomes.filter(item => ['failed', 'partial'].includes(item.status)).length,
      positive_feedback: outcomes.filter(item => item.feedback === 'positive').length,
      negative_feedback: outcomes.filter(item => item.feedback === 'negative').length,
      awaiting_feedback: outcomes.filter(item => !item.feedback).length
    };
  }
}

module.exports = {
  SkillOutcomeStore,
  STATE_KEY,
  MAX_OUTCOMES,
  FEEDBACK_WINDOW_MS,
  classifyOwnerFeedback,
  skillUsagesFromEvidence,
  outcomeStatus
};
