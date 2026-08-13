'use strict';

const {
  normalizeConversationUrn,
  normalizeDraftInput,
  normalizeMemberUrn
} = require('./linkedin_relationship');

class LinkedInDeliveryError extends Error {
  constructor(message, code, { status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LinkedInDeliveryError';
    this.code = code;
    this.status = status;
  }
}

function createLinkedInClient({
  accessToken = process.env.LINKEDIN_ACCESS_TOKEN || '',
  apiBase = process.env.LINKEDIN_API_BASE || 'https://api.linkedin.com',
  fetchImpl = global.fetch,
  messageSender = null,
  timeoutMs = 15000
} = {}) {
  const normalizedBase = String(apiBase || '').replace(/\/$/, '');
  const boundedTimeoutMs = Math.max(1000, Math.min(60000, Number(timeoutMs) || 15000));
  if (!/^https:\/\/api\.linkedin\.com$/i.test(normalizedBase)) {
    throw new Error('LINKEDIN_API_BASE must be https://api.linkedin.com.');
  }

  function status() {
    return {
      configured: Boolean(accessToken),
      connection_requests: accessToken ? 'token_configured_access_unverified' : 'partner_access_not_configured',
      messages: accessToken ? 'token_configured_access_unverified' : 'partner_access_not_configured',
      unattended_automation: false,
      scraping: false
    };
  }

  async function parseLinkedInResponse(response) {
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }
    if (!response.ok) {
      const detail = typeof data === 'object'
        ? (data?.message || data?.error_description || JSON.stringify(data))
        : data;
      throw new LinkedInDeliveryError(
        `LinkedIn rejected the delivery${detail ? `: ${String(detail).slice(0, 500)}` : '.'}`,
        'LINKEDIN_DELIVERY_REJECTED',
        { status: response.status }
      );
    }
    return { data, linkedinId: response.headers.get('x-linkedin-id') || null };
  }

  async function sendConnectionRequest({ recipient_member_urn, body }) {
    if (!accessToken) {
      throw new LinkedInDeliveryError(
        'LinkedIn connection-request delivery is not configured. An approved LinkedIn partner access token is required; the draft remains recorded and was not sent.',
        'LINKEDIN_PARTNER_ACCESS_REQUIRED'
      );
    }
    const recipient = normalizeMemberUrn(recipient_member_urn, { required: true });
    let response;
    try {
      response = await fetchImpl(`${normalizedBase}/v2/invitations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        signal: AbortSignal.timeout(boundedTimeoutMs),
        body: JSON.stringify({
          invitee: recipient,
          message: {
            'com.linkedin.invitations.InvitationMessage': { body }
          }
        })
      });
    } catch (error) {
      throw new LinkedInDeliveryError(
        'LinkedIn could not be reached. The approved draft was not sent.',
        'LINKEDIN_NETWORK_ERROR',
        { cause: error }
      );
    }
    const parsed = await parseLinkedInResponse(response);
    return {
      sent: true,
      provider: 'linkedin',
      delivery_kind: 'connection_request',
      provider_id: parsed.linkedinId
    };
  }

  async function sendApprovedDraft(input = {}) {
    const draft = normalizeDraftInput(input);
    if (draft.message_type === 'connection_request') {
      return sendConnectionRequest({
        recipient_member_urn: input.recipient_member_urn,
        body: draft.body
      });
    }
    if (!accessToken) {
      throw new LinkedInDeliveryError(
        'LinkedIn direct-message delivery requires approved Messages API partner access. The exact draft is approved and retained, but it was not sent.',
        'LINKEDIN_MESSAGES_PARTNER_ACCESS_REQUIRED'
      );
    }
    const conversation = normalizeConversationUrn(input.conversation_urn);
    const recipient = normalizeMemberUrn(input.recipient_member_urn, { required: !conversation });
    try {
      if (typeof messageSender === 'function') {
        const result = await messageSender({
          accessToken,
          recipient_member_urn: recipient,
          conversation_urn: conversation,
          message_type: draft.message_type,
          subject: draft.subject,
          body: draft.body
        });
        if (!result?.sent) throw new Error('Partner adapter did not return a send receipt.');
        return { ...result, provider: 'linkedin', delivery_kind: 'message' };
      }
      const payload = {
        body: draft.body,
        messageType: 'MEMBER_TO_MEMBER',
        attachments: [],
        ...(draft.subject ? { subject: draft.subject } : {}),
        ...(conversation ? { thread: conversation } : { recipients: [recipient] })
      };
      const response = await fetchImpl(`${normalizedBase}/v2/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Restli-Protocol-Version': '2.0.0'
        },
        signal: AbortSignal.timeout(boundedTimeoutMs),
        body: JSON.stringify(payload)
      });
      const parsed = await parseLinkedInResponse(response);
      return {
        sent: true,
        provider: 'linkedin',
        delivery_kind: 'message',
        provider_id: parsed.linkedinId
      };
    } catch (error) {
      if (error instanceof LinkedInDeliveryError) throw error;
      throw new LinkedInDeliveryError(
        `LinkedIn message delivery failed: ${error.message || 'unknown error'}. The draft was not marked sent.`,
        'LINKEDIN_MESSAGE_DELIVERY_FAILED',
        { cause: error }
      );
    }
  }

  return { sendApprovedDraft, status };
}

module.exports = {
  LinkedInDeliveryError,
  createLinkedInClient
};
