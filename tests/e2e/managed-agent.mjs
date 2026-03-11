#!/usr/bin/env node
/**
 * Managed Agent — M4 mock agent with management event support.
 *
 * What it tests:
 * - All M2/M3 functionality (auth, streaming echo)
 * - Management protocol: responds to mgmt_request events
 * - Maintains simulated state: skills, memory, cron, MCP
 *
 * The agent stays alive and handles both chat messages and management events.
 *
 * Usage:
 *   node tests/e2e/managed-agent.mjs
 *
 * Environment variables:
 *   SERVER_URL     — server base URL (default: http://localhost:4000)
 *   AGENT_API_KEY  — skip registration and use this API key directly
 *   AGENT_NAME     — agent name (default: managed-bot)
 *   HUMAN_NAME     — human user name (default: testuser)
 *   HUMAN_PASSWORD — human user password (default: testpass)
 */

import WebSocket from 'ws';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:4000';
const WS_URL = SERVER.replace('http', 'ws');
const AGENT_NAME = process.env.AGENT_NAME ?? 'managed-bot';
const HUMAN_NAME = process.env.HUMAN_NAME ?? 'testuser';
const HUMAN_PASSWORD = process.env.HUMAN_PASSWORD ?? 'testpass';

// ---------------------------------------------------------------------------
// Simulated agent state
// ---------------------------------------------------------------------------

const agentState = {
  skills: [
    { name: 'web-search', description: 'Search the web for information', enabled: true, type: 'skill' },
    { name: 'code-review', description: 'Review code for bugs and improvements', enabled: true, type: 'skill' },
    { name: 'translation', description: 'Translate between languages', enabled: false, type: 'skill' },
    {
      name: 'ai-research', description: 'AI/ML research skills', enabled: true, type: 'skillset',
      children: [
        { name: 'model-training', description: 'Train ML models', enabled: true, type: 'skill' },
        { name: 'data-analysis', description: 'Analyze datasets', enabled: true, type: 'skill' },
        { name: 'paper-review', description: 'Review research papers', enabled: false, type: 'skill' },
      ],
    },
  ],

  memory: {
    core: {
      preferences: {
        language: 'zh-CN',
        timezone: 'Asia/Shanghai',
        response_style: 'concise',
      },
      identity: {
        name: 'Managed Bot',
        version: '1.0.0',
        role: 'assistant',
      },
    },
    extended: [
      { key: 'project-notes', description: 'Notes about current project', size: 2048 },
      { key: 'user-history', description: 'Interaction history summary', size: 512 },
      { key: 'research-findings', description: 'AI research findings', size: 4096 },
    ],
    // Simulated extended memory content
    _extendedContent: {
      'project-notes': 'Agentelegram M4 管理面板开发中，需要支持 skills/memory/cron/MCP 管理。',
      'user-history': '用户偏好中文回复，喜欢简洁风格。',
      'research-findings': 'LLM agent 的记忆管理是关键挑战。参考 MemGPT 的分层记忆架构。',
    },
  },

  cron: [
    { id: 'cron-1', schedule: '0 9 * * *', description: '每日早报推送', enabled: true, lastRun: Date.now() - 86400000, nextRun: Date.now() + 3600000 },
    { id: 'cron-2', schedule: '0 0 * * 1', description: '每周总结报告', enabled: true, lastRun: Date.now() - 604800000, nextRun: Date.now() + 259200000 },
    { id: 'cron-3', schedule: '*/30 * * * *', description: '健康检查', enabled: false, lastRun: null, nextRun: null },
  ],

  mcp: [
    { name: 'playwright', enabled: true, type: 'stdio', toolCount: 15, tools: ['browser_navigate', 'browser_click', 'browser_snapshot'] },
    { name: 'notion', enabled: true, type: 'stdio', toolCount: 12, tools: ['search', 'create_page', 'query_database'] },
    { name: 'github', enabled: false, type: 'stdio', toolCount: 8, tools: ['create_issue', 'list_repos', 'create_pr'] },
  ],
};

// ---------------------------------------------------------------------------
// Management event handler
// ---------------------------------------------------------------------------

function handleMgmtRequest(event) {
  const { requestId, action, payload } = event;
  console.log(`[managed-agent] mgmt_request: ${action}`, payload ? JSON.stringify(payload) : '');

  try {
    let data;

    switch (action) {
      case 'query_state':
        data = {
          skills: agentState.skills,
          memory: { core: agentState.memory.core, extended: agentState.memory.extended },
          cron: agentState.cron,
          mcp: agentState.mcp,
        };
        break;

      case 'query_skills':
        data = agentState.skills;
        break;

      case 'update_skill': {
        const skill = findSkill(agentState.skills, payload.name);
        if (!skill) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `skill not found: ${payload.name}` };
        }
        skill.enabled = payload.enabled;
        data = skill;
        break;
      }

      case 'query_memory':
        data = { core: agentState.memory.core, extended: agentState.memory.extended };
        break;

      case 'read_memory': {
        const { tier, key } = payload;
        if (tier === 'core') {
          data = agentState.memory.core[key] ?? null;
        } else if (tier === 'extended') {
          data = agentState.memory._extendedContent[key] ?? null;
        } else {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
        }
        break;
      }

      case 'write_memory': {
        const { tier, key, value, description } = payload;
        if (tier === 'core') {
          agentState.memory.core[key] = value;
        } else if (tier === 'extended') {
          agentState.memory._extendedContent[key] = value;
          // Update key listing
          const existing = agentState.memory.extended.find(e => e.key === key);
          if (existing) {
            existing.size = typeof value === 'string' ? value.length : JSON.stringify(value).length;
            if (description) existing.description = description;
          } else {
            agentState.memory.extended.push({
              key,
              description: description ?? key,
              size: typeof value === 'string' ? value.length : JSON.stringify(value).length,
            });
          }
        } else {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
        }
        data = { written: true };
        break;
      }

      case 'delete_memory': {
        const { tier, key } = payload;
        if (tier === 'core') {
          delete agentState.memory.core[key];
        } else if (tier === 'extended') {
          delete agentState.memory._extendedContent[key];
          agentState.memory.extended = agentState.memory.extended.filter(e => e.key !== key);
        }
        data = { deleted: true };
        break;
      }

      case 'query_cron':
        data = agentState.cron;
        break;

      case 'create_cron': {
        const newCron = {
          id: `cron-${Date.now()}`,
          schedule: payload.schedule,
          description: payload.description,
          enabled: payload.enabled ?? true,
          lastRun: null,
          nextRun: Date.now() + 60000,
        };
        agentState.cron.push(newCron);
        data = newCron;
        break;
      }

      case 'update_cron': {
        const cron = agentState.cron.find(c => c.id === payload.id);
        if (!cron) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `cron not found: ${payload.id}` };
        }
        if (payload.schedule !== undefined) cron.schedule = payload.schedule;
        if (payload.description !== undefined) cron.description = payload.description;
        if (payload.enabled !== undefined) cron.enabled = payload.enabled;
        data = cron;
        break;
      }

      case 'delete_cron': {
        const idx = agentState.cron.findIndex(c => c.id === payload.id);
        if (idx === -1) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `cron not found: ${payload.id}` };
        }
        agentState.cron.splice(idx, 1);
        data = { deleted: true };
        break;
      }

      case 'query_mcp':
        data = agentState.mcp;
        break;

      case 'update_mcp': {
        const mcp = agentState.mcp.find(m => m.name === payload.name);
        if (!mcp) {
          return { type: 'mgmt_response', requestId, success: false, mgmtError: `mcp not found: ${payload.name}` };
        }
        mcp.enabled = payload.enabled;
        data = mcp;
        break;
      }

      default:
        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown action: ${action}` };
    }

    return { type: 'mgmt_response', requestId, success: true, data };
  } catch (err) {
    return { type: 'mgmt_response', requestId, success: false, mgmtError: err.message };
  }
}

/** Recursively find a skill by name (supports skillsets with children). */
function findSkill(skills, name) {
  for (const s of skills) {
    if (s.name === name) return s;
    if (s.children) {
      const found = findSkill(s.children, name);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth helpers (same as mock-agent.mjs)
// ---------------------------------------------------------------------------

async function getHumanJwt() {
  let res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, password: HUMAN_PASSWORD }),
  });
  if (res.ok) {
    const data = await res.json();
    console.log(`[managed-agent] logged in as ${HUMAN_NAME}`);
    return data.token;
  }

  res = await fetch(`${SERVER}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, displayName: 'Test User', password: HUMAN_PASSWORD }),
  });
  if (!res.ok) {
    console.error('[managed-agent] failed to register/login human:', await res.text());
    process.exit(1);
  }
  const data = await res.json();
  console.log(`[managed-agent] registered human: ${HUMAN_NAME}`);
  return data.token;
}

async function registerAgent(jwt) {
  const res = await fetch(`${SERVER}/api/auth/register-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name: AGENT_NAME, displayName: 'Managed Bot' }),
  });

  if (res.status === 409) {
    console.log(`[managed-agent] ${AGENT_NAME} already exists, need API key from env`);
    const apiKey = process.env.AGENT_API_KEY;
    if (!apiKey) {
      console.error('[managed-agent] Set AGENT_API_KEY env var for existing agent');
      process.exit(1);
    }
    return { apiKey, existing: true };
  }

  if (!res.ok) {
    console.error('[managed-agent] registration failed:', await res.text());
    process.exit(1);
  }

  const data = await res.json();
  console.log(`[managed-agent] registered: ${data.participant.name} (${data.participant.id})`);
  console.log(`[managed-agent] API key: ${data.apiKey}`);
  return { apiKey: data.apiKey, participant: data.participant, existing: false };
}

// ---------------------------------------------------------------------------
// WebSocket connection + event loop
// ---------------------------------------------------------------------------

function connectWs(apiKey) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws`);

    ws.on('open', () => {
      console.log('[managed-agent] WebSocket connected, sending auth...');
      ws.send(JSON.stringify({ type: 'auth', apiKey }));
    });

    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') {
        console.log(`[managed-agent] authenticated as ${event.participantName}`);
        resolve(ws);
      } else if (event.type === 'error') {
        console.error('[managed-agent] auth error:', event.error);
        reject(new Error(event.error?.message ?? 'auth failed'));
      }
    });

    ws.on('error', (err) => {
      console.error('[managed-agent] WebSocket error:', err.message);
      reject(err);
    });
  });
}

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stream a reply word-by-word (echo bot behavior).
 */
async function streamReply(ws, conversationId, content) {
  const replyText = `Echo: ${content}`;
  const words = replyText.split(' ');

  send(ws, { type: 'typing', conversationId, activity: 'thinking' });
  await sleep(300);

  let messageId = null;

  for (let i = 0; i < words.length; i++) {
    const chunk = (i === 0 ? '' : ' ') + words[i];

    if (i === 0) {
      send(ws, { type: 'send_message_delta', conversationId, delta: chunk });
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
    } else {
      send(ws, { type: 'send_message_delta', conversationId, messageId, delta: chunk });
    }

    await sleep(50 + Math.random() * 100);
  }

  send(ws, { type: 'send_message_done', conversationId, messageId });
  console.log(`[managed-agent] echo reply sent for message ${messageId}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let apiKey;

  if (process.env.AGENT_API_KEY) {
    apiKey = process.env.AGENT_API_KEY;
    console.log('[managed-agent] using API key from env');
  } else {
    const jwt = await getHumanJwt();
    const result = await registerAgent(jwt);
    apiKey = result.apiKey;
  }

  const ws = await connectWs(apiKey);

  // Request conversation list
  send(ws, { type: 'list_conversations' });

  console.log('[managed-agent] ready — handling chat + management events');

  ws.on('message', async (raw) => {
    const event = JSON.parse(raw.toString());

    switch (event.type) {
      case 'conversations':
        console.log(`[managed-agent] ${event.conversations?.length ?? 0} conversations`);
        break;

      case 'conversation_created':
        console.log(`[managed-agent] added to conversation: ${event.conversationId}`);
        break;

      case 'message': {
        const msg = event.message;
        if (msg && msg.content && !msg.content.startsWith('Echo:')) {
          console.log(`[managed-agent] received: "${msg.content}" from ${msg.senderId}`);
          await streamReply(ws, msg.conversationId, msg.content);
        }
        break;
      }

      case 'mgmt_request': {
        // Management event from server (forwarded from REST API)
        const response = handleMgmtRequest(event);
        send(ws, response);
        console.log(`[managed-agent] mgmt_response sent: ${event.action} → ${response.success ? 'ok' : 'error'}`);
        break;
      }

      case 'error':
        console.error('[managed-agent] server error:', event.error);
        break;
    }
  });

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('[managed-agent] shutting down...');
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[managed-agent] fatal:', err);
  process.exit(1);
});
