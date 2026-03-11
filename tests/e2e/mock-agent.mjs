#!/usr/bin/env node
/**
 * Mock Agent — E2E test script for M2 (Agent 接入).
 *
 * What it tests:
 * - Agent registration via REST API (requires human JWT)
 * - WebSocket connection with post-connection auth message (API key in data frame)
 * - Receiving a human message
 * - Sending typing indicator (thinking state)
 * - Streaming a reply via send_message_delta + send_message_done
 *
 * Expected behavior:
 * 1. Login as a human user to get a JWT (or register one)
 * 2. Register agent "echo-bot" via /api/auth/register-agent with JWT auth
 * 3. Connect to WebSocket and authenticate with { type: "auth", apiKey }
 * 4. Wait for a human to create a conversation and send a message
 * 5. Echo back the message word-by-word (streaming) with typing indicator
 *
 * Usage:
 *   node tests/e2e/mock-agent.mjs
 *
 * Environment variables:
 *   SERVER_URL   — server base URL (default: http://localhost:4000)
 *   AGENT_API_KEY — skip registration and use this API key directly
 *   HUMAN_NAME    — human user name for login (default: testuser)
 *   HUMAN_PASSWORD — human user password (default: testpass)
 *
 * Cleanup: the script exits after handling one message. The agent remains in the DB.
 */

import WebSocket from 'ws';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';
const WS_URL = SERVER.replace('http', 'ws');
const HUMAN_NAME = process.env.HUMAN_NAME ?? 'testuser';
const HUMAN_PASSWORD = process.env.HUMAN_PASSWORD ?? 'testpass';

// ── Step 0: Get a human JWT for agent registration ────────────────────────

async function getHumanJwt() {
  // Try login first
  let res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, password: HUMAN_PASSWORD }),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`[mock-agent] logged in as ${HUMAN_NAME}`);
    return data.token;
  }

  // Register if login fails
  res = await fetch(`${SERVER}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, displayName: 'Test User', password: HUMAN_PASSWORD }),
  });

  if (!res.ok) {
    console.error('[mock-agent] failed to register/login human:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log(`[mock-agent] registered human: ${HUMAN_NAME}`);
  return data.token;
}

// ── Step 1: Register agent (requires JWT) ─────────────────────────────────

async function registerAgent(jwt) {
  const res = await fetch(`${SERVER}/api/auth/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name: 'echo-bot', displayName: 'Echo Bot' }),
  });

  if (res.status === 409) {
    console.log('[mock-agent] echo-bot already exists, need API key from env');
    const apiKey = process.env.AGENT_API_KEY;
    if (!apiKey) {
      console.error('[mock-agent] Set AGENT_API_KEY env var for existing agent');
      process.exit(1);
    }
    return { apiKey, existing: true };
  }

  if (!res.ok) {
    console.error('[mock-agent] registration failed:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log(`[mock-agent] registered: ${data.participant.name} (${data.participant.id})`);
  console.log(`[mock-agent] API key: ${data.apiKey}`);
  return { apiKey: data.apiKey, participant: data.participant, existing: false };
}

// ── Step 2: Connect WebSocket with post-connection auth ───────────────────

function connectWs(apiKey) {
  return new Promise((resolve, reject) => {
    // No credentials in URL — clean WebSocket connection
    const ws = new WebSocket(`${WS_URL}/ws`);

    ws.on('open', () => {
      console.log('[mock-agent] WebSocket connected, sending auth...');
      // Authenticate via in-band message (not query string)
      ws.send(JSON.stringify({ type: 'auth', apiKey }));
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') {
        console.log(`[mock-agent] authenticated as ${event.participantName}`);
        resolve(ws);
      } else if (event.type === 'error') {
        console.error('[mock-agent] auth error:', event.error);
        reject(new Error(event.error?.message ?? 'auth failed'));
      }
    });

    ws.on('error', (err) => {
      console.error('[mock-agent] WebSocket error:', err.message);
      reject(err);
    });
  });
}

// ── Step 3: Handle messages ─────────────────────────────────────────────

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stream a reply word-by-word.
 * Simulates real agent behavior: typing → thinking → streaming deltas → done.
 */
async function streamReply(ws, conversationId, content) {
  const replyText = `Echo: ${content}`;
  const words = replyText.split(' ');

  // Send typing indicator
  send(ws, { type: 'typing', conversationId, activity: 'thinking' });
  await sleep(500);

  // First delta — no messageId, server assigns one
  let messageId = null;

  for (let i = 0; i < words.length; i++) {
    const chunk = (i === 0 ? '' : ' ') + words[i];

    if (i === 0) {
      // First delta
      send(ws, {
        type: 'send_message_delta',
        conversationId,
        delta: chunk,
      });

      // Wait for delta_ack with assignedMessageId
      messageId = await new Promise((resolve) => {
        const handler = (raw) => {
          const event = JSON.parse(raw.toString());
          if (event.type === 'delta_ack' && event.assignedMessageId) {
            ws.removeListener('message', handler);
            resolve(event.assignedMessageId);
          }
        };
        ws.on('message', handler);
      });

      console.log(`[mock-agent] streaming started, messageId: ${messageId}`);
    } else {
      // Subsequent deltas
      send(ws, {
        type: 'send_message_delta',
        conversationId,
        messageId,
        delta: chunk,
      });
    }

    // Simulate realistic typing speed
    await sleep(100 + Math.random() * 150);
  }

  // Done
  send(ws, { type: 'send_message_done', conversationId, messageId });
  console.log(`[mock-agent] streaming done for message ${messageId}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let apiKey;

  if (process.env.AGENT_API_KEY) {
    apiKey = process.env.AGENT_API_KEY;
    console.log('[mock-agent] using API key from env');
  } else {
    const jwt = await getHumanJwt();
    const result = await registerAgent(jwt);
    apiKey = result.apiKey;
  }

  const ws = await connectWs(apiKey);

  // Request conversation list
  send(ws, { type: 'list_conversations' });

  console.log('[mock-agent] waiting for messages...');

  ws.on('message', async (raw) => {
    const event = JSON.parse(raw.toString());

    switch (event.type) {
      case 'conversations':
        console.log(`[mock-agent] ${event.conversations?.length ?? 0} conversations`);
        break;

      case 'conversation_created':
        console.log(`[mock-agent] added to conversation: ${event.conversationId}`);
        break;

      case 'message': {
        const msg = event.message;
        // Don't echo our own messages
        if (msg && msg.content && !msg.content.startsWith('Echo:')) {
          console.log(`[mock-agent] received: "${msg.content}" from ${msg.senderId}`);
          await streamReply(ws, msg.conversationId, msg.content);
          console.log('[mock-agent] reply sent, exiting in 2s...');
          setTimeout(() => {
            ws.close();
            process.exit(0);
          }, 2000);
        }
        break;
      }

      case 'error':
        console.error('[mock-agent] server error:', event.error);
        break;
    }
  });
}

main().catch((err) => {
  console.error('[mock-agent] fatal:', err);
  process.exit(1);
});
