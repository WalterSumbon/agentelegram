#!/usr/bin/env node
/**
 * Mock Agent — E2E test script for M2 (Agent 接入).
 *
 * What it tests:
 * - Agent registration via REST API (API key auth)
 * - WebSocket connection with API key
 * - Receiving a human message
 * - Sending typing indicator (thinking state)
 * - Streaming a reply via send_message_delta + send_message_done
 *
 * Expected behavior:
 * 1. Register agent "echo-bot" via /api/auth/register-agent
 * 2. Connect to WebSocket with the API key
 * 3. Wait for a human to create a conversation and send a message
 * 4. Echo back the message word-by-word (streaming) with typing indicator
 *
 * Usage:
 *   node tests/e2e/mock-agent.mjs
 *
 * Cleanup: the script exits after handling one message. The agent remains in the DB.
 */

import WebSocket from 'ws';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';
const WS_URL = SERVER.replace('http', 'ws');

// ── Step 1: Register agent ──────────────────────────────────────────────────

async function registerAgent() {
  const res = await fetch(`${SERVER}/api/auth/register-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

// ── Step 2: Connect WebSocket ───────────────────────────────────────────────

function connectWs(apiKey) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws?apikey=${encodeURIComponent(apiKey)}`);

    ws.on('open', () => {
      console.log('[mock-agent] WebSocket connected');
      resolve(ws);
    });

    ws.on('error', (err) => {
      console.error('[mock-agent] WebSocket error:', err.message);
      reject(err);
    });
  });
}

// ── Step 3: Handle messages ─────────────────────────────────────────────────

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
  const { apiKey } = await registerAgent();
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
