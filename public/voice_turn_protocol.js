'use strict';

(function exposeVoiceTurnProtocol(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AuraVoiceTurnProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createVoiceTurnProtocolApi() {
  function createStreamFence(turnId, generation = 1) {
    let lastSequence = 0;
    return {
      accept(event) {
        if (!event || typeof event !== 'object') return { accepted: false, reason: 'invalid_event' };
        // Missing protocol fields remain valid during a rolling deploy. Once
        // present, all three fields are authoritative and stale events lose.
        if (event.turn_id && event.turn_id !== turnId) {
          return { accepted: false, reason: 'wrong_turn' };
        }
        if (Number.isInteger(event.generation) && event.generation !== generation) {
          return { accepted: false, reason: 'wrong_generation' };
        }
        if (Number.isInteger(event.sequence)) {
          if (event.sequence <= lastSequence) {
            return { accepted: false, reason: 'stale_sequence' };
          }
          lastSequence = event.sequence;
        }
        return { accepted: true, reason: '' };
      },
      snapshot() {
        return { turnId, generation, lastSequence };
      }
    };
  }

  function shouldDeferProactiveAlert(state = {}) {
    return Boolean(state.isProcessing || state.isSpeaking || state.isListening);
  }

  return { createStreamFence, shouldDeferProactiveAlert };
});
