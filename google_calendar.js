'use strict';

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

async function listGoogleCalendarEvents({
  timeMin = new Date().toISOString(),
  timeMax = new Date(Date.now() + 7 * 86400000).toISOString(),
  maxResults = 50
} = {}) {
  const token = await refreshCalendarAccessToken();
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
  return (data.items || []).map(item => ({
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
    updated: item.updated || null,
    htmlLink: item.htmlLink || null
  }));
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
  listGoogleCalendarEvents
};
