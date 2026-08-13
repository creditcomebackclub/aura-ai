'use strict';

const crypto = require('crypto');

const LINKEDIN_MESSAGE_TYPES = Object.freeze([
  'connection_request',
  'introduction',
  'follow_up',
  'reply',
  'thank_you',
  'collaboration',
  'reconnect',
  'move_to_call',
  'other'
]);

const LINKEDIN_DRAFT_STATUSES = Object.freeze([
  'draft',
  'approved',
  'rejected',
  'sent',
  'failed',
  'superseded'
]);

const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[a-z0-9_-]{20,}\b/i,
  /\beyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/i,
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|secret)\s*(?:is|[:=])\s*\S{8,}/i,
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/
];

const PRIVATE_CLIENT_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/,
  /\b(?:ssn|social security number|date of birth|dob)\s*[:#=-]\s*\S+/i,
  /\b(?:ccc|credit comeback club)\s+client\b/i,
  /\bclient\s+(?:account|record|file|credit report|dispute letter)\s*(?:number|id|#|:)/i,
  /\b(?:account|report)\s*(?:number|#|no\.)\s*[:=-]?\s*[a-z0-9-]{6,}\b/i
];

function cleanText(value, { required = false, max = 2000, label = 'Text' } = {}) {
  if (value == null || value === '') {
    if (required) throw new Error(`${label} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const cleaned = value.replace(/\0/g, '').trim();
  if (!cleaned && required) throw new Error(`${label} is required.`);
  if (cleaned.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return cleaned || null;
}

function assertSafeRelationshipText(value, label = 'LinkedIn context') {
  const text = String(value || '');
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) {
    throw new Error(`${label} appears to contain a credential or secret.`);
  }
  if (PRIVATE_CLIENT_PATTERNS.some(pattern => pattern.test(text))) {
    throw new Error(`${label} appears to contain private client data. Remove it before saving or drafting.`);
  }
  return true;
}

function normalizeLinkedInProfileUrl(value) {
  const text = cleanText(value, { required: true, max: 500, label: 'LinkedIn profile URL' });
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('LinkedIn profile URL must be a valid https URL.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.protocol !== 'https:' || hostname !== 'linkedin.com' || !/^\/in\/[^/]+\/?$/i.test(url.pathname)) {
    throw new Error('LinkedIn profile URL must point to a linkedin.com/in/ profile.');
  }
  url.hostname = 'www.linkedin.com';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function normalizeMemberUrn(value, { required = false } = {}) {
  const text = cleanText(value, { required, max: 300, label: 'LinkedIn member URN' });
  if (!text) return null;
  if (!/^urn:li:person:[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error('LinkedIn member URN must use urn:li:person:<id>.');
  }
  return text;
}

function normalizeConversationUrn(value) {
  const text = cleanText(value, { max: 500, label: 'LinkedIn conversation URN' });
  if (!text) return null;
  if (!/^urn:li:[A-Za-z0-9_.-]+:[^\s\0]{1,400}$/.test(text)) {
    throw new Error('LinkedIn conversation URN is invalid.');
  }
  return text;
}

function normalizeRelationshipInput(input = {}) {
  const relationship = {
    profile_url: normalizeLinkedInProfileUrl(input.profile_url),
    display_name: cleanText(input.display_name, { required: true, max: 200, label: 'Display name' }),
    linkedin_member_urn: normalizeMemberUrn(input.linkedin_member_urn),
    conversation_urn: normalizeConversationUrn(input.conversation_urn),
    headline: cleanText(input.headline, { max: 500, label: 'Headline' }),
    location: cleanText(input.location, { max: 300, label: 'Location' }),
    profile_summary: cleanText(input.profile_summary, { max: 5000, label: 'Profile summary' }),
    conversation_context: cleanText(input.conversation_context, { max: 12000, label: 'Conversation context' }),
    last_interaction_at: cleanText(input.last_interaction_at, { max: 80, label: 'Last interaction date' }),
    topic: cleanText(input.topic, { max: 500, label: 'Relationship topic' }),
    intended_next_step: cleanText(input.intended_next_step, { max: 1000, label: 'Intended next step' })
  };
  if (relationship.last_interaction_at && !Number.isFinite(Date.parse(relationship.last_interaction_at))) {
    throw new Error('Last interaction date must be an ISO date or datetime.');
  }
  assertSafeRelationshipText(Object.values(relationship).filter(Boolean).join('\n'));
  return relationship;
}

function normalizeDraftInput(input = {}) {
  const messageType = cleanText(input.message_type, {
    required: true,
    max: 40,
    label: 'LinkedIn message type'
  });
  if (!LINKEDIN_MESSAGE_TYPES.includes(messageType)) {
    throw new Error(`LinkedIn message type must be one of: ${LINKEDIN_MESSAGE_TYPES.join(', ')}.`);
  }
  const bodyMax = messageType === 'connection_request' ? 300 : 8000;
  const body = cleanText(input.body, { required: true, max: bodyMax, label: 'LinkedIn message body' });
  const purpose = cleanText(input.purpose, { required: true, max: 1000, label: 'Message purpose' });
  const subject = cleanText(input.subject, { max: 200, label: 'LinkedIn message subject' });
  if (messageType === 'connection_request' && subject) {
    throw new Error('LinkedIn connection requests do not support a subject.');
  }
  if (/<\/?[a-z][^>]*>/i.test(body) || (subject && /<\/?[a-z][^>]*>/i.test(subject))) {
    throw new Error('LinkedIn messages must be plain text and cannot contain HTML.');
  }
  assertSafeRelationshipText(`${purpose}\n${subject || ''}\n${body}`, 'LinkedIn draft');
  return { message_type: messageType, purpose, subject, body };
}

function relationshipContextPayload(relationship) {
  return {
    id: relationship.id,
    profile_url: relationship.profile_url,
    display_name: relationship.display_name,
    linkedin_member_urn: relationship.linkedin_member_urn || null,
    conversation_urn: relationship.conversation_urn || null,
    headline: relationship.headline || null,
    location: relationship.location || null,
    profile_summary: relationship.profile_summary || null,
    conversation_context: relationship.conversation_context || null,
    last_interaction_at: relationship.last_interaction_at || null,
    topic: relationship.topic || null,
    intended_next_step: relationship.intended_next_step || null,
    updated_at: relationship.updated_at || null
  };
}

function createContextReceipt(relationship) {
  const payload = JSON.stringify(relationshipContextPayload(relationship));
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function verifyContextReceipt(relationship, receipt) {
  if (typeof receipt !== 'string' || !/^[a-f0-9]{64}$/.test(receipt)) return false;
  const expected = createContextReceipt(relationship);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receipt));
}

function createApprovalCode(randomBytes = crypto.randomBytes) {
  return `LI-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function normalizeApprovalCode(value) {
  const code = cleanText(value, { required: true, max: 11, label: 'LinkedIn approval code' }).toUpperCase();
  if (!/^LI-[A-F0-9]{8}$/.test(code)) throw new Error('LinkedIn approval code must look like LI-12AB34CD.');
  return code;
}

function instructionApprovesCode(instruction, approvalCode) {
  const text = String(instruction || '');
  const code = normalizeApprovalCode(approvalCode);
  if (!text.toUpperCase().includes(code)) return false;
  if (/\b(?:don['’]?t|do not|not|never|cancel|reject)\b/i.test(text)) return false;
  return /\b(?:approve|approved|send|post|go ahead|do it)\b/i.test(text);
}

function instructionRejectsCode(instruction, approvalCode) {
  const text = String(instruction || '');
  const code = normalizeApprovalCode(approvalCode);
  return text.toUpperCase().includes(code) && /\b(?:reject|cancel|discard|don['’]?t send|do not send)\b/i.test(text);
}

module.exports = {
  LINKEDIN_DRAFT_STATUSES,
  LINKEDIN_MESSAGE_TYPES,
  assertSafeRelationshipText,
  createApprovalCode,
  createContextReceipt,
  instructionApprovesCode,
  instructionRejectsCode,
  normalizeApprovalCode,
  normalizeConversationUrn,
  normalizeDraftInput,
  normalizeLinkedInProfileUrl,
  normalizeMemberUrn,
  normalizeRelationshipInput,
  relationshipContextPayload,
  verifyContextReceipt
};
