'use strict';

(function exposeAudioVad(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AuraAudioVad = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAudioVadApi() {
  const DEFAULTS = Object.freeze({
    calibrationMs: 650,
    startWindowMs: 220,
    hangoverMs: 700,
    gapToleranceMs: 120,
    falseStartMinMs: 80,
    initialNoiseFloor: 0.006,
    minStartRms: 0.02,
    minContinueRms: 0.01,
    noiseStartMultiplier: 2.6,
    noiseContinueMultiplier: 1.55,
    startMargin: 0.004,
    continueMargin: 0.002,
    startConfidence: 0.7,
    continueConfidence: 0.44
  });

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function smoothstep(edge0, edge1, value) {
    if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
    const t = clamp((value - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
  }

  // Ask the browser's WebRTC capture stack to clean audio before any local
  // VAD or remote transcription sees it. Unknown standard constraints are
  // ignored by browsers; voiceIsolation is added only when explicitly exposed.
  function buildProcessedAudioConstraints(supportedConstraints = null) {
    const supported = supportedConstraints && typeof supportedConstraints === 'object'
      ? supportedConstraints
      : null;
    const enabledUnlessRejected = key => !supported || supported[key] !== false;
    const audio = { channelCount: 1 };
    if (enabledUnlessRejected('echoCancellation')) audio.echoCancellation = true;
    if (enabledUnlessRejected('noiseSuppression')) audio.noiseSuppression = true;
    if (enabledUnlessRejected('autoGainControl')) audio.autoGainControl = true;
    if (supported?.voiceIsolation === true) audio.voiceIsolation = true;
    return audio;
  }

  // A lightweight speech-likeness score for the local interruption gate.
  // Energy over the calibrated floor is necessary but not sufficient: zero
  // crossing rate rejects steady fans / hiss, while crest factor discounts
  // short impulses such as keyboard clicks. The sustained window below is the
  // final guard; Deepgram remains the authoritative transcription VAD.
  function analyzeAudioFrame(samples, noiseFloor = DEFAULTS.initialNoiseFloor) {
    if (!samples?.length) {
      return { rms: 0, peak: 0, zeroCrossingRate: 0, crestFactor: 0, snrDb: 0, confidence: 0 };
    }

    const stride = Math.max(1, Math.floor(samples.length / 2048));
    let sumSquares = 0;
    let peak = 0;
    let count = 0;
    let crossings = 0;
    let previous = 0;
    let hasPrevious = false;
    for (let index = 0; index < samples.length; index += stride) {
      const sample = Number(samples[index]) || 0;
      const absolute = Math.abs(sample);
      sumSquares += sample * sample;
      if (absolute > peak) peak = absolute;
      if (hasPrevious && ((sample >= 0) !== (previous >= 0)) && Math.abs(sample - previous) >= 0.003) {
        crossings += 1;
      }
      previous = sample;
      hasPrevious = true;
      count += 1;
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, count));
    const zeroCrossingRate = crossings / Math.max(1, count - 1);
    const crestFactor = rms > 0.00001 ? peak / rms : 0;
    const floor = Math.max(0.0005, Number(noiseFloor) || DEFAULTS.initialNoiseFloor);
    const snrDb = 20 * Math.log10(Math.max(rms, 0.00001) / floor);
    const energyScore = smoothstep(1, 10, snrDb);
    const lowerSpeechBand = smoothstep(0.002, 0.014, zeroCrossingRate);
    const upperSpeechBand = 1 - smoothstep(0.32, 0.5, zeroCrossingRate);
    const speechShapeScore = clamp(lowerSpeechBand * upperSpeechBand);
    const impulseScore = smoothstep(4.5, 9, crestFactor);
    const confidence = clamp(
      energyScore * (0.72 + speechShapeScore * 0.28) - impulseScore * 0.55
    );

    return { rms, peak, zeroCrossingRate, crestFactor, snrDb, confidence };
  }

  function createAdaptiveVad(options = {}) {
    const config = { ...DEFAULTS, ...options };
    let state = 'calibrating';
    let startedAt = null;
    let noiseFloor = config.initialNoiseFloor;
    let candidateAt = null;
    let candidateConfidentMs = 0;
    let candidatePeakConfidence = 0;
    let candidatePeakRms = 0;
    let lastConfidentAt = null;
    let speechStartedAt = null;

    function thresholds(minimumStartRms = 0) {
      const start = Math.max(
        config.minStartRms,
        minimumStartRms,
        noiseFloor * config.noiseStartMultiplier + config.startMargin
      );
      const keep = Math.max(
        config.minContinueRms,
        Math.min(start * 0.7, noiseFloor * config.noiseContinueMultiplier + config.continueMargin)
      );
      return { start, keep };
    }

    function resetCandidate() {
      candidateAt = null;
      candidateConfidentMs = 0;
      candidatePeakConfidence = 0;
      candidatePeakRms = 0;
      lastConfidentAt = null;
    }

    function process(samples, nowMs, { sampleRate = 16000, minimumStartRms = 0 } = {}) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (startedAt === null) startedAt = now;
      const frameMs = clamp((samples?.length || 0) / Math.max(1, sampleRate) * 1000, 1, 100);
      let features = analyzeAudioFrame(samples, noiseFloor);
      const elapsed = now - startedAt;

      if (elapsed < config.calibrationMs) {
        noiseFloor = clamp(noiseFloor * 0.88 + features.rms * 0.12, 0.001, 0.2);
        features = analyzeAudioFrame(samples, noiseFloor);
        return { event: 'calibrating', state, noiseFloor, ...thresholds(minimumStartRms), ...features };
      }
      if (state === 'calibrating') state = 'idle';

      const currentThresholds = thresholds(minimumStartRms);
      const startReady = features.rms >= currentThresholds.start &&
        features.confidence >= config.startConfidence;
      const continueReady = features.rms >= currentThresholds.keep &&
        features.confidence >= config.continueConfidence;

      if (state === 'speech') {
        if (continueReady) lastConfidentAt = now;
        if (now - (lastConfidentAt ?? now) >= config.hangoverMs) {
          const durationMs = Math.max(0, now - (speechStartedAt ?? now));
          state = 'idle';
          speechStartedAt = null;
          resetCandidate();
          return {
            event: 'speech_end', state, durationMs, noiseFloor,
            ...currentThresholds, ...features
          };
        }
        return { event: 'speech', state, noiseFloor, ...currentThresholds, ...features };
      }

      if (startReady) {
        if (candidateAt === null) {
          state = 'candidate';
          candidateAt = now;
          candidateConfidentMs = 0;
        }
        candidateConfidentMs += frameMs;
        candidatePeakConfidence = Math.max(candidatePeakConfidence, features.confidence);
        candidatePeakRms = Math.max(candidatePeakRms, features.rms);
        lastConfidentAt = now;
        if (candidateConfidentMs >= config.startWindowMs) {
          state = 'speech';
          speechStartedAt = candidateAt;
          return {
            event: 'speech_start', state,
            durationMs: candidateConfidentMs,
            noiseFloor, ...currentThresholds, ...features
          };
        }
        return {
          event: 'candidate', state,
          durationMs: candidateConfidentMs,
          noiseFloor, ...currentThresholds, ...features
        };
      }

      if (candidateAt !== null && now - (lastConfidentAt ?? candidateAt) <= config.gapToleranceMs) {
        return {
          event: 'candidate', state,
          durationMs: candidateConfidentMs,
          noiseFloor, ...currentThresholds, ...features
        };
      }

      if (candidateAt !== null) {
        const durationMs = candidateConfidentMs;
        const peakConfidence = candidatePeakConfidence;
        const peakRms = candidatePeakRms;
        state = 'idle';
        resetCandidate();
        if (durationMs >= config.falseStartMinMs) {
          return {
            event: 'false_start', state, durationMs,
            noiseFloor, ...currentThresholds, ...features,
            rms: peakRms,
            confidence: peakConfidence
          };
        }
      }

      // Slowly follow a changing room floor only while no speech candidate is
      // active. Cap the update so one loud transient cannot poison the floor.
      const cappedIdleRms = Math.min(features.rms, Math.max(0.002, noiseFloor * 1.35));
      noiseFloor = clamp(noiseFloor * 0.98 + cappedIdleRms * 0.02, 0.001, 0.2);
      return { event: 'idle', state, noiseFloor, ...thresholds(minimumStartRms), ...features };
    }

    function snapshot() {
      return { state, noiseFloor, ...thresholds() };
    }

    function reset() {
      state = 'calibrating';
      startedAt = null;
      noiseFloor = config.initialNoiseFloor;
      speechStartedAt = null;
      resetCandidate();
    }

    return { process, reset, snapshot };
  }

  return {
    DEFAULTS,
    analyzeAudioFrame,
    buildProcessedAudioConstraints,
    createAdaptiveVad
  };
});
