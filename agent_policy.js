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
  list_deletable_test_letters: 'read',
  list_pending_owner_actions: 'read',
  add_goal: 'reversible_write',
  update_goal_status: 'reversible_write',
  log_finance: 'reversible_write',
  save_semantic_memory: 'reversible_write',
  // Staging a deletion changes nothing on its own; only the confirm step destroys data.
  propose_test_letter_deletion: 'reversible_write',
  confirm_test_letter_deletion: 'destructive_write',
  // Same shape: staging an email changes nothing, only confirm sends it.
  propose_owner_email: 'reversible_write',
  confirm_owner_email: 'destructive_write',
  // Arbitrary recipient, unlike propose_owner_email above - the recipient IS
  // a real tool argument here, so external_action (not destructive_write)
  // is the honest label: this can affect something outside AURA's own data,
  // not just destroy a record within it. Safety comes entirely from the
  // mandatory propose/confirm gate, since there is no fixed-recipient
  // guarantee to fall back on.
  propose_email: 'reversible_write',
  confirm_email: 'external_action',
  // Calendar writes hit Google Calendar API (and may email invites). Same
  // propose → owner-approve → confirm gate as third-party email.
  propose_calendar_event: 'reversible_write',
  confirm_calendar_event: 'external_action',
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
  if (name === 'propose_test_letter_deletion' || name === 'confirm_test_letter_deletion') {
    requireString('letter_id', 300);
  }
  if (name === 'propose_owner_email') {
    requireString('subject', 300);
    requireString('body', 8000);
    if (args.pdf_content !== undefined) requireString('pdf_content', 20000);
  }
  if (name === 'confirm_owner_email') {
    requireString('action_id', 100);
    if (!/^[0-9a-f-]{8,100}$/i.test(args.action_id)) {
      throw new Error(`Invalid action_id for ${name}.`);
    }
  }
  if (name === 'propose_email') {
    requireString('to', 320);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.to.trim())) {
      throw new Error(`Invalid arguments for ${name}: to is not a valid email address.`);
    }
    requireString('subject', 300);
    requireString('body', 8000);
    if (args.pdf_content !== undefined) requireString('pdf_content', 20000);
  }
  if (name === 'confirm_email') {
    requireString('action_id', 100);
    if (!/^[0-9a-f-]{8,100}$/i.test(args.action_id)) {
      throw new Error(`Invalid action_id for ${name}.`);
    }
  }
  if (name === 'propose_calendar_event') {
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
  if (name === 'confirm_calendar_event') {
    requireString('action_id', 100);
    if (!/^[0-9a-f-]{8,100}$/i.test(args.action_id)) {
      throw new Error(`Invalid action_id for ${name}.`);
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
  if (name === 'save_semantic_memory') requireString('fact', 2000);

  if (name === 'update_goal_status') {
    const validNumericId = Number.isInteger(args.id) && args.id > 0;
    const validStringId = typeof args.id === 'string' && (
      /^[1-9][0-9]*$/.test(args.id) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.id)
    );
    if (!validNumericId && !validStringId) throw new Error('Goal id must be a positive integer or UUID.');
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
  parseAndAuthorizeToolCall,
  resolveOwnerSearchInput,
  validatePublicSearchInput,
  validateToolArguments
};
