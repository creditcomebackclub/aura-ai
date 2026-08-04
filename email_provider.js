function decodeBase64Url(value = '') {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function refreshGoogleToken() {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) throw new Error(`Gmail token refresh failed (${response.status}).`);
  return (await response.json()).access_token;
}

async function listGmailMessageItems({ query = 'is:unread', maxResults = 10 } = {}) {
  const token = await refreshGoogleToken();
  const headers = { Authorization: `Bearer ${token}` };
  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('q', String(query || 'is:unread'));
  listUrl.searchParams.set('maxResults', String(Math.max(1, Math.min(50, Number(maxResults) || 10))));
  const listResponse = await fetch(listUrl, { headers });
  if (!listResponse.ok) throw new Error(`Gmail message list failed (${listResponse.status}).`);
  const list = await listResponse.json();
  if (!list.messages?.length) return [];

  // Gmail charges each metadata read separately. Fetch sequentially so the Mac
  // and cloud schedulers cannot combine into a burst that exceeds per-user
  // quota when both inspect sent mail at the same time.
  const messages = [];
  for (const item of list.messages) {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers }
    );
    if (!response.ok) throw new Error(`Gmail message read failed (${response.status}).`);
    const message = await response.json();
    const messageHeaders = Object.fromEntries(
      (message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value])
    );
    messages.push({
      id: message.id,
      thread_id: message.threadId || null,
      received: messageHeaders.date || '',
      from: messageHeaders.from || '',
      to: messageHeaders.to || '',
      subject: messageHeaders.subject || '(No subject)',
      snippet: message.snippet || '',
      internal_date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null
    });
  }
  return messages;
}

async function getGmailUnread() {
  const messages = await listGmailMessageItems({ query: 'is:unread', maxResults: 10 });
  if (!messages.length) return 'No unread emails.';
  return messages.map(message =>
    `Received: ${message.received}\nFrom: ${message.from}\nSubject: ${message.subject}\nContent Snippet: ${message.snippet}\nMessage ID: ${message.id}\n---`
  ).join('\n');
}

async function refreshMicrosoftToken() {
  const tenant = process.env.OUTLOOK_TENANT_ID || 'common';
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.OUTLOOK_CLIENT_ID,
        client_secret: process.env.OUTLOOK_CLIENT_SECRET,
        refresh_token: process.env.OUTLOOK_REFRESH_TOKEN,
        grant_type: 'refresh_token',
        scope: 'offline_access Mail.Read'
      })
    }
  );
  if (!response.ok) throw new Error(`Outlook token refresh failed (${response.status}).`);
  return (await response.json()).access_token;
}

async function listOutlookUnreadItems({ maxResults = 10 } = {}) {
  const token = await refreshMicrosoftToken();
  const query = new URLSearchParams({
    '$filter': 'isRead eq false',
    '$top': String(Math.max(1, Math.min(50, Number(maxResults) || 10))),
    '$orderby': 'receivedDateTime desc',
    '$select': 'id,receivedDateTime,from,subject,bodyPreview'
  });
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`Outlook message read failed (${response.status}).`);
  const data = await response.json();
  return (data.value || []).map(message => ({
    id: message.id,
    thread_id: null,
    received: message.receivedDateTime || '',
    from: `${message.from?.emailAddress?.name || ''} <${message.from?.emailAddress?.address || ''}>`.trim(),
    subject: message.subject || '(No subject)',
    snippet: message.bodyPreview || '',
    internal_date: message.receivedDateTime || null
  }));
}

async function listOutlookSentItems({ maxResults = 20 } = {}) {
  const token = await refreshMicrosoftToken();
  const query = new URLSearchParams({
    '$top': String(Math.max(1, Math.min(50, Number(maxResults) || 20))),
    '$orderby': 'sentDateTime desc',
    '$select': 'id,sentDateTime,toRecipients,subject,bodyPreview'
  });
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages?${query}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`Outlook sent message read failed (${response.status}).`);
  const data = await response.json();
  return (data.value || []).map(message => ({
    id: message.id,
    thread_id: null,
    received: message.sentDateTime || '',
    from: '',
    to: (message.toRecipients || [])
      .map(item => item.emailAddress?.address || '')
      .filter(Boolean)
      .join(', '),
    subject: message.subject || '(No subject)',
    snippet: message.bodyPreview || '',
    internal_date: message.sentDateTime || null
  }));
}

async function getOutlookUnread() {
  const messages = await listOutlookUnreadItems({ maxResults: 10 });
  if (!messages.length) return 'No unread emails.';
  return messages.map(message =>
    `Received: ${message.received}\nFrom: ${message.from}\nSubject: ${message.subject}\nContent Snippet: ${message.snippet}\nMessage ID: ${message.id}\n---`
  ).join('\n');
}

function isDirectEmailConfigured() {
  if (process.env.EMAIL_PROVIDER === 'gmail') {
    return Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
  }
  if (process.env.EMAIL_PROVIDER === 'outlook') {
    return Boolean(process.env.OUTLOOK_CLIENT_ID && process.env.OUTLOOK_CLIENT_SECRET && process.env.OUTLOOK_REFRESH_TOKEN);
  }
  return false;
}

async function getDirectUnreadEmails() {
  if (process.env.EMAIL_PROVIDER === 'gmail') return getGmailUnread();
  if (process.env.EMAIL_PROVIDER === 'outlook') return getOutlookUnread();
  throw new Error('No direct email provider is configured.');
}

async function listDirectUnreadEmailItems({ maxResults = 20 } = {}) {
  if (process.env.EMAIL_PROVIDER === 'gmail') {
    return listGmailMessageItems({ query: 'is:unread', maxResults });
  }
  if (process.env.EMAIL_PROVIDER === 'outlook') {
    return listOutlookUnreadItems({ maxResults });
  }
  return [];
}

async function listDirectSentEmailItems({ maxResults = 30 } = {}) {
  if (process.env.EMAIL_PROVIDER === 'gmail') {
    return listGmailMessageItems({ query: 'in:sent newer_than:30d', maxResults });
  }
  if (process.env.EMAIL_PROVIDER === 'outlook') {
    return listOutlookSentItems({ maxResults });
  }
  return [];
}

let directEmailIdentityPromise = null;

async function getDirectEmailIdentity() {
  if (!directEmailIdentityPromise) {
    directEmailIdentityPromise = (async () => {
      if (process.env.EMAIL_PROVIDER === 'gmail') {
        const token = await refreshGoogleToken();
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`Gmail profile lookup failed (${response.status}).`);
        return (await response.json()).emailAddress || null;
      }
      if (process.env.EMAIL_PROVIDER === 'outlook') {
        const token = await refreshMicrosoftToken();
        const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`Outlook profile lookup failed (${response.status}).`);
        const profile = await response.json();
        return profile.mail || profile.userPrincipalName || null;
      }
      return null;
    })().catch(error => {
      directEmailIdentityPromise = null;
      throw error;
    });
  }
  return directEmailIdentityPromise;
}

// Only Gmail send is implemented - it's the provider AURA already has a
// refresh token for. The read-only token minted for getGmailUnread will
// reject this with an insufficient-scope error until it's re-consented
// with gmail.send (or the broad mail.google.com) added, since Google scopes
// a refresh token to whatever was granted at authorization time.
function isDirectSendConfigured() {
  return process.env.EMAIL_PROVIDER === 'gmail' &&
    Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
}

function encodeBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Builds a raw RFC 2822 message (plain text, optionally with one binary
// attachment as multipart/mixed) and sends it through Gmail's send endpoint,
// which wants the whole MIME message base64url-encoded rather than separate
// to/subject/body fields.
async function sendGmailMessage(to, subject, body, attachment = null) {
  const token = await refreshGoogleToken();
  const boundary = `aura_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headers = [
    `To: ${to}`,
    `Subject: ${subject || ''}`,
    'MIME-Version: 1.0'
  ];

  let raw;
  if (attachment) {
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    raw = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body || '',
      '',
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      '',
      attachment.base64,
      '',
      `--${boundary}--`
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    raw = [...headers, '', body || ''].join('\r\n');
  }

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encodeBase64Url(Buffer.from(raw, 'utf8')) })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gmail send failed (${response.status}): ${errText}`);
  }
  return true;
}

module.exports = {
  decodeBase64Url,
  listGmailMessageItems,
  getGmailUnread,
  listOutlookUnreadItems,
  listOutlookSentItems,
  getOutlookUnread,
  isDirectEmailConfigured,
  isDirectSendConfigured,
  sendGmailMessage,
  getDirectUnreadEmails,
  listDirectUnreadEmailItems,
  listDirectSentEmailItems,
  getDirectEmailIdentity
};
