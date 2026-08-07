const OPENAI_REASONING_EFFORTS = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

// Grok 4.5 rejects `none` and defaults to `high` when the field is omitted —
// that alone was most of a ~3.5s first_sentence on live TTFA.
const XAI_REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

function defaultPrimaryModel(provider) {
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'xai') return 'grok-4.5';
  return 'gpt-5.6-sol';
}

function resolveTranscribeModel(env = process.env) {
  // Live TTFA showed whisper-1 alone ~6s of a ~13s turn. Mini-transcribe is
  // the faster default; override with AURA_TRANSCRIBE_MODEL if needed.
  return env.AURA_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
}

function resolveXaiReasoningEffort(effort) {
  if (effort === 'none') return 'low';
  if (XAI_REASONING_EFFORTS.has(effort)) return effort;
  return 'low';
}

function resolveModelConfig(env = process.env) {
  const provider = env.AI_PROVIDER || 'openai';
  const primaryModel = env.AURA_CHAT_MODEL || defaultPrimaryModel(provider);
  // Memory extraction + rolling summaries stay on OpenAI Luna by default even
  // when chat is on xAI — vector recall uses OpenAI embeddings, and Luna is
  // the cheap OpenAI worker that fills the profile/semantic stores.
  const memoryModel = env.AURA_MEMORY_MODEL || 'gpt-5.6-luna';
  // Opt-in only: unset means the tool-routing round uses primaryModel same
  // as before. When set, it's used ONLY for the first (tool-decision) round
  // of a turn - if that round doesn't end up calling a tool, its own text
  // becomes the final reply (faster, but voiced by the router model instead
  // of primaryModel). Any round after a tool call still uses primaryModel.
  const routerModel = env.AURA_ROUTER_MODEL || null;
  // Voice latency first: default to none/low so tool-free rounds (greets,
  // post-tool answers, plain chat) don't sit on "medium" reasoning. That alone
  // was multi-second TTFT on live turns. Opt into medium/high via env when
  // you want deeper thinking. xAI rejects "none" → coerced to low below.
  const requestedEffort = env.AURA_REASONING_EFFORT
    || (provider === 'xai' ? 'low' : 'none');
  const reasoningEffort = OPENAI_REASONING_EFFORTS.has(requestedEffort)
    ? requestedEffort
    : (provider === 'xai' ? 'low' : 'none');
  return {
    provider,
    primaryModel,
    memoryModel,
    routerModel,
    reasoningEffort,
    transcribeModel: resolveTranscribeModel(env)
  };
}

function brainRequestOptions(config, options = {}) {
  const model = options.model || config.primaryModel;
  const hasFunctionTools = Array.isArray(options.tools) && options.tools.length > 0;
  const request = {
    ...options,
    model
  };

  if (config.provider === 'openai' && /^gpt-5\.6/.test(model)) {
    // GPT-5.6 Sol supports Chat Completions function tools only when
    // reasoning effort is disabled. Tool-free synthesis can retain the
    // configured reasoning level.
    request.reasoning_effort = hasFunctionTools ? 'none' : config.reasoningEffort;
  } else if (config.provider === 'xai') {
    // Always send effort for Grok — omitting it defaults to high.
    request.reasoning_effort = resolveXaiReasoningEffort(config.reasoningEffort);
  }

  return request;
}

module.exports = {
  brainRequestOptions,
  resolveModelConfig,
  resolveTranscribeModel,
  resolveXaiReasoningEffort
};
