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
  'propose_owner_email',
  'confirm_owner_email',
  'propose_email',
  'confirm_email'
]);

const CALENDAR_WRITE_TOOL_NAMES = new Set([
  'create_calendar_event'
]);

// Recovery helper for staged email flows. Calendar writes execute directly
// from an explicit owner scheduling command and never enter this queue.
const STAGED_ACTION_TOOL_NAMES = new Set([
  'list_pending_owner_actions'
]);

const BUSINESS_INTEL_KEYWORD_PATTERN = new RegExp(
  '\\b(' + [
    'client', 'clients', 'customer', 'customers', 'balance', 'balances', 'owe', 'owes',
    'owing', 'invoice', 'invoices', 'payment', 'payments', 'paid', 'unpaid', 'delinquent',
    'overdue', 'database', 'table', 'tables', 'row', 'rows', 'letter', 'letters',
    'furnisher', 'furnishers', 'phase', 'dispute', 'disputes', 'ledger', 'finance',
    'financial', 'revenue', 'mailed', 'scratch', 'ccc', 'credit comeback', 'how many',
    'mrr', 'commission'
  ].join('|') + ')\\b',
  'i'
);

const OUTBOUND_EMAIL_KEYWORD_PATTERN = /\b(email|e-?mail|send|propose|approve|confirm|draft|pending action)\b/i;
const CALENDAR_WRITE_KEYWORD_PATTERN = /\b(schedule|scheduling|scheduled|book|booking|invite|invitation|calendar event|add (?:this |it |an? )?to (?:my )?calendar|put .+ on (?:my )?calendar|block off|hold on my calendar)\b/i;
const HEAVY_CONTEXT_KEYWORD_PATTERN = /\b(email|e-?mail|calendar|blackboard|goal|goals|todo|to-do|search|remember|memory|profile|mail|consult|consultation|schedule|book|invite)\b/i;

// A short follow-up ("What about for his wife, Mary?", "Is her POA signed?")
// carries no business keyword of its own - it leans entirely on the client
// already established a turn or two earlier. Checking `text` alone drops
// every business tool for that turn, and the model has no way to tell the
// difference between "these tools don't exist" and "not offered this turn" -
// it reports the former, which reads as a false capability claim. Checking
// the tail of recent history too means a follow-up inherits its parent
// turn's relevance instead of needing its own trigger word.
const BUSINESS_INTEL_HISTORY_LOOKBACK = 6;

// Short greets / vibes only. Status asks ("any email?", "what's on my
// calendar?") keep the heavy path so tools and semantic memory stay available.
const LIGHTWEIGHT_MAX_CHARS = 80;
const LIGHTWEIGHT_HISTORY_LIMIT = 8;
const FULL_HISTORY_LIMIT = 30;

function isLightweightChitchat(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > LIGHTWEIGHT_MAX_CHARS) return false;
  if (BUSINESS_INTEL_KEYWORD_PATTERN.test(trimmed)) return false;
  if (HEAVY_CONTEXT_KEYWORD_PATTERN.test(trimmed)) return false;
  if (OUTBOUND_EMAIL_KEYWORD_PATTERN.test(trimmed)) return false;
  if (CALENDAR_WRITE_KEYWORD_PATTERN.test(trimmed)) return false;
  return true;
}

function selectToolsForTurn(tools, text, recentMessages = []) {
  const recentText = recentMessages
    .slice(-BUSINESS_INTEL_HISTORY_LOOKBACK)
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join(' ');
  const combined = `${recentText} ${text || ''}`;
  let selected = tools;
  if (!BUSINESS_INTEL_KEYWORD_PATTERN.test(combined)) {
    selected = selected.filter(tool => !BUSINESS_INTEL_TOOL_NAMES.has(tool.function.name));
  }
  const needsEmailTools = OUTBOUND_EMAIL_KEYWORD_PATTERN.test(combined);
  const needsCalendarWriteTools = CALENDAR_WRITE_KEYWORD_PATTERN.test(combined);
  if (!needsEmailTools) {
    selected = selected.filter(tool => !OUTBOUND_EMAIL_TOOL_NAMES.has(tool.function.name));
  }
  if (!needsCalendarWriteTools) {
    selected = selected.filter(tool => !CALENDAR_WRITE_TOOL_NAMES.has(tool.function.name));
  }
  if (!needsEmailTools) {
    selected = selected.filter(tool => !STAGED_ACTION_TOOL_NAMES.has(tool.function.name));
  }
  return selected;
}

function historyLimitForTurn(text) {
  return isLightweightChitchat(text) ? LIGHTWEIGHT_HISTORY_LIMIT : FULL_HISTORY_LIMIT;
}

module.exports = {
  BUSINESS_INTEL_TOOL_NAMES,
  OUTBOUND_EMAIL_TOOL_NAMES,
  CALENDAR_WRITE_TOOL_NAMES,
  STAGED_ACTION_TOOL_NAMES,
  BUSINESS_INTEL_KEYWORD_PATTERN,
  OUTBOUND_EMAIL_KEYWORD_PATTERN,
  CALENDAR_WRITE_KEYWORD_PATTERN,
  HEAVY_CONTEXT_KEYWORD_PATTERN,
  BUSINESS_INTEL_HISTORY_LOOKBACK,
  LIGHTWEIGHT_MAX_CHARS,
  LIGHTWEIGHT_HISTORY_LIMIT,
  FULL_HISTORY_LIMIT,
  isLightweightChitchat,
  selectToolsForTurn,
  historyLimitForTurn
};
