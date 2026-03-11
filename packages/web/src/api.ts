/**
 * REST API client helpers.
 */

const API_BASE = '/api';

/** Get stored JWT for authenticated API calls */
function getToken(): string | null {
  return localStorage.getItem('token');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface AuthResponse {
  participant: {
    id: string;
    type: 'human' | 'agent';
    name: string;
    displayName: string;
    avatarUrl?: string;
    createdAt: number;
  };
  token: string;
}

export async function register(name: string, displayName: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, displayName, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `register failed: ${res.status}`);
  }
  return res.json();
}

export async function login(name: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `login failed: ${res.status}`);
  }
  return res.json();
}

export async function getMe(token: string) {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('not authenticated');
  return res.json();
}

export async function listParticipants(): Promise<AuthResponse['participant'][]> {
  const res = await fetch(`${API_BASE}/participants`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('failed to fetch participants');
  return res.json();
}

export async function getConversationMembers(conversationId: string): Promise<AuthResponse['participant'][]> {
  const res = await fetch(`${API_BASE}/conversations/${conversationId}/members`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('failed to fetch members');
  return res.json();
}
