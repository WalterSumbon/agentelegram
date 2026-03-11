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

// ---------------------------------------------------------------------------
// Agent Management API
// ---------------------------------------------------------------------------

export interface AgentInfo {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: number;
  online: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
  enabled: boolean;
  type: 'skill' | 'skillset';
  children?: SkillInfo[];
}

export interface MemoryOverview {
  core: Record<string, unknown>;
  extended: { key: string; description?: string; size?: number }[];
}

export interface CronJob {
  id: string;
  schedule: string;
  description: string;
  enabled: boolean;
  lastRun?: number | null;
  nextRun?: number | null;
}

export interface McpServerInfo {
  name: string;
  enabled: boolean;
  type: string;
  toolCount?: number;
  tools?: string[];
}

export interface MgmtResponse<T = unknown> {
  success: boolean;
  data: T;
}

async function mgmtGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/agents${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  const json = await res.json();
  // Direct array/object responses (list agents) or wrapped { success, data }
  return json.data !== undefined ? json.data : json;
}

async function mgmtMutate<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/agents${path}`, {
    method,
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? `request failed: ${res.status}`);
  }
  const json = await res.json();
  return json.data !== undefined ? json.data : json;
}

export async function listAgents(): Promise<AgentInfo[]> {
  return mgmtGet<AgentInfo[]>('');
}

export async function getAgentSkills(agentId: string): Promise<SkillInfo[]> {
  return mgmtGet<SkillInfo[]>(`/${encodeURIComponent(agentId)}/skills`);
}

export async function updateAgentSkill(agentId: string, name: string, enabled: boolean): Promise<SkillInfo> {
  return mgmtMutate<SkillInfo>('PATCH', `/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(name)}`, { enabled });
}

export async function getAgentMemory(agentId: string): Promise<MemoryOverview> {
  return mgmtGet<MemoryOverview>(`/${encodeURIComponent(agentId)}/memory`);
}

export async function readAgentMemory(agentId: string, tier: string, key: string): Promise<unknown> {
  return mgmtGet<unknown>(`/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(tier)}/${encodeURIComponent(key)}`);
}

export async function writeAgentMemory(agentId: string, tier: string, key: string, value: unknown, description?: string): Promise<unknown> {
  return mgmtMutate<unknown>('PUT', `/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(tier)}/${encodeURIComponent(key)}`, { value, description });
}

export async function deleteAgentMemory(agentId: string, tier: string, key: string): Promise<unknown> {
  return mgmtMutate<unknown>('DELETE', `/${encodeURIComponent(agentId)}/memory/${encodeURIComponent(tier)}/${encodeURIComponent(key)}`);
}

export async function getAgentCron(agentId: string): Promise<CronJob[]> {
  return mgmtGet<CronJob[]>(`/${encodeURIComponent(agentId)}/cron`);
}

export async function createAgentCron(agentId: string, schedule: string, description: string): Promise<CronJob> {
  return mgmtMutate<CronJob>('POST', `/${encodeURIComponent(agentId)}/cron`, { schedule, description });
}

export async function updateAgentCron(agentId: string, cronId: string, updates: Partial<CronJob>): Promise<CronJob> {
  return mgmtMutate<CronJob>('PATCH', `/${encodeURIComponent(agentId)}/cron/${encodeURIComponent(cronId)}`, updates);
}

export async function deleteAgentCron(agentId: string, cronId: string): Promise<unknown> {
  return mgmtMutate<unknown>('DELETE', `/${encodeURIComponent(agentId)}/cron/${encodeURIComponent(cronId)}`);
}

export async function getAgentMcp(agentId: string): Promise<McpServerInfo[]> {
  return mgmtGet<McpServerInfo[]>(`/${encodeURIComponent(agentId)}/mcp`);
}

export async function updateAgentMcp(agentId: string, name: string, enabled: boolean): Promise<McpServerInfo> {
  return mgmtMutate<McpServerInfo>('PATCH', `/${encodeURIComponent(agentId)}/mcp/${encodeURIComponent(name)}`, { enabled });
}
