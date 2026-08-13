'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeAudioFrame,
  buildProcessedAudioConstraints,
  createAdaptiveVad
} = require('../public/audio_vad');

const SAMPLE_RATE = 16000;

function tone(frequency, amplitude, length = 640) {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = amplitude * Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE);
  }
  return samples;
}

test('processed microphone constraints enable browser cleanup before VAD', () => {
  assert.deepEqual(buildProcessedAudioConstraints({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceIsolation: true
  }), {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    voiceIsolation: true
  });
  assert.equal(
    buildProcessedAudioConstraints({ autoGainControl: false }).autoGainControl,
    undefined
  );
});

test('frame analysis scores sustained speech shape but rejects a keyboard-like impulse', () => {
  const speech = analyzeAudioFrame(tone(180, 0.06), 0.003);
  assert.ok(speech.confidence >= 0.7, `speech confidence was ${speech.confidence}`);

  const click = new Float32Array(640);
  click[320] = 0.9;
  const impulse = analyzeAudioFrame(click, 0.003);
  assert.ok(impulse.confidence < 0.3, `impulse confidence was ${impulse.confidence}`);
});

test('adaptive VAD calibrates, requires 220ms of confidence, and uses hysteresis', () => {
  const vad = createAdaptiveVad();
  let now = 0;
  let decision;
  for (; now < 680; now += 40) {
    decision = vad.process(tone(60, 0.002), now, { sampleRate: SAMPLE_RATE });
  }
  assert.notEqual(decision.event, 'speech_start');

  for (let frame = 0; frame < 5; frame += 1, now += 40) {
    decision = vad.process(tone(180, 0.06), now, { sampleRate: SAMPLE_RATE });
    assert.notEqual(decision.event, 'speech_start');
  }
  decision = vad.process(tone(180, 0.06), now, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'speech_start');

  // Below the start floor, but above the lower keep-open threshold.
  now += 40;
  decision = vad.process(tone(180, 0.012), now, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'speech');
  assert.equal(decision.state, 'speech');
});

test('adaptive VAD keeps brief pauses open and ends only after the 700ms hangover', () => {
  const vad = createAdaptiveVad({ calibrationMs: 0, startWindowMs: 200, hangoverMs: 700 });
  let now = 0;
  let decision;
  for (let frame = 0; frame < 5; frame += 1, now += 40) {
    decision = vad.process(tone(180, 0.06), now, { sampleRate: SAMPLE_RATE });
  }
  assert.equal(decision.event, 'speech_start');

  const lastConfidentAt = now - 40;
  while (now - lastConfidentAt < 700) {
    decision = vad.process(tone(60, 0.001), now, { sampleRate: SAMPLE_RATE });
    assert.notEqual(decision.event, 'speech_end');
    now += 40;
  }
  decision = vad.process(tone(60, 0.001), lastConfidentAt + 700, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'speech_end');
});

test('adaptive VAD reports a rejected partial candidate as a false start', () => {
  const vad = createAdaptiveVad({ calibrationMs: 0 });
  let decision = vad.process(tone(180, 0.06), 0, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'candidate');
  decision = vad.process(tone(180, 0.06), 40, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'candidate');
  vad.process(tone(60, 0.001), 100, { sampleRate: SAMPLE_RATE });
  decision = vad.process(tone(60, 0.001), 180, { sampleRate: SAMPLE_RATE });
  assert.equal(decision.event, 'false_start');
  assert.equal(decision.durationMs, 80);
});
