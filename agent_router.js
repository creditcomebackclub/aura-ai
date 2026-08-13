'use strict';

const RISK_RANK = Object.freeze({
  read: 0,
  reversible_write: 1,
  external_action: 2,
  destructive_write: 3
});

const DEFAULT_AGENTS = Object.freeze({
  aura_core: Object.freeze({
    id: 'aura_core',
    name: 'AURA',
    description: 'AURA Core handles general, mixed-domain, and action-oriented requests.',
    instructions: 'Use the full AURA persona and the normal owner authorization policy.',
    allowed_tools: null,
    maximum_risk: 'destructive_write',
    enabled: true
  }),
  client_operations: Object.freeze({
    id: 'client_operations',
    name: 'Client Operations Agent',
    description: 'Audits client progress, phases, missing records, and stalled workflows.',
    instructions: 'Use deterministic CCC tools. Report evidence and never modify client records.',
    allowed_tools: [
      'get_client_snapshot',
      'get_client_current_phase',
      'query_database_table',
      'count_database_rows'
    ],
    maximum_risk: 'read',
    enabled: true
  }),
  finance: Object.freeze({
    id: 'finance',
    name: 'Finance Agent',
    description: 'Reconciles collections, recurring revenue, balances, and commissions.',
    instructions: 'Use deterministic financial tools and state the accounting definition behind every metric.',
    allowed_tools: [
      'calculate_financial_metrics',
      'get_outstanding_balances',
      'query_database_table',
      'count_database_rows'
    ],
    maximum_risk: 'read',
    enabled: true
  })
});

const WRITE_OR_EXTERNAL_PATTERN = /\b(?:send|email|message|schedule|book|create|add|delete|remove|log|remember|forget|teach|text|telegram)\b/i;
const MUTATION_PATTERN = /\b(?:update|change|mark|edit)\b.{0,50}\b(?:goal|task|calendar|event|record|skill|workflow|status)\b/i;
const FINANCE_PATTERN = /\b(?:mrr|revenue|income|collections?|collected|payments?|paid|paying|balances?|outstanding|owes?|owed|invoice|billing|commission|financial|finances?|money|cash|churn)\b/i;
const CLIENT_OPERATIONS_PATTERN = /\b(?:client\s+(?:status|snapshot|progress|phase|record)|active\s+clients?|(?:what|which|current)\s+phase|disputes?|bureaus?|furnishers?|letters?|mailed|responses?|round\s+\d+|phase\s+\d+|stalled|missing\s+records?)\b/i;

function normalizeAgent(row, fallback) {
  if (!row || row.enabled === false) return null;
  const allowed = Array.isArray(row.allowed_tools)
    ? row.allowed_tools.filter(value => typeof value === 'string' && value)
    : fallback.allowed_tools;
  const maximumRisk = Object.hasOwn(RISK_RANK, row.maximum_risk)
    ? row.maximum_risk
    : fallback.maximum_risk;
  return {
    ...fallback,
    ...row,
    id: fallback.id,
    name: String(row.name || fallback.name).slice(0, 120),
    description: String(row.description || fallback.description).slice(0, 600),
    instructions: String(row.instructions || fallback.instructions).slice(0, 2000),
    allowed_tools: allowed,
    maximum_risk: maximumRisk,
    enabled: true
  };
}

function mergeAgentRegistry(rows = [], { fallbackMissing = true } = {}) {
  const byId = new Map((Array.isArray(rows) ? rows : []).map(row => [row?.id, row]));
  const registry = { aura_core: { ...DEFAULT_AGENTS.aura_core } };
  for (const id of ['client_operations', 'finance']) {
    if (!byId.has(id)) {
      if (fallbackMissing) registry[id] = { ...DEFAULT_AGENTS[id] };
      continue;
    }
    const normalized = normalizeAgent(byId.get(id), DEFAULT_AGENTS[id]);
    if (normalized) registry[id] = normalized;
  }
  return registry;
}

function routeAgentId(text) {
  const value = String(text || '').trim();
  if (!value || WRITE_OR_EXTERNAL_PATTERN.test(value) || MUTATION_PATTERN.test(value)) return 'aura_core';
  const finance = FINANCE_PATTERN.test(value);
  const clientOperations = CLIENT_OPERATIONS_PATTERN.test(value);
  if (finance === clientOperations) return 'aura_core';
  return finance ? 'finance' : 'client_operations';
}

function routeAgentForTurn(text, registry = mergeAgentRegistry()) {
  const requestedId = routeAgentId(text);
  return registry[requestedId] || registry.aura_core || { ...DEFAULT_AGENTS.aura_core };
}

function filterToolsForAgent(tools, agent) {
  const list = Array.isArray(tools) ? tools : [];
  if (!Array.isArray(agent?.allowed_tools)) return list;
  const allowed = new Set(agent.allowed_tools);
  return list.filter(tool => allowed.has(tool?.function?.name));
}

function assertAgentCanUseTool(agent, toolName, riskLevel) {
  const active = agent || DEFAULT_AGENTS.aura_core;
  if (Array.isArray(active.allowed_tools) && !active.allowed_tools.includes(toolName)) {
    throw new Error(`Tool is outside ${active.id}'s allowlist: ${toolName}`);
  }
  const toolRank = RISK_RANK[riskLevel];
  const ceilingRank = RISK_RANK[active.maximum_risk];
  if (toolRank == null || ceilingRank == null || toolRank > ceilingRank) {
    throw new Error(`Tool exceeds ${active.id}'s ${active.maximum_risk} risk ceiling: ${toolName}`);
  }
  return true;
}

function buildAgentPrompt(agent) {
  if (!agent || agent.id === 'aura_core') return '';
  return [
    '\nACTIVE SPECIALIST LENS (trusted configuration):',
    `${agent.name} [${agent.id}] — ${agent.description}`,
    agent.instructions,
    `This lens is limited to ${agent.maximum_risk} operations. Stay in AURA's normal voice and report only evidence returned by the offered tools.`
  ].join('\n');
}

module.exports = {
  DEFAULT_AGENTS,
  RISK_RANK,
  assertAgentCanUseTool,
  buildAgentPrompt,
  filterToolsForAgent,
  mergeAgentRegistry,
  routeAgentForTurn,
  routeAgentId
};
