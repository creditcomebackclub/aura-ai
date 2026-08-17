'use strict';

// Speech-to-text provider selection. OpenAI (gpt-4o-mini-transcribe / whisper-1)
// remains the fallback; Deepgram Nova-3 is preferred when configured — playground
// A/B showed clean MRR + client-name transcripts on nova-3.

const DEFAULT_DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_KEYTERMS = [
  'MRR',
  'AURA',
  'CCC',
  'Credit Comeback',
  'Phoenix',
  'outstanding balance',
  'client phase',
  // Nova-3 was misreading "back" as "Jack" ("the back way" -> "the Jack
  // way") - boosting the word it kept losing to a phonetically close one.
  'back',
  'back way'
];

function resolveSttProvider(env = process.env) {
  const explicit = String(env.AURA_STT_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'deepgram' || explicit === 'openai') return explicit;
  // No explicit choice: use Deepgram whenever a key is present.
  return env.DEEPGRAM_API_KEY ? 'deepgram' : 'openai';
}

function resolveDeepgramModel(env = process.env) {
  return env.AURA_DEEPGRAM_MODEL || DEFAULT_DEEPGRAM_MODEL;
}

function contentTypeForAudioPath(filePath) {
  const ext = String(require('path').extname(filePath) || '').toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.ogg' || ext === '.oga') return 'audio/ogg';
  return 'audio/webm';
}

function extractDeepgramTranscript(payload) {
  const alt = payload?.results?.channels?.[0]?.alternatives?.[0];
  const text = typeof alt?.transcript === 'string' ? alt.transcript.trim() : '';
  return text;
}

async function transcribeWithDeepgram(filePath, {
  apiKey = process.env.DEEPGRAM_API_KEY,
  model = resolveDeepgramModel(),
  fetchImpl = fetch,
  keyterms = DEEPGRAM_KEYTERMS
} = {}) {
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required for Deepgram transcription.');
  const fs = require('fs');
  const audio = fs.readFileSync(filePath);
  const params = new URLSearchParams({
    model,
    smart_format: 'true',
    punctuate: 'true',
    language: 'en'
  });
  for (const term of keyterms) {
    if (term) params.append('keyterm', term);
  }
  const response = await fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': contentTypeForAudioPath(filePath)
    },
    body: audio
  });
  const rawText = await response.text();
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error(`Deepgram returned non-JSON (${response.status}): ${rawText.slice(0, 200)}`);
  }
  if (!response.ok) {
    const message = payload?.err_msg || payload?.error || rawText.slice(0, 200);
    throw new Error(`Deepgram API error: ${response.status} - ${message}`);
  }
  return {
    text: extractDeepgramTranscript(payload),
    provider: 'deepgram',
    model,
    raw: payload
  };
}

module.exports = {
  DEFAULT_DEEPGRAM_MODEL,
  DEEPGRAM_KEYTERMS,
  resolveSttProvider,
  resolveDeepgramModel,
  contentTypeForAudioPath,
  extractDeepgramTranscript,
  transcribeWithDeepgram
};
