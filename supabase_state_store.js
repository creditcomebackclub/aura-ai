const { createClient } = require('@supabase/supabase-js');

const MEMORY_EXTRACTION_JOB_PREFIX = 'memory_extraction_job_v1:';
const ACTIVE_MEMORY_JOB_STATUSES = ['queued', 'retry_wait', 'processing'];

function memoryExtractionJobFromRow(row) {
  if (!row?.key?.startsWith(MEMORY_EXTRACTION_JOB_PREFIX) ||
      !row.value || typeof row.value !== 'object') {
    return null;
  }
  return {
    ...row.value,
    id: row.key.slice(MEMORY_EXTRACTION_JOB_PREFIX.length),
    key: row.key,
    _row_updated_at: row.updated_at
  };
}

function isMemoryExtractionJobDue(job, nowMs = Date.now()) {
  if (!job) return false;
  if (job.status === 'queued') return true;
  if (job.status === 'retry_wait') {
    return !job.available_at || Date.parse(job.available_at) <= nowMs;
  }
  if (job.status === 'processing') {
    return !job.lease_expires_at || Date.parse(job.lease_expires_at) <= nowMs;
  }
  return false;
}

function nextRowTimestamp(previousTimestamp, nowMs = Date.now()) {
  const previousMs = Date.parse(previousTimestamp);
  return new Date(Math.max(
    nowMs,
    Number.isFinite(previousMs) ? previousMs + 1 : nowMs
  )).toISOString();
}

class SupabaseStateStore {
  constructor({ url, serviceKey, ownerId, embeddingProvider = null, client = null }) {
    if (!ownerId) throw new Error('AURA_OWNER_ID is required for Supabase state.');
    this.client = client || createClient(url, serviceKey);
    this.ownerId = ownerId;
    this.embeddingProvider = embeddingProvider;
    this.conversationId = null;
    this.profileWrite = Promise.resolve();
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
    const { data, error } = await this.client.from('aura_messages').insert({
      conversation_id: conversationId,
      owner_id: this.ownerId,
      role,
      content,
      metadata
    }).select('id, role, created_at').single();
    if (error) throw error;
    await this.client.from('aura_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);
    return data;
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

  async getConversationContext(limit = 30) {
    const conversationId = await this.ensureConversation();
    const [{ data: conversation, error: conversationError }, messages] = await Promise.all([
      this.client
        .from('aura_conversations')
        .select('summary, metadata')
        .eq('id', conversationId)
        .eq('owner_id', this.ownerId)
        .single(),
      this.recentMessages(limit)
    ]);
    if (conversationError) throw conversationError;
    return {
      summary: conversation?.summary || '',
      metadata: conversation?.metadata || {},
      messages
    };
  }

  async messagesForSummary(limit = 80) {
    const conversationId = await this.ensureConversation();
    const { data: conversation, error: conversationError } = await this.client
      .from('aura_conversations')
      .select('summary, metadata')
      .eq('id', conversationId)
      .eq('owner_id', this.ownerId)
      .single();
    if (conversationError) throw conversationError;

    let query = this.client
      .from('aura_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant'])
      .order('id', { ascending: true })
      .limit(Math.max(1, Math.min(200, limit)));
    const summarizedThrough = Number(conversation?.metadata?.summary_through_message_id) || 0;
    if (summarizedThrough > 0) query = query.gt('id', summarizedThrough);
    const { data, error } = await query;
    if (error) throw error;
    return {
      existingSummary: conversation?.summary || '',
      summarizedThrough,
      messages: data || []
    };
  }

  async updateConversationSummary(summary, throughMessageId) {
    const conversationId = await this.ensureConversation();
    const { data: current, error: currentError } = await this.client
      .from('aura_conversations')
      .select('metadata')
      .eq('id', conversationId)
      .eq('owner_id', this.ownerId)
      .single();
    if (currentError) throw currentError;
    const metadata = {
      ...(current?.metadata || {}),
      summary_through_message_id: throughMessageId
    };
    const { error } = await this.client
      .from('aura_conversations')
      .update({
        summary,
        metadata,
        updated_at: new Date().toISOString()
      })
      .eq('id', conversationId)
      .eq('owner_id', this.ownerId);
    if (error) throw error;
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
    if (error?.code === '23505') {
      const { data: duplicate, error: duplicateError } = await this.client
        .from('aura_memories')
        .select('id')
        .eq('owner_id', this.ownerId)
        .eq('content', normalized)
        .is('superseded_by', null)
        .single();
      if (duplicateError) throw duplicateError;
      return { id: duplicate.id, deduplicated: true };
    }
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

  async supersedeMemory(id, replacementId) {
    const { error, count } = await this.client.from('aura_memories')
      .update({
        superseded_by: replacementId,
        updated_at: new Date().toISOString()
      }, { count: 'exact' })
      .eq('owner_id', this.ownerId)
      .eq('id', id)
      .is('superseded_by', null);
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

  async enqueueMemoryExtraction(messageId, { maxAttempts = 5 } = {}) {
    const normalizedMessageId = String(messageId || '');
    if (!/^\d+$/.test(normalizedMessageId)) {
      throw new Error('A persisted user message id is required.');
    }
    const key = `${MEMORY_EXTRACTION_JOB_PREFIX}${normalizedMessageId}`;
    const now = new Date().toISOString();
    const value = {
      version: 1,
      type: 'memory_extraction',
      message_id: normalizedMessageId,
      idempotency_key: `message:${normalizedMessageId}`,
      status: 'queued',
      attempts: 0,
      max_attempts: Math.max(1, Math.min(20, Number(maxAttempts) || 5)),
      available_at: now,
      lease_token: null,
      lease_expires_at: null,
      created_at: now,
      completed_at: null,
      learned_count: null,
      skipped: null,
      last_error: null
    };
    const { data, error } = await this.client.from('aura_state').insert({
      owner_id: this.ownerId,
      key,
      value,
      updated_at: now
    }).select('key, value, updated_at').single();
    if (!error) return { ...memoryExtractionJobFromRow(data), deduplicated: false };
    if (error.code !== '23505') throw error;

    const existing = await this.getMemoryExtractionJob(normalizedMessageId);
    if (!existing) throw error;
    return { ...existing, deduplicated: true };
  }

  async getMemoryExtractionJob(messageId) {
    const key = `${MEMORY_EXTRACTION_JOB_PREFIX}${String(messageId || '')}`;
    const { data, error } = await this.client.from('aura_state')
      .select('key, value, updated_at')
      .eq('owner_id', this.ownerId)
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return memoryExtractionJobFromRow(data);
  }

  async getMessageForMemoryExtraction(messageId) {
    const { data, error } = await this.client.from('aura_messages')
      .select('id, role, content, created_at')
      .eq('owner_id', this.ownerId)
      .eq('id', messageId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async transitionMemoryExtractionJob(job, value) {
    if (!job?.key || !job._row_updated_at) return null;
    const updatedAt = nextRowTimestamp(job._row_updated_at);
    const { data, error } = await this.client.from('aura_state')
      .update({ value, updated_at: updatedAt })
      .eq('owner_id', this.ownerId)
      .eq('key', job.key)
      .eq('updated_at', job._row_updated_at)
      .select('key, value, updated_at')
      .maybeSingle();
    if (error) throw error;
    return memoryExtractionJobFromRow(data);
  }

  async claimNextMemoryExtraction({ leaseMs = 5 * 60 * 1000, scanLimit = 250 } = {}) {
    const { data, error } = await this.client.from('aura_state')
      .select('key, value, updated_at')
      .eq('owner_id', this.ownerId)
      .like('key', `${MEMORY_EXTRACTION_JOB_PREFIX}%`)
      .in('value->>status', ACTIVE_MEMORY_JOB_STATUSES)
      .order('updated_at', { ascending: true })
      .limit(Math.max(1, Math.min(1000, Number(scanLimit) || 250)));
    if (error) throw error;

    const nowMs = Date.now();
    const candidates = (data || [])
      .map(memoryExtractionJobFromRow)
      .filter(job => isMemoryExtractionJobDue(job, nowMs))
      .sort((a, b) => {
        const aDue = Date.parse(a.available_at || a.lease_expires_at || a.created_at) || 0;
        const bDue = Date.parse(b.available_at || b.lease_expires_at || b.created_at) || 0;
        return aDue - bDue;
      });

    for (const job of candidates) {
      const leaseToken = require('crypto').randomUUID();
      const claimedAt = new Date().toISOString();
      const claimed = await this.transitionMemoryExtractionJob(job, {
        ...job,
        id: undefined,
        key: undefined,
        _row_updated_at: undefined,
        status: 'processing',
        attempts: (Number(job.attempts) || 0) + 1,
        lease_token: leaseToken,
        lease_expires_at: new Date(nowMs + Math.max(1000, Number(leaseMs) || 300000))
          .toISOString(),
        claimed_at: claimedAt
      });
      if (claimed) return claimed;
    }
    return null;
  }

  async completeMemoryExtraction(job, { learnedCount = 0, skipped = null } = {}) {
    const completedAt = new Date().toISOString();
    return this.transitionMemoryExtractionJob(job, {
      version: job.version || 1,
      type: 'memory_extraction',
      message_id: job.message_id,
      idempotency_key: job.idempotency_key,
      status: 'succeeded',
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      available_at: null,
      lease_token: null,
      lease_expires_at: null,
      created_at: job.created_at,
      completed_at: completedAt,
      learned_count: Math.max(0, Number(learnedCount) || 0),
      skipped,
      last_error: null
    });
  }

  async retryMemoryExtraction(
    job,
    error,
    { delayMs = 15000, maxAttempts = 5 } = {}
  ) {
    const attemptLimit = Math.max(
      1,
      Math.min(20, Number(job.max_attempts || maxAttempts) || 5)
    );
    const exhausted = Number(job.attempts) >= attemptLimit;
    return this.transitionMemoryExtractionJob(job, {
      version: job.version || 1,
      type: 'memory_extraction',
      message_id: job.message_id,
      idempotency_key: job.idempotency_key,
      status: exhausted ? 'failed' : 'retry_wait',
      attempts: job.attempts,
      max_attempts: attemptLimit,
      available_at: exhausted
        ? null
        : new Date(Date.now() + Math.max(1000, Number(delayMs) || 15000)).toISOString(),
      lease_token: null,
      lease_expires_at: null,
      created_at: job.created_at,
      completed_at: exhausted ? new Date().toISOString() : null,
      learned_count: null,
      skipped: null,
      last_error: {
        code: String(error?.code || 'MEMORY_EXTRACTION_FAILED').slice(0, 80),
        message: String(error?.message || 'Memory extraction failed.').slice(0, 500),
        at: new Date().toISOString()
      }
    });
  }

  async getOwnerProfile() {
    const value = await this.getState('owner_profile_v1');
    return value && typeof value === 'object'
      ? value
      : { version: 1, entries: {}, updated_at: null };
  }

  async upsertOwnerProfileEntries(entries) {
    this.profileWrite = this.profileWrite.catch(() => {}).then(async () => {
      const profile = await this.getOwnerProfile();
      const nextEntries = { ...(profile.entries || {}) };
      for (const entry of entries) {
        nextEntries[entry.key] = {
          ...entry,
          updated_at: new Date().toISOString()
        };
      }
      const next = {
        version: 1,
        entries: nextEntries,
        updated_at: new Date().toISOString()
      };
      await this.setState('owner_profile_v1', next);
      return next;
    });
    return this.profileWrite;
  }

  async removeOwnerProfileEntries(keys) {
    this.profileWrite = this.profileWrite.catch(() => {}).then(async () => {
      const profile = await this.getOwnerProfile();
      const nextEntries = { ...(profile.entries || {}) };
      for (const key of keys) delete nextEntries[key];
      const next = {
        version: 1,
        entries: nextEntries,
        updated_at: new Date().toISOString()
      };
      await this.setState('owner_profile_v1', next);
      return next;
    });
    return this.profileWrite;
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

module.exports = {
  MEMORY_EXTRACTION_JOB_PREFIX,
  SupabaseStateStore,
  isMemoryExtractionJobDue,
  memoryExtractionJobFromRow,
  nextRowTimestamp
};
