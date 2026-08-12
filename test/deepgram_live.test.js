'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDeepgramLiveUrl,
  classifyDeepgramLiveMessage,
  resolveDeepgramEndpointingMs,
  resolveDeepgramUtteranceEndMs,
  deepgramStreamingAvailable,
  extractLiveTranscript
} = require('../deepgram_live');

test('Deepgram live URL includes nova-3 streaming + endpointing knobs', () => {
  const url = buildDeepgramLiveUrl({
    AURA_DEEPGRAM_MODEL: 'nova-3',
    AURA_DEEPGRAM_ENDPOINTING_MS: '400',
    AURA_DEEPGRAM_UTTERANCE_END_MS: '1000'
  });
  assert.match(url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.match(url, /model=nova-3/);
  assert.match(url, /encoding=linear16/);
  assert.match(url, /sample_rate=16000/);
  assert.match(url, /interim_results=true/);
  assert.match(url, /endpointing=400/);
  assert.match(url, /utterance_end_ms=1000/);
  assert.match(url, /keyterm=MRR/);
});

test('endpointing defaults and clamps', () => {
  assert.equal(resolveDeepgramEndpointingMs({}), 400);
  assert.equal(resolveDeepgramUtteranceEndMs({}), 1800);
  assert.equal(resolveDeepgramUtteranceEndMs({ AURA_DEEPGRAM_UTTERANCE_END_MS: '500' }), 1800);
});

test('classifyDeepgramLiveMessage maps Results / UtteranceEnd / Error', () => {
  const interim = classifyDeepgramLiveMessage(JSON.stringify({
    type: 'Results',
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'what is my' }] }
  }));
  assert.equal(interim.kind, 'results');
  assert.equal(interim.transcript, 'what is my');
  assert.equal(interim.isFinal, false);

  const finalSpeech = classifyDeepgramLiveMessage(JSON.stringify({
    type: 'Results',
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: 'MRR' }] }
  }));
  assert.equal(finalSpeech.speechFinal, true);
  assert.equal(finalSpeech.transcript, 'MRR');

  assert.equal(classifyDeepgramLiveMessage(JSON.stringify({ type: 'UtteranceEnd' })).kind, 'utterance_end');
  assert.equal(
    classifyDeepgramLiveMessage(JSON.stringify({ type: 'Error', message: 'nope' })).error,
    'nope'
  );
});

test('extractLiveTranscript reads channel alternatives', () => {
  assert.equal(
    extractLiveTranscript({ channel: { alternatives: [{ transcript: '  hi  ' }] } }),
    'hi'
  );
});

test('deepgramStreamingAvailable requires key + deepgram provider', () => {
  assert.equal(deepgramStreamingAvailable({}), false);
  assert.equal(deepgramStreamingAvailable({ DEEPGRAM_API_KEY: 'x' }), true);
  assert.equal(
    deepgramStreamingAvailable({ DEEPGRAM_API_KEY: 'x', AURA_STT_PROVIDER: 'openai' }),
    false
  );
});
