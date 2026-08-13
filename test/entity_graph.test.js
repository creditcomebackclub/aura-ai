'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_PERSON_CONFIDENCE,
  clientLookupCandidates,
  describeClient,
  describePerson,
  indexPeople,
  linkSignal,
  matchPeople,
  personEntities,
  resolveClients
} = require('../entity_graph');
const { extractSignalEntities } = require('../entity_extraction');

const PROFILE = {
  entries: {
    'people.matt_rivera': {
      key: 'people.matt_rivera',
      kind: 'relationship',
      subject: 'Matt Rivera',
      value: 'Matt Rivera runs partnerships at Identity IQ.',
      relationship: 'business contact',
      aliases: ['Matthew Rivera'],
      emails: ['matt@identityiq.com'],
      organization: 'Identity IQ',
      role: 'VP Partnerships'
    },
    'people.dana_cole': {
      key: 'people.dana_cole',
      kind: 'relationship',
      subject: 'Dana Cole',
      value: 'Dana Cole is a client.',
      emails: ['dana@example.org'],
      organization: 'Example Org'
    },
    'communication.signoff': {
      key: 'communication.signoff',
      kind: 'communication',
      value: 'No generic sign-offs.'
    }
  }
};

const IDENTITY_IQ_SIGNAL = {
  from: '"Matt Rivera" <matt@identityiq.com>',
  subject: 'Reseller partnership — next steps'
};

test('only people-shaped profile entries are indexed', () => {
  const people = indexPeople(PROFILE);
  assert.deepEqual(people.map(person => person.name).sort(), ['Dana Cole', 'Matt Rivera']);
  assert.equal(people.find(person => person.name === 'Matt Rivera').role, 'VP Partnerships');
});

test('a person record yields address, name, alias, and organization entities', () => {
  const entities = personEntities(PROFILE.entries['people.matt_rivera']);
  const byType = type => entities.filter(entity => entity.type === type).map(entity => entity.canonical);

  assert.ok(byType('email').includes('mattidentityiqcom'));
  assert.ok(byType('domain').includes('identityiq'));
  assert.ok(byType('name').includes('mattrivera'));
  assert.ok(byType('name').includes('matthewrivera'), 'aliases must be searchable too');
  assert.ok(byType('organization').includes('identityiq'));
});

test('an exact sender address identifies the contact', () => {
  const [match] = matchPeople(extractSignalEntities(IDENTITY_IQ_SIGNAL), indexPeople(PROFILE));

  assert.equal(match.name, 'Matt Rivera');
  assert.equal(match.evidence.matched_on, 'email');
  assert.equal(match.identified, true);
  assert.ok(match.confidence > 0.9);
});

test('a colleague on a known domain is context, not an identification', () => {
  const [match] = matchPeople(
    extractSignalEntities({ from: '"Priya Nair" <priya@identityiq.com>', subject: 'Intro' }),
    indexPeople(PROFILE)
  );

  assert.equal(match.name, 'Matt Rivera');
  // Company-level evidence, whether it lands on the stored domain or the stored
  // organization name. Either way it must not claim to name the sender.
  assert.ok(['domain', 'organization'].includes(match.evidence.matched_on));
  assert.equal(match.identified, false, 'a shared domain must never claim to name the sender');
  assert.ok(match.confidence >= MIN_PERSON_CONFIDENCE);
  assert.ok(match.confidence < 0.8, 'company-level evidence must rank below a name or address match');
});

test('an unrelated sender matches nobody', () => {
  assert.deepEqual(
    matchPeople(
      extractSignalEntities({ from: 'billing@utilitycompany.net', subject: 'Statement ready' }),
      indexPeople(PROFILE)
    ),
    []
  );
});

test('a personal mailbox cannot link a person through its domain', () => {
  const profile = {
    entries: {
      'people.sue': { key: 'people.sue', kind: 'relationship', subject: 'Sue', emails: ['sue@gmail.com'] }
    }
  };
  const matches = matchPeople(
    extractSignalEntities({ from: 'Someone Else <other@gmail.com>', subject: 'hi' }),
    indexPeople(profile)
  );
  assert.deepEqual(matches, []);
});

test('an exact personal address still identifies the person', () => {
  const profile = {
    entries: {
      'people.sue': { key: 'people.sue', kind: 'relationship', subject: 'Sue Harper', emails: ['sue@gmail.com'] }
    }
  };
  const [match] = matchPeople(
    extractSignalEntities({ from: 'Sue <sue@gmail.com>', subject: 'dinner' }),
    indexPeople(profile)
  );
  assert.equal(match.identified, true);
  assert.equal(match.evidence.matched_on, 'email');
});

test('client lookups prefer an identified contact organization', () => {
  const entities = extractSignalEntities(IDENTITY_IQ_SIGNAL);
  const people = matchPeople(entities, indexPeople(PROFILE));
  const candidates = clientLookupCandidates(entities, people);

  assert.equal(candidates[0], 'Identity IQ');
  assert.ok(candidates.length <= 2, 'directory lookups stay bounded');
});

test('client lookups are deduplicated by canonical name', () => {
  const candidates = clientLookupCandidates(
    [{ type: 'domain', value: 'identityiq.com' }, { type: 'phrase', value: 'Identity IQ' }],
    [{ organization: 'Identity IQ' }]
  );
  assert.deepEqual(candidates, ['Identity IQ']);
});

test('client resolution tolerates JSON strings and survives a lookup failure', async () => {
  const ok = await resolveClients(['Identity IQ'], async () => JSON.stringify({
    found: true,
    client: { name: 'Identity IQ', status: 'Active' }
  }));
  assert.equal(ok.clients[0].client.name, 'Identity IQ');

  const failed = await resolveClients(['Identity IQ'], async () => { throw new Error('db down'); }, {
    logger: { warn() {} }
  });
  assert.deepEqual(failed.clients, []);
  assert.match(failed.errors[0], /db down/);
});

test('linkSignal resolves the contact and their client standing together', async () => {
  const links = await linkSignal({
    signal: IDENTITY_IQ_SIGNAL,
    profile: PROFILE,
    getClientSnapshot: async name => name === 'Identity IQ'
      ? {
          found: true,
          client: { name: 'Identity IQ', status: 'Active', billing_status: 'Current' },
          current_phase: 'Phase 2',
          outstanding_total: 1250
        }
      : { found: false }
  });

  assert.equal(links.people[0].name, 'Matt Rivera');
  assert.equal(links.clients[0].client.name, 'Identity IQ');
  assert.deepEqual(links.errors, []);
});

test('linkSignal works with no profile and no client source', async () => {
  const links = await linkSignal({ signal: IDENTITY_IQ_SIGNAL });
  assert.deepEqual(links.people, []);
  assert.deepEqual(links.clients, []);
});

test('descriptions read the way the meeting brief already phrases them', () => {
  assert.equal(
    describePerson({ name: 'Matt Rivera', role: 'VP Partnerships', organization: 'Identity IQ' }),
    'Matt Rivera — VP Partnerships at Identity IQ'
  );
  assert.equal(
    describePerson({ name: 'Dana Cole', relationship: 'business contact' }),
    'Dana Cole — business contact'
  );
  assert.equal(
    describeClient({
      client: { name: 'Identity IQ', status: 'Active', billing_status: 'Current' },
      current_phase: 'Phase 2',
      outstanding_total: 1250
    }),
    'Identity IQ — Phase 2 · Active · Current · $1250.00 outstanding'
  );
  assert.equal(describeClient({ client: { name: 'Acme' } }), 'Acme');
  assert.equal(describeClient({}), '');
});
