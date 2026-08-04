'use strict';

const EXECUTIVE_LOOP_STATE_KEY = 'executive_loop_v1';
const MAX_TRACKED_EMAILS = 500;
const MAX_TRACKED_EVENTS = 250;
const MAX_BRIEFED_MEETINGS = 250;

function compactText(value, maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function senderLabel(value) {
  const text = compactText(value, 160);
  const named = text.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named?.[1]) return compactText(named[1], 80);
  const address = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  return address || text || 'Someone';
}

function senderAddress(value) {
  return compactText(value, 320)
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    ?.toLowerCase() || '';
}

function classifyEmail(email = {}) {
  const subject = compactText(email.subject, 300);
  const snippet = compactText(email.snippet, 500);
  const from = compactText(email.from, 200);
  const combined = `${subject} ${snippet}`.toLowerCase();
  const automated = /\b(?:no-?reply|do-not-reply|mailer-daemon|newsletter|notifications?)\b/i.test(from) ||
    /\b(?:unsubscribe|view in browser|weekly digest|newsletter)\b/i.test(combined);
  const urgentPattern = /\b(?:urgent|asap|action required|past due|overdue|payment failed|declined|deadline|cancelled|canceled|rescheduled|security alert|fraud|suspended|final notice)\b/i;
  const actionPattern = /\?|\b(?:please|can you|could you|would you|need you|let me know|reply|respond|review|sign|approve|confirm|schedule|availability|invoice|balance|due|follow up|follow-up)\b/i;

  if (urgentPattern.test(combined)) {
    return { actionable: true, urgency: 'high', reason: 'This looks time-sensitive.' };
  }
  if (!automated && actionPattern.test(combined)) {
    return { actionable: true, urgency: 'normal', reason: 'This appears to need a response or decision.' };
  }
  return { actionable: false, urgency: 'low', reason: null };
}

function zonedHour(date, timeZone) {
  const part = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(date).find(item => item.type === 'hour');
  return Number(part?.value);
}

function isQuietTime(date, {
  timeZone = 'America/Phoenix',
  quietStartHour = 21,
  quietEndHour = 7
} = {}) {
  const hour = zonedHour(date, timeZone);
  const start = Math.max(0, Math.min(23, Number(quietStartHour)));
  const end = Math.max(0, Math.min(23, Number(quietEndHour)));
  if (start === end) return false;
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

function eventStartMs(event) {
  const raw = event?.start?.dateTime || event?.start?.date;
  const value = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(value) ? value : null;
}

function eventFingerprint(event) {
  return JSON.stringify({
    status: event?.status || 'confirmed',
    summary: compactText(event?.summary, 500),
    start: event?.start || {},
    end: event?.end || {},
    location: compactText(event?.location, 500),
    attendees: (event?.attendees || []).map(item => item.email || '').filter(Boolean).sort()
  });
}

function eventSnapshot(event) {
  return {
    fingerprint: eventFingerprint(event),
    status: event?.status || 'confirmed',
    summary: compactText(event?.summary, 500),
    start: event?.start || {},
    end: event?.end || {},
    location: compactText(event?.location, 500),
    updated: event?.updated || null
  };
}

function formatEventTime(event, timeZone) {
  const startMs = eventStartMs(event);
  if (startMs == null) return 'an unknown time';
  if (event?.start?.date && !event?.start?.dateTime) return event.start.date;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(startMs));
}

function relatedUnreadForEvent(event, emails) {
  const attendeeAddresses = new Set(
    (event?.attendees || []).map(item => String(item.email || '').toLowerCase()).filter(Boolean)
  );
  if (!attendeeAddresses.size) return [];
  return (emails || [])
    .filter(email => attendeeAddresses.has(senderAddress(email.from)))
    .slice(0, 2);
}

function buildMeetingBrief(event, emails, { now, timeZone }) {
  const startMs = eventStartMs(event);
  const minutes = startMs == null ? null : Math.max(1, Math.round((startMs - now.getTime()) / 60000));
  const lines = [
    `${compactText(event.summary, 160)} starts in ${minutes || 'a few'} minute${minutes === 1 ? '' : 's'} (${formatEventTime(event, timeZone)}).`
  ];
  if (event.location) lines.push(`Location: ${compactText(event.location, 180)}.`);
  const attendeeNames = (event.attendees || [])
    .map(item => compactText(item.displayName || item.email, 100))
    .filter(Boolean)
    .slice(0, 6);
  if (attendeeNames.length) lines.push(`With: ${attendeeNames.join(', ')}.`);
  const related = relatedUnreadForEvent(event, emails);
  if (related.length) {
    lines.push(`Unread context: ${related.map(email => `${senderLabel(email.from)} — “${compactText(email.subject, 120)}”`).join('; ')}.`);
  }
  return lines.join('\n');
}

function taskTitle(task) {
  return compactText(task?.description || task?.title, 180);
}

function trimObjectEntries(object, limit) {
  return Object.fromEntries(Object.entries(object || {}).slice(-limit));
}

function createExecutiveLoop({
  listUnreadEmails,
  listCalendarEvents,
  listOpenTasks,
  getState,
  setState,
  sendAlert,
  timeZone = 'America/Phoenix',
  quietStartHour = 21,
  quietEndHour = 7,
  meetingBriefMinMinutes = 8,
  meetingBriefMaxMinutes = 20,
  now = () => new Date()
} = {}) {
  if (typeof getState !== 'function' || typeof setState !== 'function' || typeof sendAlert !== 'function') {
    throw new Error('Executive Loop requires durable state and alert delivery.');
  }

  let activeRun = null;

  async function execute() {
    const currentTime = now();
    const currentMs = currentTime.getTime();
    const quiet = isQuietTime(currentTime, { timeZone, quietStartHour, quietEndHour });
    const previous = await getState(EXECUTIVE_LOOP_STATE_KEY);
    const initialized = Boolean(previous?.initialized_at);
    const emailInitialized = Boolean(previous?.email_initialized_at);
    const calendarInitialized = Boolean(previous?.calendar_initialized_at);
    const state = {
      version: 1,
      initialized_at: previous?.initialized_at || currentTime.toISOString(),
      email_initialized_at: previous?.email_initialized_at || null,
      calendar_initialized_at: previous?.calendar_initialized_at || null,
      known_email_ids: Array.isArray(previous?.known_email_ids) ? previous.known_email_ids : [],
      calendar_events: previous?.calendar_events && typeof previous.calendar_events === 'object'
        ? previous.calendar_events
        : {},
      briefed_meetings: Array.isArray(previous?.briefed_meetings) ? previous.briefed_meetings : [],
      last_run_at: currentTime.toISOString()
    };
    const errors = [];
    const sent = [];

    let emails = [];
    let events = [];
    let tasks = [];
    const [emailResult, calendarResult, taskResult] = await Promise.allSettled([
      typeof listUnreadEmails === 'function' ? listUnreadEmails() : [],
      typeof listCalendarEvents === 'function'
        ? listCalendarEvents({
            timeMin: new Date(currentMs - 86400000).toISOString(),
            timeMax: new Date(currentMs + 7 * 86400000).toISOString()
          })
        : [],
      typeof listOpenTasks === 'function' ? listOpenTasks() : []
    ]);
    if (emailResult.status === 'fulfilled') emails = Array.isArray(emailResult.value) ? emailResult.value : [];
    else errors.push(`email:${emailResult.reason?.message || emailResult.reason}`);
    if (calendarResult.status === 'fulfilled') events = Array.isArray(calendarResult.value) ? calendarResult.value : [];
    else errors.push(`calendar:${calendarResult.reason?.message || calendarResult.reason}`);
    if (taskResult.status === 'fulfilled') tasks = Array.isArray(taskResult.value) ? taskResult.value : [];
    else errors.push(`tasks:${taskResult.reason?.message || taskResult.reason}`);

    const knownEmails = new Set(state.known_email_ids);
    if (emailResult.status === 'fulfilled' && !emailInitialized) {
      for (const email of emails) if (email?.id) knownEmails.add(email.id);
      state.email_initialized_at = currentTime.toISOString();
    } else {
      const eligibleEmails = [];
      for (const email of emails) {
        if (!email?.id || knownEmails.has(email.id)) continue;
        const classification = classifyEmail(email);
        if (!classification.actionable) {
          knownEmails.add(email.id);
          continue;
        }
        if (quiet && classification.urgency !== 'high') continue;
        eligibleEmails.push({ email, classification });
      }
      for (const item of eligibleEmails.slice(0, 5)) {
        const { email, classification } = item;
        const alert = await sendAlert(
          `Email needs you\n${senderLabel(email.from)} — “${compactText(email.subject, 160)}”\n${classification.reason}`,
          'executive_email',
          classification.urgency,
          {
            dedupeKey: `executive-email:${email.id}`,
            metadata: { message_id: email.id, thread_id: email.thread_id || null }
          }
        );
        knownEmails.add(email.id);
        if (!alert?.deduplicated) sent.push('email');
      }
    }
    state.known_email_ids = [...knownEmails].slice(-MAX_TRACKED_EMAILS);

    const previousEvents = state.calendar_events;
    const nextEvents = { ...previousEvents };
    for (const event of events) {
      if (!event?.id) continue;
      const currentSnapshot = eventSnapshot(event);
      const prior = previousEvents[event.id];
      if (!calendarInitialized || !prior) {
        nextEvents[event.id] = currentSnapshot;
        continue;
      }
      if (prior.fingerprint === currentSnapshot.fingerprint) continue;

      const cancelled = currentSnapshot.status === 'cancelled' && prior.status !== 'cancelled';
      const oldStart = prior.start?.dateTime || prior.start?.date || '';
      const newStart = currentSnapshot.start?.dateTime || currentSnapshot.start?.date || '';
      const rescheduled = oldStart && newStart && oldStart !== newStart;
      if (!cancelled && !rescheduled) {
        nextEvents[event.id] = currentSnapshot;
        continue;
      }
      if (quiet && !cancelled) continue;

      const currentTitle = currentSnapshot.summary === '(Untitled event)'
        ? prior.summary
        : currentSnapshot.summary;
      const text = cancelled
        ? `Calendar change\n“${currentTitle || prior.summary}” was cancelled.`
        : `Calendar change\n“${currentSnapshot.summary}” moved from ${formatEventTime({ ...event, start: prior.start }, timeZone)} to ${formatEventTime(event, timeZone)}.`;
      const alert = await sendAlert(text, 'executive_calendar', cancelled ? 'high' : 'normal', {
        dedupeKey: `executive-calendar:${event.id}:${event.updated || currentSnapshot.fingerprint}`,
        metadata: { event_id: event.id, status: currentSnapshot.status }
      });
      nextEvents[event.id] = currentSnapshot;
      if (!alert?.deduplicated) sent.push('calendar');
    }
    if (calendarResult.status === 'fulfilled' && !calendarInitialized) {
      state.calendar_initialized_at = currentTime.toISOString();
    }
    state.calendar_events = trimObjectEntries(nextEvents, MAX_TRACKED_EVENTS);

    const briefed = new Set(state.briefed_meetings);
    for (const event of events) {
      if (!event?.id || event.status === 'cancelled' || !event.start?.dateTime) continue;
      const startMs = eventStartMs(event);
      if (startMs == null) continue;
      const minutesUntil = (startMs - currentMs) / 60000;
      const briefKey = `${event.id}:${event.start.dateTime}`;
      if (minutesUntil < meetingBriefMinMinutes || minutesUntil > meetingBriefMaxMinutes || briefed.has(briefKey)) {
        continue;
      }
      const alert = await sendAlert(
        buildMeetingBrief(event, emails, { now: currentTime, timeZone }),
        'meeting_brief',
        'normal',
        {
          dedupeKey: `meeting-brief:${briefKey}`,
          metadata: { event_id: event.id, starts_at: event.start.dateTime }
        }
      );
      briefed.add(briefKey);
      if (!alert?.deduplicated) sent.push('meeting');
    }
    state.briefed_meetings = [...briefed].slice(-MAX_BRIEFED_MEETINGS);

    if (!quiet) {
      for (const task of tasks) {
        const dueMs = Date.parse(task?.due_at);
        const title = taskTitle(task);
        if (!title || !Number.isFinite(dueMs)) continue;
        const minutesUntil = (dueMs - currentMs) / 60000;
        if (minutesUntil > 60 || minutesUntil < -1440) continue;
        const timing = minutesUntil < 0
          ? 'is overdue'
          : `is due in ${Math.max(1, Math.round(minutesUntil))} minute${Math.round(minutesUntil) === 1 ? '' : 's'}`;
        const dedupeTime = new Date(dueMs).toISOString();
        const alert = await sendAlert(
          `Commitment check\n${title} ${timing}.`,
          'commitment',
          minutesUntil < 0 ? 'high' : 'normal',
          {
            dedupeKey: `commitment:${task.id}:${dedupeTime}`,
            metadata: { task_id: task.id, due_at: dedupeTime }
          }
        );
        if (!alert?.deduplicated) sent.push('commitment');
      }
    }

    await setState(EXECUTIVE_LOOP_STATE_KEY, state);
    return {
      status: initialized ? 'checked' : 'initialized',
      sent: sent.length,
      categories: sent,
      emails: emails.length,
      events: events.length,
      tasks: tasks.length,
      quiet,
      errors
    };
  }

  return async function runExecutiveLoop() {
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => {
      activeRun = null;
    });
    return activeRun;
  };
}

module.exports = {
  EXECUTIVE_LOOP_STATE_KEY,
  compactText,
  senderLabel,
  senderAddress,
  classifyEmail,
  isQuietTime,
  eventFingerprint,
  eventStartMs,
  relatedUnreadForEvent,
  buildMeetingBrief,
  createExecutiveLoop
};
