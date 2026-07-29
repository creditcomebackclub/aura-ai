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

async function getGmailUnread() {
  const token = await refreshGoogleToken();
  const headers = { Authorization: `Bearer ${token}` };
  const listResponse = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread&maxResults=10',
    { headers }
  );
  if (!listResponse.ok) throw new Error(`Gmail message list failed (${listResponse.status}).`);
  const list = await listResponse.json();
  if (!list.messages?.length) return 'No unread emails.';

  const messages = await Promise.all(list.messages.map(async item => {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers }
    );
    if (!response.ok) throw new Error(`Gmail message read failed (${response.status}).`);
    const message = await response.json();
    const messageHeaders = Object.fromEntries(
      (message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value])
    );
    return {
      id: message.id,
      received: messageHeaders.date || '',
      from: messageHeaders.from || '',
      subject: messageHeaders.subject || '(No subject)',
      snippet: message.snippet || ''
    };
  }));
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

async function getOutlookUnread() {
  const token = await refreshMicrosoftToken();
  const query = new URLSearchParams({
    '$filter': 'isRead eq false',
    '$top': '10',
    '$orderby': 'receivedDateTime desc',
    '$select': 'id,receivedDateTime,from,subject,bodyPreview'
  });
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${query}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`Outlook message read failed (${response.status}).`);
  const data = await response.json();
  if (!data.value?.length) return 'No unread emails.';
  return data.value.map(message =>
    `Received: ${message.receivedDateTime}\nFrom: ${message.from?.emailAddress?.name || ''} <${message.from?.emailAddress?.address || ''}>\nSubject: ${message.subject || '(No subject)'}\nContent Snippet: ${message.bodyPreview || ''}\nMessage ID: ${message.id}\n---`
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

module.exports = {
  decodeBase64Url,
  getGmailUnread,
  getOutlookUnread,
  isDirectEmailConfigured,
  getDirectUnreadEmails
};
