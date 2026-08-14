'use strict';

// Deterministic date grounding for calendar requests. Models are good at
// extracting event details but should not be the source of truth for what
// "today" or "tomorrow" means. These helpers keep relative owner language
// anchored to the server clock in the owner's timezone.

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6
};

// A calendar write is allowed to execute immediately only when the owner's
// current message is itself a scheduling instruction. This is deliberately
// checked against the raw owner turn rather than model-composed arguments, so
// retrieved text, memories, or a mistaken tool choice cannot authorize a
// calendar mutation.
function isExplicitCalendarWriteRequest(instruction) {
  const text = String(instruction || '').trim().toLowerCase();
  if (!text) return false;
  // Questions about whether scheduling happened, and instructions merely
  // quoted from external content, are not owner authorization to create one.
  if (/^(?:did|does|has|have|is|are|was|were|what|when|where|why|how|who)\b.{0,160}\b(?:schedule|book)\b/.test(text)) {
    return false;
  }
  if (/\b(?:email|message|webpage|website|document|note)\b.{0,60}\b(?:says?|said|asks?|asked|tells?|told)\b.{0,100}\b(?:schedule|book)\b/.test(text)) {
    return false;
  }
  if (/\b(?:schedule|book)\b/.test(text)) return true;
  if (/\bblock\s+off\b/.test(text)) return true;
  if (/\binvite\b.{0,160}\b(?:to|for|on|at)\b/.test(text)) return true;
  if (/\b(?:add|put)\b.{0,160}\b(?:calendar|schedule)\b/.test(text)) return true;
  return /\b(?:create|make|set\s+up)\b.{0,100}\b(?:calendar\s+)?(?:event|appointment|meeting|call)\b/.test(text);
}

function externalTextRequestsCalendarAction(text, actionPattern) {
  const namedSource = new RegExp(
    `\\b(?:email|message|webpage|website|document|note)\\b.{0,60}\\b(?:says?|said|asks?|asked|tells?|told)\\b.{0,100}\\b(?:${actionPattern})\\b`
  );
  const reportedInstruction = new RegExp(
    `\\b(?:says?|said|asks?|asked|tells?|told|suggests?|suggested|requested)\\b.{0,120}\\b(?:${actionPattern})\\b`
  );
  return namedSource.test(text) || reportedInstruction.test(text);
}

function startsWithCalendarActionCommand(text, actionPattern) {
  const sentenceCommand = new RegExp(
    `(?:^|[.!?]+\\s*)(?:(?:yes|yeah|okay|ok|hey)[,;:]?\\s+)?(?:so\\s+)?` +
    `(?:aura[,;:]?\\s+)?(?:please\\s+)?` +
    `(?:(?:(?:can|could|would|will)\\s+you|(?:can|could|should)\\s+we)\\s+(?:please\\s+)?|` +
    `(?:i(?:'d| would)\\s+like|i\\s+(?:want|need))\\s+(?:you\\s+)?to\\s+|let'?s\\s+|` +
    `go\\s+ahead\\s+and\\s+)?(?:${actionPattern})\\b`
  );
  const strongImperative = new RegExp(
    `\\b(?:go\\s+ahead\\s+and|please|` +
    `(?:can|could|would|will)\\s+you(?:\\s+please)?|` +
    `(?:i(?:'d| would)\\s+like|i\\s+(?:want|need))\\s+(?:you\\s+)?to)\\s+` +
    `(?:${actionPattern})\\b`
  );
  return sentenceCommand.test(text) || strongImperative.test(text);
}

function isExplicitCalendarRescheduleRequest(instruction) {
  const text = String(instruction || '').trim().toLowerCase();
  if (!text) return false;
  const actionPattern = 'reschedule|move|change';
  if (/^(?:did|does|has|have|is|are|was|were|what|when|where|why|how|who)\b.{0,180}\b(?:reschedule|move|change)\b/.test(text)) {
    return false;
  }
  if (externalTextRequestsCalendarAction(text, actionPattern)) return false;
  const transcribedImperative = /^the\s+reschedule\b(?!\s+(?:was|is|has|had|failed|worked|succeeded))/i.test(text);
  if (!startsWithCalendarActionCommand(text, actionPattern) && !transcribedImperative) return false;
  if (/\breschedule\b/.test(text)) return true;
  if (/\bmove\b.{0,160}\b(?:calendar|event|appointment|meeting|call)\b/.test(text)) return true;
  if (/\bmove\b.{0,160}\b(?:to|until)\b/.test(text)) return true;
  return /\bchange\b.{0,100}\b(?:date|day|time)\b.{0,100}\b(?:calendar|event|appointment|meeting|call)\b/.test(text) ||
    /\bchange\b.{0,100}\b(?:calendar|event|appointment|meeting|call)\b.{0,100}\b(?:date|day|time|to)\b/.test(text);
}

function isExplicitCalendarCancelRequest(instruction) {
  const text = String(instruction || '').trim().toLowerCase();
  if (!text) return false;
  const actionPattern = 'cancel|delete|remove';
  if (/^(?:did|does|has|have|is|are|was|were|what|when|where|why|how|who)\b.{0,180}\b(?:cancel|delete|remove)\b/.test(text)) {
    return false;
  }
  if (externalTextRequestsCalendarAction(text, actionPattern)) return false;
  if (!startsWithCalendarActionCommand(text, actionPattern)) return false;
  if (/\b(?:cancel|delete|remove)\b\s+(?:it|that|this)\b/.test(text)) return true;
  if (/\bcancel\b.{0,160}\b(?:calendar|event|appointment|meeting|call)\b/.test(text)) return true;
  if (/\bcancel\b.{0,160}\b(?:on|from)\s+(?:my\s+)?calendar\b/.test(text)) return true;
  return /\b(?:delete|remove)\b.{0,160}\b(?:calendar|event|appointment|meeting|call)\b/.test(text) ||
    /\b(?:delete|remove)\b.{0,160}\bfrom\s+(?:my\s+)?calendar\b/.test(text);
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: get('weekday'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}

function dateKey(parts) {
  return [parts.year, parts.month, parts.day]
    .map((value, index) => index === 0 ? String(value) : String(value).padStart(2, '0'))
    .join('-');
}

function datePartsFromKey(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

function addDateKeyDays(value, days) {
  const { year, month, day } = datePartsFromKey(value);
  return new Date(Date.UTC(year, month - 1, day + days, 12))
    .toISOString()
    .slice(0, 10);
}

function weekdayForDateKey(value) {
  const { year, month, day } = datePartsFromKey(value);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function utcFromZoned(year, month, day, hour, minute, second, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  for (let i = 0; i < 4; i += 1) {
    const actual = zonedParts(new Date(utc), timeZone);
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0
    );
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

function resolveRelativeCalendarDate(instruction, {
  now = new Date(),
  timeZone = 'America/Phoenix'
} = {}) {
  const text = String(instruction || '').toLowerCase().replace(/[,]/g, ' ');
  const today = dateKey(zonedParts(now, timeZone));

  // An explicit owner-supplied date outranks relative words and weekday
  // labels (for example, "Monday, April 15"). Leave those requests to the
  // normal event parser instead of silently moving them to the next Monday.
  const hasExplicitDate =
    /\b\d{4}-\d{2}-\d{2}\b/.test(text) ||
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text) ||
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/.test(text);
  if (hasExplicitDate) return null;

  if (/\bday\s+after\s+tomorrow\b/.test(text)) {
    return { date: addDateKeyDays(today, 2), phrase: 'day after tomorrow' };
  }
  if (/\btomorrow\b/.test(text)) {
    return { date: addDateKeyDays(today, 1), phrase: 'tomorrow' };
  }
  if (/\btoday\b/.test(text)) {
    return { date: today, phrase: 'today' };
  }

  const inDays = text.match(/\bin\s+(\d{1,3})\s+days?\b/);
  if (inDays) {
    const days = Number(inDays[1]);
    return { date: addDateKeyDays(today, days), phrase: inDays[0] };
  }

  const weekday = text.match(
    /\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/
  );
  if (weekday) {
    const modifier = String(weekday[1] || '').trim();
    const wanted = WEEKDAYS[weekday[2]];
    const current = weekdayForDateKey(today);
    let delta = (wanted - current + 7) % 7;
    if (delta === 0 && modifier !== 'this') delta = 7;
    return { date: addDateKeyDays(today, delta), phrase: weekday[0].trim() };
  }

  return null;
}

function buildTemporalContext({
  now = new Date(),
  timeZone = 'America/Phoenix'
} = {}) {
  const today = dateKey(zonedParts(now, timeZone));
  const tomorrow = addDateKeyDays(today, 1);
  const readable = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(now);
  return [
    '',
    'AUTHORITATIVE CURRENT TIME (server-provided, not memory):',
    `- Current local time: ${readable} (${timeZone})`,
    `- Today: ${today}`,
    `- Tomorrow: ${tomorrow}`,
    '- Resolve relative dates from this clock. Never guess the current date.'
  ].join('\n');
}

function groundCalendarEventArgs(args, instruction, {
  now = new Date(),
  timeZone = args?.time_zone || args?.timeZone || 'America/Phoenix'
} = {}) {
  const eventArgs = { ...(args || {}) };
  const relative = resolveRelativeCalendarDate(instruction, { now, timeZone });
  if (!relative || typeof eventArgs.start !== 'string') {
    return { eventArgs, correction: null };
  }

  const rawStart = eventArgs.start.trim();
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(rawStart);
  if (allDay) {
    if (rawStart === relative.date) return { eventArgs, correction: null };
    const oldStart = rawStart;
    eventArgs.start = relative.date;
    if (typeof eventArgs.end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(eventArgs.end)) {
      const spanDays = Math.max(
        1,
        Math.round((Date.parse(`${eventArgs.end}T12:00:00Z`) - Date.parse(`${oldStart}T12:00:00Z`)) / 86400000)
      );
      eventArgs.end = addDateKeyDays(relative.date, spanDays);
    }
    return {
      eventArgs,
      correction: { phrase: relative.phrase, from: oldStart, to: eventArgs.start }
    };
  }

  const parsedStart = new Date(rawStart);
  if (!Number.isFinite(parsedStart.getTime())) return { eventArgs, correction: null };
  const startParts = zonedParts(parsedStart, timeZone);
  const actualDate = dateKey(startParts);
  if (actualDate === relative.date) return { eventArgs, correction: null };

  const target = datePartsFromKey(relative.date);
  const correctedStart = utcFromZoned(
    target.year,
    target.month,
    target.day,
    startParts.hour,
    startParts.minute,
    startParts.second,
    timeZone
  );
  eventArgs.start = correctedStart.toISOString();

  if (typeof eventArgs.end === 'string' && eventArgs.end.trim()) {
    const parsedEnd = new Date(eventArgs.end);
    if (Number.isFinite(parsedEnd.getTime()) && parsedEnd > parsedStart) {
      eventArgs.end = new Date(correctedStart.getTime() + (parsedEnd - parsedStart)).toISOString();
    }
  }

  return {
    eventArgs,
    correction: { phrase: relative.phrase, from: rawStart, to: eventArgs.start }
  };
}

module.exports = {
  addDateKeyDays,
  buildTemporalContext,
  dateKey,
  groundCalendarEventArgs,
  isExplicitCalendarCancelRequest,
  isExplicitCalendarRescheduleRequest,
  isExplicitCalendarWriteRequest,
  resolveRelativeCalendarDate,
  utcFromZoned,
  zonedParts
};
