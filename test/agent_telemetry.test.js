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
  toolDurationMs = null,
  toolRound = null,
  responseReadyMs = null,
  registryStatus = 'succeeded',
  maximumRisk = null,
  modelRounds = []
}) {
  return {
    id,
    role: 'assistant',
    content: 'Private reply text must not enter telemetry.',
    created_at: `2026-08-13T00:00:0${id}.000Z`,
    metadata: {
      evidence: tool ? [{
        tool,
        ok,
        ...(toolDurationMs == null ? {} : { duration_ms: toolDurationMs }),
        ...(toolRound == null ? {} : { round: toolRound }),
        arguments: { secret: 'tool arguments must stay private' },
        data: { secret: 'tool results must stay private' }
      }] : [],
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
        timing: { response_ready_ms: responseReadyMs, model_rounds: modelRounds }
      }
    }
  };
}

test('agent telemetry keeps operational metadata and omits conversation content', () => {
  const event = normalizeAgentTelemetryMessage(telemetryMessage({
    id: 1,
    agent: 'finance',
    tool: 'calculate_financial_metrics',
    toolDurationMs: 275,
    toolRound: 0,
    responseReadyMs: 1250,
    modelRounds: [{
      phase: 'initial',
      round: 0,
      model: 'grok-4.5',
      duration_ms: 600,
      first_delta_ms: 225,
      prompt: 'model input must stay private'
    }]
  }));
  assert.equal(event.agent, 'finance');
  assert.deepEqual(event.tools, [{
    name: 'calculate_financial_metrics',
    ok: true,
    duration_ms: 275,
    round: 0
  }]);
  assert.deepEqual(event.model_rounds, [{
    phase: 'initial',
    model: 'grok-4.5',
    duration_ms: 600,
    round: 0,
    first_delta_ms: 225
  }]);
  assert.deepEqual(event.allowlist_violations, []);
  assert.equal(event.response_ready_ms, 1250);
  assert.equal(Object.hasOwn(event, 'content'), false);
  assert.equal(JSON.stringify(event).includes('Private reply'), false);
  assert.equal(JSON.stringify(event).includes('must stay private'), false);
});

test('agent telemetry summarizes routing, failures, latency, and sample readiness', () => {
  const rows = [
    telemetryMessage({
      id: 1,
      agent: 'aura_core',
      responseReadyMs: 800,
      modelRounds: [{
        phase: 'initial', model: 'grok-4.5', round: 0, duration_ms: 500, first_delta_ms: 200
      }]
    }),
    telemetryMessage({
      id: 2,
      agent: 'finance',
      tool: 'calculate_financial_metrics',
      toolDurationMs: 250,
      responseReadyMs: 1200,
      modelRounds: [
        { phase: 'initial', model: 'luna-2', round: 0, duration_ms: 400 },
        { phase: 'tool_followup', model: 'grok-4.5', round: 1, duration_ms: 800, first_delta_ms: 300 }
      ]
    }),
    telemetryMessage({
      id: 3,
      agent: 'client_operations',
      tool: 'get_client_snapshot',
      ok: false,
      toolDurationMs: 700,
      responseReadyMs: 2400,
      modelRounds: [
        { phase: 'initial', model: 'luna-2', round: 0, duration_ms: 600 },
        { phase: 'tool_followup', model: 'grok-4.5', round: 1, duration_ms: 1600, first_delta_ms: 500 }
      ]
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
  assert.equal(summary.latency.tools.duration_ms.median, 250);
  assert.equal(summary.latency.tools.duration_ms.p95, 700);
  assert.equal(summary.latency.tools.by_tool.get_client_snapshot.failures, 1);
  assert.equal(summary.latency.model_rounds.by_phase.initial.duration_ms.median, 500);
  assert.equal(summary.latency.model_rounds.by_phase.tool_followup.duration_ms.p95, 1600);
  assert.equal(summary.latency.model_rounds.by_model['grok-4.5'].first_delta_ms.median, 300);
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
