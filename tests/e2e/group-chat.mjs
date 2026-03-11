#!/usr/bin/env node
/**
 * Group Chat E2E Test — M3 验收测试.
 *
 * What it tests:
 * 1. Register 1 human + 2 agents (with JWT auth for agent registration)
 * 2. All three connect via WebSocket (post-connection auth)
 * 3. Human creates a group conversation with both agents
 * 4. All three receive conversation_created
 * 5. Human sends a message → both agents receive it
 * 6. Both agents reply simultaneously (concurrent streaming)
 * 7. Human receives interleaved deltas from both agents
 * 8. Verify final message count via get_history
 *
 * Usage:
 *   node tests/e2e/group-chat.mjs
 *
 * Environment:
 *   SERVER_URL — default http://localhost:4000
 */

import WebSocket from 'ws';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';
const WS_URL = SERVER.replace('http', 'ws');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function registerOrLoginHuman(name, password) {
  let res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  if (res.ok) return (await res.json()).token;

  res = await fetch(`${SERVER}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName: name, password }),
  });
  if (!res.ok) throw new Error(`Register human failed: ${await res.text()}`);
  return (await res.json()).token;
}

async function registerAgent(jwt, name, displayName) {
  const res = await fetch(`${SERVER}/api/auth/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name, displayName }),
  });
  if (res.status === 409) {
    // Already exists — can't get the key again; need env
    const key = process.env[`${name.toUpperCase().replace(/-/g, '_')}_KEY`];
    if (key) return key;
    throw new Error(`Agent "${name}" already exists. Set ${name.toUpperCase().replace(/-/g, '_')}_KEY env var.`);
  }
  if (!res.ok) throw new Error(`Register agent failed: ${await res.text()}`);
  const data = await res.json();
  console.log(`[setup] registered agent: ${data.participant.name} (${data.participant.id})`);
  return data.apiKey;
}

/**
 * Connect to WebSocket and authenticate.
 * Returns { ws, participantId, events[] }.
 */
function connectAndAuth(credential) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws`);
    const events = [];

    ws.on('open', () => {
      // Post-connection auth
      if (credential.token) {
        ws.send(JSON.stringify({ type: 'auth', token: credential.token }));
      } else {
        ws.send(JSON.stringify({ type: 'auth', apiKey: credential.apiKey }));
      }
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') {
        console.log(`[ws] authenticated: ${event.participantName} (${event.participantType})`);
        // Set up event collection
        ws.on('message', (raw2) => {
          const ev = JSON.parse(raw2.toString());
          events.push(ev);
        });
        resolve({ ws, participantId: event.participantId, participantName: event.participantName, events });
      } else if (event.type === 'error') {
        reject(new Error(`Auth failed: ${event.error?.message}`));
      }
    });

    ws.on('error', (err) => reject(err));

    setTimeout(() => reject(new Error('Auth timeout')), 10000);
  });
}

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

function waitForEvent(events, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // Check existing events first
    const existing = events.find(predicate);
    if (existing) {
      events.splice(events.indexOf(existing), 1);
      resolve(existing);
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      const found = events.find(predicate);
      if (found) {
        events.splice(events.indexOf(found), 1);
        clearInterval(interval);
        resolve(found);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for event`));
      }
    }, 50);
  });
}

function collectEvents(events, predicate, durationMs = 2000) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const collected = events.filter(predicate);
      resolve(collected);
    }, durationMs);
  });
}

// ── Main Test ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== M3 Group Chat E2E Test ===\n');

  // ── Step 1: Setup — register human + 2 agents ──
  console.log('[Step 1] Setup: register human + 2 agents');
  const humanJwt = await registerOrLoginHuman('group-test-human', 'testpass');
  const agent1Key = await registerAgent(humanJwt, 'group-agent-1', 'Agent Alpha');
  const agent2Key = await registerAgent(humanJwt, 'group-agent-2', 'Agent Beta');
  console.log('[setup] all participants registered\n');

  // ── Step 2: Connect all three ──
  console.log('[Step 2] Connect all three via WebSocket');
  const human = await connectAndAuth({ token: humanJwt });
  const agent1 = await connectAndAuth({ apiKey: agent1Key });
  const agent2 = await connectAndAuth({ apiKey: agent2Key });
  console.log('');

  // ── Step 3: Human creates group conversation ──
  console.log('[Step 3] Human creates group conversation');
  send(human.ws, {
    type: 'create_conversation',
    title: 'Test Group',
    participantIds: [human.participantId, agent1.participantId, agent2.participantId],
  });

  // All three should receive conversation_created
  const humanConvEvent = await waitForEvent(human.events, (e) => e.type === 'conversation_created');
  const agent1ConvEvent = await waitForEvent(agent1.events, (e) => e.type === 'conversation_created');
  const agent2ConvEvent = await waitForEvent(agent2.events, (e) => e.type === 'conversation_created');

  const convId = humanConvEvent.conversationId;
  assert(!!convId, 'Conversation created with ID');
  assert(humanConvEvent.conversation?.type === 'group', 'Conversation type is "group"');
  assert(agent1ConvEvent.conversationId === convId, 'Agent 1 received same conversationId');
  assert(agent2ConvEvent.conversationId === convId, 'Agent 2 received same conversationId');
  console.log(`[info] conversationId: ${convId}\n`);

  // ── Step 4: Human sends a message ──
  console.log('[Step 4] Human sends message to group');
  send(human.ws, {
    type: 'send_message',
    conversationId: convId,
    content: 'Hello agents!',
    contentType: 'text',
  });

  // Both agents should receive it
  const agent1Msg = await waitForEvent(agent1.events, (e) => e.type === 'message' && e.message?.content === 'Hello agents!');
  const agent2Msg = await waitForEvent(agent2.events, (e) => e.type === 'message' && e.message?.content === 'Hello agents!');
  // Human also receives own message (server echo)
  const humanMsg = await waitForEvent(human.events, (e) => e.type === 'message' && e.message?.content === 'Hello agents!');

  assert(!!agent1Msg, 'Agent 1 received human message');
  assert(!!agent2Msg, 'Agent 2 received human message');
  assert(agent1Msg.message.senderId === human.participantId, 'Agent 1 sees correct senderId');
  assert(agent2Msg.message.senderId === human.participantId, 'Agent 2 sees correct senderId');
  console.log('');

  // ── Step 5: Both agents reply simultaneously (concurrent streaming) ──
  console.log('[Step 5] Both agents reply simultaneously (concurrent streaming)');

  // Agent 1 starts streaming
  send(agent1.ws, { type: 'typing', conversationId: convId, activity: 'thinking' });
  send(agent2.ws, { type: 'typing', conversationId: convId, activity: 'thinking' });
  await sleep(200);

  // Agent 1 first delta
  send(agent1.ws, { type: 'send_message_delta', conversationId: convId, delta: 'Alpha: ' });
  const ack1 = await waitForEvent(agent1.events, (e) => e.type === 'delta_ack');
  const msgId1 = ack1.assignedMessageId;

  // Agent 2 first delta (interleaved)
  send(agent2.ws, { type: 'send_message_delta', conversationId: convId, delta: 'Beta: ' });
  const ack2 = await waitForEvent(agent2.events, (e) => e.type === 'delta_ack');
  const msgId2 = ack2.assignedMessageId;

  assert(msgId1 !== msgId2, 'Two agents got different messageIds (independent streams)');
  console.log(`[info] Agent 1 messageId: ${msgId1}`);
  console.log(`[info] Agent 2 messageId: ${msgId2}`);

  // Continue streaming interleaved
  for (const word of ['Hello', ' from', ' Alpha!']) {
    send(agent1.ws, { type: 'send_message_delta', conversationId: convId, messageId: msgId1, delta: word });
    await sleep(50);
  }
  for (const word of ['Greetings', ' from', ' Beta!']) {
    send(agent2.ws, { type: 'send_message_delta', conversationId: convId, messageId: msgId2, delta: word });
    await sleep(50);
  }

  // Both done
  send(agent1.ws, { type: 'send_message_done', conversationId: convId, messageId: msgId1 });
  send(agent2.ws, { type: 'send_message_done', conversationId: convId, messageId: msgId2 });

  // Human should receive message_done for both
  const humanDone1 = await waitForEvent(human.events, (e) => e.type === 'message_done' && e.messageId === msgId1);
  const humanDone2 = await waitForEvent(human.events, (e) => e.type === 'message_done' && e.messageId === msgId2);

  assert(!!humanDone1, 'Human received message_done from Agent 1');
  assert(!!humanDone2, 'Human received message_done from Agent 2');
  assert(humanDone1.message?.content === 'Alpha: Hello from Alpha!', 'Agent 1 message content correct');
  assert(humanDone2.message?.content === 'Beta: Greetings from Beta!', 'Agent 2 message content correct');

  // Agent 1 should see Agent 2's message_done (and vice versa)
  const agent1SeesAgent2 = await waitForEvent(agent1.events, (e) => e.type === 'message_done' && e.messageId === msgId2);
  const agent2SeesAgent1 = await waitForEvent(agent2.events, (e) => e.type === 'message_done' && e.messageId === msgId1);
  assert(!!agent1SeesAgent2, 'Agent 1 received Agent 2\'s final message');
  assert(!!agent2SeesAgent1, 'Agent 2 received Agent 1\'s final message');
  console.log('');

  // ── Step 6: Verify history ──
  console.log('[Step 6] Verify message history');
  send(human.ws, { type: 'get_history', conversationId: convId, limit: 50 });
  const history = await waitForEvent(human.events, (e) => e.type === 'history');

  assert(history.messages?.length === 3, `History has 3 messages (got ${history.messages?.length})`);
  if (history.messages?.length >= 3) {
    const senders = history.messages.map((m) => m.senderId);
    assert(senders.includes(human.participantId), 'History includes human message');
    assert(senders.includes(agent1.participantId), 'History includes Agent 1 message');
    assert(senders.includes(agent2.participantId), 'History includes Agent 2 message');
  }
  console.log('');

  // ── Summary ──
  console.log('=== Test Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  // Cleanup
  human.ws.close();
  agent1.ws.close();
  agent2.ws.close();

  if (failed > 0) {
    console.log('\n❌ SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\n💥 FATAL:', err);
  process.exit(1);
});
