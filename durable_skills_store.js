'use strict';

// Learned workflows must outlive a Render deploy. Bundled workflows remain
// versioned files, while cloud learned workflows are kept in aura_state under
// the owner-scoped key below. Local/Mac mode keeps the existing file store.
const { NAME_PATTERN, MAX_DESCRIPTION, MAX_BODY, slugifyName, renderSkillMarkdown } = require('./skills_store');

const STATE_KEY = 'learned_skills_v1';
const MAX_WRITE_RETRIES = 5;

function normalizeSkill({ name, description, content }) {
  const normalizedName = slugifyName(name);
  if (!NAME_PATTERN.test(normalizedName)) {
    throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
  }
  const normalizedDescription = String(description || '').trim().slice(0, MAX_DESCRIPTION);
  const normalizedContent = String(content || '').trim().slice(0, MAX_BODY);
  if (!normalizedDescription) throw new Error('Skill description is required.');
  if (!normalizedContent) throw new Error('Skill content/body is required.');
  return { name: normalizedName, description: normalizedDescription, content: normalizedContent };
}

class DurableSkillsStore {
  constructor({ localStore, stateStore = null, stateKey = STATE_KEY } = {}) {
    if (!localStore) throw new Error('localStore is required.');
    this.localStore = localStore;
    this.stateStore = stateStore;
    this.stateKey = stateKey;
  }

  async #remoteSkills() {
    const state = await this.stateStore.getState(this.stateKey);
    const skills = state && typeof state === 'object' ? state.skills : null;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) return {};
    return Object.fromEntries(Object.entries(skills).filter(([name, skill]) =>
      NAME_PATTERN.test(name) && skill && typeof skill === 'object'
    ));
  }

  async listSkills() {
    if (!this.stateStore) return this.localStore.listSkills();
    // In cloud mode, learned files are deliberately ignored: Supabase is the
    // source of truth and bundled files are the only deploy-time inputs.
    const skills = new Map(this.localStore.listSkills()
      .filter(skill => skill.origin === 'bundled')
      .map(skill => [skill.name, skill]));
    for (const [name, skill] of Object.entries(await this.#remoteSkills())) {
      const normalized = normalizeSkill({ name, description: skill.description, content: skill.content });
      skills.set(name, { ...normalized, origin: 'learned', path: null });
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
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
    const bundled = this.localStore.listSkills().find(skill => skill.origin === 'bundled' && skill.name === name);

    for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt += 1) {
      const row = await this.stateStore.getStateRow(this.stateKey);
      const current = row?.value && typeof row.value === 'object' && !Array.isArray(row.value)
        ? { ...(row.value.skills || {}) } : {};
      if (action === 'delete') {
        if (bundled && !current[name]) {
          throw new Error('Bundled skills cannot be deleted. Create a learned override instead.');
        }
        if (!current[name]) throw new Error(`No learned skill named "${name}" to delete.`);
        delete current[name];
      } else {
        const existing = current[name] || (bundled
          ? { description: bundled.description, content: bundled.body }
          : null);
        if (action === 'create' && (current[name] || bundled)) {
          throw new Error(`Skill "${name}" already exists. Use patch.`);
        }
        const skill = normalizeSkill({
          name,
          description: input.description || existing?.description,
          content: input.content || existing?.content
        });
        current[name] = { description: skill.description, content: skill.content, updated_at: new Date().toISOString() };
      }
      const next = { version: 1, skills: current, updated_at: new Date().toISOString() };
      if (await this.stateStore.compareAndSetState(this.stateKey, row?.updated_at ?? null, next)) {
        return { action, name, origin: 'learned', durable: true };
      }
    }
    throw new Error('Could not save learned skill due to concurrent updates; please retry.');
  }
}

module.exports = { DurableSkillsStore, STATE_KEY, normalizeSkill };
