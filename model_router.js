const OPENAI_REASONING_EFFORTS = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

function resolveModelConfig(env = process.env) {
  const provider = env.AI_PROVIDER || 'openai';
  const primaryModel = env.AURA_CHAT_MODEL ||
    (provider === 'deepseek' ? 'deepseek-chat' : 'gpt-5.6-sol');
  const memoryModel = env.AURA_MEMORY_MODEL || 'gpt-5.6-luna';
  const requestedEffort = env.AURA_REASONING_EFFORT || 'medium';
  const reasoningEffort = OPENAI_REASONING_EFFORTS.has(requestedEffort)
    ? requestedEffort
    : 'medium';
  return {
    provider,
    primaryModel,
    memoryModel,
    reasoningEffort
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
  resolveModelConfig
};
