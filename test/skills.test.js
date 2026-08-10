'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SkillsStore
} = require('../skills_store');
const { DurableSkillsStore } = require('../durable_skills_store');
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

test('durable skills store persists learned skills through the owner state store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-durable-skills-'));
  const rows = new Map();
  let revision = 0;
  const stateStore = {
    async getState(key) { return rows.get(key)?.value ?? null; },
    async getStateRow(key) { return rows.get(key) || null; },
    async compareAndSetState(key, expectedUpdatedAt, value) {
      const current = rows.get(key) || null;
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
      rows.set(key, { value, updated_at: String(++revision) });
      return true;
    }
  };
  const store = new DurableSkillsStore({
    localStore: new SkillsStore({ rootDir: root }),
    stateStore
  });
  const created = await store.manageSkill({
    action: 'create',
    name: 'handoff-notes',
    description: 'Prepare concise handoff notes',
    content: '## Steps\n1. State the outcome.\n'
  });
  assert.equal(created.durable, true);
  const reloaded = new DurableSkillsStore({
    localStore: new SkillsStore({ rootDir: root }),
    stateStore
  });
  assert.equal((await reloaded.viewSkill('handoff-notes')).origin, 'learned');
  await reloaded.manageSkill({ action: 'delete', name: 'handoff-notes' });
  await assert.rejects(reloaded.viewSkill('handoff-notes'), /Unknown skill/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('always-on memory slice respects char cap and exclusions', () => {
  const slice = buildAlwaysOnMemorySlice([
    { kind: 'durable_fact', confidence: 0.9, content: 'Prefers morning meetings' },
    { kind: 'durable_fact', confidence: 0.8, content: 'Lives in Phoenix' },
    { kind: 'episode', confidence: 0.9, content: 'A one-time meeting was rescheduled' }
  ], {
    maxChars: 120,
    excludeContents: ['Lives in Phoenix']
  });
  assert.match(slice, /ALWAYS-ON LONG-TERM MEMORY/);
  assert.match(slice, /Prefers morning meetings/);
  assert.doesNotMatch(slice, /Lives in Phoenix/);
  assert.doesNotMatch(slice, /one-time meeting/);
});

test('learning review applies memory facts and skill creates from model output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-learn-'));
  const store = new SkillsStore({ rootDir: root });
  const learned = [];
  const episodes = [];
  const beliefs = [];
  const controller = new LearningReviewController({
    skillsStore: store,
    beliefStore: {
      async list() { return []; },
      async consider(candidate, evidence) {
        beliefs.push({ candidate, evidence });
        return { applied: true, action: 'created' };
      }
    },
    memoryV2: {
      async learnFromUserMessage(fact) {
        learned.push(fact);
        return { learned: [{ value: fact }] };
      },
      async listEpisodes() {
        return [
          { id: 'episode-1', confidence: 0.9, content: 'Briefs worked better when concise.' },
          { id: 'episode-2', confidence: 0.8, content: 'A second concise brief was accepted.' }
        ];
      },
      async rememberEpisode(episode) {
        episodes.push(episode);
        return { saved: true, id: 9 };
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
      skill_confidence: 0.92,
      skill_evidence: ['Experience 1: owner explicitly corrected brief length'],
      episode_summary: 'Chris established a shorter morning-brief workflow.',
      episode_outcome: 'The concise format became a learned procedure.',
      episode_entities: ['morning brief'],
      episode_importance: 0.8,
      belief_action: 'consolidate',
      belief_key: 'brief.concise',
      belief_statement: 'Morning briefs work best when concise.',
      belief_confidence: 0.88,
      belief_supporting_episode_ids: ['episode-1', 'episode-2'],
      belief_contradicting_episode_ids: [],
      belief_reason: 'Two successful episodes support the pattern.',
      notes: ''
    })
  });

  const result = await controller.runReview({
    transcript: 'Owner: keep briefs short\nAURA: okay',
    toolCallCount: 4
  });
  assert.equal(learned[0], 'Chris prefers short morning briefs');
  assert.equal(episodes[0].importance, 0.8);
  assert.equal(result.applied.episode.saved, true);
  assert.equal(beliefs[0].candidate.key, 'brief.concise');
  assert.equal(beliefs[0].evidence.length, 2);
  assert.equal(result.applied.belief.action, 'created');
  assert.equal(result.applied.skill.name, 'short-brief');
  assert.equal(store.viewSkill('short-brief').origin, 'learned');
  fs.rmSync(root, { recursive: true, force: true });
});

test('learning review durably reflects across multiple turns after a restart', async () => {
  const rows = new Map();
  let revision = 0;
  const stateStore = {
    async getStateRow(key) { return rows.get(key) || null; },
    async compareAndSetState(key, expectedUpdatedAt, value) {
      const current = rows.get(key) || null;
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
      rows.set(key, { value, updated_at: String(++revision) });
      return true;
    }
  };
  const reviews = [];
  const makeController = () => new LearningReviewController({
    stateStore,
    skillsStore: {
      async buildIndexPrompt() { return ''; },
      async manageSkill() { throw new Error('No skill should be written.'); }
    },
    turnInterval: 2,
    toolIterInterval: 99,
    createReviewCompletion: async ({ messages }) => {
      reviews.push(messages.at(-1).content);
      return {
        save_memory_facts: [],
        skill_action: 'none',
        skill_name: '',
        skill_description: '',
        skill_content: '',
        skill_reason: '',
        skill_confidence: 0,
        skill_evidence: [],
        notes: ''
      };
    }
  });

  const beforeRestart = makeController();
  beforeRestart.noteTurn({ transcript: 'Owner: first preference\nAURA: noted' });
  await beforeRestart.flush();

  const afterRestart = makeController();
  afterRestart.noteTurn({ transcript: 'Owner: second preference\nAURA: noted' });
  await afterRestart.flush();

  assert.equal(reviews.length, 1);
  assert.match(reviews[0], /first preference/);
  assert.match(reviews[0], /second preference/);
  const state = [...rows.values()][0].value;
  assert.equal(state.turns_since_review, 0);
  assert.deepEqual(state.experiences, []);
});

test('learning review rejects unsupported low-confidence skill changes', async () => {
  let writes = 0;
  const controller = new LearningReviewController({
    skillsStore: {
      async buildIndexPrompt() { return ''; },
      async manageSkill() { writes += 1; }
    },
    createReviewCompletion: async () => ({
      save_memory_facts: [],
      skill_action: 'create',
      skill_name: 'guessy-workflow',
      skill_description: 'An unsupported guess',
      skill_content: '## Steps\nGuess.\n',
      skill_reason: 'maybe useful',
      skill_confidence: 0.4,
      skill_evidence: ['One ambiguous interaction'],
      notes: ''
    })
  });
  const result = await controller.runReview({ transcript: 'Ambiguous turn' });
  assert.equal(writes, 0);
  assert.match(result.applied.skill_skipped, /confidence_below/);
});

test('failed durable reflection remains pending and resumes after restart', async () => {
  const rows = new Map();
  let revision = 0;
  const stateStore = {
    async getStateRow(key) { return rows.get(key) || null; },
    async compareAndSetState(key, expectedUpdatedAt, value) {
      const current = rows.get(key) || null;
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return false;
      rows.set(key, { value, updated_at: String(++revision) });
      return true;
    }
  };
  const skillsStore = {
    async buildIndexPrompt() { return ''; },
    async manageSkill() { throw new Error('No skill should be written.'); }
  };
  const completion = {
    save_memory_facts: [],
    skill_action: 'none',
    skill_name: '',
    skill_description: '',
    skill_content: '',
    skill_reason: '',
    skill_confidence: 0,
    skill_evidence: [],
    notes: ''
  };
  const quietLogger = { warn() {}, log() {} };
  const failing = new LearningReviewController({
    stateStore,
    skillsStore,
    logger: quietLogger,
    turnInterval: 1,
    createReviewCompletion: async () => { throw new Error('temporary outage'); }
  });
  failing.noteTurn({ transcript: 'Owner: retain this experience' });
  await failing.flush();

  const storedRow = [...rows.values()][0];
  assert.equal(storedRow.value.pending_review.status, 'retry_wait');
  assert.equal(storedRow.value.pending_review.attempts, 1);
  assert.match(storedRow.value.pending_review.experiences[0].transcript, /retain this experience/);
  storedRow.value.pending_review.available_at = new Date(Date.now() - 1000).toISOString();

  let recovered = 0;
  const restarted = new LearningReviewController({
    stateStore,
    skillsStore,
    logger: quietLogger,
    turnInterval: 1,
    createReviewCompletion: async () => {
      recovered += 1;
      return completion;
    }
  });
  assert.equal((await restarted.resume()).resumed, true);
  await restarted.flush();
  assert.equal(recovered, 1);
  assert.equal([...rows.values()][0].value.pending_review, null);
});

test('learning review receives structured skill outcomes and owner feedback', async () => {
  let reviewPrompt = '';
  const controller = new LearningReviewController({
    skillsStore: { async buildIndexPrompt() { return ''; } },
    outcomeStore: {
      async list() {
        return [{
          skill_name: 'client-sweep',
          skill_version: 3,
          status: 'partial',
          tools: [{ name: 'get_client_snapshot', ok: false }],
          feedback: 'negative',
          feedback_text: 'That client was active.'
        }];
      }
    },
    createReviewCompletion: async ({ messages }) => {
      reviewPrompt = messages[0].content;
      return {
        save_memory_facts: [],
        skill_action: 'none',
        skill_name: '',
        skill_description: '',
        skill_content: '',
        skill_reason: '',
        skill_confidence: 0,
        skill_evidence: [],
        notes: ''
      };
    }
  });
  await controller.runReview({ transcript: 'A later reflection batch.' });
  assert.match(reviewPrompt, /client-sweep@v3/);
  assert.match(reviewPrompt, /get_client_snapshot=failure/);
  assert.match(reviewPrompt, /That client was active/);
});
