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
  return {
    ...options,
    model,
    ...(config.provider === 'openai' && /^gpt-5\.6/.test(model)
      ? { reasoning_effort: config.reasoningEffort }
      : {})
  };
}

module.exports = {
  brainRequestOptions,
  resolveModelConfig
};
