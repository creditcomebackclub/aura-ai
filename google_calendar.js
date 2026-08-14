'use strict';

const { utcFromZoned, zonedParts } = require('./calendar_time');

// Google Calendar API path for AURA. Conversational reads can still use the
// private iCal feed (calendar_feed.js); structured Executive Loop reads and
// event writes use Calendar API + OAuth refresh token.
// Prefers GOOGLE_CALENDAR_* credentials, falls back to GMAIL_* when the same
// Google Cloud OAuth client was re-consented with calendar.events scope.

function calendarOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GMAIL_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN || '',
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary'
  };
}

function isGoogleCalendarWriteConfigured() {
  const { clientId, clientSecret, refreshToken } = calendarOAuthConfig();
  return Boolean(clientId && clientSecret && refreshToken);
}

async function refreshCalendarAccessToken() {
  const { clientId, clientSecret, refreshToken } = calendarOAuthConfig();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Calendar write is not configured. Set GOOGLE_CALENDAR_CLIENT_ID/SECRET/REFRESH_TOKEN ' +
      '(or reuse GMAIL_* with calendar.events scope).'
    );
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Calendar token refresh failed (${response.status}): ${errText}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('Google Calendar token refresh returned no access_token.');
  return data.access_token;
}

function isEmailAddress(value) {
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

function normalizeAttendees(attendees) {
  if (attendees == null || attendees === '') return [];
  const list = Array.isArray(attendees)
    ? attendees
    : String(attendees).split(/[,;\s]+/);
  const emails = [...new Set(
    list
      .map(item => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  )];
  if (emails.length > 20) {
    throw new Error('Calendar events support at most 20 attendees.');
  }
  for (const email of emails) {
    if (!isEmailAddress(email)) {
      throw new Error(`Invalid attendee email: ${email}`);
    }
  }
  return emails;
}

function parseEventInstant(value, { fieldName, timeZone }) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }
  const raw = value.trim();

  // Date-only → all-day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { allDay: true, date: raw, dateTime: null, timeZone };
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${fieldName} must be an ISO date or datetime (got "${raw}").`);
  }
  return {
    allDay: false,
    date: null,
    dateTime: parsed.toISOString(),
    timeZone
  };
}

function addDaysToDateOnly(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day + days);
  return new Date(utc).toISOString().slice(0, 10);
}

function buildGoogleCalendarEvent({
  summary,
  start,
  end = null,
  duration_minutes = null,
  description = null,
  location = null,
  attendees = null,
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix'
} = {}) {
  const title = String(summary || '').trim();
  if (!title) throw new Error('summary is required.');
  if (title.length > 500) throw new Error('summary is too long.');

  const zone = String(timeZone || process.env.AURA_TIMEZONE || 'America/Phoenix').trim() || 'America/Phoenix';
  const startPart = parseEventInstant(start, { fieldName: 'start', timeZone: zone });

  let endPart;
  if (end) {
    endPart = parseEventInstant(end, { fieldName: 'end', timeZone: zone });
  } else if (startPart.allDay) {
    endPart = {
      allDay: true,
      date: addDaysToDateOnly(startPart.date, 1),
      dateTime: null,
      timeZone: zone
    };
  } else {
    const minutes = Number(duration_minutes);
    const durationMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60 * 1000;
    endPart = {
      allDay: false,
      date: null,
      dateTime: new Date(new Date(startPart.dateTime).getTime() + durationMs).toISOString(),
      timeZone: zone
    };
  }

  if (startPart.allDay !== endPart.allDay) {
    throw new Error('start and end must both be date-only or both be datetimes.');
  }
  if (startPart.allDay) {
    if (endPart.date <= startPart.date) {
      throw new Error('end date must be after start date for all-day events.');
    }
  } else if (!(new Date(endPart.dateTime) > new Date(startPart.dateTime))) {
    throw new Error('end must be after start.');
  }

  const attendeeEmails = normalizeAttendees(attendees);
  const event = {
    summary: title,
    start: startPart.allDay
      ? { date: startPart.date }
      : { dateTime: startPart.dateTime, timeZone: zone },
    end: endPart.allDay
      ? { date: endPart.date }
      : { dateTime: endPart.dateTime, timeZone: zone }
  };

  if (description != null && String(description).trim()) {
    event.description = String(description).trim().slice(0, 8000);
  }
  if (location != null && String(location).trim()) {
    event.location = String(location).trim().slice(0, 500);
  }
  if (attendeeEmails.length) {
    event.attendees = attendeeEmails.map(email => ({ email }));
  }

  return {
    event,
    attendeeEmails,
    sendUpdates: attendeeEmails.length ? 'all' : 'none',
    timeZone: zone
  };
}

function formatCalendarDateTime(value, timeZone) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || process.env.AURA_TIMEZONE || 'America/Phoenix',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(parsed);
}

function formatEventSummary({ event, attendeeEmails, htmlLink = null }) {
  const zone = event.start.timeZone || process.env.AURA_TIMEZONE || 'America/Phoenix';
  const when = event.start.date
    ? `${event.start.date} (all day)`
    : formatCalendarDateTime(event.start.dateTime, zone);
  const until = event.end.date
    ? `${event.end.date} (exclusive)`
    : formatCalendarDateTime(event.end.dateTime, event.end.timeZone || zone);
  const lines = [
    `Title: ${event.summary}`,
    `Starts: ${when}`,
    `Ends: ${until}`
  ];
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.description) lines.push(`Description: ${event.description}`);
  if (attendeeEmails.length) lines.push(`Attendees: ${attendeeEmails.join(', ')}`);
  if (htmlLink) lines.push(`Link: ${htmlLink}`);
  return lines.join('\n');
}

async function createGoogleCalendarEvent(args = {}) {
  const built = buildGoogleCalendarEvent(args);
  const token = await refreshCalendarAccessToken();
  const { calendarId } = calendarOAuthConfig();
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set('sendUpdates', built.sendUpdates);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(built.event)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Calendar create failed (${response.status}): ${errText}`);
  }
  const created = await response.json();
  return {
    id: created.id,
    htmlLink: created.htmlLink || null,
    status: created.status || 'confirmed',
    summary: formatEventSummary({
      event: built.event,
      attendeeEmails: built.attendeeEmails,
      htmlLink: created.htmlLink || null
    }),
    attendees_notified: built.sendUpdates === 'all'
  };
}

function mapGoogleCalendarEvent(item) {
  return {
    id: item.id,
    status: item.status || 'confirmed',
    summary: item.summary || '(Untitled event)',
    description: item.description || '',
    location: item.location || '',
    start: item.start || {},
    end: item.end || {},
    attendees: (item.attendees || []).map(attendee => ({
      email: attendee.email || '',
      displayName: attendee.displayName || '',
      responseStatus: attendee.responseStatus || ''
    })),
    organizer: item.organizer || null,
    recurringEventId: item.recurringEventId || null,
    updated: item.updated || null,
    htmlLink: item.htmlLink || null
  };
}

async function listGoogleCalendarEventsWithToken(token, {
  timeMin = new Date().toISOString(),
  timeMax = new Date(Date.now() + 7 * 86400000).toISOString(),
  maxResults = 50
} = {}) {
  const { calendarId } = calendarOAuthConfig();
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set('timeMin', new Date(timeMin).toISOString());
  url.searchParams.set('timeMax', new Date(timeMax).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(Math.max(1, Math.min(250, Number(maxResults) || 50))));

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Calendar list failed (${response.status}): ${errText}`);
  }
  const data = await response.json();
  return (data.items || []).map(mapGoogleCalendarEvent);
}

async function listGoogleCalendarEvents({
  timeMin = new Date().toISOString(),
  timeMax = new Date(Date.now() + 7 * 86400000).toISOString(),
  maxResults = 50
} = {}) {
  const token = await refreshCalendarAccessToken();
  return listGoogleCalendarEventsWithToken(token, { timeMin, timeMax, maxResults });
}

function normalizeCalendarEventQuery(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function eventStartLabel(event, timeZone) {
  if (event.start?.date) return `${event.start.date} (all day)`;
  if (event.start?.dateTime) {
    return formatCalendarDateTime(event.start.dateTime, event.start.timeZone || timeZone);
  }
  return 'unknown time';
}

function filterEventsByOriginalStart(events, originalStart, timeZone) {
  if (!originalStart) return events;
  const raw = String(originalStart).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return events.filter(event => {
      if (event.start?.date) return event.start.date === raw;
      if (!event.start?.dateTime) return false;
      const parts = zonedParts(new Date(event.start.dateTime), event.start.timeZone || timeZone);
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}` === raw;
    });
  }
  const expected = new Date(raw);
  if (!Number.isFinite(expected.getTime())) {
    throw new Error('original_start must be an ISO date or datetime.');
  }
  return events.filter(event => {
    if (!event.start?.dateTime) return false;
    const actual = new Date(event.start.dateTime);
    return Number.isFinite(actual.getTime()) && Math.abs(actual - expected) <= 15 * 60 * 1000;
  });
}

function findMatchingCalendarEvent(events, {
  query,
  originalStart = null,
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix'
} = {}) {
  const normalizedQuery = normalizeCalendarEventQuery(query);
  if (!normalizedQuery) throw new Error('event_query is required.');

  const active = (events || []).filter(event => event?.id && event.status !== 'cancelled');
  const exact = active.filter(event => normalizeCalendarEventQuery(event.summary) === normalizedQuery);
  const titleMatches = exact.length
    ? exact
    : active.filter(event => {
      const title = normalizeCalendarEventQuery(event.summary);
      return title && (title.includes(normalizedQuery) || normalizedQuery.includes(title));
    });
  const matches = filterEventsByOriginalStart(titleMatches, originalStart, timeZone);

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const when = originalStart ? ` at ${originalStart}` : '';
    throw new Error(`No upcoming calendar event matched "${String(query).trim()}"${when}.`);
  }
  const candidates = matches
    .slice(0, 5)
    .map(event => `${event.summary} — ${eventStartLabel(event, timeZone)}`)
    .join('; ');
  throw new Error(`More than one calendar event matched. Ask which one: ${candidates}`);
}

function buildRescheduledEventTimes(event, newStart, {
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix'
} = {}) {
  const raw = String(newStart || '').trim();
  if (!raw) throw new Error('new_start is required.');
  const oldAllDay = Boolean(event.start?.date);
  const newIsDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);

  if (oldAllDay) {
    if (!newIsDateOnly) throw new Error('An all-day event must be moved to an ISO date.');
    if (!event.end?.date) throw new Error('The existing all-day event has no valid end date.');
    const durationDays = Math.round(
      (Date.parse(`${event.end.date}T12:00:00Z`) - Date.parse(`${event.start.date}T12:00:00Z`)) / 86400000
    );
    if (!Number.isFinite(durationDays) || durationDays < 1) {
      throw new Error('The existing all-day event has an invalid date range.');
    }
    return {
      start: { date: raw },
      end: { date: addDaysToDateOnly(raw, durationDays) }
    };
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    throw new Error('The existing event has no valid start and end time.');
  }
  const oldStart = new Date(event.start.dateTime);
  const oldEnd = new Date(event.end.dateTime);
  if (!Number.isFinite(oldStart.getTime()) || !Number.isFinite(oldEnd.getTime()) || oldEnd <= oldStart) {
    throw new Error('The existing event has an invalid time range.');
  }
  const zone = event.start.timeZone || timeZone;
  let nextStart;
  if (newIsDateOnly) {
    const [year, month, day] = raw.split('-').map(Number);
    const oldLocal = zonedParts(oldStart, zone);
    nextStart = utcFromZoned(year, month, day, oldLocal.hour, oldLocal.minute, oldLocal.second, zone);
  } else {
    nextStart = new Date(raw);
    if (!Number.isFinite(nextStart.getTime())) {
      throw new Error('new_start must be an ISO date or datetime.');
    }
  }
  const nextEnd = new Date(nextStart.getTime() + (oldEnd - oldStart));
  return {
    start: { dateTime: nextStart.toISOString(), timeZone: zone },
    end: { dateTime: nextEnd.toISOString(), timeZone: event.end.timeZone || zone }
  };
}

function searchWindowForEvent(originalStart, timeZone, now) {
  const fallbackNow = now instanceof Date ? now : new Date(now || Date.now());
  if (!Number.isFinite(fallbackNow.getTime())) throw new Error('Invalid calendar search time.');
  if (!originalStart) {
    return {
      timeMin: new Date(fallbackNow.getTime() - 2 * 86400000).toISOString(),
      timeMax: new Date(fallbackNow.getTime() + 120 * 86400000).toISOString()
    };
  }
  const raw = String(originalStart).trim();
  let anchor;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    anchor = utcFromZoned(year, month, day, 12, 0, 0, timeZone);
  } else {
    anchor = new Date(raw);
  }
  if (!Number.isFinite(anchor.getTime())) {
    throw new Error('original_start must be an ISO date or datetime.');
  }
  return {
    timeMin: new Date(anchor.getTime() - 2 * 86400000).toISOString(),
    timeMax: new Date(anchor.getTime() + 2 * 86400000).toISOString()
  };
}

async function resolveGoogleCalendarEvent({
  event_query,
  original_start = null,
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix',
  now = new Date()
} = {}) {
  const token = await refreshCalendarAccessToken();
  const window = searchWindowForEvent(original_start, timeZone, now);
  const events = await listGoogleCalendarEventsWithToken(token, {
    ...window,
    maxResults: 250
  });
  const event = findMatchingCalendarEvent(events, {
    query: event_query,
    originalStart: original_start,
    timeZone
  });
  return { token, event };
}

async function rescheduleGoogleCalendarEvent({
  event_query,
  original_start = null,
  new_start,
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix',
  now = new Date()
} = {}) {
  const { token, event } = await resolveGoogleCalendarEvent({
    event_query,
    original_start,
    timeZone,
    now
  });
  const times = buildRescheduledEventTimes(event, new_start, { timeZone });
  const { calendarId } = calendarOAuthConfig();
  const attendeeEmails = event.attendees.map(attendee => attendee.email).filter(Boolean);
  const sendUpdates = attendeeEmails.length ? 'all' : 'none';
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`
  );
  url.searchParams.set('sendUpdates', sendUpdates);
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(times)
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Calendar reschedule failed (${response.status}): ${errText}`);
  }
  const updated = mapGoogleCalendarEvent(await response.json());
  const displayEvent = {
    ...event,
    ...updated,
    start: updated.start?.date || updated.start?.dateTime ? updated.start : times.start,
    end: updated.end?.date || updated.end?.dateTime ? updated.end : times.end
  };
  return {
    id: event.id,
    htmlLink: displayEvent.htmlLink,
    summary: formatEventSummary({
      event: displayEvent,
      attendeeEmails,
      htmlLink: displayEvent.htmlLink
    }),
    previous_start: event.start,
    new_start: displayEvent.start,
    attendees_notified: sendUpdates === 'all'
  };
}

async function cancelGoogleCalendarEvent({
  event_query,
  original_start = null,
  timeZone = process.env.AURA_TIMEZONE || 'America/Phoenix',
  now = new Date()
} = {}) {
  const { token, event } = await resolveGoogleCalendarEvent({
    event_query,
    original_start,
    timeZone,
    now
  });
  const { calendarId } = calendarOAuthConfig();
  const attendeeEmails = event.attendees.map(attendee => attendee.email).filter(Boolean);
  const sendUpdates = attendeeEmails.length ? 'all' : 'none';
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}`
  );
  url.searchParams.set('sendUpdates', sendUpdates);
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Calendar cancellation failed (${response.status}): ${errText}`);
  }
  return {
    id: event.id,
    title: event.summary,
    original_start: event.start,
    original_start_label: eventStartLabel(event, timeZone),
    attendees_notified: sendUpdates === 'all'
  };
}

module.exports = {
  calendarOAuthConfig,
  isGoogleCalendarWriteConfigured,
  refreshCalendarAccessToken,
  normalizeAttendees,
  buildGoogleCalendarEvent,
  formatCalendarDateTime,
  formatEventSummary,
  createGoogleCalendarEvent,
  listGoogleCalendarEvents,
  normalizeCalendarEventQuery,
  findMatchingCalendarEvent,
  buildRescheduledEventTimes,
  rescheduleGoogleCalendarEvent,
  cancelGoogleCalendarEvent
};
