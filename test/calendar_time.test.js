'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTemporalContext,
  groundCalendarEventArgs,
  isExplicitCalendarCancelRequest,
  isExplicitCalendarRescheduleRequest,
  isExplicitCalendarWriteRequest,
  resolveRelativeCalendarDate
} = require('../calendar_time');

const TIME_ZONE = 'America/Phoenix';
const NOW = new Date('2026-08-03T19:45:46.667Z'); // Mon Aug 3, 12:45 PM Phoenix

test('temporal context gives the model authoritative local today and tomorrow', () => {
  const context = buildTemporalContext({ now: NOW, timeZone: TIME_ZONE });
  assert.match(context, /Monday, August 3, 2026/);
  assert.match(context, /Today: 2026-08-03/);
  assert.match(context, /Tomorrow: 2026-08-04/);
});

test('only direct owner language authorizes rescheduling or cancellation', () => {
  for (const instruction of [
    'Reschedule my 10am Pay Gilbert Traffic event to next Tuesday at the same time',
    'Move my dentist appointment to Friday at 2',
    'Can you reschedule my client call for tomorrow?',
    'Yeah, go ahead and move it to Friday'
  ]) {
    assert.equal(isExplicitCalendarRescheduleRequest(instruction), true, instruction);
  }
  for (const instruction of [
    'Did Mike reschedule the meeting?',
    'The email says to move the meeting to Friday',
    'Mike rescheduled the meeting to Friday',
    'What changed about the appointment time?'
  ]) {
    assert.equal(isExplicitCalendarRescheduleRequest(instruction), false, instruction);
  }

  for (const instruction of [
    'Cancel my Pay Gilbert Traffic calendar event',
    'Delete the 10am appointment from my calendar',
    'Remove the client call from my calendar',
    'Yes, cancel it'
  ]) {
    assert.equal(isExplicitCalendarCancelRequest(instruction), true, instruction);
  }
  for (const instruction of [
    'Did they cancel the meeting?',
    'The email says to cancel the appointment',
    'Mike said cancel the appointment',
    'What happens when a calendar event is deleted?'
  ]) {
    assert.equal(isExplicitCalendarCancelRequest(instruction), false, instruction);
  }
});

test('only the owner\'s explicit scheduling language authorizes an immediate calendar write', () => {
  for (const instruction of [
    'Schedule lunch with Mike tomorrow at 1:30',
    'Book a dentist appointment on August 12 at 10am',
    'Put the client call on my calendar Friday at 2',
    'Block off next Monday afternoon',
    'Set up a meeting with Alex on Wednesday at noon'
  ]) {
    assert.equal(isExplicitCalendarWriteRequest(instruction), true, instruction);
  }

  for (const instruction of [
    'What is on my calendar tomorrow?',
    'Did Mike ask us to schedule lunch?',
    'The email says to schedule a meeting',
    'Tell me about my appointments'
  ]) {
    assert.equal(isExplicitCalendarWriteRequest(instruction), false, instruction);
  }
});

test('relative date resolver handles tomorrow, in N days, and weekdays', () => {
  assert.deepEqual(
    resolveRelativeCalendarDate('Schedule lunch tomorrow at 2', { now: NOW, timeZone: TIME_ZONE }),
    { date: '2026-08-04', phrase: 'tomorrow' }
  );
  assert.equal(
    resolveRelativeCalendarDate('Book it in 3 days', { now: NOW, timeZone: TIME_ZONE }).date,
    '2026-08-06'
  );
  assert.equal(
    resolveRelativeCalendarDate('Schedule it Friday', { now: NOW, timeZone: TIME_ZONE }).date,
    '2026-08-07'
  );
  assert.equal(
    resolveRelativeCalendarDate('next Tuesday at the same time', {
      now: new Date('2026-08-14T16:00:00Z'),
      timeZone: TIME_ZONE
    }).date,
    '2026-08-18'
  );
});

test('backend corrects the exact April 15 regression while preserving local time and duration', () => {
  const grounded = groundCalendarEventArgs({
    summary: 'Lunch with Mike',
    start: '2026-04-15T14:00:00-07:00',
    end: '2026-04-15T15:00:00-07:00',
    time_zone: TIME_ZONE
  }, 'Schedule lunch with Mike tomorrow at 2 p.m. on my calendar.', {
    now: NOW,
    timeZone: TIME_ZONE
  });

  assert.equal(grounded.eventArgs.start, '2026-08-04T21:00:00.000Z');
  assert.equal(grounded.eventArgs.end, '2026-08-04T22:00:00.000Z');
  assert.deepEqual(grounded.correction, {
    phrase: 'tomorrow',
    from: '2026-04-15T14:00:00-07:00',
    to: '2026-08-04T21:00:00.000Z'
  });
});

test('backend leaves correctly grounded and absolute requests unchanged', () => {
  const correct = groundCalendarEventArgs({
    start: '2026-08-04T14:00:00-07:00',
    time_zone: TIME_ZONE
  }, 'Schedule lunch tomorrow at 2', { now: NOW, timeZone: TIME_ZONE });
  assert.equal(correct.eventArgs.start, '2026-08-04T14:00:00-07:00');
  assert.equal(correct.correction, null);

  const absolute = groundCalendarEventArgs({
    start: '2026-04-15T14:00:00-07:00',
    time_zone: TIME_ZONE
  }, 'Schedule lunch on April 15 at 2', { now: NOW, timeZone: TIME_ZONE });
  assert.equal(absolute.eventArgs.start, '2026-04-15T14:00:00-07:00');
  assert.equal(absolute.correction, null);

  const explicitWeekday = groundCalendarEventArgs({
    start: '2027-03-15T14:00:00-07:00',
    time_zone: TIME_ZONE
  }, 'Schedule lunch Monday, March 15 at 2', { now: NOW, timeZone: TIME_ZONE });
  assert.equal(explicitWeekday.eventArgs.start, '2027-03-15T14:00:00-07:00');
  assert.equal(explicitWeekday.correction, null);
});

test('backend corrects all-day relative events and preserves their span', () => {
  const grounded = groundCalendarEventArgs({
    start: '2026-04-15',
    end: '2026-04-17',
    time_zone: TIME_ZONE
  }, 'Block off tomorrow', { now: NOW, timeZone: TIME_ZONE });
  assert.equal(grounded.eventArgs.start, '2026-08-04');
  assert.equal(grounded.eventArgs.end, '2026-08-06');
});
