const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDueAt, formatDueLabel, isDueToday, isOverdue } = require('../due_date');

const TZ = 'America/Phoenix';
// Wednesday 2026-08-05 mid-morning Phoenix (UTC-7).
const NOW = new Date('2026-08-05T17:00:00Z');

test('parseDueAt accepts today, tomorrow, and in N days', () => {
  // Default due time is 5pm local → midnight UTC the next calendar day in Phoenix.
  assert.equal(parseDueAt('today', { timeZone: TZ, now: NOW }), '2026-08-06T00:00:00.000Z');
  assert.equal(parseDueAt('tomorrow', { timeZone: TZ, now: NOW }), '2026-08-07T00:00:00.000Z');
  assert.equal(parseDueAt('in 3 days', { timeZone: TZ, now: NOW }), '2026-08-09T00:00:00.000Z');
});

test('parseDueAt accepts weekdays and ISO dates', () => {
  assert.equal(parseDueAt('Friday', { timeZone: TZ, now: NOW }), '2026-08-08T00:00:00.000Z');
  assert.equal(parseDueAt('next Monday', { timeZone: TZ, now: NOW }), '2026-08-11T00:00:00.000Z');
  assert.equal(parseDueAt('2026-08-12T18:00:00Z', { timeZone: TZ, now: NOW }), '2026-08-12T18:00:00.000Z');
  assert.equal(parseDueAt('never-ever', { timeZone: TZ, now: NOW }), null);
  assert.equal(parseDueAt('', { timeZone: TZ, now: NOW }), null);
});

test('parseDueAt grounds explicit local reminder times', () => {
  assert.equal(
    parseDueAt('Thursday at 9 AM', { timeZone: TZ, now: NOW }),
    '2026-08-06T16:00:00.000Z'
  );
  assert.equal(
    parseDueAt('every Thursday at 2:30 pm', { timeZone: TZ, now: NOW }),
    '2026-08-06T21:30:00.000Z'
  );
  assert.equal(
    parseDueAt('tomorrow at noon', { timeZone: TZ, now: NOW }),
    '2026-08-06T19:00:00.000Z'
  );
});

test('same-day timed weekdays use today only while that time is still ahead', () => {
  assert.equal(
    parseDueAt('Wednesday at 11 AM', { timeZone: TZ, now: NOW }),
    '2026-08-05T18:00:00.000Z'
  );
  assert.equal(
    parseDueAt('Wednesday at 9 AM', { timeZone: TZ, now: NOW }),
    '2026-08-12T16:00:00.000Z'
  );
});

test('due labels distinguish today, overdue, and future', () => {
  const dueToday = parseDueAt('today', { timeZone: TZ, now: NOW });
  assert.equal(isDueToday(dueToday, { timeZone: TZ, now: NOW }), true);
  assert.equal(formatDueLabel(dueToday, { timeZone: TZ, now: NOW }), 'due today');

  const past = '2026-08-01T00:00:00.000Z';
  assert.equal(isOverdue(past, { now: NOW }), true);
  assert.equal(formatDueLabel(past, { timeZone: TZ, now: NOW }), 'overdue');

  const friday = parseDueAt('Friday', { timeZone: TZ, now: NOW });
  assert.match(formatDueLabel(friday, { timeZone: TZ, now: NOW }), /due Fri/i);
});

test('a date-only due date means end of the local day, not UTC midnight', () => {
  // new Date('2026-08-25') is UTC midnight = 5pm Aug 24 in Phoenix, which made
  // every date-only goal read as overdue on the morning it was actually due.
  assert.equal(parseDueAt('2026-08-25', { timeZone: TZ, now: NOW }), '2026-08-26T00:00:00.000Z');
  assert.equal(parseDueAt('2026-08-05', { timeZone: TZ, now: NOW }), '2026-08-06T00:00:00.000Z');
  // A timestamp that carries its own offset is still taken as given.
  assert.equal(
    parseDueAt('2026-08-12T18:00:00Z', { timeZone: TZ, now: NOW }),
    '2026-08-12T18:00:00.000Z'
  );
});

test('"next <weekday>" lands in the following week', () => {
  // NOW is Wednesday 2026-08-05.
  assert.equal(parseDueAt('Friday', { timeZone: TZ, now: NOW }), '2026-08-08T00:00:00.000Z');
  // Previously this returned this week's Friday, so the goal came due a week early.
  assert.equal(parseDueAt('next Friday', { timeZone: TZ, now: NOW }), '2026-08-15T00:00:00.000Z');
  assert.equal(parseDueAt('next Monday', { timeZone: TZ, now: NOW }), '2026-08-11T00:00:00.000Z');
  assert.equal(parseDueAt('next Wednesday', { timeZone: TZ, now: NOW }), '2026-08-13T00:00:00.000Z');
});
