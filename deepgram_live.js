'use strict';

const { resolveDeepgramModel, DEEPGRAM_KEYTERMS } = require('./stt_provider');

const DEFAULT_ENDPOINTING_MS = 400;
const DEFAULT_UTTERANCE_END_MS = 1200;
const DEFAULT_SAMPLE_RATE = 16000;

function resolveDeepgramEndpointingMs(env = process.env) {
  const n = Number(env.AURA_DEEPGRAM_ENDPOINTING_MS);
  return Number.isFinite(n) && n >= 10 ? Math.trunc(n) : DEFAULT_ENDPOINTING_MS;
}

function resolveDeepgramUtteranceEndMs(env = process.env) {
  const n = Number(env.AURA_DEEPGRAM_UTTERANCE_END_MS);
  // Deepgram: values under 1000ms don't help much with interim cadence.
  return Number.isFinite(n) && n >= 1000 ? Math.trunc(n) : DEFAULT_UTTERANCE_END_MS;
}

function buildDeepgramLiveUrl(env = process.env) {
  const params = new URLSearchParams({
    model: resolveDeepgramModel(env),
    encoding: 'linear16',
    sample_rate: String(DEFAULT_SAMPLE_RATE),
    channels: '1',
    language: 'en',
    smart_format: 'true',
    interim_results: 'true',
    vad_events: 'true',
    endpointing: String(resolveDeepgramEndpointingMs(env)),
    utterance_end_ms: String(resolveDeepgramUtteranceEndMs(env))
  });
  for (const term of DEEPGRAM_KEYTERMS) {
    if (term) params.append('keyterm', term);
  }
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

function extractLiveTranscript(message) {
  const alt = message?.channel?.alternatives?.[0];
  const text = typeof alt?.transcript === 'string' ? alt.transcript.trim() : '';
  return text;
}

function classifyDeepgramLiveMessage(raw) {
  let message;
  try {
    message = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { kind: 'ignore' };
  }
  const type = message?.type;
  if (type === 'Results') {
    const transcript = extractLiveTranscript(message);
    return {
      kind: 'results',
      transcript,
      isFinal: message.is_final === true,
      speechFinal: message.speech_final === true,
      message
    };
  }
  if (type === 'UtteranceEnd') {
    return { kind: 'utterance_end', message };
  }
  if (type === 'SpeechStarted') {
    return { kind: 'speech_started', message };
  }
  if (type === 'Error') {
    return {
      kind: 'error',
      error: message.message || message.err_msg || 'Deepgram live error',
      message
    };
  }
  return { kind: 'ignore', message };
}

function deepgramStreamingAvailable(env = process.env) {
  return Boolean(env.DEEPGRAM_API_KEY) && resolveSttProviderSafe(env) === 'deepgram';
}

function resolveSttProviderSafe(env) {
  const { resolveSttProvider } = require('./stt_provider');
  return resolveSttProvider(env);
}

module.exports = {
  DEFAULT_ENDPOINTING_MS,
  DEFAULT_UTTERANCE_END_MS,
  DEFAULT_SAMPLE_RATE,
  resolveDeepgramEndpointingMs,
  resolveDeepgramUtteranceEndMs,
  buildDeepgramLiveUrl,
  extractLiveTranscript,
  classifyDeepgramLiveMessage,
  deepgramStreamingAvailable
};
