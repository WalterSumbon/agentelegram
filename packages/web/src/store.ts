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
  type: string;
  name: string;
  displayName: string;
  avatarUrl?: string;
}

export interface ConversationInfo {
  id: string;
  title?: string;
  type: string;
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

interface AppState {
  user: User | null;
  token: string | null;
  conversations: ConversationInfo[];
  activeConversationId: string | null;
  messages: Map<string, ChatMessage[]>; // conversationId → messages
  /** participant id → display info */
  participantCache: Map<string, User>;
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
  participantCache: new Map(),
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
