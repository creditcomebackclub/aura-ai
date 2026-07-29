const { createClient } = require('@supabase/supabase-js');

class SupabaseStateStore {
  constructor({ url, serviceKey, ownerId, embeddingProvider = null }) {
    if (!ownerId) throw new Error('AURA_OWNER_ID is required for Supabase state.');
    this.client = createClient(url, serviceKey);
    this.ownerId = ownerId;
    this.embeddingProvider = embeddingProvider;
    this.conversationId = null;
  }

  async ensureConversation() {
    if (this.conversationId) return this.conversationId;
    const { data: existing, error } = await this.client
      .from('aura_conversations')
      .select('id')
      .eq('owner_id', this.ownerId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (existing) {
      this.conversationId = existing.id;
      return existing.id;
    }
    const { data, error: insertError } = await this.client
      .from('aura_conversations')
      .insert({ owner_id: this.ownerId, title: 'AURA Conversation' })
      .select('id')
      .single();
    if (insertError) throw insertError;
    this.conversationId = data.id;
    return data.id;
  }

  async addMessage(role, content, metadata = {}) {
    const conversationId = await this.ensureConversation();
    const { error } = await this.client.from('aura_messages').insert({
      conversation_id: conversationId,
      owner_id: this.ownerId,
      role,
      content,
      metadata
    });
    if (error) throw error;
    await this.client.from('aura_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
  }

  async recentMessages(limit = 15) {
    const conversationId = await this.ensureConversation();
    const { data, error } = await this.client
      .from('aura_messages')
      .select('role, content, created_at')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).reverse().map(({ role, content }) => ({ role, content }));
  }

  async embed(text) {
    if (!this.embeddingProvider) return null;
    try {
      return await this.embeddingProvider(text);
    } catch (error) {
      console.warn('[Supabase Memory] Embeddings unavailable:', error.message);
      return null;
    }
  }

  cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      aa += a[i] * a[i];
      bb += b[i] * b[i];
    }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  }

  async saveMemory(content, options = {}) {
    const normalized = String(content || '').trim();
    const { data: existing, error: findError } = await this.client
      .from('aura_memories')
      .select('id, confidence')
      .eq('owner_id', this.ownerId)
      .eq('content', normalized)
      .is('superseded_by', null)
      .maybeSingle();
    if (findError) throw findError;
    const embedding = await this.embed(normalized);
    if (existing) {
      const { error } = await this.client.from('aura_memories').update({
        confidence: Math.max(existing.confidence, options.confidence ?? 0.8),
        embedding: embedding || undefined,
        updated_at: new Date().toISOString()
      }).eq('id', existing.id);
      if (error) throw error;
      return { id: existing.id, deduplicated: true };
    }
    const { data, error } = await this.client.from('aura_memories').insert({
      owner_id: this.ownerId,
      content: normalized,
      kind: options.kind || 'fact',
      source: options.source || 'conversation',
      confidence: options.confidence ?? 0.8,
      sensitivity: options.sensitivity || 'private',
      embedding,
      expires_at: options.expiresAt || null
    }).select('id').single();
    if (error) throw error;
    return { id: data.id, deduplicated: false };
  }

  async searchMemories(query, { limit = 4, threshold = 0.35 } = {}) {
    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) return [];
    const { data, error } = await this.client
      .from('aura_memories')
      .select('id, content, kind, source, confidence, embedding, created_at')
      .eq('owner_id', this.ownerId)
      .is('superseded_by', null)
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (error) throw error;
    return (data || [])
      .map(row => ({ ...row, score: this.cosine(queryEmbedding, row.embedding) }))
      .filter(row => row.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ embedding, ...row }) => row);
  }

  async listMemories(limit = 100) {
    const { data, error } = await this.client.from('aura_memories')
      .select('id, content, kind, source, confidence, sensitivity, created_at, updated_at')
      .eq('owner_id', this.ownerId)
      .is('superseded_by', null)
      .order('updated_at', { ascending: false })
      .limit(Math.max(1, Math.min(500, limit)));
    if (error) throw error;
    return data || [];
  }

  async forgetMemory(id) {
    const { error, count } = await this.client.from('aura_memories')
      .delete({ count: 'exact' }).eq('owner_id', this.ownerId).eq('id', id);
    if (error) throw error;
    return count > 0;
  }

  async createNotification(text, category = 'general', urgency = 'normal', options = {}) {
    const row = {
      owner_id: this.ownerId,
      text,
      category,
      urgency,
      metadata: options.metadata || {}
    };
    if (options.dedupeKey) row.dedupe_key = options.dedupeKey;

    const { data, error } = await this.client.from('aura_notifications')
      .insert(row).select('*').single();
    if (!error) return { ...data, deduplicated: false };

    // Mac and cloud schedulers can race. The unique owner/dedupe key is the
    // durable source of truth, so the losing insert reuses the existing alert.
    if (error.code === '23505' && options.dedupeKey) {
      const { data: existing, error: findError } = await this.client
        .from('aura_notifications')
        .select('*')
        .eq('owner_id', this.ownerId)
        .eq('dedupe_key', options.dedupeKey)
        .single();
      if (findError) throw findError;
      return { ...existing, deduplicated: true };
    }
    throw error;
  }

  async listNotifications(limit = 30) {
    const { data, error } = await this.client.from('aura_notifications')
      .select('*').eq('owner_id', this.ownerId).is('acknowledged_at', null)
      .order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return data || [];
  }

  async acknowledgeNotification(id) {
    const { error, count } = await this.client.from('aura_notifications')
      .update({ acknowledged_at: new Date().toISOString() }, { count: 'exact' })
      .eq('owner_id', this.ownerId).eq('id', id);
    if (error) throw error;
    return count > 0;
  }

  async addTask(title, options = {}) {
    const { data, error } = await this.client.from('aura_tasks').insert({
      owner_id: this.ownerId,
      assigned_agent: options.assignedAgent || null,
      title,
      description: options.description || null,
      priority: options.priority || 'normal',
      due_at: options.dueAt || null,
      input: options.input || {}
    }).select('*').single();
    if (error) throw error;
    return data;
  }

  async updateTaskStatus(id, status) {
    const patch = { status, updated_at: new Date().toISOString() };
    if (status === 'completed') patch.completed_at = new Date().toISOString();
    const { data, error } = await this.client.from('aura_tasks').update(patch)
      .eq('owner_id', this.ownerId).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    return data;
  }

  async listTasks() {
    const { data, error } = await this.client.from('aura_tasks').select('*')
      .eq('owner_id', this.ownerId)
      .not('status', 'in', '("completed","cancelled")')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async proposeAction(taskId, agentId, toolName, args, riskLevel) {
    const requiresApproval = riskLevel !== 'read';
    const { data, error } = await this.client.from('aura_actions').insert({
      owner_id: this.ownerId,
      task_id: taskId,
      agent_id: agentId,
      tool_name: toolName,
      arguments: args || {},
      risk_level: riskLevel,
      requires_approval: requiresApproval,
      status: requiresApproval ? 'proposed' : 'approved'
    }).select('*').single();
    if (error) throw error;
    return data;
  }

  async listPendingActions() {
    const { data, error } = await this.client.from('aura_actions').select('*')
      .eq('owner_id', this.ownerId)
      .eq('status', 'proposed')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async decideAction(id, approved, approvedBy = this.ownerId) {
    const patch = approved
      ? { status: 'approved', approved_by: approvedBy, approved_at: new Date().toISOString() }
      : { status: 'rejected' };
    const { data, error } = await this.client.from('aura_actions').update(patch)
      .eq('owner_id', this.ownerId).eq('id', id).eq('status', 'proposed')
      .select('*').maybeSingle();
    if (error) throw error;
    return data;
  }

  async getState(key) {
    const { data, error } = await this.client.from('aura_state').select('value')
      .eq('owner_id', this.ownerId).eq('key', key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  }

  async setState(key, value) {
    const { error } = await this.client.from('aura_state').upsert({
      owner_id: this.ownerId,
      key,
      value,
      updated_at: new Date().toISOString()
    });
    if (error) throw error;
  }
}

module.exports = { SupabaseStateStore };
