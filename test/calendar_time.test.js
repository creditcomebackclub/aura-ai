'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTemporalContext,
  groundCalendarEventArgs,
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
