'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listDirectUnreadEmailItems } = require('../email_provider');

test('structured Gmail reads preserve stable ids and safe metadata for the Executive Loop', async () => {
  const keys = ['EMAIL_PROVIDER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  const urls = [];
  try {
    process.env.EMAIL_PROVIDER = 'gmail';
    process.env.GMAIL_CLIENT_ID = 'id';
    process.env.GMAIL_CLIENT_SECRET = 'secret';
    process.env.GMAIL_REFRESH_TOKEN = 'refresh';
    global.fetch = async url => {
      const value = String(url);
      urls.push(value);
      if (value.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'token' }) };
      }
      if (/\/messages\?/.test(value)) {
        return { ok: true, json: async () => ({ messages: [{ id: 'message-1', threadId: 'thread-1' }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          id: 'message-1',
          threadId: 'thread-1',
          internalDate: '1785772800000',
          snippet: 'Can you review the attached numbers?',
          payload: {
            headers: [
              { name: 'From', value: 'Mike <mike@example.com>' },
              { name: 'To', value: 'Chris <creditcomebackclub@gmail.com>' },
              { name: 'Subject', value: 'Review request' },
              { name: 'Date', value: 'Mon, 3 Aug 2026 09:00:00 -0700' }
            ]
          }
        })
      };
    };

    const items = await listDirectUnreadEmailItems({ maxResults: 20 });
    assert.deepEqual(items, [{
      id: 'message-1',
      thread_id: 'thread-1',
      received: 'Mon, 3 Aug 2026 09:00:00 -0700',
      from: 'Mike <mike@example.com>',
      to: 'Chris <creditcomebackclub@gmail.com>',
      subject: 'Review request',
      snippet: 'Can you review the attached numbers?',
      internal_date: new Date(1785772800000).toISOString()
    }]);
    const listUrl = new URL(urls[1]);
    assert.equal(listUrl.searchParams.get('q'), 'is:unread');
    assert.equal(listUrl.searchParams.get('maxResults'), '20');
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
