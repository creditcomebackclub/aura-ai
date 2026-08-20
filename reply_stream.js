const { findFalseCapabilityDenial } = require('./memory_v2');
const { findUnsupportedActionClaim } = require('./action_receipts');

// Some OpenAI-compatible models occasionally print a tool request as JSON in
// normal assistant text instead of returning it through the structured
// `tool_calls` field. Parse only complete JSON objects that name a tool the
// server actually offered; callers further restrict recovery to read-only
// tools before anything is executed.
function extractTextToolCalls(text, { allowedToolNames = [] } = {}) {
  const source = typeof text === 'string' ? text : '';
  const allowed = new Set((allowedToolNames || []).filter(Boolean));
  if (!source || allowed.size === 0 || !source.includes('tool_call')) return [];

  const calls = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  const inspectObject = raw => {
    if (!/"tool_call"\s*:/.test(raw)) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return;
    const name = typeof parsed.tool_call === 'string' ? parsed.tool_call.trim() : '';
    if (!allowed.has(name)) return;

    let args = parsed.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { args = null; }
    }
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      args = Object.fromEntries(
        Object.entries(parsed).filter(([key]) => key !== 'tool_call' && key !== 'arguments')
      );
    }
    calls.push({ name, arguments: args, raw });
  };

  for (let index = 0; index < source.length && calls.length < 8; index += 1) {
    const char = source[index];
    if (objectStart === -1) {
      if (char === '{') {
        objectStart = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        inspectObject(source.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  return calls;
}

function containsTextToolCallMarker(text) {
  return /"tool_call"\s*:\s*"[A-Za-z0-9_-]+"/.test(text);
}

// Any turn that can enter a tool/correction round must not speak provisional
// prose. The caller buffers per-round deltas and publishes only the
// authoritative final reply once the tool loop and receipt gates settle.
function shouldBufferSpeechUntilFinal(toolNames = []) {
  return Array.isArray(toolNames) && toolNames.some(name => typeof name === 'string' && name);
}

const SESSION_UNAVAILABLE_PATTERN = /\b(?:isn['’]?t|is\s+not|aren['’]?t|are\s+not|unavailable|not\s+available)\b[^.]{0,100}\b(?:session|chat|right\s+now|currently)\b/i;
const CCC_READ_TOOLS = new Set([
  'get_client_snapshot',
  'get_client_current_phase',
  'calculate_financial_metrics',
  'get_outstanding_balances',
  'query_database_table',
  'count_database_rows'
]);

// A genuine provider/database failure must never be described as a missing
// session capability. Preserve the failure, but name the actual condition so
// the owner knows whether retrying would help.
function normalizeUnavailableFailureReply(reply, evidence = []) {
  const value = String(reply || '');
  if (!SESSION_UNAVAILABLE_PATTERN.test(value)) return value;
  const failures = (Array.isArray(evidence) ? evidence : []).filter(item => item?.ok === false);
  const webFailure = [...failures].reverse().find(item => item?.tool === 'search_web');
  if (webFailure) {
    if (webFailure.error_code === 'WEB_SEARCH_DAILY_LIMIT') {
      return "I couldn't run that web search because today's live-search limit has been reached.";
    }
    if (webFailure.error_code === 'WEB_SEARCH_PRIVATE_DATA_BOUNDARY') {
      return "I can't combine public web search with private AURA data in one request. Ask for the public web lookup separately.";
    }
    return 'I attempted the live web search, but it failed this turn. Please try again.';
  }
  if (failures.some(item => CCC_READ_TOOLS.has(item?.tool))) {
    return 'I attempted the CCC lookup, but it failed this turn. Please try again.';
  }
  if (failures.some(item => item?.tool === 'check_email')) {
    return 'I attempted the live email lookup, but it failed this turn. Please try again.';
  }
  if (failures.some(item => item?.tool === 'check_calendar')) {
    return 'I attempted the live calendar lookup, but it failed this turn. Please try again.';
  }
  return value;
}

// Stream sentences to the client immediately for fast first-audio, but hold
// back (and stop emitting) as soon as the accumulating reply looks like a
// false capability denial for tools that were actually offered this turn.
// Already-spoken clean prefix sentences cannot be unsaid; the denying
// sentence itself never reaches the client, and beginCorrection() re-opens
// the gate so the replacement answer can stream live.
function createSentenceGate(onSentence, {
  availableToolNames = [],
  capabilityToolNames = availableToolNames
} = {}) {
  let accumulated = '';
  let suppressed = false;
  let correctionOpen = false;
  let denial = null;
  let unsupportedActionClaim = null;
  let protocolLeak = null;
  const attemptedToolNames = new Set();
  const successfulToolNames = new Set();
  const failedToolNames = new Set();

  const emit = typeof onSentence === 'function' ? onSentence : null;

  return {
    onSentence: emit
      ? (sentence) => {
          const text = typeof sentence === 'string' ? sentence : '';
          if (!text) return;
          if (suppressed) return;

          const next = accumulated ? `${accumulated} ${text}` : text;
          const textToolCalls = extractTextToolCalls(next, {
            allowedToolNames: availableToolNames
          });
          if (textToolCalls.length || containsTextToolCallMarker(next)) {
            suppressed = true;
            protocolLeak = { calls: textToolCalls, raw: next };
            return;
          }
          const unsupported = findUnsupportedActionClaim(next, [...successfulToolNames], {
            candidateToolNames: availableToolNames
          });
          if (unsupported) {
            suppressed = true;
            unsupportedActionClaim = unsupported;
            return;
          }
          if (correctionOpen) {
            accumulated = next;
            emit(text);
            return;
          }
          const hit = findFalseCapabilityDenial(next, capabilityToolNames, {
            failedToolNames: [...failedToolNames],
            successfulToolNames: [...successfulToolNames],
            genericToolNames: availableToolNames
          });
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
    getProtocolLeak() {
      return protocolLeak;
    },
    getUnsupportedActionClaim() {
      return unsupportedActionClaim;
    },
    markToolAttempted(name) {
      if (typeof name === 'string' && name) attemptedToolNames.add(name);
    },
    markToolOutcome(name, ok) {
      if (typeof name !== 'string' || !name) return;
      attemptedToolNames.add(name);
      if (ok === true) {
        successfulToolNames.add(name);
        failedToolNames.delete(name);
      } else if (ok === false) {
        failedToolNames.add(name);
        successfulToolNames.delete(name);
      }
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
    },
    beginReceiptCorrection() {
      accumulated = '';
      suppressed = false;
      correctionOpen = false;
      unsupportedActionClaim = null;
    },
    resetAfterToolRecovery() {
      accumulated = '';
      suppressed = false;
      correctionOpen = false;
      denial = null;
      unsupportedActionClaim = null;
      protocolLeak = null;
    }
  };
}

module.exports = {
  createSentenceGate,
  extractTextToolCalls,
  normalizeUnavailableFailureReply,
  shouldBufferSpeechUntilFinal
};
