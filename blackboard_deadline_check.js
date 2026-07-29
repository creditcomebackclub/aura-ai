function dateKey(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function createBlackboardDeadlineCheck({
  checkAssignments,
  getAlertState,
  setAlertState,
  sendAlert,
  summarizeText,
  now = () => new Date(),
  timeZone = 'America/Phoenix'
}) {
  if (typeof checkAssignments !== 'function') throw new Error('checkAssignments is required');
  if (typeof getAlertState !== 'function') throw new Error('getAlertState is required');
  if (typeof setAlertState !== 'function') throw new Error('setAlertState is required');
  if (typeof sendAlert !== 'function') throw new Error('sendAlert is required');

  let activeRun = null;

  async function execute() {
    const currentTime = now();
    const currentDateKey = dateKey(currentTime, timeZone);

    // This durable state makes retries, restarts, and overlapping scheduler
    // calls safe. It also avoids fetching the calendar again after a
    // successful check for the day.
    if ((await getAlertState('blackboard_digest_date')) === currentDateKey) {
      return { status: 'already_checked', date: currentDateKey };
    }

    const scraped = await checkAssignments();
    if (!scraped || typeof scraped !== 'string') {
      return { status: 'no_data', date: currentDateKey };
    }

    if (scraped.startsWith('BLACKBOARD_')) {
      const errorType = scraped.split(':')[0];
      let alerted = false;
      if ((await getAlertState('blackboard_error')) !== errorType) {
        const notification = await sendAlert(
          scraped.replace(/^BLACKBOARD_[A-Z_]+:\s*/, ''),
          'blackboard',
          'normal',
          { dedupeKey: `blackboard-error:${errorType}:${currentDateKey}` }
        );
        await setAlertState('blackboard_error', errorType);
        alerted = !notification?.deduplicated;
      }
      return {
        status: 'source_error',
        date: currentDateKey,
        error_type: errorType,
        alerted
      };
    }
    // Use an empty string instead of SQL NULL because aura_state.value is a
    // non-null JSONB column in the cloud state store.
    await setAlertState('blackboard_error', '');

    // Calendar feeds are structured enough to evaluate deterministically,
    // avoiding an LLM inventing or dropping a due date.
    let calendar = null;
    try {
      calendar = JSON.parse(scraped);
    } catch {
      // Browser-scraped text is not JSON and falls through below.
    }
    if (calendar?.source === 'blackboard_ical' && Array.isArray(calendar.assignments)) {
      const currentTimestamp = currentTime.getTime();
      const cutoff = currentTimestamp + 3 * 86400000;
      const upcoming = calendar.assignments
        .filter(item => {
          const due = new Date(item.due_at).getTime();
          return Number.isFinite(due) && due >= currentTimestamp && due <= cutoff;
        })
        .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));

      let notificationCreated = false;
      if (upcoming.length > 0) {
        const dueFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        });
        const list = upcoming
          .slice(0, 6)
          .map(item => `${item.title}, due ${dueFormatter.format(new Date(item.due_at))}`)
          .join('; ');
        const notification = await sendAlert(
          `You have ${upcoming.length} Blackboard deadline${upcoming.length === 1 ? '' : 's'} in the next three days: ${list}.`,
          'blackboard',
          'normal',
          { dedupeKey: `blackboard-deadlines:${currentDateKey}` }
        );
        notificationCreated = !notification?.deduplicated;
      }
      await setAlertState('blackboard_digest_date', currentDateKey);
      return {
        status: 'complete',
        date: currentDateKey,
        source: 'blackboard_ical',
        due_count: upcoming.length,
        notified: notificationCreated
      };
    }

    if (scraped.length < 50) {
      return { status: 'no_data', date: currentDateKey };
    }

    if (typeof summarizeText !== 'function') {
      throw new Error('Blackboard text summarization is not configured');
    }
    const text = String(await summarizeText(scraped) || '').trim();
    const shouldNotify = Boolean(text && text.toUpperCase() !== 'NONE');
    let notificationCreated = false;
    if (shouldNotify) {
      const notification = await sendAlert(
        text,
        'blackboard',
        'normal',
        { dedupeKey: `blackboard-deadlines:${currentDateKey}` }
      );
      notificationCreated = !notification?.deduplicated;
    }
    await setAlertState('blackboard_digest_date', currentDateKey);
    return {
      status: 'complete',
      date: currentDateKey,
      source: 'browser',
      notified: notificationCreated
    };
  }

  return function runBlackboardDeadlineCheck() {
    // A route call and the in-process cron can overlap on a warm service.
    // Sharing the active promise prevents duplicate alerts in that case.
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => {
      activeRun = null;
    });
    return activeRun;
  };
}

module.exports = {
  createBlackboardDeadlineCheck,
  dateKey
};
