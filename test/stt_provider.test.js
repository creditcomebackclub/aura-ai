'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveSttProvider,
  resolveDeepgramModel,
  contentTypeForAudioPath,
  extractDeepgramTranscript,
  transcribeWithDeepgram
} = require('../stt_provider');

test('resolveSttProvider prefers explicit override, else Deepgram when keyed', () => {
  assert.equal(resolveSttProvider({}), 'openai');
  assert.equal(resolveSttProvider({ DEEPGRAM_API_KEY: 'dg' }), 'deepgram');
  assert.equal(resolveSttProvider({ AURA_STT_PROVIDER: 'openai', DEEPGRAM_API_KEY: 'dg' }), 'openai');
  assert.equal(resolveSttProvider({ AURA_STT_PROVIDER: 'deepgram' }), 'deepgram');
});

test('resolveDeepgramModel defaults to nova-3', () => {
  assert.equal(resolveDeepgramModel({}), 'nova-3');
  assert.equal(resolveDeepgramModel({ AURA_DEEPGRAM_MODEL: 'nova-2' }), 'nova-2');
});

test('contentTypeForAudioPath maps common extensions', () => {
  assert.equal(contentTypeForAudioPath('a.webm'), 'audio/webm');
  assert.equal(contentTypeForAudioPath('a.m4a'), 'audio/mp4');
  assert.equal(contentTypeForAudioPath('a.wav'), 'audio/wav');
});

test('extractDeepgramTranscript reads the primary alternative', () => {
  assert.equal(
    extractDeepgramTranscript({
      results: { channels: [{ alternatives: [{ transcript: '  What is my MRR?  ' }] }] }
    }),
    'What is my MRR?'
  );
  assert.equal(extractDeepgramTranscript({}), '');
});

test('transcribeWithDeepgram posts audio and returns nova-3 text', async () => {
  const tmp = path.join(os.tmpdir(), `aura-dg-${Date.now()}.webm`);
  fs.writeFileSync(tmp, Buffer.from('fake-audio'));
  let sawUrl = '';
  let sawAuth = '';
  let sawKeyterms = [];
  try {
    const result = await transcribeWithDeepgram(tmp, {
      apiKey: 'test-key',
      model: 'nova-3',
      fetchImpl: async (url, options) => {
        sawUrl = String(url);
        sawAuth = options.headers.Authorization;
        const u = new URL(url);
        sawKeyterms = u.searchParams.getAll('keyterm');
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              results: {
                channels: [{ alternatives: [{ transcript: "What's my MRR?" }] }]
              }
            });
          }
        };
      }
    });
    assert.equal(result.text, "What's my MRR?");
    assert.equal(result.provider, 'deepgram');
    assert.equal(result.model, 'nova-3');
    assert.match(sawUrl, /api\.deepgram\.com\/v1\/listen/);
    assert.match(sawUrl, /model=nova-3/);
    assert.equal(sawAuth, 'Token test-key');
    assert.ok(sawKeyterms.includes('MRR'));
  } finally {
    fs.unlinkSync(tmp);
  }
});
