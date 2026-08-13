'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findUnsupportedActionClaim, toolResultSucceeded } = require('../action_receipts');

test('completion claims require the matching successful receipt', () => {
  assert.equal(findUnsupportedActionClaim("You're set. I'll remind you every Thursday.").kind, 'reminder');
  assert.equal(findUnsupportedActionClaim('The draft is on Telegram.').kind, 'telegram');
  assert.equal(findUnsupportedActionClaim('I have scheduled the meeting on your calendar.').kind, 'calendar');
  assert.equal(findUnsupportedActionClaim('I will remember that preference.').kind, 'memory');
  assert.equal(findUnsupportedActionClaim("I'll check in with you every Thursday.").kind, 'reminder');
  assert.equal(findUnsupportedActionClaim("I'll make sure to remind you every Thursday.").kind, 'reminder');
  assert.equal(findUnsupportedActionClaim('I cancelled your reminder.').kind, 'reminder cancellation');
  assert.equal(
    findUnsupportedActionClaim("You're set. I'll remind you every Thursday.", ['set_reminder']),
    null
  );
  assert.equal(findUnsupportedActionClaim('I can set that once you tell me the time.'), null);
  assert.equal(findUnsupportedActionClaim('All set.', [], {
    candidateToolNames: ['set_reminder']
  }).kind, 'action');
  assert.equal(findUnsupportedActionClaim('All set.', [], {
    candidateToolNames: ['check_calendar']
  }), null);
  assert.equal(findUnsupportedActionClaim("I'll send it now.", [], {
    candidateToolNames: ['send_email']
  }).kind, 'action');
});

test('failed action results never become successful evidence', () => {
  assert.equal(toolResultSucceeded('set_reminder', { scheduled: false }), false);
  assert.equal(toolResultSucceeded('set_reminder', { scheduled: true }), true);
  assert.equal(toolResultSucceeded('cancel_reminder', { cancelled: false }), false);
  assert.equal(toolResultSucceeded('cancel_reminder', { cancelled: true }), true);
  assert.equal(toolResultSucceeded('send_email', 'Email not sent. Missing recipient.'), false);
  assert.equal(toolResultSucceeded('send_email', 'Sent to person@example.com.'), true);
  assert.equal(toolResultSucceeded('create_calendar_event', 'Calendar event failed: outage'), false);
  assert.equal(toolResultSucceeded('create_calendar_event', 'Created on Google Calendar.'), true);
});
