'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesHeyAura,
  normalizeWakeTranscript,
  createWakeWordListener
} = require('../public/wake_word');

test('normalizeWakeTranscript strips punctuation and casing', () => {
  assert.equal(normalizeWakeTranscript('  Hey, AURA! '), 'hey aura');
});

test('matchesHeyAura accepts common wake phrases and rejects noise', () => {
  assert.equal(matchesHeyAura('hey aura'), true);
  assert.equal(matchesHeyAura('Hey Aura, what is MRR?'), true);
  assert.equal(matchesHeyAura('hi aura'), true);
  assert.equal(matchesHeyAura('hey ora'), true);
  assert.equal(matchesHeyAura('hey aurora'), true);
  assert.equal(matchesHeyAura('okay aura'), true);
  assert.equal(matchesHeyAura('what is aura'), false);
  assert.equal(matchesHeyAura('hey there'), false);
  assert.equal(matchesHeyAura(''), false);
});

test('createWakeWordListener fires onWake for a matching interim result', () => {
  let started = false;
  let stopped = false;
  let woke = null;
  const FakeRecognition = function FakeRecognition() {
    this.lang = '';
    this.interimResults = false;
    this.continuous = false;
    this.maxAlternatives = 1;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
  };
  FakeRecognition.prototype.start = function start() {
    started = true;
  };
  FakeRecognition.prototype.stop = function stop() {
    stopped = true;
  };
  FakeRecognition.prototype.abort = function abort() {};

  let instance = null;
  const listener = createWakeWordListener({
    getRecognition: () => {
      return function RecognitionFactory() {
        instance = new FakeRecognition();
        return instance;
      };
    },
    isIOS: () => false,
    shouldRun: () => true,
    onWake: transcript => {
      woke = transcript;
    }
  });

  assert.equal(listener.available(), true);
  assert.equal(listener.start(), true);
  assert.equal(started, true);
  instance.onresult({
    resultIndex: 0,
    results: [
      [{ transcript: 'hey aura' }]
    ]
  });
  assert.equal(woke, 'hey aura');
  assert.equal(stopped, true);
  assert.equal(listener.isArmed(), false);
});
