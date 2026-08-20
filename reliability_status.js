'use strict';

function buildReliabilityStatus({
  memory = {},
  agent = {},
  pendingPreferences = [],
  commitmentCandidates = [],
  clientWatchlist = [],
  integrationErrors = []
} = {}) {
  const issues = [];
  if (Number(memory.failed) > 0) issues.push({ severity: 'high', kind: 'memory_failures', count: memory.failed });
  if (Number(memory.retry_wait) > 0) issues.push({ severity: 'normal', kind: 'memory_retries', count: memory.retry_wait });
  if (pendingPreferences.length) issues.push({ severity: 'normal', kind: 'pending_preferences', count: pendingPreferences.length });
  const toolFailures = Number(agent?.latency?.tools?.failures) || 0;
  if (toolFailures) issues.push({ severity: 'normal', kind: 'tool_failures', count: toolFailures });
  if (commitmentCandidates.length) issues.push({ severity: 'normal', kind: 'commitments_to_review', count: commitmentCandidates.length });
  const highRiskClients = clientWatchlist.filter(item => item.severity === 'high').length;
  if (clientWatchlist.length) issues.push({
    severity: highRiskClients ? 'high' : 'normal',
    kind: 'clients_to_review',
    count: clientWatchlist.length,
    high: highRiskClients
  });
  if (integrationErrors.length) issues.push({ severity: 'normal', kind: 'integration_errors', count: integrationErrors.length });
  return {
    generated_at: new Date().toISOString(),
    status: issues.some(issue => issue.severity === 'high')
      ? 'needs_attention'
      : issues.length ? 'review' : 'healthy',
    issues,
    memory,
    agent,
    pending_preferences: pendingPreferences,
    commitment_candidates: commitmentCandidates,
    client_watchlist: clientWatchlist,
    integration_errors: integrationErrors
  };
}

function formatReliabilityDigest(status) {
  if (!status || status.status === 'healthy') return null;
  const labels = {
    memory_failures: 'memory jobs failed',
    memory_retries: 'memory jobs retrying',
    pending_preferences: 'preferences awaiting confirmation',
    tool_failures: 'tool failures in the telemetry sample',
    commitments_to_review: 'email commitments awaiting review',
    clients_to_review: 'clients on the explainable watchlist',
    integration_errors: 'integration checks unavailable'
  };
  return `AURA reliability check\n${status.issues
    .map(issue => `${issue.count} ${labels[issue.kind] || issue.kind}`)
    .join('\n')}`;
}

module.exports = { buildReliabilityStatus, formatReliabilityDigest };
