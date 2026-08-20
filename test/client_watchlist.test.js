const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClientWatchlist } = require('../client_watchlist');

test('client watchlist reports explainable overdue and stalled signals without an opaque score', () => {
  const rows = buildClientWatchlist([{
    id: 'client-1', name: 'Ava Client', status: 'Active', billing_status: 'Past Due',
    ledger: [{ status: 'Due', amount: 125, due_date: '2026-07-01T00:00:00Z' }]
  }], [{
    client_id: 'client-1', phase: 'Phase 2', saved_at: '2026-06-01T00:00:00Z'
  }], { now: new Date('2026-08-20T00:00:00Z') });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'high');
  assert.deepEqual(rows[0].signals.map(signal => signal.kind), [
    'overdue_balance', 'billing_status', 'stalled_phase'
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'score'), false);
});

test('client watchlist bounds owner-configured thresholds', () => {
  const client = {
    id: 'client-1', name: 'Ava Client', status: 'Active',
    ledger: [{ status: 'Due', amount: 10, due_date: '2026-08-20T00:00:00Z' }]
  };
  const recentLetter = [{ client_id: 'client-1', saved_at: '2026-08-20T00:00:00Z' }];
  const rows = buildClientWatchlist([client], recentLetter, {
    now: new Date('2026-08-20T12:00:00Z'),
    overdueDays: -20,
    stalledDays: -20
  });
  assert.deepEqual(rows[0].signals.map(signal => signal.kind), ['overdue_balance']);
});
