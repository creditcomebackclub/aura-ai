'use strict';

const { DEFAULT_AGENTS } = require('./agent_router');

const DEFAULT_MIN_SPECIALIST_TURNS = 20;
const KNOWN_AGENT_IDS = new Set(Object.keys(DEFAULT_AGENTS));
const MODEL_ROUND_PHASES = new Set([
  'initial',
  'tool_followup',
  'tool_budget_exhausted',
  'capability_correction'
]);

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percentile(values, quantile) {
  const sorted = values
    .map(finiteNumber)
    .filter(value => value != null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function boundedRound(value) {
  const number = finiteNumber(value);
  return Number.isInteger(number) && number <= 20 ? number : null;
}

function modelIdentifier(value, fallback = 'unknown') {
  const model = String(value || '').trim();
  return model && /^[a-z0-9._:/-]+$/i.test(model)
    ? model.slice(0, 120)
    : fallback;
}

function latencyStats(items, field) {
  const values = items.map(item => item[field]).filter(value => value != null);
  return {
    samples: values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95)
  };
}

function groupedLatency(items, field, bucket) {
  const keys = [...new Set(items.map(item => item[field]))].sort();
  return Object.fromEntries(keys.map(key => [
    key,
    bucket(items.filter(item => item[field] === key))
  ]));
}

function normalizeAgentTelemetryMessage(message) {
  const metadata = message?.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const brain = metadata.brain && typeof metadata.brain === 'object'
    ? metadata.brain
    : {};
  const agent = String(brain.agent || '').trim();
  if (!KNOWN_AGENT_IDS.has(agent)) return null;

  const routing = brain.routing && typeof brain.routing === 'object'
    ? brain.routing
    : {};
  const timing = brain.timing && typeof brain.timing === 'object'
    ? brain.timing
    : {};
  const tools = (Array.isArray(metadata.evidence) ? metadata.evidence : [])
    .filter(item => item && typeof item.tool === 'string' && item.tool)
    .map(item => {
      const tool = {
        name: item.tool.slice(0, 120),
        ok: item.ok === true ? true : item.ok === false ? false : null
      };
      const durationMs = finiteNumber(item.duration_ms);
      const round = boundedRound(item.round);
      if (durationMs != null) tool.duration_ms = durationMs;
      if (round != null) tool.round = round;
      return tool;
    });
  const modelRounds = (Array.isArray(timing.model_rounds) ? timing.model_rounds : [])
    .slice(0, 10)
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const durationMs = finiteNumber(item.duration_ms);
      if (durationMs == null) return null;
      const phase = MODEL_ROUND_PHASES.has(item.phase) ? item.phase : 'unknown';
      const normalized = {
        phase,
        model: modelIdentifier(item.model, modelIdentifier(brain.model)),
        duration_ms: durationMs
      };
      const round = boundedRound(item.round);
      const firstDeltaMs = finiteNumber(item.first_delta_ms);
      if (round != null) normalized.round = round;
      if (firstDeltaMs != null) normalized.first_delta_ms = firstDeltaMs;
      return normalized;
    })
    .filter(Boolean);
  const allowlist = Array.isArray(routing.allowed_tools)
    ? routing.allowed_tools.filter(tool => typeof tool === 'string' && tool).slice(0, 20)
    : DEFAULT_AGENTS[agent]?.allowed_tools;
  const allowlistViolations = Array.isArray(allowlist)
    ? tools.filter(tool => !allowlist.includes(tool.name)).map(tool => tool.name)
    : [];
  const requestedAgent = KNOWN_AGENT_IDS.has(routing.requested_agent)
    ? routing.requested_agent
    : agent;

  return {
    id: message.id ?? null,
    created_at: message.created_at || null,
    agent,
    requested_agent: requestedAgent,
    fallback_to_core: requestedAgent !== agent,
    maximum_risk: String(
      routing.maximum_risk || DEFAULT_AGENTS[agent]?.maximum_risk || 'unknown'
    ).slice(0, 40),
    registry_status: String(routing.registry_status || 'unrecorded').slice(0, 40),
    registry_refresh_ms: finiteNumber(routing.registry_refresh_ms),
    route_resolution_ms: finiteNumber(routing.resolution_ms),
    response_ready_ms: finiteNumber(timing.response_ready_ms),
    model: modelIdentifier(brain.model),
    reasoning_effort: String(brain.reasoning_effort || 'unknown').slice(0, 40),
    tools,
    model_rounds: modelRounds,
    failed_tool_calls: tools.filter(tool => tool.ok === false).length,
    allowlist_violations: allowlistViolations
  };
}

function toolLatencyBucket(tools) {
  return {
    calls: tools.length,
    failures: tools.filter(tool => tool.ok === false).length,
    duration_ms: latencyStats(tools, 'duration_ms')
  };
}

function modelRoundLatencyBucket(rounds) {
  return {
    calls: rounds.length,
    duration_ms: latencyStats(rounds, 'duration_ms'),
    first_delta_ms: latencyStats(rounds, 'first_delta_ms')
  };
}

function agentBucket(events, total) {
  const toolCalls = events.reduce((sum, event) => sum + event.tools.length, 0);
  const failedToolCalls = events.reduce((sum, event) => sum + event.failed_tool_calls, 0);
  const violations = events.flatMap(event => event.allowlist_violations);
  const latencies = events.map(event => event.response_ready_ms).filter(value => value != null);
  return {
    turns: events.length,
    share: total ? Number((events.length / total).toFixed(4)) : 0,
    tool_calls: toolCalls,
    failed_tool_calls: failedToolCalls,
    tool_failure_rate: toolCalls ? Number((failedToolCalls / toolCalls).toFixed(4)) : 0,
    allowlist_violations: violations.length,
    response_ready_ms: {
      samples: latencies.length,
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95)
    }
  };
}

function summarizeAgentTelemetry(messages, {
  minSpecialistTurns = DEFAULT_MIN_SPECIALIST_TURNS
} = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const events = rows.map(normalizeAgentTelemetryMessage).filter(Boolean);
  const byAgent = {};
  for (const id of KNOWN_AGENT_IDS) {
    byAgent[id] = agentBucket(events.filter(event => event.agent === id), events.length);
  }
  const specialistEvents = events.filter(event => event.agent !== 'aura_core');
  const specialistToolCalls = specialistEvents.reduce((sum, event) => sum + event.tools.length, 0);
  const specialistFailures = specialistEvents.reduce((sum, event) => sum + event.failed_tool_calls, 0);
  const allowlistViolations = specialistEvents.reduce(
    (sum, event) => sum + event.allowlist_violations.length,
    0
  );
  const riskCeilingViolations = specialistEvents.filter(
    event => event.maximum_risk !== 'read'
  ).length;
  const toolEvents = events.flatMap(event => event.tools);
  const modelRoundEvents = events.flatMap(event => event.model_rounds);
  const registryStatus = {};
  for (const event of events) {
    registryStatus[event.registry_status] = (registryStatus[event.registry_status] || 0) + 1;
  }
  const minimum = Math.max(1, Number(minSpecialistTurns) || DEFAULT_MIN_SPECIALIST_TURNS);
  const readinessStatus = allowlistViolations > 0 || riskCeilingViolations > 0
    ? 'policy_anomaly'
    : specialistEvents.length < minimum
      ? 'insufficient_specialist_data'
      : 'read_only_baseline_available';

  return {
    sampled_messages: rows.length,
    instrumented_turns: events.length,
    uninstrumented_messages: rows.length - events.length,
    specialist_turns: specialistEvents.length,
    specialist_share: events.length
      ? Number((specialistEvents.length / events.length).toFixed(4))
      : 0,
    fallback_to_core_turns: events.filter(event => event.fallback_to_core).length,
    specialist_tool_calls: specialistToolCalls,
    specialist_failed_tool_calls: specialistFailures,
    specialist_tool_failure_rate: specialistToolCalls
      ? Number((specialistFailures / specialistToolCalls).toFixed(4))
      : 0,
    specialist_allowlist_violations: allowlistViolations,
    specialist_risk_ceiling_violations: riskCeilingViolations,
    registry_status: registryStatus,
    by_agent: byAgent,
    latency: {
      tools: {
        ...toolLatencyBucket(toolEvents),
        by_tool: groupedLatency(toolEvents, 'name', toolLatencyBucket)
      },
      model_rounds: {
        ...modelRoundLatencyBucket(modelRoundEvents),
        by_phase: groupedLatency(modelRoundEvents, 'phase', modelRoundLatencyBucket),
        by_model: groupedLatency(modelRoundEvents, 'model', modelRoundLatencyBucket)
      }
    },
    readiness: {
      status: readinessStatus,
      observed_specialist_turns: specialistEvents.length,
      minimum_specialist_turns: minimum,
      reversible_write_expansion: 'manual_review_required'
    }
  };
}

module.exports = {
  DEFAULT_MIN_SPECIALIST_TURNS,
  normalizeAgentTelemetryMessage,
  percentile,
  summarizeAgentTelemetry
};
