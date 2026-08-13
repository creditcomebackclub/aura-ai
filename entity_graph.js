'use strict';

// Links one inbound signal to everything AURA already knows about the people
// and organizations in it.
//
// Goal matching answers "what is this about". This module answers "who is
// this", by resolving the same canonical entities against the owner profile's
// people records and, when an organization surfaces, against CCC client
// records. The result is a single alert that carries the goal, the contact, and
// the client's real standing instead of three disconnected lookups.
//
// People matching is deterministic only. Names and addresses either match or
// they do not; a fuzzy vector hit on a person is a misidentification, not a
// useful recall.

const {
  canonicalEntity,
  extractSignalEntities,
  isPublicMailboxDomain,
  phraseCandidates,
  registrableDomain,
  domainLabel,
  MIN_CANONICAL_LENGTH
} = require('./entity_extraction');

// What each kind of collision says about a person record. An exact address is
// nearly certain; a shared domain only means "same company", which is worth
// surfacing but must never read as an identification.
const PERSON_EVIDENCE_WEIGHTS = {
  email: 0.99,
  name: 0.84,
  organization: 0.72,
  domain: 0.68
};
const MIN_PERSON_CONFIDENCE = 0.68;
const MAX_PEOPLE = 2;
const MAX_CLIENT_LOOKUPS = 2;

function profileEntries(profile) {
  return Object.values(profile?.entries || {}).filter(entry => entry && entry.key);
}

// A person record reduced to the canonical values that can identify them.
function personEntities(entry) {
  const entities = [];
  const push = (value, type) => {
    const canonical = canonicalEntity(value);
    if (canonical.length >= MIN_CANONICAL_LENGTH) entities.push({ value, canonical, type });
  };

  for (const email of entry.emails || []) {
    push(email, 'email');
    const host = String(email).split('@')[1] || '';
    if (host && !isPublicMailboxDomain(host)) {
      const label = domainLabel(host);
      if (label) entities.push({ value: registrableDomain(host), canonical: canonicalEntity(label), type: 'domain' });
    }
  }
  for (const name of [entry.subject, ...(entry.aliases || [])].filter(Boolean)) {
    for (const candidate of phraseCandidates(name)) {
      entities.push({ ...candidate, type: 'name' });
    }
  }
  if (entry.organization) {
    for (const candidate of phraseCandidates(entry.organization)) {
      entities.push({ ...candidate, type: 'organization' });
    }
  }
  return entities;
}

function indexPeople(profile) {
  return profileEntries(profile)
    .filter(entry => entry.kind === 'relationship' || entry.subject || (entry.emails || []).length)
    .map(entry => ({
      key: entry.key,
      name: String(entry.subject || '').trim() || entry.value || '',
      relationship: entry.relationship || '',
      organization: String(entry.organization || '').trim(),
      role: String(entry.role || '').trim(),
      last_context: String(entry.last_context || '').trim(),
      entities: personEntities(entry)
    }))
    .filter(person => person.name && person.entities.length);
}

// Deterministic intersection between the signal and each known person.
function matchPeople(signalEntities = [], people = []) {
  const bySignal = new Map();
  for (const entity of signalEntities) {
    if (!bySignal.has(entity.canonical)) bySignal.set(entity.canonical, entity);
  }

  const matches = [];
  for (const person of people) {
    let best = null;
    for (const entity of person.entities) {
      const hit = bySignal.get(entity.canonical);
      if (!hit) continue;
      // A person-typed signal entity matching a stored organization is a
      // coincidence of wording, not evidence about who sent the mail.
      if (entity.type === 'organization' && hit.type === 'person') continue;
      const weight = PERSON_EVIDENCE_WEIGHTS[entity.type] ?? 0.6;
      if (!best || weight > best.weight) {
        best = {
          weight,
          matched_on: entity.type,
          canonical: entity.canonical,
          signal_type: hit.type,
          signal_source: hit.source || null,
          value: entity.value
        };
      }
    }
    if (best && best.weight >= MIN_PERSON_CONFIDENCE) {
      matches.push({
        key: person.key,
        name: person.name,
        relationship: person.relationship,
        organization: person.organization,
        role: person.role,
        confidence: Number(best.weight.toFixed(4)),
        // A shared domain places someone at the company; it does not name them.
        identified: best.matched_on === 'email' || best.matched_on === 'name',
        evidence: best
      });
    }
  }
  return matches
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_PEOPLE);
}

// Names worth asking the CCC directory about, strongest first: an identified
// contact's organization, then organizations named in the signal itself.
function clientLookupCandidates(signalEntities = [], people = []) {
  const names = [];
  for (const person of people) {
    if (person.organization) names.push(person.organization);
  }
  for (const entity of signalEntities) {
    if (entity.type === 'domain') names.push(entity.value.replace(/\.[a-z.]+$/i, ''));
    else if (entity.type === 'phrase' && String(entity.value || '').includes(' ')) names.push(entity.value);
  }
  const seen = new Set();
  return names
    .map(name => String(name || '').trim())
    .filter(name => {
      const key = canonicalEntity(name);
      if (key.length < MIN_CANONICAL_LENGTH || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_CLIENT_LOOKUPS);
}

async function resolveClients(candidates, getClientSnapshot, { logger = console } = {}) {
  if (typeof getClientSnapshot !== 'function') return { clients: [], errors: [] };
  const clients = [];
  const errors = [];
  for (const candidate of candidates) {
    try {
      const raw = await getClientSnapshot(candidate);
      const snapshot = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : raw;
      if (snapshot?.found) clients.push(snapshot);
    } catch (error) {
      const message = error?.message || String(error);
      errors.push(`client:${message}`);
      logger.warn?.('[Entity graph] Client lookup failed:', message);
    }
  }
  return { clients, errors };
}

// Everything AURA knows about the people and organizations in one signal.
async function linkSignal({
  signal,
  profile = null,
  getClientSnapshot = null,
  signalEntities = null,
  logger = console
} = {}) {
  const entities = Array.isArray(signalEntities) && signalEntities.length
    ? signalEntities
    : extractSignalEntities(signal || {});
  const people = matchPeople(entities, indexPeople(profile));
  const { clients, errors } = await resolveClients(
    clientLookupCandidates(entities, people),
    getClientSnapshot,
    { logger }
  );
  return { people, clients, errors };
}

// One-line CCC standing, matching the phrasing meeting briefs already use.
function describeClient(snapshot) {
  const details = [
    snapshot?.current_phase,
    snapshot?.client?.status,
    snapshot?.client?.billing_status
  ].filter(Boolean).join(' · ');
  const outstanding = Number(snapshot?.outstanding_total);
  const balance = outstanding > 0 ? ` · $${outstanding.toFixed(2)} outstanding` : '';
  const name = String(snapshot?.client?.name || '').trim();
  if (!name) return '';
  return `${name}${details ? ` — ${details}` : ''}${balance}`;
}

function describePerson(person) {
  const detail = [person?.role, person?.organization].filter(Boolean).join(' at ');
  const relationship = !detail && person?.relationship ? person.relationship : '';
  const suffix = detail || relationship;
  return `${person?.name}${suffix ? ` — ${suffix}` : ''}`;
}

module.exports = {
  MAX_CLIENT_LOOKUPS,
  MAX_PEOPLE,
  MIN_PERSON_CONFIDENCE,
  PERSON_EVIDENCE_WEIGHTS,
  clientLookupCandidates,
  describeClient,
  describePerson,
  indexPeople,
  linkSignal,
  matchPeople,
  personEntities,
  resolveClients
};
