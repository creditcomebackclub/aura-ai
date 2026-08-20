'use strict';

const byId = id => document.getElementById(id);
const sessionToken = localStorage.getItem('aura_session_token') || '';
const accessToken = localStorage.getItem('aura_access_token') || '';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken
        ? { Authorization: `Bearer ${sessionToken}` }
        : accessToken ? { 'X-AURA-Token': accessToken } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function clearAndEmpty(container, message) {
  container.replaceChildren();
  const item = document.createElement('div');
  item.className = 'card muted';
  item.textContent = message;
  container.appendChild(item);
}

function card(title, detail = '', className = '') {
  const item = document.createElement('article');
  item.className = `card ${className}`.trim();
  const strong = document.createElement('strong');
  strong.textContent = title;
  item.appendChild(strong);
  if (detail) {
    const paragraph = document.createElement('p');
    paragraph.className = 'muted';
    paragraph.textContent = detail;
    item.appendChild(paragraph);
  }
  return item;
}

function addAction(item, label, run, danger = false) {
  let actions = item.querySelector('.actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'actions';
    item.appendChild(actions);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (danger) button.className = 'danger';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await run(); } finally { button.disabled = false; }
  });
  actions.appendChild(button);
}

function renderReliability(status) {
  const container = byId('reliability');
  container.replaceChildren();
  const summary = card(status.status.replaceAll('_', ' '), `${status.issues.length} issue class(es)`, status.status);
  const metric = document.createElement('div');
  metric.className = 'metric';
  metric.textContent = status.issues.length;
  summary.prepend(metric);
  container.appendChild(summary);
  for (const issue of status.issues) {
    container.appendChild(card(
      issue.kind.replaceAll('_', ' '),
      `${issue.count} item(s)`,
      issue.severity
    ));
  }
}

function renderMemory(health, profileResponse) {
  const preferences = byId('preferences');
  preferences.replaceChildren();
  for (const candidate of health.pending_preferences || []) {
    const item = card(candidate.entry?.value || candidate.question || 'Pending preference', candidate.question || 'Awaiting owner confirmation');
    addAction(item, 'Remember', () => decidePreference(candidate.id, 'approve'));
    addAction(item, 'Reject', () => decidePreference(candidate.id, 'reject'), true);
    preferences.appendChild(item);
  }
  if (!preferences.childElementCount) clearAndEmpty(preferences, 'No preferences awaiting confirmation.');

  const jobs = byId('memory-jobs');
  jobs.replaceChildren();
  for (const job of health.recent_failed_jobs || []) {
    const item = card(`Message ${job.message_id}`, `${job.attempts || 0} attempts · ${job.error?.code || job.error?.message || 'unknown failure'}`, 'high');
    addAction(item, 'Replay safely', () => replayJob(job.message_id));
    jobs.appendChild(item);
  }
  if (!jobs.childElementCount) clearAndEmpty(jobs, 'No failed extraction jobs.');

  const profile = byId('profile');
  profile.replaceChildren();
  for (const [key, entry] of Object.entries(profileResponse.profile?.entries || {})) {
    const item = card(String(entry.value || entry.subject || entry.instruction || 'Stored fact'));
    const keyLine = document.createElement('div');
    keyLine.className = 'key';
    keyLine.textContent = key;
    item.prepend(keyLine);
    profile.appendChild(item);
  }
  if (!profile.childElementCount) clearAndEmpty(profile, 'No pinned profile facts.');
}

function renderCommitments(response) {
  const container = byId('commitments');
  container.replaceChildren();
  for (const task of response.candidates || []) {
    const due = task.due_at ? new Date(task.due_at).toLocaleString() : 'No due time';
    const item = card(task.title || task.description || 'Email commitment', due);
    addAction(item, 'Add to active list', () => decideCommitment(task.id, 'approve'));
    addAction(item, 'Dismiss', () => decideCommitment(task.id, 'reject'), true);
    container.appendChild(item);
  }
  if (!container.childElementCount) clearAndEmpty(container, 'No email commitments awaiting review.');
}

function signalText(signal) {
  if (signal.kind === 'overdue_balance') return `$${Number(signal.amount || 0).toFixed(2)} overdue; oldest ${signal.oldest_days} days`;
  if (signal.kind === 'stalled_phase') return `${signal.phase || 'Phase'} inactive for ${signal.days} days`;
  if (signal.kind === 'billing_status') return `Billing status: ${signal.value}`;
  return signal.kind.replaceAll('_', ' ');
}

function renderClients(response) {
  const container = byId('clients');
  container.replaceChildren();
  for (const row of response.clients || []) {
    container.appendChild(card(
      row.client?.name || 'Unnamed client',
      (row.signals || []).map(signalText).join(' · '),
      row.severity
    ));
  }
  if (!container.childElementCount) clearAndEmpty(container, 'No clients meet the current watchlist thresholds.');
}

async function refresh() {
  byId('notice').textContent = 'Refreshing…';
  try {
    const [status, health, profile, commitments, clients] = await Promise.all([
      api('/api/reliability/status'),
      api('/api/memory/health'),
      api('/api/profile'),
      api('/api/commitments/review').catch(error => ({ candidates: [], unavailable: error.message })),
      api('/api/clients/watchlist').catch(error => ({ clients: [], unavailable: error.message }))
    ]);
    renderReliability(status);
    renderMemory(health, profile);
    renderCommitments(commitments);
    renderClients(clients);
    byId('generated-at').textContent = `Verified ${new Date(status.generated_at).toLocaleString()}`;
    byId('notice').textContent = [commitments.unavailable, clients.unavailable].filter(Boolean).join(' · ');
  } catch (error) {
    byId('notice').textContent = `${error.message}. Open AURA and sign in on this device first.`;
  }
}

async function decidePreference(id, decision) {
  await api(`/api/memory/candidates/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ decision })
  });
  await refresh();
}

async function replayJob(messageId) {
  await api(`/api/memory/jobs/${encodeURIComponent(messageId)}/replay`, { method: 'POST', body: '{}' });
  await refresh();
}

async function decideCommitment(id, decision) {
  await api(`/api/commitments/review/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ decision })
  });
  await refresh();
}

byId('refresh').addEventListener('click', refresh);
refresh();
