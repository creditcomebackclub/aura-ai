// Minimal WAV (RIFF/PCM) parsing and concatenation - just enough to stitch
// several Cartesia TTS responses back into one continuous clip. Properly
// walks RIFF subchunks to find 'fmt ' and 'data' rather than assuming a
// fixed 44-byte header, since a header a few bytes longer than canonical
// would otherwise silently corrupt the splice point.

function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE buffer.');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        numChannels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14)
      };
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataLength = chunkSize;
    }

    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error('WAV buffer is missing a fmt or data chunk.');
  return { ...fmt, dataOffset, dataLength };
}

function buildWavHeader(dataLength, { numChannels, sampleRate, bitsPerSample, audioFormat = 1 }) {
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

// Concatenates same-format WAV buffers, in order, into one WAV buffer.
// Throws if the buffers don't share a format - callers shouldn't hide that
// by e.g. resampling silently, since a mismatch means Cartesia's own output
// changed shape and the pipeline needs to be looked at, not papered over.
function concatWavBuffers(buffers) {
  if (!buffers.length) throw new Error('No WAV buffers to concatenate.');
  const parsed = buffers.map(parseWav);
  const [first] = parsed;
  for (const p of parsed.slice(1)) {
    if (p.numChannels !== first.numChannels || p.sampleRate !== first.sampleRate || p.bitsPerSample !== first.bitsPerSample) {
      throw new Error('WAV buffers have mismatched formats and cannot be concatenated.');
    }
  }
  const dataParts = buffers.map((buf, i) => buf.subarray(parsed[i].dataOffset, parsed[i].dataOffset + parsed[i].dataLength));
  const totalDataLength = dataParts.reduce((sum, part) => sum + part.length, 0);
  const header = buildWavHeader(totalDataLength, first);
  return Buffer.concat([header, ...dataParts]);
}

// Decimal points (e.g. "$79.50") look identical to a sentence-ending period
// to a naive splitter. They're protected by replacing the period with a
// code point that (a) cannot appear in normal reply text and (b) is not
// itself whitespace, so restoring it can't be confused with a real space -
// swapping in a plain space here would corrupt the rest of the sentence
// when restored, since every space would come back as a period.
const DECIMAL_POINT_SENTINEL = String.fromCodePoint(0xe000); // private-use-area code point

// Splits reply text into sentence-ish chunks for pipelined synthesis. Errs
// toward under-splitting (keeping an ambiguous case like "Dr. Smith" joined)
// rather than over-splitting, since a wrongly-split sentence just costs a
// little parallelism, while a wrongly-joined one is invisible to the
// listener - asymmetric risk, so protect-then-split is deliberately
// conservative rather than trying to enumerate every abbreviation.
function splitIntoSentences(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const protectedText = trimmed.replace(/(\d)\.(\d)/g, (match, before, after) => `${before}${DECIMAL_POINT_SENTINEL}${after}`);
  const parts = protectedText.split(/(?<=[.!?])\s+/);
  return parts
    .map(part => part.split(DECIMAL_POINT_SENTINEL).join('.').trim())
    .filter(Boolean);
}

// Early first-audio helper: if the model hasn't finished a sentence yet, still
// peel off a leading clause (comma/dash) or a ~6-word breath once more text
// has arrived after it. Same "keep the last piece" contract as
// splitIntoSentences — caller only emits parts.slice(0, -1).
function splitLeadingClause(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];

  // Non-greedy to the first clause mark. Require whitespace after the mark so
  // thousands separators like "$1,000" stay intact. Short openers ("Yeah,")
  // are intentionally allowed — they're the whole point of early first audio.
  const clause = trimmed.match(/^([\s\S]{2,}?[,;:—–])\s+(\S[\s\S]*)$/);
  if (clause) return [clause[1].trim(), clause[2]];

  // Breath group: at least six words, then more text still arriving.
  const breath = trimmed.match(/^((?:\S+\s+){5,}\S+)\s+(\S[\s\S]*)$/);
  if (breath && breath[1].length >= 36) {
    return [breath[1].trim(), breath[2]];
  }
  return [trimmed];
}

function splitSpeakable(text, { earlyClause = false } = {}) {
  const sentences = splitIntoSentences(text);
  if (!earlyClause || sentences.length !== 1) return sentences;
  return splitLeadingClause(sentences[0]);
}

// After emitting `chunk` from `full` starting at `start`, return the index
// just past the chunk (and any following whitespace) so the next drain can
// resume cleanly even when the first clip was a clause, not a sentence.
function advancePastEmitted(full, start, chunk) {
  const from = String(full || '').slice(start);
  const target = String(chunk || '');
  if (!target) return start;
  const idx = from.indexOf(target);
  let end = start + (idx >= 0 ? idx + target.length : target.length);
  while (end < full.length && /\s/.test(full[end])) end += 1;
  return end;
}

module.exports = {
  parseWav,
  buildWavHeader,
  concatWavBuffers,
  splitIntoSentences,
  splitSpeakable,
  splitLeadingClause,
  advancePastEmitted
};
