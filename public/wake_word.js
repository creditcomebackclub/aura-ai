'use strict';

// Idle "hey Aura" wake detection via the Web Speech API.
// Pure matchers are usable from Node tests; the listener needs a browser.

const AURA_WAKE_TOKENS = new Set([
  'aura',
  'ora',
  'aurora',
  'ara',
  'orra',
  'auraa'
]);

function normalizeWakeTranscript(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Require a greeting + aura-like token so random speech doesn't wake her.
function matchesHeyAura(text) {
  const normalized = normalizeWakeTranscript(text);
  if (!normalized) return false;
  if (/\bhey\s+aura\b/.test(normalized)) return true;
  if (/\bhi\s+aura\b/.test(normalized)) return true;
  if (/\bok\s+aura\b/.test(normalized)) return true;
  const tokens = normalized.split(' ');
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const greet = tokens[i];
    const name = tokens[i + 1];
    if ((greet === 'hey' || greet === 'hi' || greet === 'okay' || greet === 'ok') &&
        AURA_WAKE_TOKENS.has(name)) {
      return true;
    }
  }
  return false;
}

function getSpeechRecognitionConstructor(globalObj = typeof window !== 'undefined' ? window : globalThis) {
  return globalObj.SpeechRecognition || globalObj.webkitSpeechRecognition || null;
}

function isIOSUserAgent(ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return /iPad|iPhone|iPod/i.test(String(ua || ''));
}

function createWakeWordListener({
  onWake,
  shouldRun,
  onStatus,
  logger = console,
  getRecognition = getSpeechRecognitionConstructor,
  isIOS = isIOSUserAgent
} = {}) {
  let recognition = null;
  let desired = false;
  let starting = false;
  let restartTimer = null;

  function clearRestart() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function ensureRecognition() {
    if (recognition) return recognition;
    const Recognition = getRecognition();
    if (!Recognition) return null;
    recognition = new Recognition();
    recognition.lang = 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    // continuous:true tends to clog on iOS; restart-on-end is more stable there.
    recognition.continuous = !isIOS();

    recognition.onresult = event => {
      if (!desired) return;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        for (let j = 0; j < result.length; j += 1) {
          const transcript = result[j]?.transcript || '';
          if (matchesHeyAura(transcript)) {
            stop();
            if (typeof onWake === 'function') onWake(transcript);
            return;
          }
        }
      }
    };

    recognition.onerror = event => {
      const error = event?.error || 'unknown';
      // not-allowed / service-not-allowed: don't spin forever.
      if (error === 'not-allowed' || error === 'service-not-allowed') {
        desired = false;
        if (typeof onStatus === 'function') {
          onStatus('Wake word blocked — tap to talk');
        }
        return;
      }
      if (error === 'aborted' || error === 'no-speech') return;
      logger.warn?.('[wake] recognition error:', error);
    };

    recognition.onend = () => {
      starting = false;
      if (!desired) return;
      if (typeof shouldRun === 'function' && !shouldRun()) {
        desired = false;
        return;
      }
      clearRestart();
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (desired) start();
      }, isIOS() ? 250 : 120);
    };

    return recognition;
  }

  function available() {
    return Boolean(getRecognition());
  }

  function start() {
    if (typeof shouldRun === 'function' && !shouldRun()) {
      desired = false;
      return false;
    }
    const rec = ensureRecognition();
    if (!rec) {
      desired = false;
      return false;
    }
    desired = true;
    if (starting) return true;
    starting = true;
    try {
      rec.start();
      if (typeof onStatus === 'function') onStatus('Say hey Aura, or tap');
      return true;
    } catch (error) {
      starting = false;
      // InvalidStateError = already started; treat as armed.
      if (/already started|InvalidStateError/i.test(String(error?.message || error))) {
        return true;
      }
      logger.warn?.('[wake] start failed:', error?.message || error);
      return false;
    }
  }

  function stop() {
    desired = false;
    starting = false;
    clearRestart();
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    }
  }

  function isArmed() {
    return desired;
  }

  return {
    available,
    start,
    stop,
    isArmed,
    matchesHeyAura,
    normalizeWakeTranscript
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AURA_WAKE_TOKENS,
    normalizeWakeTranscript,
    matchesHeyAura,
    getSpeechRecognitionConstructor,
    isIOSUserAgent,
    createWakeWordListener
  };
}

if (typeof window !== 'undefined') {
  window.AuraWakeWord = {
    normalizeWakeTranscript,
    matchesHeyAura,
    createWakeWordListener,
    getSpeechRecognitionConstructor,
    isIOSUserAgent
  };
}
