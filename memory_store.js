class MemoryStore {
  constructor(db, embeddingProvider = null) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'fact',
        source TEXT NOT NULL DEFAULT 'conversation',
        confidence REAL NOT NULL DEFAULT 0.8,
        sensitivity TEXT NOT NULL DEFAULT 'private',
        embedding TEXT,
        superseded_by INTEGER,
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS semantic_memories_content
        ON semantic_memories(content) WHERE superseded_by IS NULL;
    `);
  }

  async embed(text) {
    if (!this.embeddingProvider) return null;
    try {
      return await this.embeddingProvider(text);
    } catch (error) {
      console.warn('[Memory] Embeddings unavailable; continuing without semantic recall:', error.message);
      return null;
    }
  }

  async save(content, options = {}) {
    const normalized = String(content || '').trim();
    if (!normalized) throw new Error('Cannot save an empty memory.');
    const embedding = await this.embed(normalized);
    const existing = this.db.prepare(
      'SELECT id FROM semantic_memories WHERE lower(content) = lower(?) AND superseded_by IS NULL'
    ).get(normalized);

    if (existing) {
      this.db.prepare(`
        UPDATE semantic_memories
        SET updated_at = CURRENT_TIMESTAMP, confidence = MAX(confidence, ?),
            embedding = COALESCE(?, embedding)
        WHERE id = ?
      `).run(options.confidence ?? 0.8, embedding ? JSON.stringify(embedding) : null, existing.id);
      return { id: existing.id, deduplicated: true };
    }

    const result = this.db.prepare(`
      INSERT INTO semantic_memories
        (content, kind, source, confidence, sensitivity, embedding, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized,
      options.kind || 'fact',
      options.source || 'conversation',
      options.confidence ?? 0.8,
      options.sensitivity || 'private',
      embedding ? JSON.stringify(embedding) : null,
      options.expiresAt || null
    );
    return { id: Number(result.lastInsertRowid), deduplicated: false };
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

  async search(query, { limit = 4, threshold = 0.35, lexicalThreshold = 0.34 } = {}) {
    const { textMatchScore } = require('./memory_v2');
    const [queryEmbedding, rows] = await Promise.all([
      this.embed(query),
      Promise.resolve(this.db.prepare(`
        SELECT id, content, kind, source, confidence, embedding, created_at
        FROM semantic_memories
        WHERE superseded_by IS NULL
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        ORDER BY updated_at DESC
        LIMIT 200
      `).all())
    ]);

    const scored = rows.map(row => {
      const lexical = textMatchScore(query, row.content);
      let vector = 0;
      if (queryEmbedding && row.embedding) {
        try {
          vector = this.cosine(queryEmbedding, JSON.parse(row.embedding));
        } catch {
          vector = 0;
        }
      }
      // Prefer vector when present; keep lexical as a floor so recall still
      // works when embeddings are missing or weak (Hermes-style FTS fallback).
      const score = Math.max(vector, lexical * 0.95);
      return { ...row, score, _vector: vector, _lexical: lexical };
    }).filter(row => {
      if (row._vector >= threshold) return true;
      if (row._lexical >= lexicalThreshold) return true;
      return false;
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ embedding, _vector, _lexical, ...row }) => row);
  }

  list(limit = 100) {
    return this.db.prepare(`
      SELECT id, content, kind, source, confidence, sensitivity, created_at, updated_at
      FROM semantic_memories
      WHERE superseded_by IS NULL
      ORDER BY updated_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(500, limit)));
  }

  forget(id) {
    return this.db.prepare('DELETE FROM semantic_memories WHERE id = ?').run(id).changes > 0;
  }

  supersede(id, replacementId) {
    return this.db.prepare(`
      UPDATE semantic_memories
      SET superseded_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND superseded_by IS NULL
    `).run(replacementId, id).changes > 0;
  }
}

module.exports = { MemoryStore };
