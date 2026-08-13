'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalEntity,
  domainLabel,
  displayName,
  extractGoalEntities,
  extractSignalEntities,
  isPublicMailboxDomain,
  phraseCandidates,
  registrableDomain
} = require('../entity_extraction');

function canonicals(entities) {
  return entities.map(entity => entity.canonical);
}

test('canonical form collapses spacing, case, and punctuation', () => {
  assert.equal(canonicalEntity('Identity IQ'), 'identityiq');
  assert.equal(canonicalEntity('identity iq'), 'identityiq');
  assert.equal(canonicalEntity('IdentityIQ'), 'identityiq');
  assert.equal(canonicalEntity('Identity-IQ!'), 'identityiq');
});

test('registrable domain and label survive subdomains and multi-part TLDs', () => {
  assert.equal(registrableDomain('mail.identityiq.com'), 'identityiq.com');
  assert.equal(registrableDomain('https://www.identityiq.com/partners'), 'identityiq.com');
  assert.equal(domainLabel('mail.identityiq.com'), 'identityiq');
  assert.equal(domainLabel('acme.co.uk'), 'acme');
  assert.equal(domainLabel('notadomain'), '');
});

test('public mailbox domains are never treated as an organization', () => {
  assert.equal(isPublicMailboxDomain('gmail.com'), true);
  assert.equal(isPublicMailboxDomain('mail.gmail.com'), true);
  assert.equal(isPublicMailboxDomain('identityiq.com'), false);
});

test('display name is parsed from a From header', () => {
  assert.equal(displayName('"Matt Rivera" <matt@identityiq.com>'), 'Matt Rivera');
  assert.equal(displayName('Matt Rivera <matt@identityiq.com>'), 'Matt Rivera');
  assert.equal(displayName('matt@identityiq.com'), '');
});

test('lowercase goal text still yields the organization phrase', () => {
  const entities = extractGoalEntities({ description: 'setup partnership with identity iq' });
  const keys = canonicals(entities);
  assert.ok(keys.includes('identityiq'), `expected identityiq in ${keys.join(', ')}`);
});

test('filler never begins or ends a multi-word candidate', () => {
  const keys = canonicals(phraseCandidates('setup partnership with identity iq'));
  assert.ok(!keys.includes('withidentity'));
  assert.ok(!keys.includes('partnershipwith'));
  assert.ok(!keys.includes('partnership'));
});

test('corporate suffixes collapse onto the bare organization name', () => {
  const keys = canonicals(extractGoalEntities({ description: 'renew the Identity IQ LLC agreement' }));
  assert.ok(keys.includes('identityiq'));
});

test('structured goal hints produce domain and organization entities', () => {
  const entities = extractGoalEntities({
    description: 'close the reseller deal',
    organization: 'Identity IQ',
    domain: 'identityiq.com'
  });
  const byType = Object.fromEntries(entities.map(entity => [entity.type, entity.canonical]));
  assert.equal(byType.organization, 'identityiq');
  assert.equal(byType.domain, 'identityiq');
});

test('sender domain becomes a typed domain entity, personal mail does not', () => {
  const business = extractSignalEntities({ from: '"Matt Rivera" <matt@identityiq.com>', subject: 'Partnership follow-up' });
  const domain = business.find(entity => entity.type === 'domain');
  assert.equal(domain.canonical, 'identityiq');
  assert.equal(domain.source, 'sender_domain');

  const personal = extractSignalEntities({ from: 'Aunt Sue <sue@gmail.com>', subject: 'dinner sunday' });
  assert.equal(personal.find(entity => entity.type === 'domain'), undefined);
});

test('sender display name is typed as a person, not an organization', () => {
  const entities = extractSignalEntities({ from: '"Matt Rivera" <matt@identityiq.com>' });
  const person = entities.find(entity => entity.type === 'person');
  assert.equal(person.canonical, 'mattrivera');
});

test('the motivating case links a real email to a hand-written goal', () => {
  const goal = canonicals(extractGoalEntities({ description: 'setup partnership with identity iq' }));
  const signal = canonicals(extractSignalEntities({
    from: '"Matt Rivera" <matt@identityiq.com>',
    subject: 'Reseller partnership — next steps',
    snippet: 'Wanted to see if you had time this week to talk through the agreement.'
  }));
  assert.ok(goal.some(key => signal.includes(key)));
});
