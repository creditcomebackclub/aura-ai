'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveMorningBriefPreferences,
  resolveExecutivePreferences
} = require('../proactive_preferences');

function profile(...values) {
  return {
    entries: Object.fromEntries(values.map((value, index) => [String(index), { kind: 'preference', value }]))
  };
}

test('morning brief preferences are derived only from durable scoped entries', () => {
  const resolved = resolveMorningBriefPreferences(profile(
    'Do not include my calendar in the morning brief.',
    'Show Blackboard deadlines from the next 5 days in my morning brief.',
    'Skip calendar details in ordinary chat.'
  ));
  assert.deepEqual(resolved, {
    goals: true,
    calendar: false,
    blackboard: true,
    blackboardDays: 5
  });
});

test('morning brief only preference narrows sections', () => {
  assert.deepEqual(
    resolveMorningBriefPreferences(profile('Only include goals and calendar in my morning brief.')),
    { goals: true, calendar: true, blackboard: false, blackboardDays: 3 }
  );
});

test('executive preferences resolve quiet hours and meeting lead time', () => {
  const resolved = resolveExecutivePreferences(profile(
    'My quiet hours are from 10 pm to 6 am.',
    'Give me a meeting brief 15 minutes before the meeting.'
  ));
  assert.deepEqual(resolved, {
    quietStartHour: 22,
    quietEndHour: 6,
    meetingBriefMinMinutes: 13,
    meetingBriefMaxMinutes: 17
  });
});

test('untrusted memory candidates do not alter proactive settings', () => {
  const resolved = resolveExecutivePreferences({
    entries: {},
    memory_candidates: [{ value: 'My quiet hours are from 1 am to 2 am.' }]
  });
  assert.equal(resolved.quietStartHour, 21);
  assert.equal(resolved.quietEndHour, 7);
});
