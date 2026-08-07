'use strict';

// Pure helpers for per-turn tool selection and the lightweight chit-chat
// fast path. Kept out of server.js so tests can exercise them without
// booting Express / OpenAI / Supabase.

const BUSINESS_INTEL_TOOL_NAMES = new Set([
  'list_database_tables',
  'get_table_schema',
  'query_database_table',
  'get_outstanding_balances',
  'list_deletable_test_letters',
  'propose_test_letter_deletion',
  'confirm_test_letter_deletion',
  'get_client_snapshot',
  'get_client_current_phase',
  'count_database_rows',
  'calculate_financial_metrics'
]);

const OUTBOUND_EMAIL_TOOL_NAMES = new Set([
  'send_owner_email',
  'send_email'
]);

const CALENDAR_WRITE_TOOL_NAMES = new Set([
  'create_calendar_event'
]);

const GOAL_TOOL_NAMES = new Set(['get_goals', 'add_goal', 'update_goal_status']);
const BLACKBOARD_TOOL_NAMES = new Set(['check_blackboard']);
const TELEGRAM_TOOL_NAMES = new Set(['send_telegram_message']);
const WEB_SEARCH_TOOL_NAMES = new Set(['search_web']);
const SKILL_TOOL_NAMES = new Set(['list_skills', 'view_skill', 'manage_skill']);
const PERSONAL_FINANCE_TOOL_NAMES = new Set(['log_finance', 'query_finances']);
const MEMORY_WRITE_TOOL_NAMES = new Set(['save_semantic_memory']);
const EMAIL_READ_TOOL_NAMES = new Set(['check_email']);
const CALENDAR_READ_TOOL_NAMES = new Set(['check_calendar']);

const BUSINESS_INTEL_KEYWORD_PATTERN = new RegExp(
  '\\b(' + [
    'client', 'clients', 'customer', 'customers', 'balance', 'balances', 'owe', 'owes',
    'owing', 'invoice', 'invoices', 'payment', 'payments', 'paid', 'unpaid', 'delinquent',
    'overdue', 'database', 'table', 'tables', 'row', 'rows', 'letter', 'letters',
    'furnisher', 'furnishers', 'phase', 'dispute', 'disputes', 'ledger', 'finance',
    'financial', 'revenue', 'mailed', 'scratch', 'ccc', 'credit comeback', 'how many',
    // mmr = common speech/typo for mrr (Whisper often spells it that way)
    'mrr', 'mmr', 'commission'
  ].join('|') + ')\\b',
  'i'
);

const OUTBOUND_EMAIL_KEYWORD_PATTERN = /\b(email|e-?mail|send)\b/i;
const CALENDAR_WRITE_KEYWORD_PATTERN = /\b(schedule|scheduling|scheduled|book|booking|invite|invitation|calendar event|add (?:this |it |an? )?to (?:my )?calendar|put .+ on (?:my )?calendar|block off|hold on my calendar)\b/i;
const HEAVY_CONTEXT_KEYWORD_PATTERN = /\b(email|e-?mail|calendar|blackboard|goal|goals|todo|to-do|search|remember|memory|profile|mail|consult|consultation|schedule|book|invite|skill|skills|procedure|workflow)\b/i;
const GOAL_KEYWORD_PATTERN = /\b(goal|goals|todo|to-?do|task|tasks)\b/i;
const BLACKBOARD_KEYWORD_PATTERN = /\b(blackboard|consult|consultation)\b/i;
const TELEGRAM_KEYWORD_PATTERN = /\b(telegram|text (?:him|her|me|chris)|message (?:chris|me))\b/i;
const WEB_SEARCH_KEYWORD_PATTERN = /\b(search(?:\s+the)?\s+web|google|look\s+(?:it\s+)?up online|web\s+search|latest news|weather|who is|what(?:'s| is) (?:the )?(?:news|score|price of))\b/i;
const SKILL_KEYWORD_PATTERN = /\b(skill|skills|workflow|procedure|playbook)\b/i;
const PERSONAL_FINANCE_KEYWORD_PATTERN = /\b(expense|expenses|spent|spending|budget|log (?:a )?purchase)\b/i;
const MEMORY_WRITE_KEYWORD_PATTERN = /\b(remember(?:\s+that|\s+this)?|save (?:this|that)|memorize)\b/i;
const EMAIL_READ_KEYWORD_PATTERN = /\b(email|e-?mail|inbox|mail)\b/i;
const CALENDAR_READ_KEYWORD_PATTERN = /\b(calendar|schedule|meeting|meetings|appointment|agenda|am i free|what'?s on)\b/i;

// Embedding + in-process scan of up to 1000 memory rows is multi-second.
// Only pay that when the turn actually asks for long-term recall.
const SEMANTIC_MEMORY_PATTERN = /\b(remember|memory|memories|recall|forgot|forget|last time|you (?:said|told|mentioned)|we (?:talked|discussed|decided)|preference|allergic|birthday|anniversary|wife|kids?|dog|profile)\b/i;

// A short follow-up ("What about for his wife, Mary?", "Is her POA signed?")
// carries no business keyword of its own - it leans entirely on the client
// already established a turn or two earlier. Checking `text` alone drops
// every business tool for that turn, and the model has no way to tell the
// difference between "these tools don't exist" and "not offered this turn" -
// it reports the former, which reads as a false capability claim. Checking
// the tail of recent history too means a follow-up inherits its parent
// turn's relevance instead of needing its own trigger word.
const BUSINESS_INTEL_HISTORY_LOOKBACK = 6;

// Short greets / vibes only — allowlist, not "everything short without a
// business keyword." The old denylist treated "What's my MMR?" as lightweight
// (Whisper spelled MRR as MMR), stripped finance tools, and she spent ~10s
// asking "Do you mean MRR?" instead of answering.
const LIGHTWEIGHT_MAX_CHARS = 80;
const LIGHTWEIGHT_HISTORY_LIMIT = 4;
const DEFAULT_HISTORY_LIMIT = 12;
const FULL_HISTORY_LIMIT = 30;
const LIGHTWEIGHT_GREET_PATTERN = /^(?:hey(?:\s+there|\s+aura)?|hi(?:\s+there|\s+aura)?|hello(?:\s+aura)?|yo|sup|howdy|good\s+(?:morning|afternoon|evening)(?:\s+aura)?|(?:what'?s|whats)\s+up(?:\s+aura)?|how(?:'s|\s+are|\s+is)\s+(?:it\s+going|you(?:\s+doing)?|things)(?:\s+going)?|how\s+goes(?:\s+it)?|just\s+checking\s+in)(?:[\s,.!?;:].*)?$/i;

// Pure metric reads ("what's my MRR?", "yes I meant MRR") don't need vector
// memory, skills index, or a tool round — prefetch numbers and answer in one shot.
const DIRECT_METRICS_MAX_CHARS = 160;
const DIRECT_METRICS_HISTORY_LIMIT = 8;
const DIRECT_METRICS_PATTERN = /\b(mrr|mmr|outstanding(?:\s+balances?)?|lifetime\s+revenue|commission(?:\s+owed)?|(?:monthly\s+)?recurring\s+revenue|financial\s+metrics)\b/i;

function isLightweightChitchat(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > LIGHTWEIGHT_MAX_CHARS) return false;
  if (BUSINESS_INTEL_KEYWORD_PATTERN.test(trimmed)) return false;
  if (HEAVY_CONTEXT_KEYWORD_PATTERN.test(trimmed)) return false;
  if (OUTBOUND_EMAIL_KEYWORD_PATTERN.test(trimmed)) return false;
  if (CALENDAR_WRITE_KEYWORD_PATTERN.test(trimmed)) return false;
  return LIGHTWEIGHT_GREET_PATTERN.test(trimmed);
}

function needsSemanticMemory(text) {
  return SEMANTIC_MEMORY_PATTERN.test(String(text || ''));
}

function isDirectFinancialMetricsAsk(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > DIRECT_METRICS_MAX_CHARS) return false;
  // Multi-intent turns still need the normal tool loop.
  if (/\b(client|clients|letter|letters|phase|email|e-?mail|calendar|send|search)\b/i.test(trimmed)) {
    return false;
  }
  return DIRECT_METRICS_PATTERN.test(trimmed);
}

function shouldSkipSemanticMemory(text) {
  if (isLightweightChitchat(text)) return true;
  if (isDirectFinancialMetricsAsk(text)) return true;
  // Default skip: most turns don't need the embed + 1000-row scan.
  return !needsSemanticMemory(text);
}

function shouldSkipHeavyMemory(text) {
  return shouldSkipSemanticMemory(text);
}

function formatFinancialMetricsPromptBlock(metricsJson) {
  const body = String(metricsJson || '').trim();
  if (!body || body.startsWith('Error')) return '';
  return (
    '\nCURRENT FINANCIAL METRICS (fetched just now for this turn — authoritative ' +
    'live numbers; answer from these in one short spoken sentence; do not call ' +
    'calculate_financial_metrics):\n' +
    body +
    '\n'
  );
}

function dropToolsByName(tools, names) {
  return tools.filter(tool => !names.has(tool.function.name));
}

function selectToolsForTurn(tools, text, recentMessages = []) {
  const recentText = recentMessages
    .slice(-BUSINESS_INTEL_HISTORY_LOOKBACK)
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join(' ');
  const combined = `${recentText} ${text || ''}`;
  let selected = tools;
  if (!BUSINESS_INTEL_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, BUSINESS_INTEL_TOOL_NAMES);
  }
  const needsEmailTools = OUTBOUND_EMAIL_KEYWORD_PATTERN.test(combined);
  const needsCalendarWriteTools = CALENDAR_WRITE_KEYWORD_PATTERN.test(combined);
  if (!needsEmailTools) {
    selected = dropToolsByName(selected, OUTBOUND_EMAIL_TOOL_NAMES);
  }
  if (!needsCalendarWriteTools) {
    selected = dropToolsByName(selected, CALENDAR_WRITE_TOOL_NAMES);
  }
  // Keyword-gate the always-on noise tools. Shipping 14+ schemas on every
  // turn costs TTFT and tempts silent tool rounds before speech.
  if (!GOAL_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, GOAL_TOOL_NAMES);
  }
  if (!BLACKBOARD_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, BLACKBOARD_TOOL_NAMES);
  }
  if (!TELEGRAM_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, TELEGRAM_TOOL_NAMES);
  }
  if (!WEB_SEARCH_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, WEB_SEARCH_TOOL_NAMES);
  }
  if (!SKILL_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, SKILL_TOOL_NAMES);
  }
  if (!PERSONAL_FINANCE_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, PERSONAL_FINANCE_TOOL_NAMES);
  }
  if (!MEMORY_WRITE_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, MEMORY_WRITE_TOOL_NAMES);
  }
  if (!EMAIL_READ_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, EMAIL_READ_TOOL_NAMES);
  }
  if (!CALENDAR_READ_KEYWORD_PATTERN.test(combined) && !needsCalendarWriteTools) {
    selected = dropToolsByName(selected, CALENDAR_READ_TOOL_NAMES);
  }
  return selected;
}

function historyLimitForTurn(text) {
  if (isLightweightChitchat(text)) return LIGHTWEIGHT_HISTORY_LIMIT;
  if (isDirectFinancialMetricsAsk(text)) return DIRECT_METRICS_HISTORY_LIMIT;
  if (needsSemanticMemory(text) || BUSINESS_INTEL_KEYWORD_PATTERN.test(String(text || ''))) {
    return FULL_HISTORY_LIMIT;
  }
  return DEFAULT_HISTORY_LIMIT;
}

// Whisper / casual typing: common business acronyms before tools see the text.
function correctCommonSpeechTerms(text) {
  return String(text || '').replace(/\bmmr\b/gi, 'MRR');
}

module.exports = {
  BUSINESS_INTEL_TOOL_NAMES,
  OUTBOUND_EMAIL_TOOL_NAMES,
  CALENDAR_WRITE_TOOL_NAMES,
  BUSINESS_INTEL_KEYWORD_PATTERN,
  OUTBOUND_EMAIL_KEYWORD_PATTERN,
  CALENDAR_WRITE_KEYWORD_PATTERN,
  HEAVY_CONTEXT_KEYWORD_PATTERN,
  BUSINESS_INTEL_HISTORY_LOOKBACK,
  LIGHTWEIGHT_MAX_CHARS,
  LIGHTWEIGHT_HISTORY_LIMIT,
  DEFAULT_HISTORY_LIMIT,
  FULL_HISTORY_LIMIT,
  LIGHTWEIGHT_GREET_PATTERN,
  DIRECT_METRICS_MAX_CHARS,
  DIRECT_METRICS_HISTORY_LIMIT,
  DIRECT_METRICS_PATTERN,
  SEMANTIC_MEMORY_PATTERN,
  isLightweightChitchat,
  needsSemanticMemory,
  isDirectFinancialMetricsAsk,
  shouldSkipSemanticMemory,
  shouldSkipHeavyMemory,
  formatFinancialMetricsPromptBlock,
  selectToolsForTurn,
  historyLimitForTurn,
  correctCommonSpeechTerms
};
