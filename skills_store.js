'use strict';

const fs = require('fs');
const path = require('path');

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DESCRIPTION = 240;
const MAX_BODY = 24000;

function slugifyName(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function parseFrontmatter(raw) {
  const text = String(raw || '');
  if (!text.startsWith('---')) {
    return { meta: {}, body: text.trim() };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text.trim() };
  const yaml = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const meta = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[match[1]] = value;
  }
  return { meta, body };
}

function renderSkillMarkdown({ name, description, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    String(body || '').trim(),
    ''
  ].join('\n');
}

class SkillsStore {
  constructor({ rootDir = path.join(__dirname, 'skills') } = {}) {
    this.rootDir = rootDir;
    this.bundledDir = path.join(rootDir, 'bundled');
    this.learnedDir = path.join(rootDir, 'learned');
    this._indexCache = null;
  }

  ensureDirs() {
    fs.mkdirSync(this.bundledDir, { recursive: true });
    fs.mkdirSync(this.learnedDir, { recursive: true });
  }

  invalidateCache() {
    this._indexCache = null;
  }

  #skillPath(origin, name) {
    return path.join(this.rootDir, origin, name, 'SKILL.md');
  }

  #readSkillFile(filePath, origin) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const dirName = path.basename(path.dirname(filePath));
    const name = slugifyName(meta.name || dirName);
    if (!NAME_PATTERN.test(name)) return null;
    const description = String(meta.description || '').trim().slice(0, MAX_DESCRIPTION);
    return {
      name,
      description: description || name,
      body,
      origin,
      path: filePath
    };
  }

  listSkills() {
    this.ensureDirs();
    const skills = new Map();
    for (const origin of ['bundled', 'learned']) {
      const dir = path.join(this.rootDir, origin);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const filePath = this.#skillPath(origin, entry.name);
        if (!fs.existsSync(filePath)) continue;
        try {
          const skill = this.#readSkillFile(filePath, origin);
          if (!skill) continue;
          // Learned overrides bundled on name collision.
          skills.set(skill.name, skill);
        } catch (error) {
          console.warn(`[Skills] Failed to read ${filePath}:`, error.message);
        }
      }
    }
    return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  buildIndexPrompt() {
    if (this._indexCache != null) return this._indexCache;
    const skills = this.listSkills();
    if (!skills.length) {
      this._indexCache = '';
      return '';
    }
    const lines = skills.map(skill => {
      const tag = skill.origin === 'learned' ? 'learned' : 'built-in';
      return `- ${skill.name} (${tag}): ${skill.description}`;
    });
    this._indexCache = [
      '',
      'AVAILABLE WORKFLOWS (names only — call view_skill for steps when one fits):',
      lines.join('\n')
    ].join('\n');
    return this._indexCache;
  }

  viewSkill(name) {
    const normalized = slugifyName(name);
    if (!NAME_PATTERN.test(normalized)) {
      throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
    }
    const skill = this.listSkills().find(item => item.name === normalized);
    if (!skill) {
      const available = this.listSkills().map(item => item.name);
      throw new Error(
        available.length
          ? `Unknown skill "${normalized}". Available: ${available.join(', ')}`
          : `Unknown skill "${normalized}". No skills are installed.`
      );
    }
    return {
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      content: renderSkillMarkdown({
        name: skill.name,
        description: skill.description,
        body: skill.body
      })
    };
  }

  manageSkill({ action, name, description, content } = {}) {
    this.ensureDirs();
    this.invalidateCache();
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!['create', 'patch', 'delete'].includes(normalizedAction)) {
      throw new Error('manage_skill action must be create, patch, or delete.');
    }
    const normalized = slugifyName(name);
    if (!NAME_PATTERN.test(normalized)) {
      throw new Error('Skill name must be lowercase letters, numbers, and hyphens.');
    }

    const learnedPath = this.#skillPath('learned', normalized);
    const bundledPath = this.#skillPath('bundled', normalized);

    if (normalizedAction === 'delete') {
      if (fs.existsSync(bundledPath) && !fs.existsSync(learnedPath)) {
        throw new Error('Bundled skills cannot be deleted. Create a learned override instead.');
      }
      if (!fs.existsSync(learnedPath)) {
        throw new Error(`No learned skill named "${normalized}" to delete.`);
      }
      fs.rmSync(path.dirname(learnedPath), { recursive: true, force: true });
      return { action: 'delete', name: normalized, origin: 'learned' };
    }

    const desc = String(description || '').trim().slice(0, MAX_DESCRIPTION);
    const body = String(content || '').trim().slice(0, MAX_BODY);
    if (!desc) throw new Error('Skill description is required.');
    if (!body) throw new Error('Skill content/body is required.');

    if (normalizedAction === 'create') {
      if (fs.existsSync(learnedPath)) {
        throw new Error(`Learned skill "${normalized}" already exists. Use patch.`);
      }
      if (fs.existsSync(bundledPath)) {
        throw new Error(
          `Bundled skill "${normalized}" already exists. Use a new name or patch a learned override.`
        );
      }
      fs.mkdirSync(path.dirname(learnedPath), { recursive: true });
      fs.writeFileSync(
        learnedPath,
        renderSkillMarkdown({ name: normalized, description: desc, body }),
        'utf8'
      );
      return { action: 'create', name: normalized, origin: 'learned', path: learnedPath };
    }

    // patch
    let existingBody = body;
    let existingDesc = desc;
    if (fs.existsSync(learnedPath)) {
      const current = this.#readSkillFile(learnedPath, 'learned');
      existingDesc = desc || current.description;
      existingBody = body || current.body;
    } else if (fs.existsSync(bundledPath)) {
      // Learned override of a bundled skill.
      const current = this.#readSkillFile(bundledPath, 'bundled');
      existingDesc = desc || current.description;
      existingBody = body || current.body;
    }
    fs.mkdirSync(path.dirname(learnedPath), { recursive: true });
    fs.writeFileSync(
      learnedPath,
      renderSkillMarkdown({
        name: normalized,
        description: existingDesc,
        body: existingBody
      }),
      'utf8'
    );
    return { action: 'patch', name: normalized, origin: 'learned', path: learnedPath };
  }
}

module.exports = {
  SkillsStore,
  NAME_PATTERN,
  MAX_DESCRIPTION,
  MAX_BODY,
  slugifyName,
  parseFrontmatter,
  renderSkillMarkdown
};
