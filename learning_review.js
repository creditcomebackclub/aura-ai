'use strict';

// Post-turn Hermes-style learning loop: after enough tool-heavy turns,
// ask the background model whether a reusable learned skill (or durable
// memory fact) should be written. Runs after the owner reply is sent.

const DEFAULT_TURN_INTERVAL = 10;
const DEFAULT_TOOL_ITER_INTERVAL = 10;

function boundedPositiveInteger(value, fallback, maximum = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.floor(parsed));
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    save_memory_facts: {
      type: 'array',
      items: { type: 'string' }
    },
    skill_action: {
      type: 'string',
      enum: ['create', 'patch', 'none']
    },
    skill_name: { type: 'string' },
    skill_description: { type: 'string' },
    skill_content: { type: 'string' },
    skill_reason: { type: 'string' },
    notes: { type: 'string' }
  },
  required: [
    'save_memory_facts',
    'skill_action',
    'skill_name',
    'skill_description',
    'skill_content',
    'skill_reason',
    'notes'
  ]
};

function buildReviewMessages({ transcript, skillIndex, toolCallCount }) {
  return [
    {
      role: 'system',
      content: [
        'You are AURA\'s background learning reviewer (Hermes-style closed loop).',
        'Decide whether this turn sequence produced a reusable procedural skill or durable owner facts.',
        'Rules:',
        '- Prefer skill.action "none" unless the workflow is class-level and reusable.',
        '- Prefer patching an existing learned skill over creating a one-off.',
        '- Never invent CCC schema, letter ids, or authorization bypasses.',
        '- Never propose deleting bundled skills or writing Tier-2/3 destructive flows as autonomous.',
        '- Skill bodies should be concise markdown procedures (When to use, steps, pitfalls).',
        '- Memory facts must be durable preferences/identity — not transient task chatter.',
        `Tool calls this turn: ${toolCallCount}.`,
        skillIndex ? `Current skills index:\n${skillIndex}` : 'No skills installed yet.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Transcript digest:\n${transcript}`
    }
  ];
}

class LearningReviewController {
  constructor({
    skillsStore,
    memoryV2,
    createReviewCompletion,
    logger = console,
    turnInterval = DEFAULT_TURN_INTERVAL,
    toolIterInterval = DEFAULT_TOOL_ITER_INTERVAL,
    enabled = true
  } = {}) {
    if (!skillsStore) throw new Error('skillsStore is required.');
    if (!createReviewCompletion) throw new Error('createReviewCompletion is required.');
    this.skillsStore = skillsStore;
    this.memoryV2 = memoryV2 || null;
    this.createReviewCompletion = createReviewCompletion;
    this.logger = logger;
    this.turnInterval = boundedPositiveInteger(turnInterval, DEFAULT_TURN_INTERVAL);
    this.toolIterInterval = boundedPositiveInteger(toolIterInterval, DEFAULT_TOOL_ITER_INTERVAL);
    this.enabled = enabled !== false;
    this.turnsSinceReview = 0;
    this.toolItersSinceReview = 0;
    this.running = null;
  }

  noteTurn({ toolCallCount = 0, transcript = '' } = {}) {
    if (!this.enabled) return { scheduled: false, reason: 'disabled' };
    this.turnsSinceReview += 1;
    this.toolItersSinceReview += Math.max(0, Number(toolCallCount) || 0);
    const dueByTurns = this.turnsSinceReview >= this.turnInterval;
    const dueByTools = this.toolItersSinceReview >= this.toolIterInterval && toolCallCount >= 3;
    if (!dueByTurns && !dueByTools) {
      return { scheduled: false, reason: 'intervals_not_met' };
    }
    if (!String(transcript || '').trim()) {
      return { scheduled: false, reason: 'empty_transcript' };
    }
    this.turnsSinceReview = 0;
    this.toolItersSinceReview = 0;
    this.#schedule(transcript, toolCallCount);
    return { scheduled: true, reason: dueByTools ? 'tool_iters' : 'turns' };
  }

  #schedule(transcript, toolCallCount) {
    if (this.running) return;
    this.running = this.runReview({ transcript, toolCallCount })
      .catch(error => {
        this.logger.warn('[Learning review] Failed:', error.message);
      })
      .finally(() => {
        this.running = null;
      });
  }

  async runReview({ transcript, toolCallCount = 0 } = {}) {
    const skillIndex = await this.skillsStore.buildIndexPrompt();
    const completion = await this.createReviewCompletion({
      messages: buildReviewMessages({ transcript, skillIndex, toolCallCount }),
      schema: REVIEW_SCHEMA
    });
    const parsed = typeof completion === 'string' ? JSON.parse(completion) : completion;
    const applied = { memories: [], skill: null };

    for (const fact of parsed.save_memory_facts || []) {
      const text = String(fact || '').trim();
      if (!text || !this.memoryV2?.learnFromUserMessage) continue;
      const result = await this.memoryV2.learnFromUserMessage(text, {
        source: 'learning_review',
        explicit: true
      });
      if (result.learned?.length) applied.memories.push(...result.learned);
    }

    const skillAction = String(parsed.skill_action || 'none').toLowerCase();
    if (skillAction === 'create' || skillAction === 'patch') {
      applied.skill = await this.skillsStore.manageSkill({
        action: skillAction,
        name: parsed.skill_name,
        description: parsed.skill_description,
        content: parsed.skill_content
      });
      this.logger.log(
        `[Learning review] skill ${applied.skill.action}: ${applied.skill.name}`
      );
    }

    return { parsed, applied };
  }
}

module.exports = {
  LearningReviewController,
  REVIEW_SCHEMA,
  buildReviewMessages,
  DEFAULT_TURN_INTERVAL,
  DEFAULT_TOOL_ITER_INTERVAL
};
