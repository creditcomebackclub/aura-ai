'use strict';

// Bundled workflows remain versioned files. Cloud learned workflows use an
// owner-scoped lifecycle in aura_state: candidate -> active -> retired or
// rolled_back. Legacy v1 rows are normalized as active v1 records on read, so
// deploying this does not hide or rewrite skills learned before the lifecycle.
const { NAME_PATTERN, MAX_DESCRIPTION, MAX_BODY, slugifyName, renderSkillMarkdown } = require('./skills_store');
const { containsSecret } = require('./memory_v2');

const STATE_KEY = 'learned_skills_v1';
const STATE_VERSION = 2;
const MAX_WRITE_RETRIES = 5;
const MAX_VERSIONS_PER_SKILL = 20;
const MIN_PROMOTION_SCORE = 0.75;
const MIN_SCENARIO_COUNT = 2;
const MIN_SCORE_IMPROVEMENT = 0.05;

function normalizeSkill({ name, description, content }) {
  const normalizedName = slugifyName(name);
  if (!NAME_PATTERN.test(normalizedName)) {
    throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
  }
  const normalizedDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION);
  const normalizedContent = String(content || '').trim().slice(0, MAX_BODY);
  if (!normalizedDescription) throw new Error('Skill description is required.');
  if (!normalizedContent) throw new Error('Skill content/body is required.');
  if (containsSecret(`${normalizedDescription}\n${normalizedContent}`)) {
    throw new Error('Skill content cannot contain credentials or secrets.');
  }
  return { name: normalizedName, description: normalizedDescription, content: normalizedContent };
}

function normalizeEvidence(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => String(item || '').trim().slice(0, 500))
    .filter(item => item && !containsSecret(item))
    .slice(0, 12);
}

function normalizeVersion(name, version, raw = {}) {
  const skill = normalizeSkill({
    name,
    description: raw.description,
    content: raw.content
  });
  const numericVersion = Math.max(1, Number(version) || Number(raw.version) || 1);
  return {
    version: numericVersion,
    description: skill.description,
    content: skill.content,
    status: ['candidate', 'active', 'retired', 'rejected', 'rolled_back', 'deleted'].includes(raw.status)
      ? raw.status
      : 'active',
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
    evidence: normalizeEvidence(raw.evidence),
    reason: containsSecret(raw.reason) ? '' : String(raw.reason || '').trim().slice(0, 500),
    evaluation: raw.evaluation && typeof raw.evaluation === 'object' ? raw.evaluation : null,
    proposal_source: raw.proposal_source || 'legacy',
    created_at: raw.created_at || raw.learned_at || raw.updated_at || null,
    updated_at: raw.updated_at || null,
    activated_at: raw.activated_at || (raw.status === 'active' ? raw.updated_at || raw.learned_at || null : null),
    retired_at: raw.retired_at || null,
    rollback_reason: String(raw.rollback_reason || '').slice(0, 500) || null
  };
}

function normalizeLifecycle(name, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      name,
      active_version: null,
      candidate_version: null,
      versions: {},
      rollbacks: [],
      learned_at: null,
      updated_at: null
    };
  }

  // v1 shape: one flat active skill. Preserve it as a legacy active version.
  if (!raw.versions || typeof raw.versions !== 'object' || Array.isArray(raw.versions)) {
    const legacy = normalizeVersion(name, raw.version || 1, {
      ...raw,
      status: 'active',
      proposal_source: 'legacy_migration'
    });
    return {
      name,
      active_version: legacy.version,
      candidate_version: null,
      versions: { [legacy.version]: legacy },
      rollbacks: [],
      learned_at: raw.learned_at || legacy.created_at,
      updated_at: raw.updated_at || legacy.updated_at
    };
  }

  const versions = {};
  for (const [version, value] of Object.entries(raw.versions)) {
    try {
      const normalized = normalizeVersion(name, version, value);
      versions[normalized.version] = normalized;
    } catch {
      // Ignore a malformed historical version without hiding valid siblings.
    }
  }
  const active = Number(raw.active_version);
  const candidate = Number(raw.candidate_version);
  return {
    name,
    active_version: Number.isInteger(active) && versions[active] ? active : null,
    candidate_version: Number.isInteger(candidate) && versions[candidate] ? candidate : null,
    versions,
    rollbacks: Array.isArray(raw.rollbacks) ? raw.rollbacks.slice(-20) : [],
    learned_at: raw.learned_at || null,
    updated_at: raw.updated_at || null
  };
}

function nextVersion(lifecycle) {
  return Math.max(0, ...Object.keys(lifecycle.versions || {}).map(Number).filter(Number.isFinite)) + 1;
}

function publicVersion(name, record, extra = {}) {
  return {
    name,
    description: record.description,
    content: record.content,
    origin: 'learned',
    path: null,
    version: record.version,
    status: record.status,
    confidence: record.confidence,
    evidence_count: record.evidence.length,
    reason: record.reason,
    learned_at: record.created_at,
    updated_at: record.updated_at,
    ...extra
  };
}

class DurableSkillsStore {
  constructor({ localStore, stateStore = null, stateKey = STATE_KEY } = {}) {
    if (!localStore) throw new Error('localStore is required.');
    this.localStore = localStore;
    this.stateStore = stateStore;
    this.stateKey = stateKey;
  }

  #bundled(name) {
    return this.localStore.listSkills()
      .find(skill => skill.origin === 'bundled' && skill.name === name) || null;
  }

  async #remoteLifecycles() {
    const state = await this.stateStore.getState(this.stateKey);
    const skills = state && typeof state === 'object' ? state.skills : null;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return {};
    const lifecycles = {};
    for (const [name, raw] of Object.entries(skills)) {
      if (!NAME_PATTERN.test(name)) continue;
      try {
        lifecycles[name] = normalizeLifecycle(name, raw);
      } catch {
        // A malformed skill must not break the entire active index.
      }
    }
    return lifecycles;
  }

  async #mutate(name, mutator) {
    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
      const row = await this.stateStore.getStateRow(this.stateKey);
      const state = row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? row.value
        : {};
      const skills = state.skills && typeof state.skills === 'object' && !Array.isArray(state.skills)
        ? { ...state.skills }
        : {};
      const lifecycle = normalizeLifecycle(name, skills[name]);
      const result = mutator(lifecycle);
      if (!result?.changed) return result?.value ?? null;
      const protectedVersions = new Set([
        lifecycle.active_version,
        lifecycle.candidate_version
      ].filter(Boolean));
      const newest = Object.values(lifecycle.versions)
        .sort((left, right) => right.version - left.version);
      const retainedIds = new Set([...protectedVersions]);
      for (const version of newest) {
        if (retainedIds.size >= MAX_VERSIONS_PER_SKILL) break;
        retainedIds.add(version.version);
      }
      const orderedVersions = newest
        .filter(version => retainedIds.has(version.version))
        .sort((left, right) => left.version - right.version);
      lifecycle.versions = Object.fromEntries(orderedVersions.map(version => [version.version, version]));
      lifecycle.updated_at = new Date().toISOString();
      skills[name] = lifecycle;
      const next = {
        version: STATE_VERSION,
        skills,
        updated_at: new Date().toISOString()
      };
      if (await this.stateStore.compareAndSetState(this.stateKey, row?.updated_at ?? null, next)) {
        return result.value;
      }
    }
    throw new Error('Could not save learned skill due to concurrent updates; please retry.');
  }

  async listSkills() {
    if (!this.stateStore) return this.localStore.listSkills();
    const skills = new Map(this.localStore.listSkills()
      .filter(skill => skill.origin === 'bundled')
      .map(skill => [skill.name, skill]));
    for (const [name, lifecycle] of Object.entries(await this.#remoteLifecycles())) {
      const active = lifecycle.versions[lifecycle.active_version];
      if (!active) continue;
      skills.set(name, publicVersion(name, active));
    }
    return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async buildIndexPrompt() {
    const skills = await this.listSkills();
    if (!skills.length) return '';
    return [
      '',
      'AVAILABLE WORKFLOWS (names only — call view_skill for steps when one fits):',
      skills.map(skill => `- ${skill.name} (${skill.origin === 'learned' ? 'learned' : 'built-in'}): ${skill.description}`).join('\n')
    ].join('\n');
  }

  async viewSkill(name) {
    const normalizedName = slugifyName(name);
    if (!NAME_PATTERN.test(normalizedName)) {
      throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
    }
    const skill = (await this.listSkills()).find(item => item.name === normalizedName);
    if (!skill) throw new Error(`Unknown skill "${normalizedName}".`);
    return {
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      version: Math.max(1, Number(skill.version) || 1),
      confidence: skill.confidence ?? null,
      evidence_count: Math.max(0, Number(skill.evidence_count) || 0),
      content: renderSkillMarkdown({ name: skill.name, description: skill.description, body: skill.content || skill.body })
    };
  }

  async manageSkill(input = {}) {
    if (!this.stateStore) return this.localStore.manageSkill(input);
    const action = String(input.action || '').trim().toLowerCase();
    if (!['create', 'patch', 'delete'].includes(action)) {
      throw new Error('manage_skill action must be create, patch, or delete.');
    }
    const name = slugifyName(input.name);
    if (!NAME_PATTERN.test(name)) throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
    const bundled = this.#bundled(name);

    return this.#mutate(name, lifecycle => {
      const now = new Date().toISOString();
      const active = lifecycle.versions[lifecycle.active_version] || null;
      if (action === 'delete') {
        if (!active) {
          if (bundled) throw new Error('Bundled skills cannot be deleted.');
          if (!lifecycle.candidate_version) throw new Error(`No learned skill named "${name}" to delete.`);
        }
        for (const version of Object.values(lifecycle.versions)) {
          if (version.status === 'active' || version.status === 'candidate') {
            version.status = 'deleted';
            version.updated_at = now;
          }
        }
        lifecycle.active_version = null;
        lifecycle.candidate_version = null;
        return { changed: true, value: { action, name, origin: 'learned', durable: true, version: null } };
      }

      if (action === 'create' && (active || bundled)) {
        throw new Error(`Skill "${name}" already exists. Use patch.`);
      }
      const base = active || (bundled ? {
        description: bundled.description,
        content: bundled.body
      } : null);
      const skill = normalizeSkill({
        name,
        description: input.description || base?.description,
        content: input.content || base?.content
      });
      const versionNumber = nextVersion(lifecycle);
      if (active) {
        active.status = 'retired';
        active.retired_at = now;
        active.updated_at = now;
      }
      const pending = lifecycle.versions[lifecycle.candidate_version];
      if (pending) {
        pending.status = 'rejected';
        pending.updated_at = now;
      }
      lifecycle.versions[versionNumber] = normalizeVersion(name, versionNumber, {
        ...skill,
        status: 'active',
        confidence: input.confidence ?? 1,
        evidence: input.evidence,
        reason: input.reason || 'Direct owner-managed skill change.',
        proposal_source: 'owner_direct',
        created_at: now,
        updated_at: now,
        activated_at: now
      });
      lifecycle.active_version = versionNumber;
      lifecycle.candidate_version = null;
      lifecycle.learned_at ||= now;
      return {
        changed: true,
        value: { action, name, origin: 'learned', durable: true, version: versionNumber, status: 'active' }
      };
    });
  }

  async proposeSkill(input = {}) {
    if (!this.stateStore) {
      return { action: 'candidate_skipped', name: slugifyName(input.name), reason: 'durable_lifecycle_unavailable' };
    }
    const action = String(input.action || '').trim().toLowerCase();
    if (!['create', 'patch'].includes(action)) throw new Error('Candidate action must be create or patch.');
    const name = slugifyName(input.name);
    if (!NAME_PATTERN.test(name)) throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
    const bundled = this.#bundled(name);

    return this.#mutate(name, lifecycle => {
      const now = new Date().toISOString();
      const active = lifecycle.versions[lifecycle.active_version] || null;
      if (action === 'create' && (active || bundled)) {
        throw new Error(`Skill "${name}" already exists. Use patch.`);
      }
      const base = active || (bundled ? { description: bundled.description, content: bundled.body } : null);
      const skill = normalizeSkill({
        name,
        description: input.description || base?.description,
        content: input.content || base?.content
      });
      const priorCandidate = lifecycle.versions[lifecycle.candidate_version];
      if (
        priorCandidate
        && priorCandidate.description === skill.description
        && priorCandidate.content === skill.content
      ) {
        return {
          changed: false,
          value: {
            action: 'candidate',
            name,
            origin: 'learned',
            durable: true,
            version: priorCandidate.version,
            status: 'candidate',
            candidate: publicVersion(name, priorCandidate),
            baseline: active
              ? publicVersion(name, active)
              : (bundled ? {
                  name,
                  description: bundled.description,
                  content: bundled.body,
                  origin: 'bundled',
                  version: 1,
                  status: 'active'
                } : null)
          }
        };
      }
      if (priorCandidate) {
        priorCandidate.status = 'rejected';
        priorCandidate.reason = 'Superseded by a newer candidate.';
        priorCandidate.updated_at = now;
      }
      const versionNumber = nextVersion(lifecycle);
      const candidate = normalizeVersion(name, versionNumber, {
        ...skill,
        status: 'candidate',
        confidence: input.confidence,
        evidence: input.evidence,
        reason: input.reason,
        proposal_source: 'learning_review',
        created_at: now,
        updated_at: now
      });
      lifecycle.versions[versionNumber] = candidate;
      lifecycle.candidate_version = versionNumber;
      lifecycle.learned_at ||= now;
      return {
        changed: true,
        value: {
          action: 'candidate',
          name,
          origin: 'learned',
          durable: true,
          version: versionNumber,
          status: 'candidate',
          candidate: publicVersion(name, candidate),
          baseline: active
            ? publicVersion(name, active)
            : (bundled ? {
                name,
                description: bundled.description,
                content: bundled.body,
                origin: 'bundled',
                version: 1,
                status: 'active'
              } : null)
        }
      };
    });
  }

  async applyCandidateEvaluation(name, version, evaluation = {}) {
    const normalizedName = slugifyName(name);
    const numericVersion = Math.max(1, Number(version) || 1);
    return this.#mutate(normalizedName, lifecycle => {
      const candidate = lifecycle.versions[numericVersion];
      if (!candidate || lifecycle.candidate_version !== numericVersion || candidate.status !== 'candidate') {
        return { changed: false, value: { promoted: false, reason: 'candidate_not_current' } };
      }
      const now = new Date().toISOString();
      const scenarioResults = (Array.isArray(evaluation.scenario_results) ? evaluation.scenario_results : [])
        .map(result => ({
          scenario_id: String(result.scenario_id || '').slice(0, 80),
          candidate_score: Math.max(0, Math.min(1, Number(result.candidate_score) || 0)),
          baseline_score: Math.max(0, Math.min(1, Number(result.baseline_score) || 0)),
          passed: result.passed === true,
          reason: String(result.reason || '').slice(0, 300)
        }))
        .filter(result => result.scenario_id)
        .slice(0, 12);
      const uniqueScenarios = new Set(scenarioResults.map(result => result.scenario_id));
      const candidateScore = scenarioResults.length
        ? scenarioResults.reduce((sum, result) => sum + result.candidate_score, 0) / scenarioResults.length
        : 0;
      const baselineScore = scenarioResults.length
        ? scenarioResults.reduce((sum, result) => sum + result.baseline_score, 0) / scenarioResults.length
        : 0;
      const hasBaseline = Boolean(lifecycle.active_version || this.#bundled(normalizedName));
      const passed = evaluation.policy_passed === true
        && uniqueScenarios.size >= MIN_SCENARIO_COUNT
        && scenarioResults.every(result => result.passed)
        && candidateScore >= MIN_PROMOTION_SCORE
        && (!hasBaseline || candidateScore - baselineScore >= MIN_SCORE_IMPROVEMENT);
      candidate.evaluation = {
        policy_passed: evaluation.policy_passed === true,
        policy_checks: Array.isArray(evaluation.policy_checks) ? evaluation.policy_checks.slice(0, 20) : [],
        scenario_results: scenarioResults,
        candidate_score: Number(candidateScore.toFixed(4)),
        baseline_score: Number(baselineScore.toFixed(4)),
        rationale: String(evaluation.rationale || '').slice(0, 500),
        evaluated_at: now,
        passed
      };
      candidate.updated_at = now;
      lifecycle.candidate_version = null;
      if (!passed) {
        candidate.status = 'rejected';
        return {
          changed: true,
          value: { promoted: false, reason: 'evaluation_failed', name: normalizedName, version: numericVersion }
        };
      }
      const active = lifecycle.versions[lifecycle.active_version];
      if (active) {
        active.status = 'retired';
        active.retired_at = now;
        active.updated_at = now;
      }
      candidate.status = 'active';
      candidate.activated_at = now;
      lifecycle.active_version = numericVersion;
      return {
        changed: true,
        value: {
          promoted: true,
          name: normalizedName,
          version: numericVersion,
          previous_version: active?.version || null,
          candidate_score: candidate.evaluation.candidate_score,
          baseline_score: candidate.evaluation.baseline_score
        }
      };
    });
  }

  async rollbackSkill(name, { fromVersion = null, reason = '', source = 'owner' } = {}) {
    if (!this.stateStore) return { rolled_back: false, reason: 'durable_lifecycle_unavailable' };
    const normalizedName = slugifyName(name);
    if (containsSecret(reason)) throw new Error('Rollback reason cannot contain credentials or secrets.');
    return this.#mutate(normalizedName, lifecycle => {
      const active = lifecycle.versions[lifecycle.active_version];
      if (!active) return { changed: false, value: { rolled_back: false, reason: 'no_active_learned_version' } };
      if (fromVersion != null && active.version !== Number(fromVersion)) {
        return { changed: false, value: { rolled_back: false, reason: 'active_version_changed' } };
      }
      const now = new Date().toISOString();
      const previous = Object.values(lifecycle.versions)
        .filter(version => version.version < active.version && ['retired', 'rolled_back'].includes(version.status))
        .sort((left, right) => right.version - left.version)[0] || null;
      active.status = 'rolled_back';
      active.rollback_reason = String(reason || 'Repeated failures.').slice(0, 500);
      active.updated_at = now;
      if (previous) {
        previous.status = 'active';
        previous.activated_at = now;
        previous.updated_at = now;
      }
      lifecycle.active_version = previous?.version || null;
      lifecycle.rollbacks.push({
        from_version: active.version,
        to_version: previous?.version || null,
        reason: active.rollback_reason,
        source: String(source || 'owner').slice(0, 80),
        created_at: now
      });
      lifecycle.rollbacks = lifecycle.rollbacks.slice(-20);
      return {
        changed: true,
        value: {
          rolled_back: true,
          name: normalizedName,
          from_version: active.version,
          to_version: previous?.version || null,
          fallback: previous ? 'learned_previous' : (this.#bundled(normalizedName) ? 'bundled' : 'disabled')
        }
      };
    });
  }

  async getSkillLifecycle(name) {
    if (!this.stateStore) return null;
    const normalizedName = slugifyName(name);
    return (await this.#remoteLifecycles())[normalizedName] || null;
  }

  async listLifecycles(limit = 100) {
    if (!this.stateStore) return [];
    const bounded = Math.max(1, Math.min(100, Number(limit) || 100));
    return Object.values(await this.#remoteLifecycles())
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')))
      .slice(0, bounded);
  }
}

module.exports = {
  DurableSkillsStore,
  STATE_KEY,
  STATE_VERSION,
  MAX_VERSIONS_PER_SKILL,
  MIN_PROMOTION_SCORE,
  MIN_SCENARIO_COUNT,
  MIN_SCORE_IMPROVEMENT,
  normalizeSkill,
  normalizeLifecycle
};
