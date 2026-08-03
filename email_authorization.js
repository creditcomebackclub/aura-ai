'use strict';

// Email sends may execute immediately only when the owner's current message
// is itself a send command. Keep this check independent from model-composed
// tool arguments so quoted webpages, emails, memories, and tool results cannot
// authorize outbound mail.
function isExplicitEmailSendRequest(instruction) {
  const text = String(instruction || '').trim().toLowerCase();
  if (!text) return false;

  // Clear non-send intents and reported/quoted instructions fail closed.
  if (/^(?:summarize|review|analyze|read|explain|quote|what|why|how|did|does|has|have|is|are)\b/.test(text)) {
    return false;
  }
  if (/^(?:do\s+not|don'?t|hold\s+off|cancel)\b.{0,80}\b(?:email|send)\b/.test(text)) {
    return false;
  }
  const lead = text.slice(0, 240);
  const politePrefix = '(?:(?:hey\\s+)?aura[,.:\\s]+)?(?:please\\s+)?';
  const explicitLead = new RegExp(`^${politePrefix}(?:email|e-mail)\\b`, 'i').test(lead) ||
    new RegExp(`^${politePrefix}send\\b`, 'i').test(lead) ||
    /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:email|e-mail|send)\b/i.test(lead) ||
    /^(?:i\s+(?:need|want|would\s+like)|i'?d\s+like)\s+you\s+to\s+(?:email|e-mail|send)\b/i.test(lead);
  if (explicitLead) return true;

  if (/\b(?:email|message|webpage|website|document|note)\b.{0,60}\b(?:says?|said|asks?|asked|tells?|told)\b.{0,100}\b(?:email|send)\b/.test(text)) {
    return false;
  }
  return false;
}

function ownerInstructionIncludesRecipient(instruction, address) {
  const normalizedAddress = String(address || '').trim().toLowerCase();
  if (!normalizedAddress) return false;
  return String(instruction || '').toLowerCase().includes(normalizedAddress);
}

module.exports = {
  isExplicitEmailSendRequest,
  ownerInstructionIncludesRecipient
};
