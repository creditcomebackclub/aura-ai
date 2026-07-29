const Database = require('better-sqlite3');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ quiet: true });

const ownerId = process.env.AURA_OWNER_ID;
if (!ownerId) {
  console.error('Migration requires AURA_OWNER_ID from the authenticated Supabase user.');
  process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const db = new Database('aura.db', { readonly: true });

async function insertMany(table, rows, batchSize = 100) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + batchSize));
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

(async () => {
  const { data: conversation, error: conversationError } = await supabase
    .from('aura_conversations')
    .insert({
      owner_id: ownerId,
      title: 'Imported local AURA conversation',
      metadata: { imported_from: 'aura.db' }
    })
    .select('id')
    .single();
  if (conversationError) throw conversationError;

  const messages = db.prepare(
    'SELECT role, content, timestamp FROM memory ORDER BY id'
  ).all().map(row => ({
    conversation_id: conversation.id,
    owner_id: ownerId,
    role: row.role,
    content: row.content,
    metadata: { imported_from: 'aura.db', original_timestamp: row.timestamp }
  }));
  await insertMany('aura_messages', messages);

  const memories = db.prepare(`
    SELECT content, kind, source, confidence, sensitivity, embedding,
           expires_at, created_at, updated_at
    FROM semantic_memories WHERE superseded_by IS NULL
  `).all().map(row => ({
    owner_id: ownerId,
    content: row.content,
    kind: row.kind,
    source: row.source,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    embedding: row.embedding ? JSON.parse(row.embedding) : null,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));
  await insertMany('aura_memories', memories);

  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id').all()
    .map(row => ({
      owner_id: ownerId,
      text: row.text,
      category: row.category,
      urgency: row.urgency,
      delivered_at: row.delivered_at,
      acknowledged_at: row.acknowledged_at,
      created_at: row.created_at,
      metadata: { imported_from: 'aura.db' }
    }));
  await insertMany('aura_notifications', notifications);

  const goals = db.prepare('SELECT * FROM goals ORDER BY id').all().map(row => ({
    owner_id: ownerId,
    assigned_agent: 'client_operations',
    title: row.description,
    status: row.status === 'completed' ? 'completed' : 'pending',
    created_at: row.created_at,
    completed_at: row.status === 'completed' ? row.created_at : null,
    input: { imported_from: 'goals', original_id: row.id }
  }));
  await insertMany('aura_tasks', goals);

  console.log(JSON.stringify({
    conversation_id: conversation.id,
    messages: messages.length,
    memories: memories.length,
    notifications: notifications.length,
    tasks: goals.length,
    owner_id: ownerId
  }, null, 2));
  db.close();
})().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  db.close();
  process.exit(1);
});
