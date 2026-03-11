/**
 * Agentelegram Server — entry point.
 *
 * HTTP (Express) for REST management API.
 * WebSocket for unified chat protocol (human & agent).
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb, getPool } from './db.js';
import { authRouter } from './auth.js';
import { setupWsHandler } from './ws-handler.js';

const PORT = parseInt(process.env.PORT ?? '4000', 10);

async function main(): Promise<void> {
  // --- Database ---
  await initDb();

  // --- Express ---
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Auth routes
  app.use('/api/auth', authRouter);

  // REST: list all participants (for creating conversations)
  app.get('/api/participants', async (_req, res) => {
    const db = getPool();
    const result = await db.query(
      `SELECT id, type, name, display_name, avatar_url, created_at
       FROM participants ORDER BY created_at`
    );
    const participants = result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      createdAt: Number(r.created_at),
    }));
    res.json(participants);
  });

  // REST: get conversation members
  app.get('/api/conversations/:id/members', async (req, res) => {
    const db = getPool();
    const result = await db.query(
      `SELECT p.id, p.type, p.name, p.display_name, p.avatar_url, p.created_at
       FROM participants p
       JOIN conversation_participants cp ON cp.participant_id = p.id
       WHERE cp.conversation_id = $1`,
      [req.params.id]
    );
    const members = result.rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      createdAt: Number(r.created_at),
    }));
    res.json(members);
  });

  // --- HTTP Server ---
  const server = createServer(app);

  // --- WebSocket ---
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWsHandler(wss);

  // --- Start ---
  server.listen(PORT, () => {
    console.log(`[agentelegram] server running on http://localhost:${PORT}`);
    console.log(`[agentelegram] WebSocket on ws://localhost:${PORT}/ws`);
  });

  // --- Graceful shutdown ---
  const shutdown = async () => {
    console.log('[agentelegram] shutting down...');
    wss.close();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[agentelegram] fatal:', err);
  process.exit(1);
});
