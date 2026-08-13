'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReminderInput,
  isReminderTask,
  nextReminderDueAt,
  normalizeReminderRecurrence,
  reminderMessage
} = require('../reminders');

test('reminder input is explicit durable task metadata', () => {
  const task = {
    due_at: '2026-08-13T16:00:00.000Z',
    input: createReminderInput('Post the discussion response', 'weekly')
  };
  assert.equal(isReminderTask(task), true);
  assert.equal(reminderMessage(task), 'Post the discussion response');
  assert.equal(task.input.reminder.delivery, 'in_app_and_telegram');
});

test('recurring reminders advance from their schedule and skip missed intervals', () => {
  const weekly = {
    due_at: '2026-08-06T16:00:00.000Z',
    input: createReminderInput('Discussion post', 'weekly')
  };
  assert.equal(
    nextReminderDueAt(weekly, { after: new Date('2026-08-13T16:05:00.000Z') }),
    '2026-08-20T16:00:00.000Z'
  );
  const once = { ...weekly, input: createReminderInput('Discussion post', 'once') };
  assert.equal(nextReminderDueAt(once), null);
  assert.throws(() => normalizeReminderRecurrence('occasionally'), /once, daily, weekly/);
});
