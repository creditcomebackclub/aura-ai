'use strict';

const ACTION_RECEIPT_RULES = Object.freeze([
  {
    kind: 'reminder',
    tools: ['set_reminder'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:set|scheduled|created)\s+(?:a|the|your)\s+reminder|(?:the|your)?\s*reminder\s+(?:(?:is|has been|was)\s+)?(?:set|scheduled|created)|i(?:'ll| will)\s+(?:(?:make sure to\s+)?remind\s+you|check[- ]?in\s+with\s+you|(?:set|schedule|create)\s+(?:a|the|your)\s+reminder)|you(?:'ll| will)\s+(?:get|receive)\s+(?:a|the)\s+(?:reminder|check[- ]?in))\b/i
  },
  {
    kind: 'reminder cancellation',
    tools: ['cancel_reminder'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:cancelled|canceled|stopped|removed)\b.{0,80}\breminder|(?:the|your)\s+reminder\s+(?:(?:is|has been|was)\s+)?(?:cancelled|canceled|stopped|removed))\b/i
  },
  {
    kind: 'email',
    tools: ['send_owner_email', 'send_email'],
    pattern: /\b(?:i(?:'ve| have)?\s+emailed\b|i(?:'ve| have)?\s+sent\b.{0,80}\b(?:email|e-?mail|mail)\b|(?:the\s+)?email\s+(?:(?:is|has been|was)\s+)?sent\b|sent\s+(?:the\s+)?(?:email|e-?mail)\b)/i
  },
  {
    kind: 'LinkedIn message',
    tools: ['approve_linkedin_message'],
    pattern: /\b(?:i(?:'ve| have)?\s+sent\b.{0,100}\b(?:linkedin|connection request|message)|(?:the|your)\s+(?:linkedin\s+)?(?:message|connection request)\s+(?:(?:is|has been|was)\s+)?sent|sent\s+(?:the\s+)?(?:linkedin\s+)?(?:message|connection request))\b/i
  },
  {
    kind: 'LinkedIn draft',
    tools: ['draft_linkedin_message'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:drafted|prepared|created)\b.{0,100}\blinkedin\b|(?:the|your)\s+linkedin\s+draft\s+(?:(?:is|has been|was)\s+)?(?:ready|created|prepared))\b/i
  },
  {
    kind: 'telegram',
    tools: ['send_telegram_message'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:sent|posted)\b.{0,80}\btelegram\b|(?:it|that|the\s+(?:draft|message|file))\s+(?:is|'s|was)\s+(?:on|in)\s+telegram\b|sent\s+(?:it\s+)?(?:to|on)\s+telegram\b)/i
  },
  {
    kind: 'calendar',
    tools: ['create_calendar_event'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:scheduled|booked|created|added)\b.{0,100}\b(?:calendar|event|meeting|appointment|consult)|i\s+(?:put|added)\s+(?:it|that|the\s+\w+)\s+on\s+your\s+calendar|(?:it|that)\s+(?:is|'s|was)\s+on\s+your\s+calendar|(?:the|your)\s+(?:event|meeting|appointment)\s+(?:is|has been|was)\s+(?:scheduled|booked|created))\b/i
  },
  {
    kind: 'calendar reschedule',
    tools: ['reschedule_calendar_event'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:rescheduled|moved|changed)\b.{0,100}\b(?:calendar|event|meeting|appointment|consult)|(?:the|your)\s+(?:event|meeting|appointment|consult)\s+(?:(?:is|has been|was)\s+)?(?:rescheduled|moved|changed))\b/i
  },
  {
    kind: 'calendar cancellation',
    tools: ['cancel_calendar_event'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:cancelled|canceled|deleted|removed)\b.{0,100}\b(?:calendar|event|meeting|appointment|consult)|(?:the|your)\s+(?:event|meeting|appointment|consult)\s+(?:(?:is|has been|was)\s+)?(?:cancelled|canceled|deleted|removed))\b/i
  },
  {
    kind: 'goal',
    tools: ['add_goal', 'set_goal_plan', 'update_goal_step', 'update_goal_status'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:added|saved|created|updated|completed|marked)\b.{0,100}\b(?:goal|task|to-?do|plan)|(?:the|your)\s+(?:goal|task|to-?do|plan)\s+(?:is|has been|was)\s+(?:added|saved|created|updated|completed|marked))\b/i
  },
  {
    kind: 'memory',
    tools: ['save_semantic_memory', 'memory_remember', 'memory_correct', 'memory_confirm'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:saved|stored|remembered)\b.{0,80}\b(?:that|this|it|memory|preference|profile)|i(?:'ll| will)\s+remember\s+(?:that|this|it)|(?:that|this|it)\s+(?:is|has been|was)\s+(?:saved|stored)\s+(?:to|in)\s+(?:memory|your profile))\b/i
  },
  {
    kind: 'skill',
    tools: ['manage_skill'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:created|updated|patched|deleted|removed)\b.{0,100}\b(?:skill|workflow|procedure|playbook)|(?:the|your)\s+(?:skill|workflow|procedure|playbook)\s+(?:is|has been|was)\s+(?:created|updated|patched|deleted|removed))\b/i
  },
  {
    kind: 'deletion',
    tools: ['confirm_test_letter_deletion'],
    pattern: /\b(?:i(?:'ve| have)?\s+deleted\b|(?:the|that)\s+(?:letter|record)\s+(?:is|has been|was)\s+deleted)\b/i
  },
  {
    kind: 'finance log',
    tools: ['log_finance'],
    pattern: /\b(?:i(?:'ve| have)?\s+(?:logged|recorded)\b.{0,80}\b(?:expense|purchase|transaction|finance)|(?:the|that)\s+(?:expense|purchase|transaction)\s+(?:is|has been|was)\s+(?:logged|recorded))\b/i
  }
]);

const GENERIC_ACTION_TOOLS = new Set(ACTION_RECEIPT_RULES.flatMap(rule => rule.tools));
const GENERIC_COMPLETION_PATTERN = /\b(?:done|all set|taken care of|handled|consider it done|i\s+(?:sent|scheduled|saved|added|updated|logged|deleted)\s+(?:it|that)|i(?:'ll| will)\s+(?:send|schedule|save|add|update|log|delete)\b)\b/i;

function findUnsupportedActionClaim(text, successfulToolNames = [], { candidateToolNames = [] } = {}) {
  const source = String(text || '');
  if (!source) return null;
  const successful = new Set((successfulToolNames || []).filter(Boolean));
  for (const rule of ACTION_RECEIPT_RULES) {
    const match = source.match(rule.pattern);
    if (!match || rule.tools.some(tool => successful.has(tool))) continue;
    return {
      kind: rule.kind,
      tools: [...rule.tools],
      snippet: match[0]
    };
  }
  const candidates = (candidateToolNames || []).filter(tool => GENERIC_ACTION_TOOLS.has(tool));
  const generic = source.match(GENERIC_COMPLETION_PATTERN);
  if (generic && candidates.length && !candidates.some(tool => successful.has(tool))) {
    return { kind: 'action', tools: candidates, snippet: generic[0] };
  }
  return null;
}

function toolResultSucceeded(name, result) {
  if (name === 'set_reminder') return result?.scheduled === true;
  if (name === 'cancel_reminder') return result?.cancelled === true;
  if (name === 'draft_linkedin_message') return result?.drafted === true && result?.sent === false;
  if (name === 'approve_linkedin_message') return result?.sent === true && result?.status === 'sent';
  if (name === 'reject_linkedin_message') return result?.rejected === true && result?.sent === false;
  if (name === 'send_owner_email' || name === 'send_email') {
    return typeof result === 'string' && /^Sent\b/i.test(result);
  }
  if (name === 'send_telegram_message') {
    return typeof result === 'string' && /^Sent on Telegram\./i.test(result);
  }
  if (name === 'create_calendar_event') {
    return typeof result === 'string' && /^Created on Google Calendar\./i.test(result);
  }
  if (name === 'reschedule_calendar_event') {
    return typeof result === 'string' && /^Rescheduled on Google Calendar\./i.test(result);
  }
  if (name === 'cancel_calendar_event') {
    return typeof result === 'string' && /^Cancelled on Google Calendar\./i.test(result);
  }
  if (name === 'confirm_test_letter_deletion') {
    return typeof result === 'string' && /^Deleted at\b/i.test(result);
  }
  if (name === 'propose_test_letter_deletion') {
    return typeof result === 'string' && /^Staged for deletion\./i.test(result);
  }
  if (name === 'add_goal') return Boolean(result) && !/not added|not found|failed/i.test(String(result));
  if (name === 'save_semantic_memory') {
    return Array.isArray(result?.learned) ? result.learned.length > 0 : Boolean(result?.saved);
  }
  if (name === 'manage_skill') return Boolean(result) && result?.ok !== false;
  if (typeof result === 'string') {
    return !/^(?:Error\b|.*\bnot (?:sent|created|set|saved|logged|updated|found)\b|.*\bfailed\b|Could not\b|Deletion refused\b)/i.test(result);
  }
  return result != null;
}

module.exports = {
  ACTION_RECEIPT_RULES,
  findUnsupportedActionClaim,
  toolResultSucceeded
};
