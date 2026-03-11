// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

/** Participant — human or agent, unified. */
export interface Participant {
  id: string;
  type: 'human' | 'agent';
  name: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: number;
}

/** Conversation — direct (1:1) or group. */
export interface Conversation {
  id: string;
  title?: string;
  type: 'direct' | 'group';
  createdBy: string; // participant id
  createdAt: number;
  updatedAt: number;
}

/** Message — append-only, immutable once created. */
export interface Message {
  id: string;
  conversationId: string;
  senderId: string; // participant id
  content: string;
  contentType: 'text' | 'file' | 'image' | 'mixed';
  attachments?: Attachment[];
  timestamp: number; // server-assigned
}

export interface Attachment {
  id: string;
  fileName: string;
  mimeType: string;
  url: string;
  size?: number;
}
