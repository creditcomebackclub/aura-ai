'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  blocksTime,
  busyIntervals,
  describeOpenWindows,
  findOpenWindows,
  formatWindow
} = require('../calendar_availability');

// Phoenix never observes DST, so 9:00 local is a stable 16:00Z all year.
const TIME_ZONE = 'America/Phoenix';
const THURSDAY_8AM = new Date('2026-08-20T15:00:00Z');

function timed(startZ, endZ, extra = {}) {
  return {
    id: `${startZ}-${endZ}`,
    status: 'confirmed',
    summary: 'Busy',
    start: { dateTime: startZ },
    end: { dateTime: endZ },
    ...extra
  };
}

test('an empty calendar offers the whole business day', () => {
  const [first] = findOpenWindows([], { now: THURSDAY_8AM, timeZone: TIME_ZONE, leadMinutes: 0 });
  assert.equal(first.start, '2026-08-20T16:00:00.000Z');
  assert.equal(first.end, '2026-08-21T00:00:00.000Z');
  assert.equal(first.minutes, 480);
});

test('a midday meeting splits the day into two windows', () => {
  const windows = findOpenWindows(
    [timed('2026-08-20T18:00:00Z', '2026-08-20T19:00:00Z')],
    { now: THURSDAY_8AM, timeZone: TIME_ZONE, leadMinutes: 0 }
  );
  assert.equal(windows[0].end, '2026-08-20T18:00:00.000Z');
  assert.equal(windows[1].start, '2026-08-20T19:00:00.000Z');
});

test('overlapping meetings merge into a single busy block', () => {
  const merged = busyIntervals([
    timed('2026-08-20T18:00:00Z', '2026-08-20T19:30:00Z'),
    timed('2026-08-20T19:00:00Z', '2026-08-20T20:00:00Z')
  ]);
  assert.equal(merged.length, 1);
  assert.equal(new Date(merged[0].end).toISOString(), '2026-08-20T20:00:00.000Z');
});

test('an all-day event consumes the day', () => {
  const windows = findOpenWindows(
    [{ id: 'off', status: 'confirmed', start: { date: '2026-08-20' }, end: { date: '2026-08-21' } }],
    { now: THURSDAY_8AM, timeZone: TIME_ZONE, leadMinutes: 0 }
  );
  assert.ok(windows.every(window => !window.start.startsWith('2026-08-20')));
});

test('cancelled, transparent, and declined events do not block time', () => {
  assert.equal(blocksTime(timed('a', 'b', { status: 'cancelled' })), false);
  assert.equal(blocksTime(timed('a', 'b', { transparency: 'transparent' })), false);
  assert.equal(
    blocksTime(timed('a', 'b', { attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }] })),
    false
  );
  assert.equal(blocksTime(timed('a', 'b')), true);
});

test('weekends are skipped unless explicitly included', () => {
  const friday = new Date('2026-08-21T15:00:00Z');
  const weekdayOnly = findOpenWindows([], {
    now: friday, timeZone: TIME_ZONE, leadMinutes: 0, maxWindows: 5
  });
  assert.ok(weekdayOnly.every(window => !window.label.startsWith('Saturday')));

  const withWeekends = findOpenWindows([], {
    now: friday, timeZone: TIME_ZONE, leadMinutes: 0, includeWeekends: true, maxWindows: 5
  });
  assert.ok(withWeekends.some(window => window.label.startsWith('Saturday')));
});

test('lead time keeps imminent windows out of a suggestion', () => {
  const lateMorning = new Date('2026-08-20T17:30:00Z'); // 10:30 Phoenix
  const [first] = findOpenWindows([], {
    now: lateMorning, timeZone: TIME_ZONE, leadMinutes: 120
  });
  assert.equal(first.start, '2026-08-20T19:30:00.000Z'); // 12:30 Phoenix
});

test('short gaps below the minimum are not offered', () => {
  const windows = findOpenWindows(
    [
      timed('2026-08-20T16:00:00Z', '2026-08-20T19:00:00Z'),
      timed('2026-08-20T19:20:00Z', '2026-08-21T00:00:00Z')
    ],
    { now: THURSDAY_8AM, timeZone: TIME_ZONE, leadMinutes: 0, minMinutes: 30 }
  );
  assert.ok(windows.every(window => !window.start.startsWith('2026-08-20T19:00')));
});

test('window labels read the way a person would say them', () => {
  const label = formatWindow(
    { start: Date.parse('2026-08-20T22:00:00Z'), end: Date.parse('2026-08-21T00:00:00Z') },
    TIME_ZONE
  );
  assert.equal(label, 'Thursday, Aug 20 3–5 PM');
});

test('multiple windows are described as a single phrase', () => {
  assert.equal(describeOpenWindows([{ label: 'A' }, { label: 'B' }, { label: 'C' }]), 'A, B, or C');
  assert.equal(describeOpenWindows([{ label: 'A' }]), 'A');
  assert.equal(describeOpenWindows([]), '');
});
