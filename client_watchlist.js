'use strict';

function dateMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function latestLetterByClient(letters = []) {
  const latest = new Map();
  for (const letter of letters) {
    const key = String(letter?.client_id || letter?.client_name || '').toLowerCase();
    if (!key) continue;
    const timestamp = dateMs(letter.saved_at || letter.mailed_date) || 0;
    if (!latest.has(key) || timestamp > latest.get(key).timestamp) {
      latest.set(key, { letter, timestamp });
    }
  }
  return latest;
}

function buildClientWatchlist(clients = [], letters = [], {
  now = new Date(),
  stalledDays = 45,
  overdueDays = 3,
  limit = 100
} = {}) {
  const nowMs = now.getTime();
  const configuredStalledDays = Number(stalledDays);
  const configuredOverdueDays = Number(overdueDays);
  const stalledThreshold = Math.max(1, Math.min(3650,
    Number.isFinite(configuredStalledDays) ? configuredStalledDays : 45));
  const overdueThreshold = Math.max(0, Math.min(3650,
    Number.isFinite(configuredOverdueDays) ? configuredOverdueDays : 3));
  const latest = latestLetterByClient(letters);
  const rows = [];
  for (const client of clients) {
    const status = String(client?.status || '').trim();
    const active = !/^(?:cancelled|canceled|closed|completed|inactive)$/i.test(status);
    if (!active) continue;
    const signals = [];
    const openLedger = (Array.isArray(client.ledger) ? client.ledger : [])
      .filter(entry => ['due', 'unpaid', 'pending', 'overdue', 'past due']
        .includes(String(entry?.status || '').trim().toLowerCase()) && Number(entry?.amount) > 0);
    const overdue = openLedger.filter(entry => {
      const dueMs = dateMs(entry.due_date || entry.date || entry.created_at);
      return dueMs != null && nowMs - dueMs >= overdueThreshold * 86400000;
    });
    if (overdue.length) {
      signals.push({
        kind: 'overdue_balance',
        amount: overdue.reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
        oldest_days: Math.max(...overdue.map(entry => Math.floor((nowMs - dateMs(entry.due_date || entry.date || entry.created_at)) / 86400000)))
      });
    }
    if (/past due|overdue|failed|delinquent/i.test(String(client.billing_status || ''))) {
      signals.push({ kind: 'billing_status', value: String(client.billing_status).slice(0, 120) });
    }
    const letterState = latest.get(String(client.id || '').toLowerCase()) ||
      latest.get(String(client.name || '').toLowerCase());
    if (letterState?.timestamp) {
      const inactiveDays = Math.floor((nowMs - letterState.timestamp) / 86400000);
      if (inactiveDays >= stalledThreshold) {
        signals.push({
          kind: 'stalled_phase',
          days: inactiveDays,
          phase: letterState.letter.phase || null,
          last_activity_at: new Date(letterState.timestamp).toISOString()
        });
      }
    }
    if (!signals.length) continue;
    rows.push({
      client: { id: client.id, name: client.name, status, billing_status: client.billing_status || null },
      severity: signals.some(signal => signal.kind === 'billing_status' || signal.oldest_days >= 14)
        ? 'high'
        : 'normal',
      signals
    });
  }
  return rows
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
      String(a.client.name).localeCompare(String(b.client.name)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)));
}

module.exports = { buildClientWatchlist };
