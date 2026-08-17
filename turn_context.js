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
  'create_calendar_event',
  'reschedule_calendar_event',
  'cancel_calendar_event'
]);

const GOAL_TOOL_NAMES = new Set([
  'get_goals',
  'get_goal_plans',
  'add_goal',
  'set_goal_plan',
  'update_goal_step',
  'update_goal_status'
]);
const GOAL_WRITE_TOOL_NAMES = new Set([
  'add_goal',
  'set_goal_plan',
  'update_goal_step',
  'update_goal_status'
]);
const REMINDER_TOOL_NAMES = new Set(['get_reminders', 'set_reminder', 'cancel_reminder']);
const BLACKBOARD_TOOL_NAMES = new Set(['check_blackboard']);
const TELEGRAM_TOOL_NAMES = new Set(['send_telegram_message']);
const WEB_SEARCH_TOOL_NAMES = new Set(['search_web']);
const SKILL_TOOL_NAMES = new Set(['list_skills', 'view_skill', 'manage_skill']);
const PERSONAL_FINANCE_TOOL_NAMES = new Set(['log_finance', 'query_finances']);
const MEMORY_WRITE_TOOL_NAMES = new Set(['save_semantic_memory']);
const EMAIL_READ_TOOL_NAMES = new Set(['check_email']);
const CALENDAR_READ_TOOL_NAMES = new Set(['check_calendar']);
const LINKEDIN_TOOL_NAMES = new Set([
  'list_linkedin_relationships',
  'get_linkedin_relationship_context',
  'save_linkedin_relationship_context',
  'draft_linkedin_message',
  'approve_linkedin_message',
  'reject_linkedin_message'
]);

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
const CALENDAR_WRITE_KEYWORD_PATTERN = /\b(schedule|scheduling|scheduled|book|booking|invite|invitation|reschedule|rescheduling|move .{0,100}(?:event|meeting|appointment|calendar|to|until)|change .{0,100}(?:event|meeting|appointment|calendar|date|day|time)|cancel .{0,100}(?:event|meeting|appointment|calendar|call)|(?:delete|remove) .{0,100}(?:event|meeting|appointment|calendar|call)|calendar event|add (?:this |it |an? )?to (?:my )?calendar|put .+ on (?:my )?calendar|block off|hold on my calendar)\b/i;
const HEAVY_CONTEXT_KEYWORD_PATTERN = /\b(email|e-?mail|calendar|blackboard|goal|goals|todo|to-do|plan|planning|milestone|search|remember|remind|reminder|memory|profile|mail|consult|consultation|schedule|book|invite|reschedule|cancel|skill|skills|procedure|workflow|linkedin|networking)\b/i;
const GOAL_KEYWORD_PATTERN = /\b(goal|goals|todo|to-?do|task|tasks|plan|planning|milestone|milestones|next action|prioriti[sz]e|what should (?:i|we) do next|what(?:'s| is) next|where should (?:i|we) start)\b/i;
const BLACKBOARD_KEYWORD_PATTERN = /\b(blackboard|consult|consultation)\b/i;
const TELEGRAM_KEYWORD_PATTERN = /\b(telegram|text (?:him|her|me|chris)|message (?:chris|me))\b/i;
const WEB_SEARCH_KEYWORD_PATTERN = /\b(search(?:\s+the)?\s+(?:web|internet)|google|browse(?:\s+the)?\s+(?:web|internet)|look\s+(?:it\s+)?up(?:\s+(?:online|on\s+the\s+web))?|web\s+search|latest news|weather|who is|what(?:'s| is) (?:the )?(?:news|score|price of))\b/i;
const PUBLIC_CONTACT_LOOKUP_PATTERN = /\b(?:find|verify|locate|confirm)\b.{0,100}\b(?:official|correct|current|contact|partnership)\b.{0,100}\b(?:email|e-?mail|address|website|page|phone|contact)\b/i;
const PUBLIC_LOOKUP_FOLLOWUP_PATTERN = /\b(?:double[- ]check|check again|try again|look again|verify again)\b/i;
const PUBLIC_LOOKUP_CONTEXT_PATTERN = /\b(?:official|public|website|contact page|partnership contact|email address|web search|online)\b/i;
const PRIVATE_WEB_SEARCH_INPUT_PATTERN = /\b(?:client|ccc|credit comeback|blackboard)\b|\b(?:my|our)\s+(?:email|inbox|mail|calendar|schedule|goals?|finances?|transactions?|account)\b/i;
const SKILL_KEYWORD_PATTERN = /\b(skill|skills|workflow|procedure|playbook)\b/i;
const PERSONAL_FINANCE_KEYWORD_PATTERN = /\b(expense|expenses|spent|spending|budget|log (?:a )?purchase)\b/i;
const MEMORY_WRITE_KEYWORD_PATTERN = /\b(remember(?:\s+that|\s+this)?|save (?:this|that)|memorize)\b/i;
const EMAIL_READ_KEYWORD_PATTERN = /\b(email(?:s|ed|ing)?|e-?mails?|inbox|mail|outreach)\b/i;
const CALENDAR_READ_KEYWORD_PATTERN = /\b(calendar|schedule|meeting|meetings|appointment|agenda|am i free|what'?s on)\b/i;
const REMINDER_KEYWORD_PATTERN = /\b(remind|reminder|check[- ]?in with me|nudge|prompt me)\b/i;
const DAILY_PLATE_PATTERN = /\b(?:(?:what(?:['’]s| is)|whats)\s+on\s+my\s+plate(?:\s+today)?|what\s+does\s+my\s+plate\s+look\s+like(?:\s+today)?|(?:give|show|tell)\s+me\s+(?:today['’]?s|my)\s+(?:real\s+)?(?:agenda|plate|priorities)(?:\s+(?:for\s+today|and\s+deadlines))?)\b/i;
const LINKEDIN_KEYWORD_PATTERN = /\b(?:linked\s?in|professional network|networking|connection request|approval code\s+LI-[A-F0-9]{8}|LI-[A-F0-9]{8})\b/i;

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

// Deeper reasoning is selected deterministically so deciding how hard to think
// never adds another model round. Keep this intent-based: message length alone
// is a poor proxy (a pasted name can be long; "why?" can be short).
const MEDIUM_REASONING_PATTERN = /\b(?:analy[sz]e|analysis|compare|contrast|evaluate|assess|recommend|recommendation|advise|advice|strateg(?:y|ic|ize)|prioriti[sz]e|trade[ -]?offs?|pros and cons|root cause|reason through|think (?:this |it )?through|think hard|figure out why|explain|planning)\b/i;
const WHY_REASONING_PATTERN = /\bwhy\s+(?:did|does|do|is|are|was|were|would|could|should|has|have|can)\b/i;
const DECISION_REASONING_PATTERN = /\b(?:what should (?:i|we)|what would you do|help me (?:decide|choose|plan)|make (?:me )?a plan|plan (?:this|it|that|out|for))\b/i;
const INTERPRETATION_REASONING_PATTERN = /\bwhat does\b.{0,100}\bmean\b/i;

const REASONING_EFFORT_RANK = Object.freeze({ none: 0, low: 1, medium: 2, high: 3 });

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
  if (
    MEDIUM_REASONING_PATTERN.test(trimmed) ||
    WHY_REASONING_PATTERN.test(trimmed) ||
    DECISION_REASONING_PATTERN.test(trimmed) ||
    INTERPRETATION_REASONING_PATTERN.test(trimmed)
  ) return false;
  // Multi-intent turns still need the normal tool loop.
  if (/\b(client|clients|letter|letters|phase|email|e-?mail|calendar|send|search)\b/i.test(trimmed)) {
    return false;
  }
  return DIRECT_METRICS_PATTERN.test(trimmed);
}

function reasoningEffortForTurn(
  text,
  { baseEffort = 'low' } = {}
) {
  const normalizedBase = Object.hasOwn(REASONING_EFFORT_RANK, baseEffort)
    ? baseEffort
    : 'low';
  // An explicit deployment setting above low remains a floor. Adaptive mode
  // deepens selected turns; it never silently weakens an operator override.
  if (REASONING_EFFORT_RANK[normalizedBase] >= REASONING_EFFORT_RANK.medium) {
    return normalizedBase;
  }

  const value = String(text || '').trim();
  if (!value || isLightweightChitchat(value)) {
    return normalizedBase;
  }
  if (
    MEDIUM_REASONING_PATTERN.test(value) ||
    WHY_REASONING_PATTERN.test(value) ||
    DECISION_REASONING_PATTERN.test(value) ||
    INTERPRETATION_REASONING_PATTERN.test(value)
  ) {
    return 'medium';
  }
  if (isDirectFinancialMetricsAsk(value)) return normalizedBase;
  // Tool breadth is not reasoning depth. A daily brief may read goals,
  // calendar, and Blackboard but only needs concise synthesis; escalating it
  // to medium made the post-tool answer several seconds slower. Explicit
  // analysis, comparison, strategy, planning, and decision language above
  // still selects medium regardless of how many tool groups are involved.
  return normalizedBase;
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

function shouldForceWebSearchForTurn(text, recentMessages = []) {
  const current = String(text || '');
  if (!current.trim() || PRIVATE_WEB_SEARCH_INPUT_PATTERN.test(current)) return false;
  if (WEB_SEARCH_KEYWORD_PATTERN.test(current) || PUBLIC_CONTACT_LOOKUP_PATTERN.test(current)) {
    return true;
  }
  if (!PUBLIC_LOOKUP_FOLLOWUP_PATTERN.test(current)) return false;
  const recentText = recentMessages
    .slice(-BUSINESS_INTEL_HISTORY_LOOKBACK)
    .map(message => (typeof message.content === 'string' ? message.content : ''))
    .join(' ');
  return PUBLIC_LOOKUP_CONTEXT_PATTERN.test(recentText) ||
    PUBLIC_CONTACT_LOOKUP_PATTERN.test(recentText);
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
  const needsDailyPlateTools = DAILY_PLATE_PATTERN.test(combined);
  const needsWebSearch = WEB_SEARCH_KEYWORD_PATTERN.test(combined) ||
    PUBLIC_CONTACT_LOOKUP_PATTERN.test(combined) ||
    shouldForceWebSearchForTurn(text, recentMessages);
  if (!needsEmailTools) {
    selected = dropToolsByName(selected, OUTBOUND_EMAIL_TOOL_NAMES);
  }
  if (!needsCalendarWriteTools) {
    selected = dropToolsByName(selected, CALENDAR_WRITE_TOOL_NAMES);
  }
  // Keyword-gate the always-on noise tools. Shipping 14+ schemas on every
  // turn costs TTFT and tempts silent tool rounds before speech.
  if (!GOAL_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(
      selected,
      needsDailyPlateTools ? GOAL_WRITE_TOOL_NAMES : GOAL_TOOL_NAMES
    );
  }
  if (!REMINDER_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, REMINDER_TOOL_NAMES);
  }
  if (!BLACKBOARD_KEYWORD_PATTERN.test(combined) && !needsDailyPlateTools) {
    selected = dropToolsByName(selected, BLACKBOARD_TOOL_NAMES);
  }
  if (!TELEGRAM_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, TELEGRAM_TOOL_NAMES);
  }
  if (!needsWebSearch) {
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
  if (!CALENDAR_READ_KEYWORD_PATTERN.test(combined) &&
      !needsCalendarWriteTools && !needsDailyPlateTools) {
    selected = dropToolsByName(selected, CALENDAR_READ_TOOL_NAMES);
  }
  if (!LINKEDIN_KEYWORD_PATTERN.test(combined)) {
    selected = dropToolsByName(selected, LINKEDIN_TOOL_NAMES);
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
  LINKEDIN_TOOL_NAMES,
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
  reasoningEffortForTurn,
  shouldSkipSemanticMemory,
  shouldSkipHeavyMemory,
  formatFinancialMetricsPromptBlock,
  shouldForceWebSearchForTurn,
  selectToolsForTurn,
  historyLimitForTurn,
  correctCommonSpeechTerms
};
