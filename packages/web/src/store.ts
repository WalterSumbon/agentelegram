/**
 * Lightweight global state store using React-external state + useSyncExternalStore.
 *
 * Keeps things simple — no Zustand/Jotai dependency for M1.
 */
import { useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  type: 'human' | 'agent';
  name: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ConversationInfo {
  id: string;
  title?: string;
  type: 'direct' | 'group';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Display label (computed from members or title) */
  label?: string;
  /** Last message preview */
  lastMessage?: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  contentType: string;
  timestamp: number;
}

/** A streaming (in-progress) message — not yet finalized. */
export interface StreamingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  content: string; // accumulated so far
}

/** Typing indicator state */
export interface TypingState {
  participantId: string;
  activity: string;
  /** Auto-expire timestamp */
  expiresAt: number;
}

interface AppState {
  user: User | null;
  token: string | null;
  conversations: ConversationInfo[];
  activeConversationId: string | null;
  messages: Map<string, ChatMessage[]>; // conversationId → messages
  /** In-progress streaming messages: messageId → StreamingMessage */
  streamingMessages: Map<string, StreamingMessage>;
  /** Active typing indicators: conversationId → TypingState[] */
  typingStates: Map<string, TypingState[]>;
  /** participant id → display info */
  participantCache: Map<string, User>;
  /** conversationId → member list (for group display) */
  conversationMembers: Map<string, User[]>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state: AppState = {
  user: null,
  token: null,
  conversations: [],
  activeConversationId: null,
  messages: new Map(),
  streamingMessages: new Map(),
  typingStates: new Map(),
  participantCache: new Map(),
  conversationMembers: new Map(),
};

let listeners: (() => void)[] = [];

function emit() {
  state = { ...state }; // new reference to trigger re-render
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot() {
  return state;
}

export function useStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function setAuth(user: User, token: string) {
  state.user = user;
  state.token = token;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  emit();
}

export function clearAuth() {
  state.user = null;
  state.token = null;
  state.conversations = [];
  state.activeConversationId = null;
  state.messages = new Map();
  state.streamingMessages = new Map();
  state.typingStates = new Map();
  state.conversationMembers = new Map();
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  emit();
}

export function loadAuthFromStorage(): boolean {
  const token = localStorage.getItem('token');
  const userJson = localStorage.getItem('user');
  if (token && userJson) {
    try {
      state.user = JSON.parse(userJson);
      state.token = token;
      emit();
      return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function setConversations(conversations: ConversationInfo[]) {
  state.conversations = conversations;
  emit();
}

export function addConversation(conv: ConversationInfo) {
  // Avoid duplicates
  if (!state.conversations.find((c) => c.id === conv.id)) {
    state.conversations = [conv, ...state.conversations];
    emit();
  }
}

export function setActiveConversation(id: string | null) {
  state.activeConversationId = id;
  emit();
}

export function setMessages(conversationId: string, messages: ChatMessage[]) {
  state.messages = new Map(state.messages);
  state.messages.set(conversationId, messages);
  emit();
}

export function addMessage(message: ChatMessage) {
  state.messages = new Map(state.messages);
  const existing = state.messages.get(message.conversationId) ?? [];
  // Avoid duplicates
  if (!existing.find((m) => m.id === message.id)) {
    state.messages.set(message.conversationId, [...existing, message]);
  }

  // Update conversation's updatedAt + lastMessage
  state.conversations = state.conversations.map((c) =>
    c.id === message.conversationId
      ? { ...c, updatedAt: message.timestamp, lastMessage: message.content.slice(0, 60) }
      : c
  );
  // Re-sort by updatedAt
  state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);

  emit();
}

export function cacheParticipant(p: User) {
  state.participantCache = new Map(state.participantCache);
  state.participantCache.set(p.id, p);
  emit();
}

export function cacheParticipants(participants: User[]) {
  state.participantCache = new Map(state.participantCache);
  for (const p of participants) {
    state.participantCache.set(p.id, p);
  }
  emit();
}

export function getParticipantName(id: string): string {
  return state.participantCache.get(id)?.displayName ?? id.slice(0, 8);
}

export function setConversationMembers(conversationId: string, members: User[]) {
  state.conversationMembers = new Map(state.conversationMembers);
  state.conversationMembers.set(conversationId, members);
  emit();
}

export function getConversationMembersList(conversationId: string): User[] {
  return state.conversationMembers.get(conversationId) ?? [];
}

// ---------------------------------------------------------------------------
// Streaming message actions
// ---------------------------------------------------------------------------

export function applyDelta(conversationId: string, messageId: string, senderId: string, deltaContent: string) {
  state.streamingMessages = new Map(state.streamingMessages);
  const existing = state.streamingMessages.get(messageId);
  if (existing) {
    state.streamingMessages.set(messageId, {
      ...existing,
      content: existing.content + deltaContent,
    });
  } else {
    state.streamingMessages.set(messageId, {
      id: messageId,
      conversationId,
      senderId,
      content: deltaContent,
    });
  }
  // Clear typing indicator for this participant (they're now streaming)
  clearTyping(conversationId, senderId);
  emit();
}

export function finalizeStreamingMessage(messageId: string, finalMessage?: ChatMessage) {
  const streaming = state.streamingMessages.get(messageId);
  state.streamingMessages = new Map(state.streamingMessages);
  state.streamingMessages.delete(messageId);

  if (finalMessage) {
    // Add as a regular completed message
    addMessage(finalMessage);
  } else if (streaming) {
    // Fallback: construct from streaming state
    addMessage({
      id: streaming.id,
      conversationId: streaming.conversationId,
      senderId: streaming.senderId,
      content: streaming.content,
      contentType: 'text',
      timestamp: Date.now(),
    });
  }
  // emit() is called by addMessage
}

/**
 * Get all streaming messages for a given conversation.
 */
export function getStreamingMessages(conversationId: string): StreamingMessage[] {
  const result: StreamingMessage[] = [];
  for (const sm of state.streamingMessages.values()) {
    if (sm.conversationId === conversationId) {
      result.push(sm);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Typing state actions
// ---------------------------------------------------------------------------

const TYPING_TIMEOUT_MS = 5000;

export function setTyping(conversationId: string, participantId: string, activity: string) {
  state.typingStates = new Map(state.typingStates);
  const existing = state.typingStates.get(conversationId) ?? [];
  const filtered = existing.filter((t) => t.participantId !== participantId);
  filtered.push({ participantId, activity, expiresAt: Date.now() + TYPING_TIMEOUT_MS });
  state.typingStates.set(conversationId, filtered);
  emit();

  // Auto-expire
  setTimeout(() => {
    clearTyping(conversationId, participantId);
  }, TYPING_TIMEOUT_MS);
}

export function clearTyping(conversationId: string, participantId: string) {
  const existing = state.typingStates.get(conversationId);
  if (!existing) return;
  const filtered = existing.filter((t) => t.participantId !== participantId);
  state.typingStates = new Map(state.typingStates);
  if (filtered.length === 0) {
    state.typingStates.delete(conversationId);
  } else {
    state.typingStates.set(conversationId, filtered);
  }
  emit();
}

export function getTypingStates(conversationId: string): TypingState[] {
  return (state.typingStates.get(conversationId) ?? []).filter((t) => t.expiresAt > Date.now());
}
