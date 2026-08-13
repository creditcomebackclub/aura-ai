'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAgentTelemetryMessage,
  percentile,
  summarizeAgentTelemetry
} = require('../agent_telemetry');

function telemetryMessage({
  id,
  agent,
  requestedAgent = agent,
  tool = null,
  ok = true,
  responseReadyMs = null,
  registryStatus = 'succeeded',
  maximumRisk = null
}) {
  return {
    id,
    role: 'assistant',
    content: 'Private reply text must not enter telemetry.',
    created_at: `2026-08-13T00:00:0${id}.000Z`,
    metadata: {
      evidence: tool ? [{ tool, ok, data: { private: true } }] : [],
      brain: {
        agent,
        model: 'grok-4.5',
        reasoning_effort: 'low',
        routing: {
          requested_agent: requestedAgent,
          ...(maximumRisk ? { maximum_risk: maximumRisk } : {}),
          registry_status: registryStatus,
          registry_refresh_ms: 12,
          resolution_ms: 14
        },
        timing: { response_ready_ms: responseReadyMs }
      }
    }
  };
}

test('agent telemetry keeps operational metadata and omits conversation content', () => {
  const event = normalizeAgentTelemetryMessage(telemetryMessage({
    id: 1,
    agent: 'finance',
    tool: 'calculate_financial_metrics',
    responseReadyMs: 1250
  }));
  assert.equal(event.agent, 'finance');
  assert.deepEqual(event.tools, [{ name: 'calculate_financial_metrics', ok: true }]);
  assert.deepEqual(event.allowlist_violations, []);
  assert.equal(event.response_ready_ms, 1250);
  assert.equal(Object.hasOwn(event, 'content'), false);
  assert.equal(JSON.stringify(event).includes('Private reply'), false);
});

test('agent telemetry summarizes routing, failures, latency, and sample readiness', () => {
  const rows = [
    telemetryMessage({ id: 1, agent: 'aura_core', responseReadyMs: 800 }),
    telemetryMessage({
      id: 2,
      agent: 'finance',
      tool: 'calculate_financial_metrics',
      responseReadyMs: 1200
    }),
    telemetryMessage({
      id: 3,
      agent: 'client_operations',
      tool: 'get_client_snapshot',
      ok: false,
      responseReadyMs: 2400
    }),
    { id: 4, metadata: {} }
  ];
  const summary = summarizeAgentTelemetry(rows, { minSpecialistTurns: 2 });
  assert.equal(summary.sampled_messages, 4);
  assert.equal(summary.instrumented_turns, 3);
  assert.equal(summary.specialist_turns, 2);
  assert.equal(summary.specialist_tool_calls, 2);
  assert.equal(summary.specialist_failed_tool_calls, 1);
  assert.equal(summary.specialist_allowlist_violations, 0);
  assert.equal(summary.by_agent.finance.response_ready_ms.median, 1200);
  assert.equal(summary.readiness.status, 'read_only_baseline_available');
  assert.equal(summary.readiness.reversible_write_expansion, 'manual_review_required');
  assert.equal(percentile([800, 1200, 2400], 0.95), 2400);
});

test('agent telemetry flags specialist evidence outside its read-only allowlist', () => {
  const summary = summarizeAgentTelemetry([
    telemetryMessage({ id: 1, agent: 'finance', tool: 'send_email' })
  ], { minSpecialistTurns: 1 });
  assert.equal(summary.specialist_allowlist_violations, 1);
  assert.equal(summary.readiness.status, 'policy_anomaly');
});

test('agent telemetry flags a specialist risk ceiling above read', () => {
  const summary = summarizeAgentTelemetry([
    telemetryMessage({
      id: 1,
      agent: 'client_operations',
      tool: 'get_client_snapshot',
      maximumRisk: 'reversible_write'
    })
  ], { minSpecialistTurns: 1 });
  assert.equal(summary.specialist_risk_ceiling_violations, 1);
  assert.equal(summary.readiness.status, 'policy_anomaly');
});
