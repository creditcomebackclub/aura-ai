'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findBusinessSummaryPreference, formatBusinessSummary } = require('../business_summary');

test('business summary requires a trusted Telegram preference', () => {
  const requested = findBusinessSummaryPreference({
    entries: {
      summary: {
        kind: 'preference',
        value: 'Send a Telegram business summary with new invoices, leads, and letters from the previous 72 hours.'
      }
    }
  });
  assert.deepEqual(requested, {
    value: 'Send a Telegram business summary with new invoices, leads, and letters from the previous 72 hours.',
    hours: 72
  });
  assert.equal(findBusinessSummaryPreference({
    entries: {},
    memory_candidates: [{ value: 'Send a Telegram business summary.' }]
  }), null);
});

test('business summary reports all three activity counts compactly', () => {
  const text = formatBusinessSummary({
    invoices: [{ client: 'Jordan Richardson' }],
    leads: [],
    letters: [{ client_name: 'Cameron May' }, { client_name: 'David Roberts' }]
  }, { hours: 48 });
  assert.equal(text, [
    'CCC — previous 48 hours',
    'New invoices: 1 — Jordan Richardson',
    'New leads: 0',
    'Letters sent: 2 — Cameron May, David Roberts'
  ].join('\n'));
});
