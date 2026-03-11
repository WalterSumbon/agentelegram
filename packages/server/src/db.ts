/**
 * PostgreSQL database connection and schema initialization.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const { Pool } = pg;

let pool: pg.Pool;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/agentelegram',
    });
  }
  return pool;
}

/**
 * Initialize database schema — create tables if they don't exist.
 */
export async function initDb(): Promise<void> {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS participants (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type        TEXT NOT NULL CHECK (type IN ('human', 'agent')),
      name        TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url  TEXT,
      auth_hash   TEXT NOT NULL,
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title       TEXT,
      type        TEXT NOT NULL CHECK (type IN ('direct', 'group')),
      created_by  UUID NOT NULL REFERENCES participants(id),
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
      updated_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      participant_id  UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      role            TEXT DEFAULT 'member',
      joined_at       BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
      PRIMARY KEY (conversation_id, participant_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id       UUID NOT NULL REFERENCES participants(id),
      content         TEXT NOT NULL DEFAULT '',
      content_type    TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'file', 'image', 'mixed')),
      attachments     JSONB,
      timestamp       BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_timestamp
      ON messages (conversation_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_conversation_participants_participant
      ON conversation_participants (participant_id);
  `);

  console.log('[db] schema initialized');
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
