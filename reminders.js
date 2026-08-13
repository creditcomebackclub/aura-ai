'use strict';

const REMINDER_INPUT_TYPE = 'reminder';
const REMINDER_RECURRENCES = Object.freeze(['once', 'daily', 'weekly']);

function normalizeReminderRecurrence(value) {
  const recurrence = String(value || 'once').trim().toLowerCase();
  if (!REMINDER_RECURRENCES.includes(recurrence)) {
    throw new Error(`Reminder recurrence must be one of: ${REMINDER_RECURRENCES.join(', ')}.`);
  }
  return recurrence;
}

function createReminderInput(message, recurrence = 'once') {
  return {
    type: REMINDER_INPUT_TYPE,
    reminder: {
      message: String(message || '').trim(),
      recurrence: normalizeReminderRecurrence(recurrence),
      delivery: 'in_app_and_telegram'
    }
  };
}

function isReminderTask(task) {
  return task?.input?.type === REMINDER_INPUT_TYPE &&
    typeof task?.input?.reminder?.message === 'string' &&
    Boolean(task.input.reminder.message.trim());
}

function reminderMessage(task) {
  return isReminderTask(task) ? task.input.reminder.message.trim() : '';
}

function nextReminderDueAt(task, { after = new Date() } = {}) {
  if (!isReminderTask(task)) return null;
  const recurrence = normalizeReminderRecurrence(task.input.reminder.recurrence);
  if (recurrence === 'once') return null;

  const dueMs = Date.parse(task.due_at);
  const afterMs = after instanceof Date ? after.getTime() : Date.parse(after);
  if (!Number.isFinite(dueMs) || !Number.isFinite(afterMs)) return null;
  const intervalMs = recurrence === 'daily' ? 86400000 : 7 * 86400000;
  const elapsedIntervals = Math.max(1, Math.floor((afterMs - dueMs) / intervalMs) + 1);
  return new Date(dueMs + elapsedIntervals * intervalMs).toISOString();
}

module.exports = {
  REMINDER_INPUT_TYPE,
  REMINDER_RECURRENCES,
  createReminderInput,
  isReminderTask,
  nextReminderDueAt,
  normalizeReminderRecurrence,
  reminderMessage
};
