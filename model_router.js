const OPENAI_REASONING_EFFORTS = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

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
  const requestedEffort = env.AURA_REASONING_EFFORT || 'medium';
  const reasoningEffort = OPENAI_REASONING_EFFORTS.has(requestedEffort)
    ? requestedEffort
    : 'medium';
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
  return {
    ...options,
    model,
    ...(config.provider === 'openai' && /^gpt-5\.6/.test(model)
      ? {
          // GPT-5.6 Sol supports Chat Completions function tools only when
          // reasoning effort is disabled. Tool-free synthesis can retain the
          // configured reasoning level.
          reasoning_effort: hasFunctionTools ? 'none' : config.reasoningEffort
        }
      : {})
  };
}

module.exports = {
  brainRequestOptions,
  resolveModelConfig,
  resolveTranscribeModel
};
