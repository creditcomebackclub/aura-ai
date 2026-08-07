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

// Keeps the first complete sentence (or early clause) fast, then groups later
// sentences into larger connected TTS performances. Tiny 2-sentence clips were
// resetting Cartesia prosody too often and sounded chopped on the phone.
function createSpeechChunkAccumulator(onChunk, {
  maxSentences = 5,
  maxChars = 720
} = {}) {
  const emit = typeof onChunk === 'function' ? onChunk : null;
  const sentenceLimit = Math.max(1, Math.trunc(Number(maxSentences)) || 5);
  const charLimit = Math.max(80, Math.trunc(Number(maxChars)) || 720);
  let emittedFirst = false;
  let pending = [];

  function flush() {
    if (!pending.length) return null;
    const chunk = pending.join(' ');
    pending = [];
    if (emit) emit(chunk);
    return chunk;
  }

  return {
    add(sentence) {
      const text = String(sentence || '').trim();
      if (!text) return null;
      if (!emittedFirst) {
        emittedFirst = true;
        if (emit) emit(text);
        return text;
      }
      pending.push(text);
      if (pending.length >= sentenceLimit || pending.join(' ').length >= charLimit) {
        return flush();
      }
      return null;
    },
    flush,
    pendingCount() {
      return pending.length;
    },
    hasEmitted() {
      return emittedFirst;
    }
  };
}

// When the first sentence is still streaming and already long, emit a clause
// so Cartesia can start while the model finishes the thought. Returns null
// when the normal sentence splitter should handle it instead.
function extractEarlySpeakable(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length < 64) return null;
  // A finished sentence is present — let splitIntoSentences own it.
  if (/[.!?]["')\]]?(?:\s|$)/.test(trimmed)) return null;
  const clause = trimmed.match(/^([\s\S]{48,160}?)([,;—–])\s+/);
  if (clause) return `${clause[1]}${clause[2]}`;
  if (trimmed.length >= 110) {
    const slice = trimmed.slice(0, 100);
    const breakAt = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(','));
    if (breakAt > 40) return slice.slice(0, breakAt).trim();
  }
  return null;
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

// Last-line defense for Cartesia: even if the model slips markdown into a
// reply, strip the syntax that TTS would otherwise read aloud as "asterisk
// asterisk From colon". Keeps prose; does not try to rewrite meaning.
function sanitizeSpokenText(text) {
  let value = String(text || '');
  if (!value.trim()) return '';

  value = value.replace(/\r\n/g, '\n');
  // Fenced code blocks → plain inner text
  value = value.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, body) => body.trim());
  // Links [label](url) → label
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  // Bold / italic markers
  value = value.replace(/\*\*([^*]+)\*\*/g, '$1');
  value = value.replace(/__([^_]+)__/g, '$1');
  value = value.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1');
  value = value.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '$1');
  value = value.replace(/`([^`]+)`/g, '$1');
  // Headings / quote markers at line start
  value = value.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  value = value.replace(/^\s{0,3}>\s?/gm, '');
  // Bullets and numbered lists → spoken clauses
  value = value.replace(/^\s*[-*+]\s+/gm, '');
  value = value.replace(/^\s*\d+[.)]\s+/gm, '');
  // Collapse leftover emphasis debris and whitespace
  value = value.replace(/^\s*[*_]{1,3}\s*$/gm, '');
  value = value.replace(/[ \t]+\n/g, '\n');
  value = value.replace(/\n{3,}/g, '\n\n');
  value = value.replace(/[ \t]{2,}/g, ' ');
  return value.trim();
}

module.exports = {
  parseWav,
  buildWavHeader,
  concatWavBuffers,
  splitIntoSentences,
  createSpeechChunkAccumulator,
  extractEarlySpeakable,
  advancePastEmitted,
  sanitizeSpokenText
};
