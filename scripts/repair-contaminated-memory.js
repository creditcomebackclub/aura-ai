#!/usr/bin/env node
'use strict';

// Repairs owner memory that was poisoned before the name-correction and
// relationship fixes landed.
//
// Four things went wrong and left durable state behind:
//
//   1. correctTranscriptClientNames rewrote ordinary English into client
//      names ("call him back" -> "call him Jack") BEFORE the text was stored,
//      so fabricated client mentions sit in conversation rows and in memory.
//   2. Person records keyed on a bare first name fused different people and
//      kept whichever relationship label landed first, so a client can be
//      carrying a personal label such as "wife" or "girlfriend".
//   3. Relationship entries with no stated relationship were rendered - and
//      SAVED - as "<name> is the owner's known person", asserting a personal
//      relation that was never stated.
//   4. Memory-confirmation candidates could never be resolved, so the pending
//      queue holds questions that have been re-asked for up to 30 days.
//
// Safety model:
//   * Dry run by default. Nothing is written without --apply.
//   * --apply always writes a full JSON backup of the profile and the scanned
//     memory rows first, and refuses to continue if the backup cannot be written.
//   * Only unambiguous repairs are automated. Anything requiring a judgement
//     call is reported for review and left alone.
//   * Deleting whole records additionally requires --delete-flagged, and every
//     row is listed before it goes.
//
// Usage:
//   node scripts/repair-contaminated-memory.js                     # report only
//   node scripts/repair-contaminated-memory.js --apply             # safe repairs
//   node scripts/repair-contaminated-memory.js --apply --delete-flagged
//   node scripts/repair-contaminated-memory.js --apply --backup-dir ./backups

const fs = require('fs');
const path = require('path');
const { SupabaseStateStore } = require('../supabase_state_store');
const { loadClientDirectory, scoreClientName, normalizeClientName } = require('../ccc_database');

require('dotenv').config({ quiet: true });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DELETE_FLAGGED = args.includes('--delete-flagged');
const BACKUP_DIR = (() => {
  const index = args.indexOf('--backup-dir');
  return index !== -1 && args[index + 1] ? args[index + 1] : '.';
})();

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'AURA_OWNER_ID']) {
  if (!process.env[key]) throw new Error(`${key} is required.`);
}

const state = new SupabaseStateStore({
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
  ownerId: process.env.AURA_OWNER_ID
});

// Relationship labels that assert a personal tie to the owner. A CCC client
// must never carry one of these.
const PERSONAL_RELATIONSHIPS = new Set([
  'wife', 'husband', 'spouse', 'partner', 'girlfriend', 'boyfriend', 'fiance',
  'fiancee', 'ex', 'ex-wife', 'ex-husband', 'lover', 'date', 'daughter', 'son',
  'child', 'kid', 'mother', 'mom', 'father', 'dad', 'parent', 'sister',
  'brother', 'sibling', 'aunt', 'uncle', 'cousin', 'grandmother',
  'grandfather', 'niece', 'nephew', 'friend', 'best friend', 'roommate'
]);

// How close a stored person's name must be to a real client name before this
// script treats them as the same person. Deliberately high: a false positive
// here rewrites a genuine personal relationship.
const CLIENT_NAME_MATCH_MIN = 0.9;

const FABRICATED_RELATION_PATTERN = /\bis the owner's known person\b/i;

const MAX_CANDIDATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Owner-authored content that --delete-flagged must never remove.
const PROTECTED_MEMORY_KINDS = new Set(['dream_journal', 'episode', 'journal']);

function isPersonalRelationship(value) {
  return PERSONAL_RELATIONSHIPS.has(String(value || '').trim().toLowerCase());
}

function matchingClient(name, clients) {
  const tokens = normalizeClientName(name);
  // A bare first name is NOT enough to relabel somebody as a client.
  // scoreClientName deliberately favours short queries, so "Sarah" scores a
  // perfect 1.0 against a client called "Sarah Kline" - and acting on that
  // would rewrite a genuine personal relationship into a business one, which
  // is the very error this script exists to undo. Require a full name.
  if (tokens.length < 2) return null;
  let best = null;
  for (const client of clients) {
    if (normalizeClientName(client.name).length < 2) continue;
    const score = scoreClientName(name, client.name);
    if (score >= CLIENT_NAME_MATCH_MIN && (!best || score > best.score)) {
      best = { client, score };
    }
  }
  return best;
}

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

function describeEntry(entry) {
  const bits = [
    entry.relationship ? `relationship=${entry.relationship}` : 'relationship=(none)',
    entry.organization ? `org=${entry.organization}` : '',
    entry.emails?.length ? `email=${entry.emails.join(',')}` : ''
  ].filter(Boolean);
  return `${entry.key} — ${entry.subject || entry.value} [${bits.join(' | ')}]`;
}

function writeBackup(payload) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.resolve(BACKUP_DIR, `aura-memory-backup-${stamp}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

async function main() {
  console.log(APPLY
    ? '=== REPAIR MODE — changes WILL be written ==='
    : '=== DRY RUN — no changes will be written (pass --apply to repair) ===');

  const [profile, memories, directory] = await Promise.all([
    state.getOwnerProfile(),
    state.listMemories(500),
    loadClientDirectory().catch(error => ({ error: error.message }))
  ]);

  const clients = directory?.data || [];
  if (directory?.error) {
    console.warn(`\n! Client directory unavailable (${directory.error}).`);
    console.warn('  Client cross-checks will be skipped; other repairs still run.');
  }
  const entries = Object.values(profile?.entries || {}).filter(entry => entry && entry.key);
  const candidates = Array.isArray(profile?.memory_candidates) ? profile.memory_candidates : [];

  console.log(`\nProfile: ${entries.length} entries, ${candidates.length} pending confirmations`);
  console.log(`Memories scanned: ${memories.length}`);
  console.log(`Client directory: ${clients.length} records`);

  const clientFirstNamesEarly = new Set(
    clients.map(client => normalizeClientName(client.name)[0]).filter(Boolean)
  );

  // ---------------------------------------------------------------- 1. labels
  // A person record that matches a real client but carries a personal
  // relationship label. This is the exact shape of the romantic-relationship
  // incident, and correcting the label is unambiguous.
  const mislabelled = [];
  for (const entry of entries) {
    if (entry.kind !== 'relationship') continue;
    if (!isPersonalRelationship(entry.relationship)) continue;
    const hit = matchingClient(entry.subject || entry.value, clients);
    if (hit) mislabelled.push({ entry, client: hit.client, score: hit.score });
  }

  heading(`1. Client records carrying a personal relationship label (${mislabelled.length})`);
  if (!mislabelled.length) console.log('None found.');
  for (const item of mislabelled) {
    console.log(`  ${describeEntry(item.entry)}`);
    console.log(`     matches CCC client "${item.client.name}" (${item.score}) — relationship will become "client"`);
  }

  // ------------------------------------------------------- 2. fusion-prone keys
  // Bare-first-name keys are the ones the old merge could fuse. These are
  // REPORTED ONLY: deciding whether two records are one person needs a human.
  const fusionRisk = entries.filter(entry =>
    entry.kind === 'relationship' &&
    String(entry.subject || '').trim().split(/\s+/).filter(Boolean).length === 1
  );

  heading(`2. Person records keyed on a bare first name (${fusionRisk.length}) — REVIEW ONLY`);
  if (!fusionRisk.length) console.log('None found.');
  for (const entry of fusionRisk) {
    const emails = entry.emails?.length || 0;
    const flags = [];
    if (emails > 1) flags.push('multiple addresses: possible fusion of two people');
    // A bare first name carrying a personal label that also exists in the
    // client roster is the highest-risk record in the profile - but it is
    // exactly the case that cannot be resolved automatically.
    if (isPersonalRelationship(entry.relationship) &&
        clientFirstNamesEarly.has(normalizeClientName(entry.subject || entry.value)[0])) {
      flags.push(`personal label "${entry.relationship}" but a client shares this first name`);
    }
    console.log(`  ${describeEntry(entry)}${flags.length ? `\n     <-- ${flags.join('; ')}` : ''}`);
  }
  if (fusionRisk.length) {
    console.log('\n  Not repaired automatically. Merging or splitting these is a judgement call;');
    console.log('  delete the wrong ones through the normal profile route once reviewed.');
  }

  // ----------------------------------------------- 3. fabricated personal framing
  const fabricatedMemories = memories.filter(row => FABRICATED_RELATION_PATTERN.test(row.content || ''));

  heading(`3. Memory rows asserting an unstated personal relation (${fabricatedMemories.length})`);
  if (!fabricatedMemories.length) console.log('None found.');
  for (const row of fabricatedMemories) {
    console.log(`  #${row.id}: ${String(row.content).slice(0, 120)}`);
  }
  if (fabricatedMemories.length) {
    console.log('\n  Repair: "X is the owner\'s known person" -> "X is a known contact".');
  }

  // ------------------------------------------------ 4. stale confirmation queue
  const now = Date.now();
  const staleCandidates = candidates.filter(candidate => {
    const createdMs = Date.parse(candidate?.created_at || '');
    const tooOld = Number.isFinite(createdMs) && now - createdMs > MAX_CANDIDATE_AGE_MS;
    const spent = Number(candidate?.ask_count || 0) >= 2;
    return tooOld || spent;
  });

  heading(`4. Unresolvable pending confirmations (${staleCandidates.length} of ${candidates.length})`);
  if (!candidates.length) console.log('Queue is empty.');
  for (const candidate of candidates) {
    const createdMs = Date.parse(candidate?.created_at || '');
    const ageDays = Number.isFinite(createdMs)
      ? Math.round((now - createdMs) / 86400000)
      : '?';
    const stale = staleCandidates.includes(candidate) ? ' <-- will be cleared' : '';
    console.log(`  ${candidate?.entry?.key || '(unknown)'} — asked ${candidate?.ask_count || 0}x, ${ageDays}d old${stale}`);
  }

  // ------------------------------------------- 5. possible transcript corruption
  // Memory rows naming a client where the surrounding wording reads like
  // ordinary speech rather than business. Reported only - deciding whether a
  // sentence was corrupted needs the owner's eye.
  const clientFirstNames = clientFirstNamesEarly;
  const PERSONAL_CONTEXT = /\b(love|loved|miss|missed|dream|dreamt|dreamed|kiss|hug|marry|married|date|dating|relationship|feel|felt|heart)\b/i;
  const suspectMemories = memories.filter(row => {
    const content = String(row.content || '');
    if (!PERSONAL_CONTEXT.test(content)) return false;
    return normalizeClientName(content).some(token => clientFirstNames.has(token));
  });

  heading(`5. Memory rows pairing a client name with personal language (${suspectMemories.length}) — REVIEW ONLY`);
  if (!suspectMemories.length) console.log('None found.');
  for (const row of suspectMemories) {
    const protectedRow = PROTECTED_MEMORY_KINDS.has(row.kind) || row.source === 'manual_repair';
    console.log(`  #${row.id} [${row.kind}/${row.source}]${protectedRow ? ' (protected)' : ''}`);
    console.log(`     ${String(row.content).slice(0, 160)}`);
  }
  if (suspectMemories.length) {
    console.log('\n  These are the likely survivors of the "I love you back" -> "I love you Jack"');
    console.log('  rewrite. Pass --delete-flagged with --apply to remove them, after reading each one.');
    console.log('  Rows marked (protected) are owner-authored and are never deleted by this script.');
  }

  // ------------------------------------------------------------------- apply
  const hasWork = mislabelled.length || fabricatedMemories.length || staleCandidates.length ||
    (DELETE_FLAGGED && suspectMemories.length);

  if (!APPLY) {
    heading('Summary');
    console.log(`Would repair: ${mislabelled.length} relationship label(s), ` +
      `${fabricatedMemories.length} memory row(s), ${staleCandidates.length} pending confirmation(s).`);
    console.log(`Review by hand: ${fusionRisk.length} name-collision record(s), ` +
      `${suspectMemories.length} possibly-corrupted memory row(s).`);
    console.log('\nRe-run with --apply to perform the repairs above.');
    return;
  }

  if (!hasWork) {
    console.log('\nNothing to repair.');
    return;
  }

  let backupFile;
  try {
    backupFile = writeBackup({
      created_at: new Date().toISOString(),
      owner_id: process.env.AURA_OWNER_ID,
      profile,
      memories
    });
  } catch (error) {
    console.error(`\nAborting: could not write backup (${error.message}).`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nBackup written: ${backupFile}`);

  if (mislabelled.length) {
    const repaired = mislabelled.map(({ entry }) => ({
      ...entry,
      relationship: 'client',
      updated_at: new Date().toISOString()
    }));
    await state.upsertOwnerProfileEntries(repaired);
    console.log(`Relabelled ${repaired.length} client record(s) as relationship=client.`);
  }

  for (const row of fabricatedMemories) {
    const rewritten = String(row.content).replace(
      /\bis the owner's known person\b/gi,
      'is a known contact'
    );
    const saved = await state.saveMemory(rewritten, {
      kind: row.kind,
      source: row.source,
      confidence: row.confidence
    });
    await state.supersedeMemory(row.id, saved.id);
    console.log(`Rewrote memory #${row.id} -> #${saved.id}`);
  }

  if (staleCandidates.length) {
    const keep = candidates.filter(candidate => !staleCandidates.includes(candidate));
    await state.setOwnerMemoryCandidates(keep);
    console.log(`Cleared ${staleCandidates.length} unresolvable pending confirmation(s).`);
  }

  if (DELETE_FLAGGED && suspectMemories.length) {
    for (const row of suspectMemories) {
      // Never destroy the owner's own authored material. Dream journals and
      // hand-repaired rows are exactly where a stray client name is most
      // likely to be either deliberate or already corrected, and they cannot
      // be regenerated. SOUL.md is explicit that dream content is quoted, not
      // corrected - so it is reviewed by hand, never swept.
      if (PROTECTED_MEMORY_KINDS.has(row.kind) || row.source === 'manual_repair') {
        console.log(`Kept memory #${row.id} (${row.kind}/${row.source}) — owner-authored, review by hand`);
        continue;
      }
      await state.forgetMemory(row.id);
      console.log(`Deleted memory #${row.id}`);
    }
  } else if (suspectMemories.length) {
    console.log(`Left ${suspectMemories.length} flagged memory row(s) in place (--delete-flagged not set).`);
  }

  console.log('\nDone. Restart AURA so the in-process memory caches reload.');
}

main().catch(error => {
  console.error('\nRepair failed:', error.message || error);
  process.exitCode = 1;
});
