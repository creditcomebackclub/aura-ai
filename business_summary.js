'use strict';

function findBusinessSummaryPreference(profile) {
  for (const entry of Object.values(profile?.entries || {})) {
    const value = String(entry?.value || '').replace(/\s+/g, ' ').trim();
    if (!/\bbusiness\s+summary\b/i.test(value) || !/\btelegram\b/i.test(value)) continue;
    const match = value.match(/\b(?:previous|past|last)\s+(\d{1,3})\s+hours?\b/i);
    const hours = match ? Math.max(1, Math.min(168, Number(match[1]))) : 48;
    return { value, hours };
  }
  return null;
}

function itemLabel(item) {
  return String(item?.name || item?.client || item?.client_name || '').trim();
}

function compactLabels(items, limit = 4) {
  const labels = (Array.isArray(items) ? items : []).map(itemLabel).filter(Boolean);
  if (!labels.length) return '';
  const shown = labels.slice(0, limit);
  const remainder = labels.length - shown.length;
  return `${shown.join(', ')}${remainder > 0 ? `, plus ${remainder} more` : ''}`;
}

function formatBusinessSummary(activity, { hours = 48 } = {}) {
  const invoices = Array.isArray(activity?.invoices) ? activity.invoices : [];
  const leads = Array.isArray(activity?.leads) ? activity.leads : [];
  const letters = Array.isArray(activity?.letters) ? activity.letters : [];
  const lines = [`CCC — previous ${hours} hours`];
  const sections = [
    ['New invoices', invoices],
    ['New leads', leads],
    ['Letters sent', letters]
  ];
  for (const [label, items] of sections) {
    const names = compactLabels(items);
    lines.push(`${label}: ${items.length}${names ? ` — ${names}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  findBusinessSummaryPreference,
  formatBusinessSummary
};
