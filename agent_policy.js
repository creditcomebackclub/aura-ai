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
  add_goal: 'reversible_write',
  update_goal_status: 'reversible_write',
  log_finance: 'reversible_write',
  save_semantic_memory: 'reversible_write'
});

const SEARCH_SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[a-z0-9_-]{20,}\b/i,
  /\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*(?:is|[:=])\s*\S{8,}/i,
  /\b[a-f0-9]{48,}\b/i
];

function validatePublicSearchInput(value, maxLength = 1000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A public web search request is required.');
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`Public web search requests must be ${maxLength} characters or fewer.`);
  }
  if (SEARCH_SECRET_PATTERNS.some(pattern => pattern.test(normalized))) {
    throw new Error('Search query appears to contain a credential or secret.');
  }
  return normalized;
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
  if (name === 'add_goal') requireString('description', 1000);
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
  TOOL_POLICIES,
  getToolPolicy,
  parseAndAuthorizeToolCall,
  validatePublicSearchInput,
  validateToolArguments
};
