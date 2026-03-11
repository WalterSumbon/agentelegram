/**
 * WebSocket chat protocol handler.
 *
 * Authenticates connections via:
 *   - JWT token (query param `token`) — for humans
 *   - API key (query param `apikey`) — for agents
 *
 * Then handles the unified chat protocol events.
 */
import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, verifyApiKey } from './auth.js';
import { getPool } from './db.js';
import type { ClientEvent, ServerEvent } from '@agentelegram/shared';

interface AuthPayload {
  sub: string;   // participant id
  name: string;
  type: string;
}

/** participantId → Set of active WebSocket connections */
const connections = new Map<string, Set<WebSocket>>();

/**
 * In-progress streaming messages: messageId → accumulated state.
 * When an agent sends deltas, we accumulate content here until send_message_done.
 */
interface StreamingMessage {
  messageId: string;
  conversationId: string;
  senderId: string;
  content: string;      // accumulated content so far
  contentType: string;
  startedAt: number;
}
const streamingMessages = new Map<string, StreamingMessage>();

/**
 * Set up WebSocket server event handling.
 */
export function setupWsHandler(wss: WebSocketServer): void {
  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const apikey = url.searchParams.get('apikey');

    if (!token && !apikey) {
      sendEvent(ws, { type: 'error', error: { code: 'AUTH_REQUIRED', message: 'missing token or apikey' } });
      ws.close(4001, 'missing credentials');
      return;
    }

    let auth: AuthPayload;

    if (token) {
      // JWT auth (human)
      try {
        auth = jwt.verify(token, JWT_SECRET) as AuthPayload;
      } catch {
        sendEvent(ws, { type: 'error', error: { code: 'AUTH_FAILED', message: 'invalid token' } });
        ws.close(4001, 'invalid token');
        return;
      }
    } else {
      // API key auth (agent)
      const result = await verifyApiKey(apikey!);
      if (!result) {
        sendEvent(ws, { type: 'error', error: { code: 'AUTH_FAILED', message: 'invalid api key' } });
        ws.close(4001, 'invalid api key');
        return;
      }
      auth = result;
    }

    console.log(`[ws] authenticated: ${auth.name} (${auth.type}, ${auth.sub})`);

    // Register connection
    if (!connections.has(auth.sub)) {
      connections.set(auth.sub, new Set());
    }
    connections.get(auth.sub)!.add(ws);

    ws.on('message', async (raw) => {
      try {
        const event: ClientEvent = JSON.parse(raw.toString());
        await handleClientEvent(ws, auth, event);
      } catch (err) {
        console.error('[ws] bad message:', err);
        sendEvent(ws, { type: 'error', error: { code: 'BAD_MESSAGE', message: 'invalid JSON' } });
      }
    });

    ws.on('close', async () => {
      console.log(`[ws] disconnected: ${auth.name}`);
      const set = connections.get(auth.sub);
      if (set) {
        set.delete(ws);
        if (set.size === 0) connections.delete(auth.sub);
      }

      // Clean up orphaned streaming messages from this participant.
      // If agent disconnects mid-stream, persist partial content or delete empty rows.
      for (const [msgId, streaming] of streamingMessages.entries()) {
        if (streaming.senderId !== auth.sub) continue;
        streamingMessages.delete(msgId);
        console.log(`[ws] cleaning up orphaned stream: ${msgId} from ${auth.name}`);
        try {
          const db = getPool();
          if (streaming.content.length > 0) {
            // Persist partial content so it's not lost
            await db.query(`UPDATE messages SET content = $1 WHERE id = $2`, [streaming.content, msgId]);
          } else {
            // Empty message row — delete it
            await db.query(`DELETE FROM messages WHERE id = $1`, [msgId]);
          }
        } catch (err) {
          console.error(`[ws] failed to clean up stream ${msgId}:`, err);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleClientEvent(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  switch (event.type) {
    case 'create_conversation':
      return handleCreateConversation(ws, auth, event);
    case 'list_conversations':
      return handleListConversations(ws, auth);
    case 'send_message':
      return handleSendMessage(ws, auth, event);
    case 'send_message_delta':
      return handleSendMessageDelta(ws, auth, event);
    case 'send_message_done':
      return handleSendMessageDone(ws, auth, event);
    case 'get_history':
      return handleGetHistory(ws, auth, event);
    case 'typing':
      return handleTyping(auth, event);
    default:
      sendEvent(ws, { type: 'error', error: { code: 'UNKNOWN_EVENT', message: `unknown event: ${event.type}` } });
  }
}

/**
 * create_conversation — create a 1:1 or group conversation.
 */
async function handleCreateConversation(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  const db = getPool();
  const participantIds = event.participantIds ?? [];

  // Ensure creator is included
  if (!participantIds.includes(auth.sub)) {
    participantIds.push(auth.sub);
  }

  const convType = participantIds.length <= 2 ? 'direct' : 'group';

  // Create conversation
  const convResult = await db.query(
    `INSERT INTO conversations (title, type, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, title, type, created_by, created_at, updated_at`,
    [event.title ?? null, convType, auth.sub]
  );
  const conv = convResult.rows[0];

  // Add participants
  for (const pid of participantIds) {
    await db.query(
      `INSERT INTO conversation_participants (conversation_id, participant_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [conv.id, pid, pid === auth.sub ? 'owner' : 'member']
    );
  }

  const conversation = {
    id: conv.id,
    title: conv.title,
    type: conv.type,
    createdBy: conv.created_by,
    createdAt: Number(conv.created_at),
    updatedAt: Number(conv.updated_at),
  };

  const fullEvent = { type: 'conversation_created' as const, conversationId: conv.id, conversation };
  for (const pid of participantIds) {
    broadcastToParticipant(pid, fullEvent);
  }
}

/**
 * list_conversations — return all conversations the user is a member of.
 */
async function handleListConversations(ws: WebSocket, auth: AuthPayload): Promise<void> {
  const db = getPool();

  const result = await db.query(
    `SELECT c.id, c.title, c.type, c.created_by, c.created_at, c.updated_at
     FROM conversations c
     JOIN conversation_participants cp ON cp.conversation_id = c.id
     WHERE cp.participant_id = $1
     ORDER BY c.updated_at DESC`,
    [auth.sub]
  );

  const conversations = result.rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    createdBy: r.created_by,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));

  sendEvent(ws, { type: 'conversations', conversations });
}

/**
 * send_message — persist complete message and fan-out.
 */
async function handleSendMessage(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  if (!event.conversationId || !event.content) {
    sendEvent(ws, { type: 'error', error: { code: 'BAD_REQUEST', message: 'conversationId and content required' } });
    return;
  }

  const db = getPool();

  // Verify sender is a member
  const memberCheck = await db.query(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND participant_id = $2`,
    [event.conversationId, auth.sub]
  );
  if (memberCheck.rows.length === 0) {
    sendEvent(ws, { type: 'error', error: { code: 'FORBIDDEN', message: 'not a member of this conversation' } });
    return;
  }

  // Insert message
  const msgResult = await db.query(
    `INSERT INTO messages (conversation_id, sender_id, content, content_type)
     VALUES ($1, $2, $3, $4)
     RETURNING id, conversation_id, sender_id, content, content_type, timestamp`,
    [event.conversationId, auth.sub, event.content, event.contentType ?? 'text']
  );
  const row = msgResult.rows[0];

  await db.query(
    `UPDATE conversations SET updated_at = $1 WHERE id = $2`,
    [row.timestamp, event.conversationId]
  );

  const message = {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    content: row.content,
    contentType: row.content_type,
    timestamp: Number(row.timestamp),
  };

  // Fan-out
  const participants = await db.query(
    `SELECT participant_id FROM conversation_participants WHERE conversation_id = $1`,
    [event.conversationId]
  );

  const serverEvent: ServerEvent = { type: 'message', conversationId: event.conversationId, message };
  for (const p of participants.rows) {
    broadcastToParticipant(p.participant_id, serverEvent);
  }
}

/**
 * send_message_delta — streaming chunk from a participant (typically agent).
 *
 * First delta (no messageId): server allocates a message row, returns delta_ack with assignedMessageId.
 * Subsequent deltas (with messageId): server accumulates content and forwards to other participants.
 */
async function handleSendMessageDelta(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  if (!event.conversationId || event.delta === undefined) {
    sendEvent(ws, { type: 'error', error: { code: 'BAD_REQUEST', message: 'conversationId and delta required' } });
    return;
  }

  const db = getPool();
  let messageId = event.messageId;

  if (!messageId) {
    // First delta — allocate a message row with empty content (will be updated on done)
    const memberCheck = await db.query(
      `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND participant_id = $2`,
      [event.conversationId, auth.sub]
    );
    if (memberCheck.rows.length === 0) {
      sendEvent(ws, { type: 'error', error: { code: 'FORBIDDEN', message: 'not a member of this conversation' } });
      return;
    }

    const msgResult = await db.query(
      `INSERT INTO messages (conversation_id, sender_id, content, content_type)
       VALUES ($1, $2, '', 'text')
       RETURNING id, timestamp`,
      [event.conversationId, auth.sub]
    );
    messageId = msgResult.rows[0].id;

    // Initialize streaming state
    streamingMessages.set(messageId, {
      messageId,
      conversationId: event.conversationId,
      senderId: auth.sub,
      content: event.delta,
      contentType: 'text',
      startedAt: Number(msgResult.rows[0].timestamp),
    });

    // Ack with the assigned message ID
    sendEvent(ws, { type: 'delta_ack', assignedMessageId: messageId, conversationId: event.conversationId });
  } else {
    // Subsequent delta — accumulate
    const streaming = streamingMessages.get(messageId);
    if (!streaming) {
      sendEvent(ws, { type: 'error', error: { code: 'NOT_FOUND', message: 'no streaming message found for this messageId' } });
      return;
    }
    if (streaming.senderId !== auth.sub) {
      sendEvent(ws, { type: 'error', error: { code: 'FORBIDDEN', message: 'cannot append to another participant\'s stream' } });
      return;
    }
    streaming.content += event.delta;
  }

  // Forward delta to other participants in the conversation
  const participants = await db.query(
    `SELECT participant_id FROM conversation_participants WHERE conversation_id = $1`,
    [event.conversationId]
  );

  const deltaEvent: ServerEvent = {
    type: 'message_delta',
    conversationId: event.conversationId,
    delta: {
      messageId: messageId!,
      senderId: auth.sub,
      content: event.delta,
    },
  };

  for (const p of participants.rows) {
    if (p.participant_id !== auth.sub) {
      broadcastToParticipant(p.participant_id, deltaEvent);
    }
  }
}

/**
 * send_message_done — streaming complete.
 * Persist the accumulated content and broadcast message_done + final message.
 */
async function handleSendMessageDone(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  const messageId = event.messageId;
  if (!messageId) {
    sendEvent(ws, { type: 'error', error: { code: 'BAD_REQUEST', message: 'messageId required for send_message_done' } });
    return;
  }

  const streaming = streamingMessages.get(messageId);
  if (!streaming) {
    sendEvent(ws, { type: 'error', error: { code: 'NOT_FOUND', message: 'no streaming message found' } });
    return;
  }
  if (streaming.senderId !== auth.sub) {
    sendEvent(ws, { type: 'error', error: { code: 'FORBIDDEN', message: 'cannot finalize another participant\'s stream' } });
    return;
  }

  streamingMessages.delete(messageId);

  const db = getPool();

  // Persist final content
  const result = await db.query(
    `UPDATE messages SET content = $1 WHERE id = $2 RETURNING timestamp`,
    [streaming.content, messageId]
  );
  const timestamp = Number(result.rows[0].timestamp);

  // Update conversation updated_at
  await db.query(
    `UPDATE conversations SET updated_at = $1 WHERE id = $2`,
    [timestamp, streaming.conversationId]
  );

  const finalMessage = {
    id: messageId,
    conversationId: streaming.conversationId,
    senderId: streaming.senderId,
    content: streaming.content,
    contentType: streaming.contentType,
    timestamp,
  };

  // Broadcast message_done + full message to all participants
  const participants = await db.query(
    `SELECT participant_id FROM conversation_participants WHERE conversation_id = $1`,
    [streaming.conversationId]
  );

  const doneEvent = {
    type: 'message_done' as const,
    conversationId: streaming.conversationId,
    messageId,
    message: finalMessage,
  };

  for (const p of participants.rows) {
    broadcastToParticipant(p.participant_id, doneEvent);
  }
}

/**
 * get_history — paginated message history for a conversation.
 */
async function handleGetHistory(ws: WebSocket, auth: AuthPayload, event: ClientEvent): Promise<void> {
  if (!event.conversationId) {
    sendEvent(ws, { type: 'error', error: { code: 'BAD_REQUEST', message: 'conversationId required' } });
    return;
  }

  const db = getPool();
  const limit = Math.min(event.limit ?? 50, 100);

  let query: string;
  let params: unknown[];

  if (event.before) {
    query = `SELECT id, conversation_id, sender_id, content, content_type, timestamp
             FROM messages
             WHERE conversation_id = $1 AND timestamp < $2
             ORDER BY timestamp DESC
             LIMIT $3`;
    params = [event.conversationId, event.before, limit + 1];
  } else {
    query = `SELECT id, conversation_id, sender_id, content, content_type, timestamp
             FROM messages
             WHERE conversation_id = $1
             ORDER BY timestamp DESC
             LIMIT $2`;
    params = [event.conversationId, limit + 1];
  }

  const result = await db.query(query, params);
  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

  const messages = rows
    .map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      content: r.content,
      contentType: r.content_type,
      timestamp: Number(r.timestamp),
    }))
    .reverse(); // chronological order

  sendEvent(ws, {
    type: 'history',
    conversationId: event.conversationId,
    messages,
    hasMore,
  });
}

/**
 * typing — forward to other participants in the conversation.
 */
async function handleTyping(auth: AuthPayload, event: ClientEvent): Promise<void> {
  if (!event.conversationId) return;

  const db = getPool();
  const participants = await db.query(
    `SELECT participant_id FROM conversation_participants WHERE conversation_id = $1`,
    [event.conversationId]
  );

  const typingEvent: ServerEvent = {
    type: 'typing',
    conversationId: event.conversationId,
    participantId: auth.sub,
    activity: event.activity ?? 'typing',
  };

  for (const p of participants.rows) {
    if (p.participant_id !== auth.sub) {
      broadcastToParticipant(p.participant_id, typingEvent);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendEvent(ws: WebSocket, event: ServerEvent & Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function broadcastToParticipant(participantId: string, event: ServerEvent & Record<string, unknown>): void {
  const sockets = connections.get(participantId);
  if (!sockets) return;
  const data = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  }
}
