'use strict';

const crypto = require('crypto');
const { parseDueAt } = require('./due_date');
const { describeOpenWindows } = require('./calendar_availability');
const { describeClient, describePerson } = require('./entity_graph');
const { isReminderTask, nextReminderDueAt, reminderMessage } = require('./reminders');

const EXECUTIVE_LOOP_STATE_KEY = 'executive_loop_v1';
const MAX_TRACKED_EMAILS = 500;
const MAX_TRACKED_SENT_EMAILS = 500;
const MAX_TRACKED_EVENTS = 250;
const MAX_BRIEFED_MEETINGS = 250;
const MAX_TRACKED_GOAL_SIGNALS = 400;
// Bounded per run so a burst of new mail cannot fan out into many model calls.
const MAX_GOAL_SIGNALS_PER_RUN = 6;

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
    return { category: 'urgent', actionable: true, urgency: 'high', reason: 'This looks time-sensitive.' };
  }
  if (!automated && actionPattern.test(combined)) {
    return { category: 'action', actionable: true, urgency: 'normal', reason: 'This appears to need a response or decision.' };
  }
  return {
    category: automated ? 'automated' : 'informational',
    actionable: false,
    urgency: 'low',
    reason: null
  };
}

function deterministicCommitmentId(messageId) {
  const hex = crypto.createHash('sha256')
    .update(`aura-email-commitment:${messageId}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function extractOwnerCommitment(email = {}, {
  now = new Date(),
  timeZone = 'America/Phoenix'
} = {}) {
  // Gmail snippets can append quoted history. Only inspect the owner-authored
  // prefix and never treat a subject line or quoted correspondent promise as
  // the owner's commitment.
  const content = compactText(email.snippet, 900)
    .split(/\b(?:on .{0,180} wrote:|[- ]{4,}forwarded message[- ]{4,}|from:\s+.{0,180})/i)[0];
  const promise = content.match(/\b(?:i['’]?ll|i\s+will|i(?:'m| am)\s+going\s+to)\s+([^.!?]{3,260})/i);
  if (!promise) return null;

  const clause = compactText(promise[1], 260);
  const deadline = clause.match(
    /\b(?:by|before|on)\s+((?:next\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|today|tomorrow|next\s+week)\b|\bin\s+(\d{1,3})\s+days?\b|\b(today|tomorrow|next\s+week)\b/i
  );
  if (!deadline) return null;
  const duePhrase = deadline[1] || (deadline[2] ? `in ${deadline[2]} days` : deadline[3]);
  const dueAt = parseDueAt(duePhrase, { now, timeZone });
  if (!dueAt) return null;

  const action = compactText(clause.slice(0, deadline.index).replace(/\b(?:by|before|on)\s*$/i, ''), 180);
  if (action.length < 3) return null;
  return {
    id: deterministicCommitmentId(email.id),
    title: `Follow through: ${action}`,
    due_at: dueAt,
    recipient: compactText(email.to, 200) || null,
    source_message_id: email.id,
    source_thread_id: email.thread_id || null
  };
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

function relatedTasksForEvent(event, tasks) {
  const needles = (event?.attendees || []).flatMap(item => {
    const address = String(item.email || '').toLowerCase();
    const name = compactText(item.displayName, 100).toLowerCase();
    return [address, name, ...name.split(/\s+/)].filter(value => value.length >= 4);
  });
  if (!needles.length) return [];
  return (tasks || []).filter(task => {
    const title = taskTitle(task).toLowerCase();
    return needles.some(needle => title.includes(needle));
  }).slice(0, 3);
}

function buildMeetingBrief(event, emails, {
  now,
  timeZone,
  tasks = [],
  clientSnapshots = []
}) {
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
  for (const snapshot of clientSnapshots.slice(0, 2)) {
    const details = [
      snapshot.current_phase,
      snapshot.client?.status,
      snapshot.client?.billing_status
    ].filter(Boolean).join(' · ');
    const balance = Number(snapshot.outstanding_total) > 0
      ? ` · $${Number(snapshot.outstanding_total).toFixed(2)} outstanding`
      : '';
    lines.push(`CCC: ${compactText(snapshot.client?.name, 100)}${details ? ` — ${compactText(details, 180)}` : ''}${balance}.`);
  }
  const relatedTasks = relatedTasksForEvent(event, tasks);
  if (relatedTasks.length) {
    lines.push(`Open follow-up${relatedTasks.length === 1 ? '' : 's'}: ${relatedTasks.map(task => taskTitle(task)).join('; ')}.`);
  }
  return lines.join('\n');
}

// The connect-the-dots alert: who reached out, which goal it advances, and the
// time the owner actually has free.
function formatGoalSignalAlert({
  match,
  signal = {},
  source = 'email',
  windows = [],
  links = {},
  draft = null
} = {}) {
  const who = senderLabel(signal.from || signal.address);
  const subject = compactText(signal.subject, 160);
  const lines = ['Goal connection'];
  if (source === 'calendar') {
    lines.push(`${subject || 'A new event'} puts you with ${who}.`);
  } else {
    lines.push(`${who} emailed you${subject ? ` — “${subject}”` : ''}.`);
  }
  lines.push(`This lines up with your goal: ${compactText(match?.goal_text, 200)}.`);

  // A domain-only person match places someone at a company without naming
  // them, so it is worded as context rather than an identification.
  for (const person of (links.people || []).slice(0, 2)) {
    const description = compactText(describePerson(person), 180);
    if (!description) continue;
    lines.push(person.identified ? `Known contact: ${description}.` : `Possibly related: ${description}.`);
  }
  for (const client of (links.clients || []).slice(0, 2)) {
    const description = compactText(describeClient(client), 200);
    if (description) lines.push(`CCC: ${description}.`);
  }

  const availability = describeOpenWindows(windows);
  if (availability) lines.push(`You're open ${availability} if you want to set up a time.`);
  if (draft?.action_id) {
    lines.push('I drafted a reply offering those times — approve it and I\'ll send it.');
  }
  return lines.join('\n');
}

// Attendees of a new event, shaped like an inbound signal for the matcher.
function calendarSignal(event) {
  const attendees = (event?.attendees || []).filter(attendee => attendee?.email && !attendee.self);
  if (!attendees.length) return null;
  return {
    id: event.id,
    address: attendees.map(attendee => attendee.email).join(' '),
    displayName: compactText(attendees[0].displayName || attendees[0].email, 80),
    from: attendees[0].displayName
      ? `"${compactText(attendees[0].displayName, 80)}" <${attendees[0].email}>`
      : attendees[0].email,
    subject: compactText(event.summary, 200),
    snippet: compactText(event.description, 400)
  };
}

function taskTitle(task) {
  return compactText(task?.description || task?.title, 180);
}

function trimObjectEntries(object, limit) {
  return Object.fromEntries(Object.entries(object || {}).slice(-limit));
}

function createExecutiveLoop({
  listUnreadEmails,
  listSentEmails,
  getEmailIdentity,
  listCalendarEvents,
  listOpenTasks,
  createCommitment,
  resolveReminder,
  getMeetingContext,
  matchGoalSignals,
  recordGoalMatch,
  stageReplyDraft,
  getPreferences,
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
    let preferences = {};
    if (typeof getPreferences === 'function') {
      try {
        preferences = await getPreferences() || {};
      } catch (error) {
        console.warn('[Executive Loop] Preference lookup failed:', error.message || error);
      }
    }
    const activeQuietStartHour = Number(preferences.quietStartHour ?? quietStartHour);
    const activeQuietEndHour = Number(preferences.quietEndHour ?? quietEndHour);
    const activeBriefMinMinutes = Number(preferences.meetingBriefMinMinutes ?? meetingBriefMinMinutes);
    const activeBriefMaxMinutes = Number(preferences.meetingBriefMaxMinutes ?? meetingBriefMaxMinutes);
    const quiet = isQuietTime(currentTime, {
      timeZone,
      quietStartHour: activeQuietStartHour,
      quietEndHour: activeQuietEndHour
    });
    const previous = await getState(EXECUTIVE_LOOP_STATE_KEY);
    const initialized = Boolean(previous?.initialized_at);
    let emailInitialized = Boolean(previous?.email_initialized_at);
    let sentEmailInitialized = Boolean(previous?.sent_email_initialized_at);
    const calendarInitialized = Boolean(previous?.calendar_initialized_at);
    const state = {
      version: 2,
      initialized_at: previous?.initialized_at || currentTime.toISOString(),
      email_initialized_at: previous?.email_initialized_at || null,
      email_account: previous?.email_account || null,
      sent_email_initialized_at: previous?.sent_email_initialized_at || null,
      calendar_initialized_at: previous?.calendar_initialized_at || null,
      known_email_ids: Array.isArray(previous?.known_email_ids) ? previous.known_email_ids : [],
      known_sent_email_ids: Array.isArray(previous?.known_sent_email_ids) ? previous.known_sent_email_ids : [],
      calendar_events: previous?.calendar_events && typeof previous.calendar_events === 'object'
        ? previous.calendar_events
        : {},
      briefed_meetings: Array.isArray(previous?.briefed_meetings) ? previous.briefed_meetings : [],
      goal_signaled_ids: Array.isArray(previous?.goal_signaled_ids) ? previous.goal_signaled_ids : [],
      last_run_at: currentTime.toISOString()
    };
    const errors = [];
    const sent = [];

    let emails = [];
    let sentEmails = [];
    let emailAccount = state.email_account;
    let events = [];
    let tasks = [];
    const [emailResult, sentEmailResult, emailIdentityResult, calendarResult, taskResult] = await Promise.allSettled([
      typeof listUnreadEmails === 'function' ? listUnreadEmails() : [],
      typeof listSentEmails === 'function' ? listSentEmails() : [],
      typeof getEmailIdentity === 'function' ? getEmailIdentity() : null,
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
    if (sentEmailResult.status === 'fulfilled') sentEmails = Array.isArray(sentEmailResult.value) ? sentEmailResult.value : [];
    else errors.push(`sent_email:${sentEmailResult.reason?.message || sentEmailResult.reason}`);
    if (emailIdentityResult.status === 'fulfilled') {
      emailAccount = compactText(emailIdentityResult.value, 320) || null;
      if (state.email_account && emailAccount && state.email_account !== emailAccount) {
        state.email_initialized_at = null;
        state.sent_email_initialized_at = null;
        state.known_email_ids = [];
        state.known_sent_email_ids = [];
        emailInitialized = false;
        sentEmailInitialized = false;
      }
      state.email_account = emailAccount;
    } else {
      errors.push(`email_identity:${emailIdentityResult.reason?.message || emailIdentityResult.reason}`);
    }
    if (calendarResult.status === 'fulfilled') events = Array.isArray(calendarResult.value) ? calendarResult.value : [];
    else errors.push(`calendar:${calendarResult.reason?.message || calendarResult.reason}`);
    if (taskResult.status === 'fulfilled') tasks = Array.isArray(taskResult.value) ? taskResult.value : [];
    else errors.push(`tasks:${taskResult.reason?.message || taskResult.reason}`);

    const knownEmails = new Set(state.known_email_ids);
    const newEmails = [];
    const baselineGoalSignalKeys = [];
    if (emailResult.status === 'fulfilled' && !emailInitialized) {
      for (const email of emails) {
        if (!email?.id) continue;
        knownEmails.add(email.id);
        // Baseline goal matching alongside email: enabling the loop must not
        // replay connections for mail that was already sitting in the inbox.
        baselineGoalSignalKeys.push(`email:${email.id}`);
      }
      state.email_initialized_at = currentTime.toISOString();
    } else {
      const eligibleEmails = [];
      for (const email of emails) {
        if (!email?.id) continue;
        const classification = classifyEmail(email);
        // Goal matching keeps its own seen-set, so it considers every human
        // email in the inbox rather than inheriting the alert tracker's dedupe.
        // Two reasons: "just checking in" advances a partnership without ever
        // looking actionable, and a connection deferred by quiet hours must
        // still be there in the morning.
        if (classification.category !== 'automated') newEmails.push(email);
        if (knownEmails.has(email.id)) continue;
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

    const knownSentEmails = new Set(state.known_sent_email_ids);
    if (sentEmailResult.status === 'fulfilled' && !sentEmailInitialized) {
      for (const email of sentEmails) if (email?.id) knownSentEmails.add(email.id);
      state.sent_email_initialized_at = currentTime.toISOString();
    } else {
      for (const email of sentEmails) {
        if (!email?.id || knownSentEmails.has(email.id)) continue;
        const commitment = extractOwnerCommitment(email, { now: currentTime, timeZone });
        if (commitment && quiet) continue;
        knownSentEmails.add(email.id);
        if (!commitment || typeof createCommitment !== 'function') continue;

        const task = await createCommitment(commitment);
        const dueLabel = new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        }).format(new Date(commitment.due_at));
        const alert = await sendAlert(
          `Commitment captured\n${commitment.title.replace(/^Follow through:\s*/i, '')}\nDue ${dueLabel}.`,
          'commitment_captured',
          'normal',
          {
            dedupeKey: `commitment-captured:${email.id}`,
            metadata: {
              task_id: task?.id || commitment.id,
              source_message_id: email.id,
              due_at: commitment.due_at
            }
          }
        );
        if (!alert?.deduplicated) sent.push('captured');
      }
    }
    state.known_sent_email_ids = [...knownSentEmails].slice(-MAX_TRACKED_SENT_EMAILS);

    const previousEvents = state.calendar_events;
    const nextEvents = { ...previousEvents };
    const newEvents = [];
    for (const event of events) {
      if (!event?.id) continue;
      const currentSnapshot = eventSnapshot(event);
      const prior = previousEvents[event.id];
      if (!calendarInitialized || !prior) {
        // Only after the baseline run: a genuinely new invitation can be the
        // first time a goal's counterparty appears anywhere.
        if (calendarInitialized && currentSnapshot.status !== 'cancelled') newEvents.push(event);
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
      if (minutesUntil < activeBriefMinMinutes || minutesUntil > activeBriefMaxMinutes || briefed.has(briefKey)) {
        continue;
      }
      const alert = await sendAlert(
        buildMeetingBrief(event, emails, {
          now: currentTime,
          timeZone,
          tasks,
          ...(typeof getMeetingContext === 'function' ? await getMeetingContext(event) : {})
        }),
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

    // Goal connections. Held back entirely during quiet hours — and because a
    // signal is only marked as seen once it has actually been evaluated, the
    // ones skipped tonight are still waiting in the morning.
    const goalSignaled = new Set([...state.goal_signaled_ids, ...baselineGoalSignalKeys]);
    if (typeof matchGoalSignals === 'function' && !quiet) {
      const candidates = [
        ...newEmails.map(email => ({ signal: email, source: 'email' })),
        ...newEvents.map(event => ({ signal: calendarSignal(event), source: 'calendar' }))
      ].filter(candidate => candidate.signal?.id && !goalSignaled.has(`${candidate.source}:${candidate.signal.id}`));

      for (const { signal, source } of candidates.slice(0, MAX_GOAL_SIGNALS_PER_RUN)) {
        const signalKey = `${source}:${signal.id}`;
        let outcome = null;
        try {
          outcome = await matchGoalSignals({ signal, source, events, now: currentTime });
        } catch (error) {
          errors.push(`goal_signal:${error?.message || error}`);
          continue;
        }
        // Mark seen only after a clean evaluation, so a provider outage retries
        // rather than silently dropping the signal.
        goalSignaled.add(signalKey);
        const matches = Array.isArray(outcome?.matches) ? outcome.matches : [];
        const windows = Array.isArray(outcome?.windows) ? outcome.windows : [];
        const links = outcome?.links && typeof outcome.links === 'object' ? outcome.links : {};
        if (outcome?.errors?.length) errors.push(...outcome.errors.map(item => `goal_signal:${item}`));

        for (const match of matches.slice(0, 1)) {
          // Staged first so the alert can tell the owner a reply is waiting.
          // Never sent here — it only enters the approval queue.
          let draft = null;
          if (typeof stageReplyDraft === 'function' && source === 'email' && windows.length) {
            try {
              draft = await stageReplyDraft({ match, signal, windows });
            } catch (error) {
              errors.push(`goal_reply_draft:${error?.message || error}`);
            }
          }

          const alert = await sendAlert(
            formatGoalSignalAlert({ match, signal, source, windows, links, draft }),
            'goal_signal',
            'normal',
            {
              dedupeKey: `goal-signal:${signalKey}:${match.goal_id}`,
              metadata: {
                goal_id: match.goal_id,
                signal_source: source,
                signal_id: signal.id,
                confidence: match.confidence,
                tier: match.tier,
                matched_by: match.matched_by,
                linked_people: (links.people || []).length,
                linked_clients: (links.clients || []).length,
                draft_action_id: draft?.action_id ?? null
              }
            }
          );
          if (typeof recordGoalMatch === 'function') {
            try {
              await recordGoalMatch({
                match,
                signal,
                source,
                windows,
                links,
                draftActionId: draft?.action_id ?? null,
                notificationId: alert?.id ?? null
              });
            } catch (error) {
              errors.push(`goal_match_record:${error?.message || error}`);
            }
          }
          if (!alert?.deduplicated) sent.push('goal_signal');
        }
      }
    }
    state.goal_signaled_ids = [...goalSignaled].slice(-MAX_TRACKED_GOAL_SIGNALS);

    if (!quiet) {
      for (const task of tasks) {
        const dueMs = Date.parse(task?.due_at);
        const title = taskTitle(task);
        if (!title || !Number.isFinite(dueMs)) continue;
        const minutesUntil = (dueMs - currentMs) / 60000;
        if (isReminderTask(task)) {
          if (minutesUntil > 0) continue;
          const dedupeTime = new Date(dueMs).toISOString();
          const alert = await sendAlert(
            `Reminder\n${reminderMessage(task)}`,
            'reminder',
            'normal',
            {
              dedupeKey: `reminder:${task.id}:${dedupeTime}`,
              metadata: { task_id: task.id, due_at: dedupeTime }
            }
          );
          if (typeof resolveReminder === 'function') {
            await resolveReminder(task, {
              deliveredAt: currentTime.toISOString(),
              nextDueAt: nextReminderDueAt(task, { after: currentTime })
            });
          }
          if (!alert?.deduplicated) sent.push('reminder');
          continue;
        }
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
      sent_emails: sentEmails.length,
      email_account: emailAccount,
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
  deterministicCommitmentId,
  extractOwnerCommitment,
  isQuietTime,
  eventFingerprint,
  eventStartMs,
  calendarSignal,
  formatGoalSignalAlert,
  relatedUnreadForEvent,
  relatedTasksForEvent,
  buildMeetingBrief,
  createExecutiveLoop
};
