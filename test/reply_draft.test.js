'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSchedulingReply,
  recipientAddress,
  replySubject,
  sanitizeGreetingName,
  sanitizeHeaderText
} = require('../reply_draft');

const WINDOWS = [
  { start: '2026-08-20T22:00:00Z', end: '2026-08-21T00:00:00Z', minutes: 120, label: 'Thursday, Aug 20 3–5 PM' }
];
const TWO_WINDOWS = [
  ...WINDOWS,
  { start: '2026-08-21T16:00:00Z', end: '2026-08-21T18:00:00Z', minutes: 120, label: 'Friday, Aug 21 9–11 AM' }
];

const SIGNAL = {
  from: '"Matt Rivera" <matt@identityiq.com>',
  subject: 'Reseller partnership — next steps'
};

test('a scheduling reply offers the owner windows and nothing else', () => {
  const draft = buildSchedulingReply({ signal: SIGNAL, windows: WINDOWS, ownerName: 'Chris' });

  assert.equal(draft.to, 'matt@identityiq.com');
  assert.equal(draft.subject, 'Re: Reseller partnership — next steps');
  assert.equal(
    draft.body,
    'Hi Matt,\n' +
    '\n' +
    'Thanks for reaching out — happy to find a time to talk.\n' +
    '\n' +
    "I'm open Thursday, Aug 20 3–5 PM. Would that work for you?\n" +
    '\n' +
    'Best,\n' +
    'Chris'
  );
});

test('several windows are offered as a choice', () => {
  const draft = buildSchedulingReply({ signal: SIGNAL, windows: TWO_WINDOWS, ownerName: 'Chris' });
  assert.match(draft.body, /I have a few windows open — Thursday, Aug 20 3–5 PM, or Friday, Aug 21 9–11 AM\. Would any of those work for you\?/);
});

test('the private goal text never reaches the outbound draft', () => {
  const draft = buildSchedulingReply({
    signal: SIGNAL,
    windows: WINDOWS,
    ownerName: 'Chris',
    goal: 'setup partnership with identity iq'
  });
  assert.doesNotMatch(draft.body, /goal|partnership with identity iq/i);
});

test('a display name cannot inject content into the body', () => {
  const draft = buildSchedulingReply({
    signal: {
      from: '"Matt\r\nBcc: attacker@evil.com" <matt@identityiq.com>',
      subject: 'Hello'
    },
    windows: WINDOWS,
    ownerName: 'Chris'
  });
  assert.match(draft.body, /^Hi Matt,/);
  assert.doesNotMatch(draft.body, /Bcc|attacker@evil\.com/);
});

test('a hostile display name degrades to a bare greeting', () => {
  const draft = buildSchedulingReply({
    signal: { from: '"<script>alert(1)</script>" <x@example.com>', subject: 'Hi' },
    windows: WINDOWS,
    ownerName: 'Chris'
  });
  assert.match(draft.body, /^Hi,/);
  assert.doesNotMatch(draft.body, /script|alert/);
});

test('a subject line cannot inject a header', () => {
  assert.equal(
    replySubject('Partnership\r\nBcc: attacker@evil.com'),
    'Re: Partnership Bcc: attacker@evil.com'
  );
  assert.doesNotMatch(replySubject('Partnership\r\nBcc: x@y.com'), /[\r\n]/);
});

test('an existing Re: prefix is not doubled, and an empty subject gets a default', () => {
  assert.equal(replySubject('Re: Partnership'), 'Re: Partnership');
  assert.equal(replySubject('RE: Partnership'), 'RE: Partnership');
  assert.equal(replySubject(''), 'Finding time to connect');
});

test('no-reply and automated senders are never drafted to', () => {
  assert.equal(recipientAddress({ from: 'no-reply@identityiq.com' }), '');
  assert.equal(recipientAddress({ from: 'Do Not Reply <donotreply@identityiq.com>' }), '');
  assert.equal(recipientAddress({ from: 'notifications@identityiq.com' }), '');
  assert.equal(recipientAddress({ from: 'mailer-daemon@identityiq.com' }), '');
  assert.equal(recipientAddress({ from: '"Matt" <matt@identityiq.com>' }), 'matt@identityiq.com');
});

test('there is no draft without free time or a repliable address', () => {
  assert.equal(buildSchedulingReply({ signal: SIGNAL, windows: [] }), null);
  assert.equal(buildSchedulingReply({ signal: { from: 'no-reply@x.com' }, windows: WINDOWS }), null);
  assert.equal(buildSchedulingReply({ signal: { from: 'not an address' }, windows: WINDOWS }), null);
});

test('AURA never drafts a reply to the owner', () => {
  assert.equal(
    buildSchedulingReply({
      signal: { from: 'Chris <chris@creditcomebackclub.com>', subject: 'Note to self' },
      windows: WINDOWS,
      ownerEmail: 'chris@creditcomebackclub.com'
    }),
    null
  );
});

test('sanitizers strip control characters and markup', () => {
  assert.equal(sanitizeHeaderText('a\r\nb\tc', 100), 'a b c');
  assert.equal(sanitizeHeaderText('<b>bold</b>', 100), 'bbold/b');
  assert.equal(sanitizeGreetingName('Matt Rivera'), 'Matt');
  assert.equal(sanitizeGreetingName("O'Brien"), "O'Brien");
  assert.equal(sanitizeGreetingName('123'), '');
  assert.equal(sanitizeGreetingName(''), '');
});

test('a personal-domain recipient is flagged but still drafted', () => {
  const draft = buildSchedulingReply({
    signal: { from: 'Sue <sue@gmail.com>', subject: 'Coffee?' },
    windows: WINDOWS,
    ownerName: 'Chris'
  });
  assert.equal(draft.to, 'sue@gmail.com');
  assert.equal(draft.personal_domain, true);
});
