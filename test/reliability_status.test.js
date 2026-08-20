const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReliabilityStatus, formatReliabilityDigest } = require('../reliability_status');

test('reliability status ranks actionable durable and client issues', () => {
  const status = buildReliabilityStatus({
    memory: { failed: 1, retry_wait: 2 },
    pendingPreferences: [{ id: 'candidate' }],
    clientWatchlist: [{ severity: 'high' }]
  });
  assert.equal(status.status, 'needs_attention');
  assert.match(formatReliabilityDigest(status), /1 memory jobs failed/);
  assert.match(formatReliabilityDigest(status), /1 clients on the explainable watchlist/);
});
