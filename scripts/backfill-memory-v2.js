const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { MemoryV2, deterministicEntries } = require('../memory_v2');
const { SupabaseStateStore } = require('../supabase_state_store');

require('dotenv').config({ quiet: true });

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'AURA_OWNER_ID']) {
  if (!process.env[key]) throw new Error(`${key} is required.`);
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const embeddingProvider = openai
  ? async text => {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
      });
      return response.data[0].embedding;
    }
  : null;
const state = new SupabaseStateStore({
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
  ownerId: process.env.AURA_OWNER_ID,
  embeddingProvider
});
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const memory = new MemoryV2({
  profileStore: state,
  semanticMemory: {
    save: (content, options) => state.saveMemory(content, options),
    search: (query, options) => state.searchMemories(query, options),
    list: limit => state.listMemories(limit),
    forget: id => state.forgetMemory(id),
    supersede: (id, replacementId) => state.supersedeMemory(id, replacementId)
  },
  // This migration intentionally uses deterministic rules only. It does not
  // replay the owner's historical transcript through a model.
  client: null
});

(async () => {
  const { data, error } = await supabase
    .from('aura_messages')
    .select('content, created_at')
    .eq('owner_id', process.env.AURA_OWNER_ID)
    .eq('role', 'user')
    .order('created_at', { ascending: true })
    .limit(1000);
  if (error) throw error;

  const candidates = (data || []).filter(row =>
    deterministicEntries(row.content, 'history_backfill').length > 0
  );
  const counts = {};
  let learnedCount = 0;
  for (const row of candidates) {
    const result = await memory.learnFromUserMessage(row.content, {
      source: 'history_backfill'
    });
    for (const entry of result.learned || []) {
      counts[entry.kind] = (counts[entry.kind] || 0) + 1;
      learnedCount += 1;
    }
  }
  console.log(JSON.stringify({
    scanned_messages: (data || []).length,
    candidate_messages: candidates.length,
    learned_entries: learnedCount,
    learned_kinds: counts
  }, null, 2));
})().catch(error => {
  console.error(JSON.stringify({
    error: error.message,
    code: error.code || null
  }));
  process.exitCode = 1;
});
