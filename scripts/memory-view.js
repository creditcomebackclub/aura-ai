// Prints a human-readable snapshot of everything AURA currently "believes":
// the pinned owner profile, durable long-term memories, and the rolling
// conversation summary. Run it any time her answers look off - a poisoned
// summary or a stale pinned fact is visible here immediately, which previously
// required ad-hoc raw Supabase queries to discover.
//
//   npm run memory:view
//
// Talks to Supabase directly (service key, no HTTP, no auth token), so it works
// from a checked-out repo without the server running.
const { renderMemoryDocument } = require('../memory_v2');
const { SupabaseStateStore } = require('../supabase_state_store');

require('dotenv').config({ quiet: true });

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'AURA_OWNER_ID']) {
  if (!process.env[key]) throw new Error(`${key} is required.`);
}

// No embeddingProvider: reading the profile/memories/summary never embeds.
const state = new SupabaseStateStore({
  url: process.env.SUPABASE_URL,
  serviceKey: process.env.SUPABASE_SERVICE_KEY,
  ownerId: process.env.AURA_OWNER_ID
});

async function main() {
  const [profile, memories, conversationContext] = await Promise.all([
    state.getOwnerProfile(),
    state.listMemories(200),
    state.getConversationContext(1)
  ]);

  const { markdown, warnings } = renderMemoryDocument({
    profile,
    memories,
    summary: conversationContext.summary,
    summaryUpdatedAt: conversationContext.updatedAt || null
  });

  console.log(markdown);

  // stderr so warnings stand out and survive piping stdout to a file.
  for (const warning of warnings) {
    console.error(`\n[WARNING] ${warning}`);
  }
}

main().catch(error => {
  console.error(`memory-view failed: ${error.message}`);
  process.exitCode = 1;
});
