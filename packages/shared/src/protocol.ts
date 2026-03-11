// ---------------------------------------------------------------------------
// WebSocket Chat Protocol — unified for human & agent
// ---------------------------------------------------------------------------

import type { Message, Conversation } from './types.js';
import type { MgmtAction } from './management.js';

// ---------------------------------------------------------------------------
// Participant → Server events
// ---------------------------------------------------------------------------

export type ClientEventType =
  | 'auth'
  | 'send_message'
  | 'send_message_delta'
  | 'send_message_done'
  | 'typing'
  | 'create_conversation'
  | 'delete_conversation'
  | 'list_conversations'
  | 'get_history'
  | 'mgmt_response';    // agent → server: response to a management request

export interface ClientEvent {
  type: ClientEventType;

  /** Target conversation. Required for message/typing/history events. */
  conversationId?: string;

  // -- auth (must be the first message after connection) --
  /** JWT token for human authentication. */
  token?: string;
  /** API key for agent authentication. */
  apiKey?: string;

  // -- send_message --
  content?: string;
  contentType?: Message['contentType'];

  // -- send_message_delta --
  /** Streaming message ID (server-assigned, returned in delta_ack). */
  messageId?: string;
  delta?: string;

  // -- typing --
  /** Optional detail: 'typing' | 'thinking' | 'tool_calling' | 'reading_file' etc. */
  activity?: string;

  // -- create_conversation --
  title?: string;
  participantIds?: string[];

  // -- get_history --
  /** Cursor for pagination (message ID or timestamp). */
  before?: string;
  limit?: number;

  // -- mgmt_response (agent → server) --
  /** Correlation ID matching the original mgmt_request. */
  requestId?: string;
  /** Whether the management operation succeeded. */
  success?: boolean;
  /** Response payload (action-specific). */
  data?: unknown;
  /** Error message when success is false. */
  mgmtError?: string;
}

// ---------------------------------------------------------------------------
// Server → Participant events
// ---------------------------------------------------------------------------

export type ServerEventType =
  | 'auth_ok'
  | 'message'
  | 'message_delta'
  | 'message_done'
  | 'delta_ack'
  | 'typing'
  | 'conversation_created'
  | 'conversation_updated'
  | 'conversation_deleted'
  | 'conversations'
  | 'history'
  | 'error'
  | 'mgmt_request';     // server → agent: management request forwarded from REST API

export interface ServerEvent {
  type: ServerEventType;

  conversationId?: string;

  // -- auth_ok (response to auth event) --
  /** Authenticated participant ID. */
  participantId?: string;
  /** Authenticated participant name. */
  participantName?: string;
  /** Participant type: 'human' or 'agent'. */
  participantType?: string;

  // -- message / message_done --
  message?: Message;

  // -- message_delta --
  /** Streaming chunk forwarded from a participant. */
  delta?: {
    messageId: string;
    senderId: string;
    content: string;
  };

  // -- message_done --
  messageId?: string;

  // -- delta_ack (response to first send_message_delta) --
  /** Server-assigned message ID for a new streaming message. */
  assignedMessageId?: string;

  // -- typing --
  /** participantId is shared with auth_ok (above). */
  activity?: string;

  // -- conversation_created --
  conversation?: Conversation;

  // -- conversations --
  conversations?: Conversation[];

  // -- history --
  messages?: Message[];
  hasMore?: boolean;

  // -- error --
  error?: {
    code: string;
    message: string;
  };

  // -- mgmt_request (server → agent) --
  /** Correlation ID for matching request → response. */
  requestId?: string;
  /** Management action to perform. */
  action?: MgmtAction;
  /** Action-specific payload. */
  payload?: Record<string, unknown>;

  /** Allow additional fields for forward compatibility. */
  [key: string]: unknown;
}
