const { findFalseCapabilityDenial } = require('./memory_v2');

// Stream sentences to the client immediately for fast first-audio, but hold
// back (and stop emitting) as soon as the accumulating reply looks like a
// false capability denial for tools that were actually offered this turn.
// Already-spoken clean prefix sentences cannot be unsaid; the denying
// sentence itself never reaches the client, and beginCorrection() re-opens
// the gate so the replacement answer can stream live.
function createSentenceGate(onSentence, { availableToolNames = [] } = {}) {
  let accumulated = '';
  let suppressed = false;
  let correctionOpen = false;
  let denial = null;

  const emit = typeof onSentence === 'function' ? onSentence : null;

  return {
    onSentence: emit
      ? (sentence) => {
          const text = typeof sentence === 'string' ? sentence : '';
          if (!text) return;
          if (correctionOpen) {
            emit(text);
            return;
          }
          if (suppressed) return;

          const next = accumulated ? `${accumulated} ${text}` : text;
          const hit = findFalseCapabilityDenial(next, availableToolNames);
          if (hit) {
            suppressed = true;
            denial = hit;
            return;
          }
          accumulated = next;
          emit(text);
        }
      : undefined,
    getDenial() {
      return denial;
    },
    wasSuppressed() {
      return suppressed;
    },
    // Kept for call-site compatibility with the old buffer-everything gate.
    // Passthrough mode has nothing to flush.
    release() {},
    discard() {
      suppressed = true;
    },
    beginCorrection() {
      suppressed = false;
      correctionOpen = true;
    }
  };
}

// Short spoken filler before the first tool round so the channel doesn't go
// silent while lookups run. Not persisted into the assistant transcript —
// callers emit via onSentence only.
function pickToolWorkingBeat(toolNames = []) {
  const names = toolNames instanceof Set
    ? toolNames
    : new Set(Array.isArray(toolNames) ? toolNames : []);
  if (names.has('search_web')) return 'Looking that up.';
  if (names.has('check_email') || names.has('check_calendar')) return 'Checking now.';
  if (
    names.has('get_client_snapshot') ||
    names.has('get_client_current_phase') ||
    names.has('query_database_table') ||
    names.has('get_outstanding_balances') ||
    names.has('count_database_rows')
  ) {
    return 'Pulling that up.';
  }
  return 'One sec.';
}

function emitToolWorkingBeat(onSentence, toolNames) {
  if (typeof onSentence !== 'function') return false;
  onSentence(pickToolWorkingBeat(toolNames));
  return true;
}

module.exports = {
  createSentenceGate,
  emitToolWorkingBeat,
  pickToolWorkingBeat
};
