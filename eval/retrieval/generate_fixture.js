'use strict';

// Deterministic fixture authoring helper. The committed JSON files are what the
// benchmark consumes; this only makes their synthetic provenance reproducible.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname);
const stamp = (days) => new Date(Date.UTC(2026, 8, 1, 12) - days * 86400000).toISOString();
const corpus = [];
const add = (id, content, kind = 'fact', confidence = 0.85, age = 30, updatedAge = age) => {
  corpus.push({ id, content, kind, confidence, created_at: stamp(age + 5), updated_at: stamp(updatedAge) });
};

const targets = [
  ['pref-quiet-brief', 'The owner prefers the morning brief as three concise bullets with no motivational introduction.', 'preference'],
  ['pref-calendar-buffer', 'The owner prefers a fifteen minute buffer before every client call.', 'preference'],
  ['person-mira-voss', 'Mira Voss is the fictional operations lead at Northstar Credit Works and owns dispute packet review.', 'fact'],
  ['person-teo-larkin', 'Teo Larkin is the fictional bookkeeping advisor who reconciles invoice adjustments on Fridays.', 'fact'],
  ['client-orion-phase', 'Fictional client Orion Vale is in the bureau-response review phase after Experian acknowledged packet ZX-4821.', 'episode'],
  ['client-lyra-phase', 'Fictional client Lyra Quill is waiting for identity documents before the first dispute packet can be mailed.', 'episode'],
  ['client-lyra-code', 'Lyra Quill case code QV-7719 is attached to the Equifax address correction workflow.', 'fact'],
  ['client-cedar-payment', 'Fictional client Cedar Rowan scheduled a $129 payment for the 18th after a missed installment.', 'episode'],
  ['course-aster-deadline', 'ASTR-204 fictional coursework: submit the orbital mechanics lab by September 18 at 5 PM.', 'fact'],
  ['course-nova-reading', 'For the fictional NOVA-310 seminar, read the memory-systems chapter before the Wednesday discussion.', 'fact'],
  ['meeting-harbor', 'The fictional Harbor Lantern meeting is Tuesday at 10 AM to review weekly dispute response counts.', 'episode'],
  ['meeting-kestrel', 'Schedule the fictional Kestrel planning session for Thursday at 2 PM with Mira Voss.', 'episode'],
  ['episode-packet-zx', 'Experian acknowledged fictional dispute packet ZX-4821 for Orion Vale; the next step is to wait for its response.', 'episode'],
  ['episode-followup', 'During the fictional Friday review, Teo Larkin asked for the aged-invoice ledger before noon.', 'episode'],
  ['belief-followthrough', 'The owner believes client updates should explain the next concrete step rather than only report a bureau status.', 'belief'],
  ['belief-focus', 'The owner believes afternoon meetings should be grouped to protect a long morning focus block.', 'belief'],
  ['org-northstar', 'Northstar Credit Works is a fictional credit-repair practice with a Tuesday operations review.', 'fact'],
  ['org-ember', 'Ember Ledger is a fictional bookkeeping vendor used only for invoice reconciliation.', 'fact'],
  ['code-aurora', 'Fictional workflow code AUR-9042 means request a fresh proof-of-address document before a dispute.', 'fact'],
  ['code-lumen', 'Fictional workflow code LUM-1138 marks a duplicate collection account that needs a documentation checklist.', 'fact'],
  ['temporal-old-orion', 'Earlier fictional Orion Vale update: the dispute packet was being assembled for Experian.', 'episode', 0.77, 80, 80],
  ['temporal-new-orion', 'Latest fictional Orion Vale update: Experian acknowledged packet ZX-4821 and the case is in response review.', 'episode', 0.9, 3, 2],
  ['temporal-old-brief', 'Earlier preference note: the owner liked a detailed morning brief with ten sections.', 'preference', 0.6, 150, 150],
  ['temporal-new-brief', 'Current preference note: the owner wants exactly three concise morning-brief bullets.', 'preference', 0.92, 5, 1]
];
for (const [id, content, kind, confidence, age, updatedAge] of targets) add(id, content, kind, confidence, age, updatedAge);

// Purposeful near-duplicates and recent high-confidence false friends.
const distractors = [
  ['dist-orion-invoice', 'Orion Vale invoice status is current; this is unrelated to the Experian dispute response.', 'episode'],
  ['dist-mira-social', 'Mira Voss chose coffee for the fictional Northstar office social, not a packet review decision.', 'episode'],
  ['dist-lyra-calendar', 'Lyra Quill was invited to a fictional calendar planning call; this is not a document request.', 'episode'],
  ['dist-zx-training', 'The training exercise ZX-4821 explains how to label mock folders and is not a client packet.', 'fact'],
  ['dist-aster-meeting', 'ASTR-204 study group meets September 18, but no assignment is due in this note.', 'episode'],
  ['dist-harbor-invoice', 'Harbor Lantern reviewed invoice colors, not dispute response counts.', 'episode'],
  ['dist-quiet-office', 'The Northstar office is quiet before noon; this is unrelated to morning brief formatting.', 'fact'],
  ['dist-aurora-brand', 'Aurora is a fictional paint color used in the office, unrelated to workflow code AUR-9042.', 'fact'],
  ['dist-recent-unrelated', 'A recent high-confidence note: the fictional greenhouse thermostat was set to 71 degrees.', 'fact'],
  ['dist-lumen-lamp', 'The Lumen desk lamp warranty was filed; it is unrelated to collection accounts.', 'fact']
];
for (const [id, content, kind] of distractors) add(id, content, kind, 0.99, 1, 0);

const fillerSubjects = ['Alder Finch', 'Bramble Knox', 'Cobalt Wren', 'Dune Sable', 'Elara Pike', 'Fable Moss', 'Garnet Vale', 'Hollow Reed', 'Indigo Crane', 'Juniper Slate', 'Kepler Ash', 'Lark Ember', 'Marrow Finch', 'Nimble Frost', 'Opal Grove', 'Piper North', 'Quartz Bloom', 'Raven Sol', 'Sable Hart', 'Tundra Bell', 'Umber Fox', 'Vesper Rain', 'Willow Crest', 'Xylo Fern', 'Yarrow Lake', 'Zephyr Stone'];
const fillerTopics = ['document checklist', 'invoice follow-up', 'bureau timeline', 'course note', 'calendar hold', 'status summary'];
for (let i = 0; corpus.length < 180; i++) {
  const name = fillerSubjects[i % fillerSubjects.length];
  const topic = fillerTopics[i % fillerTopics.length];
  add(`filler-${String(i + 1).padStart(3, '0')}`, `Fictional ${name} ${topic}: record ${String(4100 + i)} was reviewed during the routine weekly workflow.`, i % 5 === 0 ? 'episode' : 'fact', 0.55 + (i % 40) / 100, 20 + i, 20 + i);
}

const queries = [];
const q = (id, query, split, category, relevant, extra = {}) => queries.push({ id, query, split, category, relevant, ...extra });
// Labels below are authored from the fixture semantics, before retrieval is run.
q('para-01', 'How should the daily update be formatted?', 'dev', 'paraphrase', { 'pref-quiet-brief': 2 });
q('para-02', 'When should we leave space around a customer call?', 'dev', 'paraphrase', { 'pref-calendar-buffer': 2 });
q('para-03', 'Who handles review of challenge packets?', 'dev', 'paraphrase', { 'person-mira-voss': 2 });
q('para-04', 'What is the next stage after the bureau has received Orion paperwork?', 'dev', 'paraphrase', { 'client-orion-phase': 2, 'episode-packet-zx': 1 });
q('para-05', 'What task must happen before mailing Lyra paperwork?', 'dev', 'paraphrase', { 'client-lyra-phase': 2 });
q('para-06', 'Which study deliverable is due in mid September?', 'test', 'paraphrase', { 'course-aster-deadline': 2 });
q('para-07', 'What should client status messages emphasize?', 'test', 'paraphrase', { 'belief-followthrough': 2 });
q('para-08', 'How should the workday protect concentrated work?', 'test', 'paraphrase', { 'belief-focus': 2 });
q('para-09', 'What is the next action on the acknowledged Orion case?', 'test', 'paraphrase', { 'episode-packet-zx': 2, 'client-orion-phase': 1 });
q('para-10', 'Which financial record did Teo request?', 'test', 'paraphrase', { 'episode-followup': 2 });
q('para-11', 'What happens with a missed Cedar installment?', 'test', 'paraphrase', { 'client-cedar-payment': 2 });
q('para-12', 'What preparation is needed for a duplicate collection?', 'test', 'paraphrase', { 'code-lumen': 2 });
q('term-01', 'What does ZX-4821 refer to?', 'dev', 'exact_term', { 'episode-packet-zx': 2, 'client-orion-phase': 1 });
q('term-02', 'Find QV-7719.', 'dev', 'exact_term', { 'client-lyra-code': 2 });
q('term-03', 'Explain AUR-9042.', 'dev', 'exact_term', { 'code-aurora': 2 });
q('term-04', 'Explain LUM-1138.', 'dev', 'exact_term', { 'code-lumen': 2 });
q('term-05', 'What is ASTR-204 due date?', 'dev', 'exact_term', { 'course-aster-deadline': 2 });
q('term-06', 'What should I read for NOVA-310?', 'test', 'exact_term', { 'course-nova-reading': 2 });
q('term-07', 'What is the Harbor Lantern agenda?', 'test', 'exact_term', { 'meeting-harbor': 2 });
q('term-08', 'What is Ember Ledger used for?', 'test', 'exact_term', { 'org-ember': 2 });
q('term-09', 'What does Northstar Credit Works do?', 'test', 'exact_term', { 'org-northstar': 2 });
q('term-10', 'What is Kestrel planning?', 'test', 'exact_term', { 'meeting-kestrel': 2 });
q('term-11', 'Which case has code QV-7719?', 'test', 'exact_term', { 'client-lyra-code': 2 });
q('term-12', 'Which packet is ZX-4821?', 'test', 'exact_term', { 'episode-packet-zx': 2 });
q('entity-01', 'What does Mira Voss own?', 'dev', 'named_entity', { 'person-mira-voss': 2 });
q('entity-02', 'What is Teo Larkin responsible for?', 'dev', 'named_entity', { 'person-teo-larkin': 2 });
q('entity-03', 'What is Orion Vale doing now?', 'dev', 'named_entity', { 'temporal-new-orion': 2, 'client-orion-phase': 1 });
q('entity-04', 'What document does Lyra Quill need?', 'dev', 'named_entity', { 'client-lyra-phase': 2 });
q('entity-05', 'What did Cedar Rowan schedule?', 'dev', 'named_entity', { 'client-cedar-payment': 2 });
q('entity-06', 'When is the Kestrel session with Mira Voss?', 'test', 'named_entity', { 'meeting-kestrel': 2 });
q('entity-07', 'What is Northstar Credit Works?', 'test', 'named_entity', { 'org-northstar': 2 });
q('entity-08', 'Who asked for the aged-invoice ledger?', 'test', 'named_entity', { 'episode-followup': 2 });
q('entity-09', 'What was Orion Vale waiting for?', 'test', 'named_entity', { 'episode-packet-zx': 2 });
q('entity-10', 'What workflow is tied to Lyra Quill?', 'test', 'named_entity', { 'client-lyra-code': 2 });
q('entity-11', 'What does Mira Voss review?', 'test', 'named_entity', { 'person-mira-voss': 2 });
q('entity-12', 'What is Teo Larkin’s Friday task?', 'test', 'named_entity', { 'person-teo-larkin': 2 });
q('spoken-01', 'Mira um what does she handle', 'dev', 'spoken', { 'person-mira-voss': 2 });
q('spoken-02', 'Orion hey whats the latest on him', 'dev', 'spoken', { 'temporal-new-orion': 2, 'client-orion-phase': 1 });
q('spoken-03', 'Lyra uh what papers are we waiting on', 'dev', 'spoken', { 'client-lyra-phase': 2 });
q('spoken-04', 'Teo can you remind me what he checks', 'dev', 'spoken', { 'person-teo-larkin': 2 });
q('spoken-05', 'Harbor so what are we reviewing', 'dev', 'spoken', { 'meeting-harbor': 2 });
q('spoken-06', 'AUR-9042 wait what is that', 'test', 'spoken', { 'code-aurora': 2 });
q('spoken-07', 'Cedar what payment did they plan', 'test', 'spoken', { 'client-cedar-payment': 2 });
q('spoken-08', 'Kestrel when is that planning thing', 'test', 'spoken', { 'meeting-kestrel': 2 });
q('spoken-09', 'Northstar hey what kind of place is it', 'test', 'spoken', { 'org-northstar': 2 });
q('spoken-10', 'NOVA what am i supposed to read', 'test', 'spoken', { 'course-nova-reading': 2 });
q('spoken-11', 'Lumen uh whats the checklist for', 'test', 'spoken', { 'code-lumen': 2 });
q('spoken-12', 'Orion did experian already get it', 'test', 'spoken', { 'episode-packet-zx': 2 });
q('time-01', 'What is the current Orion Vale status?', 'dev', 'temporal', { 'temporal-new-orion': 2, 'client-orion-phase': 1 });
q('time-02', 'How should the morning brief be formatted now?', 'dev', 'temporal', { 'temporal-new-brief': 2, 'pref-quiet-brief': 1 });
q('time-03', 'Which Orion update is newest?', 'dev', 'temporal', { 'temporal-new-orion': 2 });
q('time-04', 'What is the latest brief preference?', 'dev', 'temporal', { 'temporal-new-brief': 2 });
q('time-05', 'Where is Orion in the workflow today?', 'dev', 'temporal', { 'temporal-new-orion': 2, 'client-orion-phase': 1 });
q('time-06', 'What is the newest report about the daily brief?', 'test', 'temporal', { 'temporal-new-brief': 2 });
q('time-07', 'Has Orion moved beyond packet assembly?', 'test', 'temporal', { 'temporal-new-orion': 2 });
q('time-08', 'What is the current three-bullet preference?', 'test', 'temporal', { 'temporal-new-brief': 2, 'pref-quiet-brief': 1 });
q('time-09', 'What happened after Experian received Orion material?', 'test', 'temporal', { 'temporal-new-orion': 2, 'episode-packet-zx': 1 });
q('time-10', 'Which update supersedes Orion assembly?', 'test', 'temporal', { 'temporal-new-orion': 2 });
q('time-11', 'What does the owner want in the brief now?', 'test', 'temporal', { 'temporal-new-brief': 2 });
q('time-12', 'What is Orion’s latest bureau step?', 'test', 'temporal', { 'temporal-new-orion': 2 });
q('dist-01', 'What is the status of Orion Vale’s Experian dispute?', 'dev', 'distractor', { 'client-orion-phase': 2, 'episode-packet-zx': 1 }, { distractor_id: 'dist-orion-invoice' });
q('dist-02', 'What review does Mira Voss lead?', 'dev', 'distractor', { 'person-mira-voss': 2 }, { distractor_id: 'dist-mira-social' });
q('dist-03', 'What does Lyra need before her first packet?', 'dev', 'distractor', { 'client-lyra-phase': 2 }, { distractor_id: 'dist-lyra-calendar' });
q('dist-04', 'What occurred for packet ZX-4821?', 'dev', 'distractor', { 'episode-packet-zx': 2 }, { distractor_id: 'dist-zx-training' });
q('dist-05', 'When is the orbital mechanics lab due?', 'dev', 'distractor', { 'course-aster-deadline': 2 }, { distractor_id: 'dist-aster-meeting' });
q('dist-06', 'What will Harbor Lantern review?', 'test', 'distractor', { 'meeting-harbor': 2 }, { distractor_id: 'dist-harbor-invoice' });
q('dist-07', 'How many bullets should the morning brief have?', 'test', 'distractor', { 'pref-quiet-brief': 2, 'temporal-new-brief': 1 }, { distractor_id: 'dist-quiet-office' });
q('dist-08', 'What must happen for AUR-9042?', 'test', 'distractor', { 'code-aurora': 2 }, { distractor_id: 'dist-aurora-brand' });
q('dist-09', 'Which record needs a documentation checklist?', 'test', 'distractor', { 'code-lumen': 2 }, { distractor_id: 'dist-lumen-lamp' });
q('dist-10', 'What is Lyra’s case code?', 'test', 'distractor', { 'client-lyra-code': 2 }, { distractor_id: 'dist-recent-unrelated' });
q('dist-11', 'What did Teo request Friday?', 'test', 'distractor', { 'episode-followup': 2 }, { distractor_id: 'dist-recent-unrelated' });
q('dist-12', 'What payment did Cedar schedule?', 'test', 'distractor', { 'client-cedar-payment': 2 }, { distractor_id: 'dist-recent-unrelated' });
q('none-01', 'What color is the fictional greenhouse thermostat?', 'dev', 'no_answer', {});
q('none-02', 'Who won the imaginary comet race?', 'dev', 'no_answer', {});
q('none-03', 'What is the recipe for lunar soup?', 'dev', 'no_answer', {});
q('none-04', 'Where is the underwater observatory?', 'dev', 'no_answer', {});
q('none-05', 'What was the dragon’s library password?', 'dev', 'no_answer', {});
q('none-06', 'When does the fictional airship depart?', 'test', 'no_answer', {});
q('none-07', 'What habitat does the Altair nebula have?', 'test', 'no_answer', {});
q('none-08', 'Which chef invented cloud bread?', 'test', 'no_answer', {});
q('none-09', 'What is the moon garden watering schedule?', 'test', 'no_answer', {});
q('none-10', 'How many wings has the imaginary museum?', 'test', 'no_answer', {});
q('none-11', 'What language do paper whales speak?', 'test', 'no_answer', {});
q('none-12', 'Who repairs the fictional time telescope?', 'test', 'no_answer', {});

fs.writeFileSync(path.join(out, 'corpus.json'), `${JSON.stringify(corpus, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'queries.json'), `${JSON.stringify(queries, null, 2)}\n`);
console.log(`Wrote ${corpus.length} memories and ${queries.length} queries.`);
