'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SkillsStore
} = require('../skills_store');
const { buildAlwaysOnMemorySlice } = require('../memory_v2');
const { LearningReviewController } = require('../learning_review');

test('skills store indexes bundled skills and loads full bodies', () => {
  const store = new SkillsStore({ rootDir: path.join(__dirname, '..', 'skills') });
  const skills = store.listSkills();
  assert.ok(skills.some(skill => skill.name === 'named-client-lookup'));
  const index = store.buildIndexPrompt();
  assert.match(index, /named-client-lookup/);
  assert.match(index, /view_skill/);
  assert.doesNotMatch(index, /progressive disclosure/i);
  const viewed = store.viewSkill('named-client-lookup');
  assert.equal(viewed.origin, 'bundled');
  assert.match(viewed.content, /get_client_snapshot/);
});

test('skills store writes learned skills and refuses bundled deletes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-skills-'));
  fs.mkdirSync(path.join(root, 'bundled', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'bundled', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Bundled demo\n---\n\n# Demo\n',
    'utf8'
  );
  const store = new SkillsStore({ rootDir: root });

  const created = store.manageSkill({
    action: 'create',
    name: 'morning-sweep',
    description: 'Reusable morning sweep',
    content: '## Steps\n1. Check mail\n2. Check calendar\n'
  });
  assert.equal(created.origin, 'learned');
  assert.equal(store.viewSkill('morning-sweep').origin, 'learned');

  assert.throws(
    () => store.manageSkill({ action: 'delete', name: 'demo' }),
    /Bundled skills cannot be deleted/
  );

  store.manageSkill({
    action: 'patch',
    name: 'demo',
    description: 'Override demo',
    content: '## Override\nUse learned steps.\n'
  });
  assert.equal(store.viewSkill('demo').origin, 'learned');

  store.manageSkill({ action: 'delete', name: 'morning-sweep' });
  assert.throws(() => store.viewSkill('morning-sweep'), /Unknown skill/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('always-on memory slice respects char cap and exclusions', () => {
  const slice = buildAlwaysOnMemorySlice([
    { kind: 'durable_fact', confidence: 0.9, content: 'Prefers morning meetings' },
    { kind: 'durable_fact', confidence: 0.8, content: 'Lives in Phoenix' }
  ], {
    maxChars: 120,
    excludeContents: ['Lives in Phoenix']
  });
  assert.match(slice, /ALWAYS-ON LONG-TERM MEMORY/);
  assert.match(slice, /Prefers morning meetings/);
  assert.doesNotMatch(slice, /Lives in Phoenix/);
});

test('learning review applies memory facts and skill creates from model output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-learn-'));
  const store = new SkillsStore({ rootDir: root });
  const learned = [];
  const controller = new LearningReviewController({
    skillsStore: store,
    memoryV2: {
      async learnFromUserMessage(fact) {
        learned.push(fact);
        return { learned: [{ value: fact }] };
      }
    },
    turnInterval: 1,
    toolIterInterval: 1,
    createReviewCompletion: async () => ({
      save_memory_facts: ['Chris prefers short morning briefs'],
      skill_action: 'create',
      skill_name: 'short-brief',
      skill_description: 'Keep morning briefs short',
      skill_content: '## Steps\nLead with calendar then goals.\n',
      skill_reason: 'repeated preference',
      notes: ''
    })
  });

  const result = await controller.runReview({
    transcript: 'Owner: keep briefs short\nAURA: okay',
    toolCallCount: 4
  });
  assert.equal(learned[0], 'Chris prefers short morning briefs');
  assert.equal(result.applied.skill.name, 'short-brief');
  assert.equal(store.viewSkill('short-brief').origin, 'learned');
  fs.rmSync(root, { recursive: true, force: true });
});
