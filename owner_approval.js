// Owner-consent gate for staged destructive/external actions.
// Checked against the owner's raw message text only — never model output or
// tool results. A match on an approval word alone is not enough: the message
// must be approval-shaped (short confirmation), not a mixed turn that happens
// to contain "yes" or "send" while asking for something else.

const OWNER_APPROVAL_PATTERN = /\b(yes|yeah|yep|yup|confirm|confirmed|confirming|approve|approved|go ahead|do it|delete it|send|send it|proceed|permission granted)\b/i;
const OWNER_REFUSAL_PATTERN = /\b(no|nope|don'?t|do not|cancel|stop|wait|hold off|never ?mind|not yet)\b/i;

// Leftover tokens that still count as confirming the staged action itself
// ("yes, send the email", "yes that's fine") rather than starting a new request.
const APPROVAL_HARMLESS_REMAINDER = /^(?:(?:the|a|an|my|that|thats|this|it|its|please|now|just|then|and|to|for|me|ok|okay|sure|alright|all\s+right|right|thanks?|thank\s+you|email|letter|deletion|message|mail|action|pdf|report|file|one|fine|good|great|perfect|absolutely|definitely|sounds|works|cool|totally|exactly|calendar|event|invite|invitation|appointment|meeting|consult|consultation|schedule|create|book)\s*)*$/i;

function stripApprovalPhrases(message) {
  // Fresh /gi copy: the exported pattern has no `g` (so .test() is safe to
  // reuse), but a mixed approval like "yes, send it" needs every approval
  // phrase removed before the remainder check. Possessives ("that's") are
  // folded to their stem so "yes that's fine" survives the remainder check.
  return String(message || '')
    .replace(new RegExp(OWNER_APPROVAL_PATTERN.source, 'gi'), ' ')
    .replace(/\b(\w+)'s\b/gi, '$1')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isClearOwnerRefusal(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return false;
  return OWNER_REFUSAL_PATTERN.test(text);
}

// True only when the owner's message is a clear approval of a pending staged
// action — not when an approval word appears inside a larger, different ask.
function isClearOwnerApproval(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return false;
  // Refusal wins when both shapes appear ("don't send it").
  if (OWNER_REFUSAL_PATTERN.test(text)) return false;
  if (!OWNER_APPROVAL_PATTERN.test(text)) return false;
  const remainder = stripApprovalPhrases(text);
  if (!remainder) return true;
  return APPROVAL_HARMLESS_REMAINDER.test(remainder);
}

module.exports = {
  APPROVAL_HARMLESS_REMAINDER,
  OWNER_APPROVAL_PATTERN,
  OWNER_REFUSAL_PATTERN,
  isClearOwnerApproval,
  isClearOwnerRefusal,
  stripApprovalPhrases
};
