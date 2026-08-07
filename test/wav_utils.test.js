const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWav,
  buildWavHeader,
  concatWavBuffers,
  splitIntoSentences,
  createSpeechChunkAccumulator,
  advancePastEmitted,
  sanitizeSpokenText
} = require('../wav_utils');

function makeWav({ numChannels = 1, sampleRate = 44100, bitsPerSample = 16, samples = [] } = {}) {
  const dataLength = samples.length * (bitsPerSample / 8);
  const header = buildWavHeader(dataLength, { numChannels, sampleRate, bitsPerSample });
  const data = Buffer.alloc(dataLength);
  samples.forEach((value, i) => data.writeInt16LE(value, i * 2));
  return Buffer.concat([header, data]);
}

test('parseWav reads a canonical PCM WAV header correctly', () => {
  const wav = makeWav({ samples: [1, 2, 3, 4] });
  const parsed = parseWav(wav);
  assert.equal(parsed.numChannels, 1);
  assert.equal(parsed.sampleRate, 44100);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.dataLength, 8);
  assert.equal(parsed.dataOffset, 44);
});

test('parseWav rejects a non-WAV buffer', () => {
  assert.throws(() => parseWav(Buffer.from('not a wav file at all')));
});

test('concatWavBuffers stitches same-format clips into one, preserving sample order', () => {
  const a = makeWav({ samples: [1, 2, 3] });
  const b = makeWav({ samples: [4, 5] });
  const combined = concatWavBuffers([a, b]);
  const parsed = parseWav(combined);
  assert.equal(parsed.dataLength, 10); // 5 samples * 2 bytes
  const pcm = combined.subarray(parsed.dataOffset, parsed.dataOffset + parsed.dataLength);
  const values = [];
  for (let i = 0; i < pcm.length; i += 2) values.push(pcm.readInt16LE(i));
  assert.deepEqual(values, [1, 2, 3, 4, 5]);
});

test('concatWavBuffers refuses to silently combine mismatched formats', () => {
  const a = makeWav({ samples: [1], sampleRate: 44100 });
  const b = makeWav({ samples: [2], sampleRate: 22050 });
  assert.throws(() => concatWavBuffers([a, b]), /mismatched formats/);
});

test('concatWavBuffers of a single buffer round-trips it losslessly', () => {
  const a = makeWav({ samples: [10, 20, 30] });
  const combined = concatWavBuffers([a]);
  const parsed = parseWav(combined);
  assert.equal(parsed.dataLength, 6);
});

test('splitIntoSentences splits on real sentence boundaries', () => {
  const result = splitIntoSentences('First sentence. Second sentence! Third one?');
  assert.deepEqual(result, ['First sentence.', 'Second sentence!', 'Third one?']);
});

test('splitIntoSentences does not split on a decimal number', () => {
  const result = splitIntoSentences('The balance is $79.50 due today.');
  assert.equal(result.length, 1);
  assert.equal(result[0], 'The balance is $79.50 due today.');
});

test('splitIntoSentences handles a single short reply as one chunk', () => {
  const result = splitIntoSentences('Sent.');
  assert.deepEqual(result, ['Sent.']);
});

test('splitIntoSentences handles empty/whitespace input without throwing', () => {
  assert.deepEqual(splitIntoSentences(''), []);
  assert.deepEqual(splitIntoSentences('   '), []);
});

test('speech chunking emits one complete opening sentence, never a leading fragment', () => {
  const emitted = [];
  const chunks = createSpeechChunkAccumulator(text => emitted.push(text));
  chunks.add('Yeah, I checked the calendar for Monday.');
  assert.deepEqual(emitted, ['Yeah, I checked the calendar for Monday.']);
  assert.equal(emitted.includes('Yeah,'), false);
});

test('speech chunking keeps later sentences in a larger connected group', () => {
  const emitted = [];
  const chunks = createSpeechChunkAccumulator(text => emitted.push(text));
  chunks.add('The first sentence starts quickly.');
  chunks.add('Two.');
  chunks.add('Three.');
  chunks.add('Four.');
  chunks.add('Five.');
  assert.deepEqual(emitted, ['The first sentence starts quickly.']);
  chunks.add('Six completes the five-sentence group.');
  assert.deepEqual(emitted, [
    'The first sentence starts quickly.',
    'Two. Three. Four. Five. Six completes the five-sentence group.'
  ]);
});

test('extractEarlySpeakable emits a clause before the first period on long openings', () => {
  const { extractEarlySpeakable } = require('../wav_utils');
  assert.equal(extractEarlySpeakable('Short opener'), null);
  assert.equal(
    extractEarlySpeakable('Yeah, I pulled the ledger for the last thirty days and'),
    null
  );
  const early = extractEarlySpeakable(
    'Yeah, I pulled the ledger for the last thirty days, and the outstanding balance is still coming in'
  );
  assert.match(early, /thirty days,/);
  assert.equal(extractEarlySpeakable('MRR is five ninety-four.'), null);
});

test('speech chunking flushes a final unpaired sentence', () => {
  const emitted = [];
  const chunks = createSpeechChunkAccumulator(text => emitted.push(text));
  chunks.add('First.');
  chunks.add('Last.');
  assert.equal(chunks.pendingCount(), 1);
  chunks.flush();
  assert.deepEqual(emitted, ['First.', 'Last.']);
});

test('advancePastEmitted skips the chunk and following whitespace', () => {
  const full = 'Yeah, I checked Monday.';
  const next = advancePastEmitted(full, 0, 'Yeah,');
  assert.equal(full.slice(next), 'I checked Monday.');
});

test('sanitizeSpokenText strips markdown that TTS would read aloud', () => {
  const raw = [
    'Here are the last three emails:',
    '',
    '1. **From:** LinkedIn',
    '   **Subject:** people viewed your profile',
    '',
    '- Chess.com streak reminder',
    '',
    'If you need anything else, just let me know!'
  ].join('\n');
  const spoken = sanitizeSpokenText(raw);
  assert.doesNotMatch(spoken, /\*\*/);
  assert.doesNotMatch(spoken, /^\s*1\.\s/m);
  assert.doesNotMatch(spoken, /^\s*-\s/m);
  assert.match(spoken, /LinkedIn/);
  assert.match(spoken, /Chess\.com streak reminder/);
});
