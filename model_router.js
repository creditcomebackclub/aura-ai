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

function isOpenAiChatModel(model) {
  return /^gpt-/i.test(String(model || ''));
}

// Round-0 tool routing (and tool-free greets) can use a faster model than the
// spoken primary. OpenAI defaults to Luna on the same API. xAI stays on the
// primary unless AURA_ROUTER_MODEL is set explicitly (may be an OpenAI model
// routed through the OpenAI client). Set AURA_ROUTER_MODEL=off to disable.
function resolveRouterModel(env = process.env, provider = 'openai', memoryModel = 'gpt-5.6-luna') {
  const raw = env.AURA_ROUTER_MODEL;
  if (raw === undefined || raw === null) {
    // Round-0 Luna is the main TTFT win. Prefer it whenever OpenAI is
    // reachable — including xAI/Grok chat, which routes Luna through the
    // embeddings client. Without OPENAI_API_KEY, non-OpenAI providers stay
    // on their primary model.
    if (provider === 'openai' || env.OPENAI_API_KEY) return memoryModel;
    return null;
  }
  const trimmed = String(raw).trim();
  if (!trimmed || /^(off|false|none|null)$/i.test(trimmed)) return null;
  return trimmed;
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
  const routerModel = resolveRouterModel(env, provider, memoryModel);
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
  const { _reasoningEffort, ...requestOptions } = options;
  const model = requestOptions.model || config.primaryModel;
  const effectiveReasoningEffort = OPENAI_REASONING_EFFORTS.has(_reasoningEffort)
    ? _reasoningEffort
    : config.reasoningEffort;
  const hasFunctionTools = Array.isArray(requestOptions.tools) && requestOptions.tools.length > 0;
  const request = {
    ...requestOptions,
    model
  };
  // Key off the model id, not AI_PROVIDER — round-0 may call Luna via the
  // OpenAI client while chat is still on xAI/Grok.
  const openAiModel = isOpenAiChatModel(model);

  if (openAiModel && /^gpt-5\.6/.test(model)) {
    // GPT-5.6 supports Chat Completions function tools only when reasoning
    // effort is disabled. Tool-free synthesis can retain the configured level
    // unless this is an explicit router/Luna fast round (always none).
    const isRouterRound = Boolean(
      config.routerModel && model === config.routerModel && model !== config.primaryModel
    );
    request.reasoning_effort = (hasFunctionTools || isRouterRound)
      ? 'none'
      : effectiveReasoningEffort;
  } else if (!openAiModel && config.provider === 'xai') {
    // Always send effort for Grok — omitting it defaults to high.
    request.reasoning_effort = resolveXaiReasoningEffort(effectiveReasoningEffort);
  }

  return request;
}

module.exports = {
  brainRequestOptions,
  resolveModelConfig,
  resolveTranscribeModel,
  resolveRouterModel,
  resolveXaiReasoningEffort,
  isOpenAiChatModel
};
