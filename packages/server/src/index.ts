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
import { initDb, closeDb } from './db.js';

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

  // TODO M1: auth routes (register, login)
  // TODO M1: conversation routes

  // --- HTTP Server ---
  const server = createServer(app);

  // --- WebSocket ---
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    console.log('[ws] new connection');
    // TODO M1: authenticate, handle chat protocol events
    ws.on('message', (raw) => {
      console.log('[ws] received:', raw.toString().slice(0, 200));
    });
    ws.on('close', () => {
      console.log('[ws] disconnected');
    });
  });

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
