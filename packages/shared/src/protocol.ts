// ---------------------------------------------------------------------------
// WebSocket Chat Protocol — unified for human & agent
// ---------------------------------------------------------------------------

import type { Message, Conversation } from './types.js';

// ---------------------------------------------------------------------------
// Participant → Server events
// ---------------------------------------------------------------------------

export type ClientEventType =
  | 'send_message'
  | 'send_message_delta'
  | 'send_message_done'
  | 'typing'
  | 'create_conversation'
  | 'delete_conversation'
  | 'list_conversations'
  | 'get_history';

export interface ClientEvent {
  type: ClientEventType;

  /** Target conversation. Required for message/typing/history events. */
  conversationId?: string;

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
}

// ---------------------------------------------------------------------------
// Server → Participant events
// ---------------------------------------------------------------------------

export type ServerEventType =
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
  | 'error';

export interface ServerEvent {
  type: ServerEventType;

  conversationId?: string;

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
  /** Who is typing. */
  participantId?: string;
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

  /** Allow additional fields for forward compatibility. */
  [key: string]: unknown;
}
