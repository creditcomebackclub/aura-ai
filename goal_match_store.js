'use strict';

// Durable ledger of goal/signal connections, plus the feedback loop that tunes
// how eager AURA is to make them.
//
// Every fired match is recorded with its full score breakdown, so a bad
// connection is debuggable rather than mysterious. Outcomes then feed back into
// a per-class confidence threshold: match classes the owner keeps acting on get
// a lower bar, classes the owner keeps ignoring get a higher one. Thresholds
// only move once a class has enough observations to be worth trusting, and are
// always clamped, so one stray "no" cannot silence a whole class.

const crypto = require('crypto');
const { containsSecret } = require('./memory_v2');

const STATE_KEY = 'goal_signal_matches_v1';
const MAX_RECORDS = 200;

const BASE_THRESHOLD = 0.55;
const MIN_THRESHOLD = 0.45;
const MAX_THRESHOLD = 0.9;
// Below this many resolved observations a class keeps the base threshold.
const MIN_OBSERVATIONS = 3;
// Precision AURA aims for; classes above it get more eager, below it back off.
const TARGET_PRECISION = 0.75;
const THRESHOLD_SENSITIVITY = 0.5;
// Laplace smoothing so a single outcome cannot swing a class to 0 or 1.
const PRIOR_POSITIVES = 1;
const PRIOR_TOTAL = 2;
// A match the owner never acted on is treated as a soft negative after this.
const IGNORED_AFTER_MS = 7 * 86400000;

const MATCH_CLASSES = ['domain', 'organization', 'person', 'phrase', 'semantic'];

function matchClass(match) {
  if (match?.tier === 'semantic') return 'semantic';
  const type = match?.evidence?.[0]?.signal_type;
  return MATCH_CLASSES.includes(type) ? type : 'phrase';
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

// Subject lines here come from arbitrary inbound mail, which routinely carries
// one-time codes. containsSecret covers API keys and tokens; these patterns add
// the OTP shapes, scoped to this ledger so the shared memory helper — and its
// callers — keep their existing behavior.
const ONE_TIME_CODE_PATTERNS = [
  /\b(?:one[-\s]?time|verification|confirmation|security|login|sign[-\s]?in|auth(?:entication)?)\b[^.]{0,40}?\b\d{4,8}\b/i,
  /\b(?:otp|passcode|pin|code)\b[^.]{0,24}?\b\d{4,8}\b/i,
  /\b\d{4,8}\b[^.]{0,24}?\b(?:is your|as your)\b[^.]{0,24}?\b(?:code|otp|passcode|pin)\b/i
];

function containsSensitiveSignal(text) {
  const value = String(text || '');
  return containsSecret(value) || ONE_TIME_CODE_PATTERNS.some(pattern => pattern.test(value));
}

function safeText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  return containsSensitiveSignal(text) ? '' : text;
}

// Smoothed precision for one class, then mapped onto a threshold. A class
// running above the target precision earns a lower bar; one running below it
// gets a higher bar.
function thresholdFromCounts({ positives = 0, negatives = 0 } = {}) {
  const resolved = positives + negatives;
  if (resolved < MIN_OBSERVATIONS) {
    return { threshold: BASE_THRESHOLD, precision: null, observations: resolved, adapted: false };
  }
  const precision = (positives + PRIOR_POSITIVES) / (resolved + PRIOR_TOTAL);
  const threshold = clamp(
    BASE_THRESHOLD + (TARGET_PRECISION - precision) * THRESHOLD_SENSITIVITY,
    MIN_THRESHOLD,
    MAX_THRESHOLD
  );
  return {
    threshold: Number(threshold.toFixed(4)),
    precision: Number(precision.toFixed(4)),
    observations: resolved,
    adapted: true
  };
}

// A record counts as positive when the owner acted or said so, negative when
// they rejected it or let it go stale unacknowledged.
function resolveOutcome(record, { now = Date.now() } = {}) {
  if (record.feedback === 'positive' || record.outcome === 'acted') return 'positive';
  if (record.feedback === 'negative' || record.outcome === 'ignored') return 'negative';
  if (Date.parse(record.created_at) < now - IGNORED_AFTER_MS) return 'negative';
  return null;
}

function tallyByClass(records, { now = Date.now() } = {}) {
  const counts = {};
  for (const name of MATCH_CLASSES) counts[name] = { positives: 0, negatives: 0 };
  for (const record of records) {
    const bucket = counts[record.match_class] || counts.phrase;
    const outcome = resolveOutcome(record, { now });
    if (outcome === 'positive') bucket.positives += 1;
    else if (outcome === 'negative') bucket.negatives += 1;
  }
  return counts;
}

class GoalMatchStore {
  constructor({ stateStore, stateKey = STATE_KEY, logger = console } = {}) {
    if (!stateStore) throw new Error('stateStore is required.');
    this.stateStore = stateStore;
    this.stateKey = stateKey;
    this.logger = logger;
    this.mutationQueue = Promise.resolve();
  }

  async #read() {
    const value = await this.stateStore.getState(this.stateKey);
    return Array.isArray(value?.matches) ? value.matches : [];
  }

  #mutate(mutator) {
    const run = this.mutationQueue.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const row = await this.stateStore.getStateRow(this.stateKey);
        const current = row?.value && typeof row.value === 'object' ? row.value : {};
        const matches = Array.isArray(current.matches) ? [...current.matches] : [];
        const result = mutator(matches);
        if (!result?.changed) return result?.value ?? null;
        const next = {
          version: 1,
          matches: matches.slice(-MAX_RECORDS),
          updated_at: new Date().toISOString()
        };
        if (await this.stateStore.compareAndSetState(this.stateKey, row?.updated_at ?? null, next)) {
          return result.value;
        }
      }
      throw new Error('Could not update the goal match ledger due to concurrent updates.');
    });
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  // Per-class thresholds derived from resolved outcomes.
  async thresholds({ now = Date.now() } = {}) {
    const counts = tallyByClass(await this.#read(), { now });
    return Object.fromEntries(
      MATCH_CLASSES.map(name => [name, { ...thresholdFromCounts(counts[name]), ...counts[name] }])
    );
  }

  // The matcher runs once at the most permissive threshold; each candidate is
  // then held to its own class threshold by filterByThreshold.
  async minThreshold(options = {}) {
    const thresholds = await this.thresholds(options);
    return Math.min(...MATCH_CLASSES.map(name => thresholds[name].threshold));
  }

  async filterByThreshold(matches = [], options = {}) {
    const thresholds = await this.thresholds(options);
    return (Array.isArray(matches) ? matches : []).filter(match => {
      const name = matchClass(match);
      return match.confidence >= (thresholds[name]?.threshold ?? BASE_THRESHOLD);
    });
  }

  async alreadyRecorded(signalId, goalId) {
    if (!signalId || !goalId) return false;
    return (await this.#read()).some(
      record => record.signal_id === String(signalId) && record.goal_id === String(goalId)
    );
  }

  async record({
    match,
    signal = {},
    signalSource = 'email',
    suggestedWindows = [],
    links = {},
    draftActionId = null,
    notificationId = null,
    now = new Date()
  } = {}) {
    if (!match?.goal_id) throw new Error('A goal match requires goal_id.');
    const signalId = signal.id == null ? null : String(signal.id).slice(0, 200);
    const record = {
      id: crypto.randomUUID(),
      goal_id: String(match.goal_id),
      goal_text: safeText(match.goal_text, 400),
      signal_source: signalSource === 'calendar' ? 'calendar' : 'email',
      signal_id: signalId,
      signal_from: safeText(signal.from, 200),
      signal_subject: safeText(signal.subject, 200),
      match_class: matchClass(match),
      tier: match.tier || 'deterministic',
      confidence: Number(match.confidence) || 0,
      matched_by: Array.isArray(match.matched_by) ? match.matched_by.slice(0, 8) : [],
      evidence: Array.isArray(match.evidence) ? match.evidence.slice(0, 4) : [],
      scores: match.scores || {},
      suggested_windows: (Array.isArray(suggestedWindows) ? suggestedWindows : [])
        .slice(0, 3)
        .map(window => ({
          start: window.start,
          end: window.end,
          minutes: window.minutes,
          label: safeText(window.label, 80)
        })),
      // Who and what the signal resolved to beyond the goal itself. Stored as
      // labels only — the ledger is a record of reasoning, not a copy of the
      // profile or the client database.
      linked_people: (Array.isArray(links.people) ? links.people : []).slice(0, 2).map(person => ({
        key: safeText(person.key, 120),
        name: safeText(person.name, 120),
        organization: safeText(person.organization, 120),
        role: safeText(person.role, 120),
        confidence: Number(person.confidence) || 0,
        identified: person.identified === true,
        matched_on: safeText(person.evidence?.matched_on, 40)
      })),
      linked_clients: (Array.isArray(links.clients) ? links.clients : []).slice(0, 2).map(client => ({
        name: safeText(client?.client?.name, 120),
        status: safeText(client?.client?.status, 60),
        billing_status: safeText(client?.client?.billing_status, 60),
        current_phase: safeText(client?.current_phase, 80),
        outstanding_total: Number(client?.outstanding_total) || 0
      })),
      notification_id: notificationId == null ? null : String(notificationId).slice(0, 100),
      draft_action_id: draftActionId == null ? null : String(draftActionId).slice(0, 100),
      outcome: null,
      feedback: null,
      feedback_source: null,
      feedback_text: '',
      feedback_at: null,
      created_at: now.toISOString()
    };
    return this.#mutate(matches => {
      if (signalId && matches.some(item => item.signal_id === signalId && item.goal_id === record.goal_id)) {
        return { changed: false, value: null };
      }
      matches.push(record);
      return { changed: true, value: record };
    });
  }

  async setOutcome(id, outcome) {
    if (!['acted', 'ignored'].includes(outcome)) {
      throw new Error('Outcome must be acted or ignored.');
    }
    return this.#mutate(matches => {
      const index = matches.findIndex(item => item.id === String(id));
      if (index === -1) return { changed: false, value: null };
      matches[index] = { ...matches[index], outcome, feedback_at: new Date().toISOString() };
      return { changed: true, value: matches[index] };
    });
  }

  // Approving the drafted reply is the owner acting on the connection — the
  // strongest confirmation available that the match was right, and it needs no
  // separate rating from them.
  async markDraftApproved(actionId) {
    const normalized = String(actionId || '');
    if (!normalized) return null;
    return this.#mutate(matches => {
      const index = matches.findIndex(item => item.draft_action_id === normalized);
      if (index === -1 || matches[index].outcome === 'acted') return { changed: false, value: null };
      matches[index] = {
        ...matches[index],
        outcome: 'acted',
        feedback_source: 'draft_approved',
        feedback_at: new Date().toISOString()
      };
      return { changed: true, value: matches[index] };
    });
  }

  async setFeedback(id, { rating, note = '' } = {}) {
    if (!['positive', 'negative'].includes(rating)) {
      throw new Error('Feedback rating must be positive or negative.');
    }
    const normalizedId = String(id || '');
    if (!/^[0-9a-f-]{36}$/i.test(normalizedId)) throw new Error('Invalid match id.');
    if (containsSensitiveSignal(note)) throw new Error('Feedback notes cannot contain credentials.');
    return this.#mutate(matches => {
      const index = matches.findIndex(item => item.id === normalizedId);
      if (index === -1) return { changed: false, value: null };
      matches[index] = {
        ...matches[index],
        feedback: rating,
        feedback_source: 'explicit_owner_feedback',
        feedback_text: String(note || '').trim().slice(0, 1000),
        feedback_at: new Date().toISOString()
      };
      return { changed: true, value: matches[index] };
    });
  }

  async list(limit = 50) {
    const bounded = Math.max(1, Math.min(MAX_RECORDS, Number(limit) || 50));
    return (await this.#read()).slice(-bounded).reverse();
  }

  async summary({ now = Date.now() } = {}) {
    const matches = await this.#read();
    const thresholds = await this.thresholds({ now });
    return {
      total: matches.length,
      by_class: Object.fromEntries(MATCH_CLASSES.map(name => [
        name,
        matches.filter(record => record.match_class === name).length
      ])),
      deterministic: matches.filter(record => record.tier === 'deterministic').length,
      semantic: matches.filter(record => record.tier === 'semantic').length,
      acted: matches.filter(record => record.outcome === 'acted').length,
      positive_feedback: matches.filter(record => record.feedback === 'positive').length,
      negative_feedback: matches.filter(record => record.feedback === 'negative').length,
      awaiting_outcome: matches.filter(record => !record.feedback && !record.outcome).length,
      thresholds
    };
  }
}

module.exports = {
  BASE_THRESHOLD,
  GoalMatchStore,
  ONE_TIME_CODE_PATTERNS,
  containsSensitiveSignal,
  IGNORED_AFTER_MS,
  MATCH_CLASSES,
  MAX_RECORDS,
  MAX_THRESHOLD,
  MIN_OBSERVATIONS,
  MIN_THRESHOLD,
  STATE_KEY,
  TARGET_PRECISION,
  matchClass,
  resolveOutcome,
  tallyByClass,
  thresholdFromCounts
};
