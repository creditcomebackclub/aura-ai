const {
  normalizeApprovalCode,
  normalizeDraftInput,
  normalizeRelationshipInput
} = require('./linkedin_relationship');

const TOOL_POLICIES = Object.freeze({
  list_database_tables: 'read',
  get_table_schema: 'read',
  query_database_table: 'read',
  count_database_rows: 'read',
  get_outstanding_balances: 'read',
  calculate_financial_metrics: 'read',
  get_client_snapshot: 'read',
  get_client_current_phase: 'read',
  check_email: 'read',
  check_calendar: 'read',
  get_goals: 'read',
  query_finances: 'read',
  check_blackboard: 'read',
  search_web: 'read',
  list_linkedin_relationships: 'read',
  get_linkedin_relationship_context: 'read',
  save_linkedin_relationship_context: 'reversible_write',
  draft_linkedin_message: 'reversible_write',
  approve_linkedin_message: 'external_action',
  reject_linkedin_message: 'reversible_write',
  list_deletable_test_letters: 'read',
  add_goal: 'reversible_write',
  get_reminders: 'read',
  set_reminder: 'reversible_write',
  cancel_reminder: 'reversible_write',
  set_goal_plan: 'reversible_write',
  update_goal_step: 'reversible_write',
  update_goal_status: 'reversible_write',
  get_goal_plans: 'read',
  log_finance: 'reversible_write',
  save_semantic_memory: 'reversible_write',
  list_skills: 'read',
  view_skill: 'read',
  manage_skill: 'reversible_write',
  // Staging a deletion changes nothing on its own; only the confirm step destroys data.
  propose_test_letter_deletion: 'reversible_write',
  confirm_test_letter_deletion: 'destructive_write',
  // A clear current-turn owner command authorizes immediate email delivery.
  // Owner mail has a fixed configured recipient; arbitrary-recipient mail is
  // additionally checked against the exact address in the raw owner message.
  send_owner_email: 'destructive_write',
  send_email: 'external_action',
  // A direct owner scheduling command authorizes this reversible write in the
  // same turn. The handler independently checks the raw owner instruction;
  // model-composed arguments alone can never authorize a calendar mutation.
  create_calendar_event: 'reversible_write',
  reschedule_calendar_event: 'reversible_write',
  // Cancelling can notify attendees and removes the event, so keep its risk
  // distinct even though a direct current-turn owner command executes it.
  cancel_calendar_event: 'external_action',
  // No staging - the recipient is fixed to the owner's own chat regardless,
  // so a confirmation step protects against nothing here (unlike email).
  send_telegram_message: 'destructive_write'
});

const SEARCH_SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[a-z0-9_-]{20,}\b/i,
  /\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*(?:is|[:=])\s*\S{8,}/i,
  /\b[a-f0-9]{48,}\b/i,
  // Common cloud/VCS tokens the owner might paste into a "was this leaked?" ask.
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bgho_[a-zA-Z0-9]{20,}\b/,
  /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/,
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsb_secret_[a-zA-Z0-9_-]{20,}\b/,
  /\bBearer\s+[a-zA-Z0-9._\-+/=]{20,}\b/i
];

const OWNER_SEARCH_INPUT_MAX_LENGTH = 1000;

function containsSearchSecret(value) {
  return SEARCH_SECRET_PATTERNS.some(pattern => pattern.test(value));
}

function validatePublicSearchInput(value, maxLength = 1000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A public web search request is required.');
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Public web search requests must be ${maxLength} characters or fewer.`);
  }
  if (containsSearchSecret(normalized)) {
    throw new Error('Search query appears to contain a credential or secret.');
  }
  return normalized;
}

// Decides whether the owner's own message can stand in as the live-search
// input. AURA prefers the owner's literal words over anything the model
// composes, but processOwnerText accepts messages up to 10,000 characters
// while a usable search input is far shorter - and that input becomes the
// prompt for a web-enabled sub-model, so an unbounded paste is both a token
// cost and a prompt-injection surface. Past maxLength this returns null, and
// the caller falls back to the model's own `query` argument, which
// validateToolArguments already caps at 500 characters and screens with the
// same secret patterns. Returning null rather than throwing is the entire
// point: pasting an article or a long error log alongside a short question
// used to fail the search outright, with nothing explaining why.
//
// The credential screen is deliberately NOT length-gated. A pasted secret
// must block the public search at any message length, so this throws instead
// of falling back - the model's query could paraphrase the secret's context
// even though the secret itself would be screened out of args.query.
function resolveOwnerSearchInput(value, maxLength = OWNER_SEARCH_INPUT_MAX_LENGTH) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A public web search request is required.');
  }
  const normalized = value.trim();
  if (containsSearchSecret(normalized)) {
    const error = new Error(
      'That message looks like it contains a credential or secret, so it was not sent to a public web search.'
    );
    error.code = 'WEB_SEARCH_SECRET_IN_INPUT';
    throw error;
  }
  return normalized.length > maxLength ? null : normalized;
}

function getToolPolicy(name) {
  return TOOL_POLICIES[name] || 'blocked';
}

function isExplicitSkillManagementRequest(message, action) {
  const text = String(message || '').trim();
  if (!text) return false;
  const prefix = '^(?:aura[,:]?\\s*)?(?:please\\s+|can you\\s+|could you\\s+|i want you to\\s+)?';
  const patterns = {
    create: new RegExp(`${prefix}(?:create|add|save|teach|learn|remember|make)\\b.{0,160}\\b(?:skill|workflow|procedure|playbook)\\b`, 'i'),
    patch: new RegExp(`${prefix}(?:update|change|edit|patch|revise|improve|fix|override)\\b.{0,160}\\b(?:skill|workflow|procedure|playbook)\\b`, 'i'),
    delete: new RegExp(`${prefix}(?:delete|remove|forget|discard)\\b.{0,160}\\b(?:skill|workflow|procedure|playbook)\\b`, 'i')
  };
  return Boolean(patterns[action]?.test(text));
}

function validateToolArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${name}: expected an object.`);
  }

  const requireString = (key, max = 1000) => {
    if (typeof args[key] !== 'string' || !args[key].trim()) {
      throw new Error(`Invalid arguments for ${name}: ${key} is required.`);
    }
    if (args[key].length > max) {
      throw new Error(`Invalid arguments for ${name}: ${key} is too long.`);
    }
  };

  const requireGoalId = (value, label = 'Goal id') => {
    const validNumericId = Number.isInteger(value) && value > 0;
    const validStringId = typeof value === 'string' && (
      /^[1-9][0-9]*$/.test(value) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
    if (!validNumericId && !validStringId) {
      throw new Error(`${label} must be a positive integer or UUID.`);
    }
  };

  const requireUuid = (value, label) => {
    if (typeof value !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`${label} must be a UUID.`);
    }
  };

  if (['get_table_schema', 'query_database_table', 'count_database_rows'].includes(name)) {
    requireString('table_name', 80);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(args.table_name)) {
      throw new Error(`Invalid table name: ${args.table_name}`);
    }
  }

  if (name === 'get_client_snapshot' || name === 'get_client_current_phase') {
    requireString('name', 200);
  }
  if (name === 'search_web') {
    requireString('query', 500);
    validatePublicSearchInput(args.query, 500);
  }
  if (name === 'save_linkedin_relationship_context') {
    Object.assign(args, normalizeRelationshipInput(args));
  }
  if (name === 'get_linkedin_relationship_context') {
    requireUuid(args.relationship_id, 'LinkedIn relationship id');
  }
  if (name === 'draft_linkedin_message') {
    for (const prohibited of ['recipients', 'audience', 'search_filter', 'schedule_at', 'auto_follow_up']) {
      if (args[prohibited] !== undefined) {
        throw new Error(`LinkedIn drafts cannot include ${prohibited}; only one selected relationship is allowed.`);
      }
    }
    requireUuid(args.relationship_id, 'LinkedIn relationship id');
    requireString('context_receipt', 64);
    if (!/^[a-f0-9]{64}$/.test(args.context_receipt)) {
      throw new Error('LinkedIn context receipt must be the exact value returned by the context tool.');
    }
    if (args.supersedes_draft_id !== undefined && args.supersedes_draft_id !== null) {
      requireUuid(args.supersedes_draft_id, 'Superseded LinkedIn draft id');
    }
    Object.assign(args, normalizeDraftInput(args));
  }
  if (name === 'approve_linkedin_message' || name === 'reject_linkedin_message') {
    args.approval_code = normalizeApprovalCode(args.approval_code);
  }
  if (name === 'propose_test_letter_deletion' || name === 'confirm_test_letter_deletion') {
    requireString('letter_id', 300);
  }
  if (name === 'send_owner_email') {
    requireString('subject', 300);
    requireString('body', 8000);
    if (args.pdf_content !== undefined) requireString('pdf_content', 20000);
  }
  if (name === 'send_email') {
    requireString('to', 320);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.to.trim())) {
      throw new Error(`Invalid arguments for ${name}: to is not a valid email address.`);
    }
    requireString('subject', 300);
    requireString('body', 8000);
    if (args.pdf_content !== undefined) requireString('pdf_content', 20000);
  }
  if (name === 'create_calendar_event') {
    requireString('summary', 500);
    requireString('start', 80);
    if (args.end !== undefined && args.end !== null) requireString('end', 80);
    if (args.description !== undefined && args.description !== null) {
      requireString('description', 8000);
    }
    if (args.location !== undefined && args.location !== null) {
      requireString('location', 500);
    }
    if (args.time_zone !== undefined && args.time_zone !== null) {
      requireString('time_zone', 80);
    }
    if (args.duration_minutes !== undefined && args.duration_minutes !== null) {
      const minutes = Number(args.duration_minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) {
        throw new Error('duration_minutes must be between 1 and 1440.');
      }
      args.duration_minutes = Math.trunc(minutes);
    }
    if (args.attendees !== undefined && args.attendees !== null) {
      if (!Array.isArray(args.attendees)) {
        throw new Error('attendees must be an array of email addresses.');
      }
      if (args.attendees.length > 20) {
        throw new Error('attendees supports at most 20 addresses.');
      }
      args.attendees = args.attendees.map(email => {
        if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
          throw new Error('Each attendee must be a valid email address.');
        }
        return email.trim().toLowerCase();
      });
    }
  }
  if (name === 'reschedule_calendar_event' || name === 'cancel_calendar_event') {
    requireString('event_query', 500);
    if (args.original_start !== undefined && args.original_start !== null) {
      requireString('original_start', 80);
    }
    if (args.time_zone !== undefined && args.time_zone !== null) {
      requireString('time_zone', 80);
    }
    if (name === 'reschedule_calendar_event') {
      requireString('new_start', 80);
    }
  }
  if (name === 'send_telegram_message') {
    requireString('message', 4000);
  }
  if (name === 'add_goal') {
    requireString('description', 1000);
    if (args.due_at !== undefined && args.due_at !== null) {
      if (typeof args.due_at !== 'string' || args.due_at.length > 80) {
        throw new Error('Goal due_at must be a short date string.');
      }
    }
  }
  if (name === 'set_reminder') {
    requireString('message', 1000);
    requireString('when', 120);
    if (!['once', 'daily', 'weekly'].includes(args.recurrence)) {
      throw new Error('Reminder recurrence must be once, daily, or weekly.');
    }
  }
  if (name === 'cancel_reminder') requireGoalId(args.id, 'Reminder id');
  if (name === 'set_goal_plan') {
    if (args.id !== undefined && args.id !== null) requireGoalId(args.id);
    requireString('title', 1000);
    requireString('desired_outcome', 1200);
    if (args.due_at !== undefined && args.due_at !== null &&
        (typeof args.due_at !== 'string' || args.due_at.length > 80)) {
      throw new Error('Goal plan due_at must be a short date string.');
    }
    if (!Array.isArray(args.steps) || args.steps.length < 2 || args.steps.length > 12) {
      throw new Error('Goal plans require between 2 and 12 steps.');
    }
    const seen = new Set();
    args.steps = args.steps.map(step => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error('Each goal plan step must be an object.');
      }
      if (typeof step.title !== 'string' || !step.title.trim() || step.title.length > 500) {
        throw new Error('Each goal plan step requires a title of 500 characters or fewer.');
      }
      const key = step.title.trim().replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) throw new Error('Goal plan steps must have unique titles.');
      seen.add(key);
      if (step.due_at !== undefined && step.due_at !== null &&
          (typeof step.due_at !== 'string' || step.due_at.length > 80)) {
        throw new Error('Goal plan step due_at must be a short date string.');
      }
      return {
        title: step.title.trim().replace(/\s+/g, ' '),
        ...(step.due_at !== undefined ? { due_at: step.due_at } : {})
      };
    });
    if (containsSearchSecret([
      args.title,
      args.desired_outcome,
      ...args.steps.map(step => step.title)
    ].join('\n'))) {
      throw new Error('Goal plans cannot contain credentials or secrets.');
    }
  }
  if (name === 'update_goal_step') {
    requireGoalId(args.goal_id);
    requireString('step_id', 80);
    if (!['pending', 'active', 'blocked', 'completed', 'dropped'].includes(args.status)) {
      throw new Error('Invalid goal step status.');
    }
  }
  if (name === 'save_semantic_memory') requireString('fact', 2000);
  if (name === 'view_skill') requireString('name', 80);
  if (name === 'manage_skill') {
    if (!['create', 'patch', 'delete'].includes(args.action)) {
      throw new Error('manage_skill action must be create, patch, or delete.');
    }
    requireString('name', 80);
    if (args.action === 'create' || args.action === 'patch') {
      requireString('description', 240);
      requireString('content', 24000);
      if (containsSearchSecret(`${args.description}\n${args.content}`)) {
        throw new Error('Skill content cannot contain credentials or secrets.');
      }
    }
  }

  if (name === 'update_goal_status') {
    requireGoalId(args.id);
    if (!['pending', 'active', 'paused', 'completed', 'dropped'].includes(args.status)) {
      throw new Error('Invalid goal status.');
    }
  }

  if (name === 'log_finance') {
    if (!Number.isFinite(args.amount) || Math.abs(args.amount) > 100000000) {
      throw new Error('Finance amount must be a reasonable number.');
    }
    requireString('category', 100);
    if (args.description !== undefined && typeof args.description !== 'string') {
      throw new Error('Finance description must be text.');
    }
  }

  if (args.limit !== undefined) {
    args.limit = Math.max(1, Math.min(200, Math.trunc(Number(args.limit) || 0)));
  }

  if (args.filters !== undefined) {
    if (!Array.isArray(args.filters) || args.filters.length > 12) {
      throw new Error('Filters must be an array with at most 12 entries.');
    }
    const allowedOps = new Set(['eq', 'match', 'is_null', 'not_null', 'gt', 'gte', 'lt', 'lte']);
    for (const filter of args.filters) {
      if (!filter || typeof filter.column !== 'string' ||
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(filter.column) ||
          (filter.op && !allowedOps.has(filter.op))) {
        throw new Error('Invalid database filter.');
      }
    }
  }

  return args;
}

function parseAndAuthorizeToolCall(toolCall) {
  const name = toolCall?.function?.name;
  const policy = getToolPolicy(name);
  if (policy === 'blocked') throw new Error(`Tool is not authorized: ${name || 'unknown'}`);

  let args;
  try {
    args = JSON.parse(toolCall.function.arguments || '{}');
  } catch {
    throw new Error(`Invalid JSON arguments for ${name}.`);
  }

  return { name, policy, args: validateToolArguments(name, args) };
}

module.exports = {
  OWNER_SEARCH_INPUT_MAX_LENGTH,
  TOOL_POLICIES,
  containsSearchSecret,
  getToolPolicy,
  isExplicitSkillManagementRequest,
  parseAndAuthorizeToolCall,
  resolveOwnerSearchInput,
  validatePublicSearchInput,
  validateToolArguments
};
