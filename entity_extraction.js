'use strict';

// Deterministic entity extraction shared by goals and inbound signals.
//
// Goals are typed or dictated in lowercase ("setup partnership with identity
// iq"), so capitalization is never required to find the organization. Instead
// every contiguous 1-3 word run becomes a candidate, and each candidate is
// collapsed to a canonical form that absorbs the spacing and punctuation
// differences between "Identity IQ", "IdentityIQ", and "identityiq.com" — so a
// goal written by hand still lines up with the sending domain of a real email.
//
// This module is intentionally dependency-free and pure: callers own secret
// filtering, persistence, and scoring.

const PUBLIC_MAILBOX_DOMAINS = new Set([
  'aol.com', 'duck.com', 'fastmail.com', 'gmail.com', 'gmx.com', 'googlemail.com',
  'hey.com', 'hotmail.com', 'icloud.com', 'live.com', 'mac.com', 'mail.com',
  'me.com', 'msn.com', 'outlook.com', 'pm.me', 'proton.me', 'protonmail.com',
  'yahoo.com', 'yandex.com', 'ymail.com', 'zoho.com'
]);

// Enough of the public suffix list to keep "foo.co.uk" from collapsing to "co".
const MULTI_PART_TLDS = new Set([
  'ac.uk', 'co.il', 'co.in', 'co.jp', 'co.kr', 'co.nz', 'co.uk', 'co.za',
  'com.au', 'com.br', 'com.mx', 'com.sg', 'gov.uk', 'net.au', 'org.uk'
]);

// Words that carry no entity signal on their own. A single-word candidate made
// only of these is dropped, and multi-word candidates may not start or end with
// one — that removes "with identity" and "partnership with" while keeping the
// "identity iq" in the middle.
const GENERIC_TERMS = new Set([
  'a', 'about', 'above', 'account', 'add', 'after', 'agenda', 'agreement', 'all',
  'an', 'and', 'another', 'any', 'appointment', 'approve', 'are', 'arrange', 'as',
  'ask', 'at', 'available', 'availability', 'be', 'before', 'begin', 'book',
  'build', 'business', 'but', 'by', 'call', 'campaign', 'chat', 'check', 'client',
  'clients', 'close', 'company', 'confirm', 'connect', 'contract', 'conversation',
  'create', 'deal', 'demo', 'discuss', 'do', 'draft', 'due', 'during', 'email',
  'establish', 'eventually', 'file', 'finalize', 'find', 'finish', 'follow',
  'for', 'from', 'get', 'go', 'goal', 'group', 'have', 'help', 'hi', 'hello',
  'i', 'if', 'in', 'integration', 'into', 'introduce', 'invoice', 'is', 'it',
  'launch', 'lead', 'let', 'letter', 'like', 'link', 'looking', 'made', 'mail',
  'make', 'meet', 'meeting', 'message', 'more', 'my', 'need', 'new', 'next',
  'note', 'of', 'off', 'on', 'onboard', 'once', 'one', 'or', 'our', 'out',
  'over', 'partner', 'partners', 'partnership', 'pay', 'payment', 'phone',
  'pitch', 'plan', 'please', 'program', 'project', 'proposal', 'quote', 'reach',
  'ready', 'renew', 'reply', 'report', 'request', 'research', 'review', 'run',
  'schedule', 'send', 'set', 'setup', 'sign', 'sign-up', 'signup', 'so', 'some',
  'start', 'status', 'sync', 'system', 'take', 'talk', 'team', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'thread', 'time',
  'to', 'today', 'tomorrow', 'touch', 'up', 'update', 'us', 'use', 'via', 'want',
  'was', 'we', 'week', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'will', 'with', 'work', 'would', 'you', 'your'
]);

// Corporate suffixes are dropped from the tail of an organization phrase so
// "Identity IQ LLC" and "Identity IQ" reach the same canonical value.
const CORPORATE_SUFFIXES = new Set([
  'co', 'company', 'corp', 'corporation', 'gmbh', 'group', 'holdings', 'inc',
  'incorporated', 'limited', 'llc', 'llp', 'ltd', 'partners', 'plc', 'pllc',
  'sa', 'solutions', 'systems'
]);

const MIN_UNIGRAM_LENGTH = 4;
const MIN_CANONICAL_LENGTH = 4;
const MAX_GRAM = 3;

// Collapses a display value to its comparison key. Everything that is not a
// letter or digit disappears, which is what lets "Identity IQ" (goal text) and
// "identityiq" (mail domain label) resolve to the same entity.
function canonicalEntity(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function registrableDomain(host) {
  const cleaned = String(host || '')
    .toLowerCase()
    .trim()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '')
    .replace(/\.+$/, '');
  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  if (!/^[a-z0-9-]+$/.test(parts[parts.length - 1])) return '';
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

// "identityiq.com" -> "identityiq"; "acme.co.uk" -> "acme".
function domainLabel(host) {
  const registrable = registrableDomain(host);
  if (!registrable) return '';
  const parts = registrable.split('.');
  const suffixLength = MULTI_PART_TLDS.has(parts.slice(-2).join('.')) ? 2 : 1;
  return parts.slice(0, Math.max(1, parts.length - suffixLength)).join('');
}

function isPublicMailboxDomain(host) {
  const registrable = registrableDomain(host);
  return Boolean(registrable) && PUBLIC_MAILBOX_DOMAINS.has(registrable);
}

function emailAddresses(value) {
  return [...new Set(
    (String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])
      .map(address => address.toLowerCase())
  )];
}

// Display name out of "Matt Rivera <matt@identityiq.com>".
function displayName(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const quoted = text.match(/^"([^"]+)"\s*</);
  if (quoted?.[1]) return quoted[1].trim().slice(0, 80);
  const bare = text.match(/^([^"<@]+?)\s*</);
  if (bare?.[1]) return bare[1].trim().slice(0, 80);
  return '';
}

function words(text) {
  return String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'&+-]*/g) || [];
}

function trimCorporateSuffix(tokens) {
  const trimmed = [...tokens];
  while (trimmed.length > 1 && CORPORATE_SUFFIXES.has(trimmed[trimmed.length - 1].toLowerCase())) {
    trimmed.pop();
  }
  return trimmed;
}

// Every contiguous 1-3 word run that could name an organization. Multi-word
// runs may not begin or end on a generic term, so filler is never glued onto a
// real name.
function phraseCandidates(text, { source = 'text', maxGram = MAX_GRAM } = {}) {
  const tokens = words(text);
  const found = new Map();
  for (let size = 1; size <= maxGram; size += 1) {
    for (let start = 0; start + size <= tokens.length; start += 1) {
      const gram = tokens.slice(start, start + size);
      const lower = gram.map(token => token.toLowerCase());
      if (GENERIC_TERMS.has(lower[0]) || GENERIC_TERMS.has(lower[lower.length - 1])) continue;
      if (size === 1) {
        if (lower[0].length < MIN_UNIGRAM_LENGTH) continue;
        if (/^\d+$/.test(lower[0])) continue;
      }
      const meaningful = trimCorporateSuffix(gram);
      const canonical = canonicalEntity(meaningful.join(''));
      if (canonical.length < MIN_CANONICAL_LENGTH) continue;
      if (/^\d+$/.test(canonical)) continue;
      const existing = found.get(canonical);
      // Keep the longest surface form for display, but the canonical is what
      // matching compares on.
      if (!existing || meaningful.length > existing.words) {
        found.set(canonical, {
          value: meaningful.join(' '),
          canonical,
          type: 'phrase',
          source,
          words: meaningful.length
        });
      }
    }
  }
  // Most specific first: a full "Matt Rivera" or "Identity IQ" should be the
  // entity a caller reports as the match, not the bare first token.
  return [...found.values()]
    .sort((left, right) => right.words - left.words || right.canonical.length - left.canonical.length)
    .map(({ words: _ignored, ...entity }) => entity);
}

function dedupeEntities(entities) {
  const byKey = new Map();
  for (const entity of entities) {
    if (!entity?.canonical) continue;
    const key = `${entity.type}:${entity.canonical}`;
    if (!byKey.has(key)) byKey.set(key, entity);
  }
  return [...byKey.values()];
}

// Entities describing what a goal is *about*. Explicit organization/domain
// hints (set when a goal is created with structured detail) outrank text.
function extractGoalEntities(goal = {}) {
  const text = String(goal.description || goal.title || '');
  const entities = [];

  for (const address of emailAddresses(text)) {
    // The full address is always safe to compare exactly, even on a public
    // provider; only inferring an organization from the domain is not.
    entities.push({
      value: address,
      canonical: canonicalEntity(address),
      type: 'email',
      source: 'goal_text'
    });
    const host = address.split('@')[1] || '';
    if (isPublicMailboxDomain(host)) continue;
    const label = domainLabel(host);
    if (label.length >= MIN_CANONICAL_LENGTH) {
      entities.push({
        value: registrableDomain(host),
        canonical: canonicalEntity(label),
        type: 'domain',
        source: 'goal_text'
      });
    }
  }

  for (const hint of [goal.organization, goal.company].filter(Boolean)) {
    const canonical = canonicalEntity(trimCorporateSuffix(words(hint)).join(''));
    if (canonical.length >= MIN_CANONICAL_LENGTH) {
      entities.push({ value: String(hint).trim().slice(0, 120), canonical, type: 'organization', source: 'goal_hint' });
    }
  }

  for (const hint of [].concat(goal.domain || [], goal.domains || []).filter(Boolean)) {
    const label = domainLabel(hint);
    if (label.length >= MIN_CANONICAL_LENGTH) {
      entities.push({
        value: registrableDomain(hint),
        canonical: canonicalEntity(label),
        type: 'domain',
        source: 'goal_hint'
      });
    }
  }

  const textWithoutAddresses = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');
  entities.push(...phraseCandidates(textWithoutAddresses, { source: 'goal_text' }));
  return dedupeEntities(entities);
}

// Entities describing who/what an inbound signal is *from*. Sender domain is
// the strongest evidence available, so it is typed separately from prose.
function extractSignalEntities(signal = {}) {
  const entities = [];
  const from = String(signal.from || '');
  const addresses = [...new Set([...emailAddresses(from), ...emailAddresses(signal.address || '')])];

  for (const address of addresses) {
    entities.push({
      value: address,
      canonical: canonicalEntity(address),
      type: 'email',
      source: 'sender_address'
    });
    const host = address.split('@')[1] || '';
    if (!host || isPublicMailboxDomain(host)) continue;
    const label = domainLabel(host);
    if (label.length < MIN_CANONICAL_LENGTH) continue;
    entities.push({
      value: registrableDomain(host),
      canonical: canonicalEntity(label),
      type: 'domain',
      source: 'sender_domain'
    });
  }

  const name = displayName(from) || String(signal.displayName || '').trim();
  if (name) {
    entities.push(...phraseCandidates(name, { source: 'sender_name' })
      .map(entity => ({ ...entity, type: 'person' })));
  }

  const prose = [signal.subject, signal.snippet, signal.summary]
    .map(value => String(value || ''))
    .join(' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ');
  entities.push(...phraseCandidates(prose, { source: 'signal_text' }));

  return dedupeEntities(entities);
}

// Compact text used for the semantic tier and for embedding cache keys.
function signalText(signal = {}) {
  const name = displayName(signal.from) || String(signal.displayName || '').trim();
  return [name, signal.subject, signal.snippet, signal.summary]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' — ')
    .slice(0, 900);
}

module.exports = {
  CORPORATE_SUFFIXES,
  GENERIC_TERMS,
  MIN_CANONICAL_LENGTH,
  MIN_UNIGRAM_LENGTH,
  MULTI_PART_TLDS,
  PUBLIC_MAILBOX_DOMAINS,
  canonicalEntity,
  dedupeEntities,
  displayName,
  domainLabel,
  emailAddresses,
  extractGoalEntities,
  extractSignalEntities,
  isPublicMailboxDomain,
  phraseCandidates,
  registrableDomain,
  signalText,
  trimCorporateSuffix
};
