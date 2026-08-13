'use strict';

const DEFAULT_MORNING_BRIEF = Object.freeze({
  goals: true,
  calendar: true,
  blackboard: true,
  blackboardDays: 3
});

function durablePreferenceValues(profile) {
  return Object.values(profile?.entries || {})
    .filter(entry => entry && entry.kind !== 'memory_candidate')
    .map(entry => String(entry.value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function scopedMorningBriefValues(profile) {
  return durablePreferenceValues(profile).filter(value => /\bmorning\s+brief\b/i.test(value));
}

function mentionsSection(value, section) {
  if (section === 'goals') return /\b(?:goals?|tasks?|priorities)\b/i.test(value);
  if (section === 'calendar') return /\b(?:calendar|schedule|events?)\b/i.test(value);
  return /\b(?:blackboard|school|assignments?|deadlines?|coursework)\b/i.test(value);
}

function explicitlyExcludes(value, section) {
  const label = section === 'goals'
    ? '(?:goals?|tasks?|priorities)'
    : section === 'calendar'
      ? '(?:calendar|schedule|events?)'
      : '(?:blackboard|school|assignments?|deadlines?|coursework)';
  return new RegExp(`\\b(?:do not|don\\'t|never|omit|exclude|skip|without|no)\\b.{0,40}\\b${label}\\b`, 'i').test(value);
}

function resolveMorningBriefPreferences(profile, defaults = {}) {
  const resolved = { ...DEFAULT_MORNING_BRIEF, ...defaults };
  for (const value of scopedMorningBriefValues(profile)) {
    const only = /\b(?:only|just)\s+(?:include|show|give me|cover)\b/i.test(value);
    if (only) {
      resolved.goals = mentionsSection(value, 'goals');
      resolved.calendar = mentionsSection(value, 'calendar');
      resolved.blackboard = mentionsSection(value, 'blackboard');
    }
    for (const section of ['goals', 'calendar', 'blackboard']) {
      if (explicitlyExcludes(value, section)) resolved[section] = false;
      else if (mentionsSection(value, section)) resolved[section] = true;
    }
    const days = value.match(/\b(?:next|within|coming)\s+(\d{1,2})\s+days?\b/i);
    if (days && mentionsSection(value, 'blackboard')) {
      resolved.blackboardDays = Math.max(1, Math.min(14, Number(days[1])));
    }
  }
  return resolved;
}

function parseHour(value, meridiem) {
  let hour = Number(value);
  if (!Number.isInteger(hour)) return null;
  const marker = String(meridiem || '').toLowerCase();
  if (marker) {
    if (hour < 1 || hour > 12) return null;
    if (marker === 'am') hour %= 12;
    else if (hour !== 12) hour += 12;
  }
  return hour >= 0 && hour <= 23 ? hour : null;
}

function resolveExecutivePreferences(profile, defaults = {}) {
  const resolved = {
    quietStartHour: Number(defaults.quietStartHour ?? 21),
    quietEndHour: Number(defaults.quietEndHour ?? 7),
    meetingBriefMinMinutes: Number(defaults.meetingBriefMinMinutes ?? 8),
    meetingBriefMaxMinutes: Number(defaults.meetingBriefMaxMinutes ?? 20)
  };

  for (const value of durablePreferenceValues(profile)) {
    const quiet = value.match(/\bquiet\s+hours?\b.{0,30}?\b(?:from\s+)?(\d{1,2})\s*(am|pm)?\s+(?:to|until|through|-)\s+(\d{1,2})\s*(am|pm)?\b/i);
    if (quiet) {
      const start = parseHour(quiet[1], quiet[2]);
      const end = parseHour(quiet[3], quiet[4]);
      if (start != null && end != null && start !== end) {
        resolved.quietStartHour = start;
        resolved.quietEndHour = end;
      }
    }

    if (/\b(?:meeting\s+brief|brief\s+me)\b/i.test(value)) {
      const window = value.match(/\b(?:between|from)\s+(\d{1,3})\s+(?:and|to|-)\s+(\d{1,3})\s+minutes?\s+before\b/i);
      const exact = value.match(/\b(\d{1,3})\s+minutes?\s+before\b/i);
      if (window) {
        const first = Math.max(1, Math.min(120, Number(window[1])));
        const second = Math.max(1, Math.min(120, Number(window[2])));
        resolved.meetingBriefMinMinutes = Math.min(first, second);
        resolved.meetingBriefMaxMinutes = Math.max(first, second);
      } else if (exact) {
        const minutes = Math.max(1, Math.min(120, Number(exact[1])));
        resolved.meetingBriefMinMinutes = Math.max(1, minutes - 2);
        resolved.meetingBriefMaxMinutes = minutes + 2;
      }
    }
  }
  return resolved;
}

module.exports = {
  DEFAULT_MORNING_BRIEF,
  durablePreferenceValues,
  resolveMorningBriefPreferences,
  resolveExecutivePreferences
};
