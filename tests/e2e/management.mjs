#!/usr/bin/env node
/**
 * Agent Management E2E Test — M4 验收测试.
 *
 * What it tests:
 * 1. Register 1 human + 1 agent (managed-bot)
 * 2. Agent connects via WebSocket and handles mgmt_request events
 * 3. Human queries agent list via REST → sees managed-bot online
 * 4. Human queries skills → gets hierarchical skill tree
 * 5. Human toggles a skill → agent state updates
 * 6. Human queries memory → gets core + extended overview
 * 7. Human reads extended memory key → gets content
 * 8. Human queries cron → gets cron job list
 * 9. Human creates a cron job → agent adds it
 * 10. Human deletes a cron job → agent removes it
 * 11. Human queries MCP → gets server list
 * 12. Human toggles MCP server → agent updates
 * 13. Agent disconnects → human sees agent offline
 * 14. Human queries skills when offline → gets 503
 *
 * Usage:
 *   node tests/e2e/management.mjs
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
    console.log(`  \u2705 ${message}`);
  } else {
    failed++;
    console.error(`  \u274C ${message}`);
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
    const envKey = process.env[`${name.toUpperCase().replace(/-/g, '_')}_KEY`];
    if (envKey) return { apiKey: envKey };
    throw new Error(`Agent "${name}" already exists. Set ${name.toUpperCase().replace(/-/g, '_')}_KEY env var.`);
  }
  if (!res.ok) throw new Error(`Register agent failed: ${await res.text()}`);
  const data = await res.json();
  console.log(`[setup] registered agent: ${data.participant.name} (${data.participant.id})`);
  return { apiKey: data.apiKey, participantId: data.participant.id };
}

function connectWs(credential) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify(credential.token
        ? { type: 'auth', token: credential.token }
        : { type: 'auth', apiKey: credential.apiKey }));
    });
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') resolve(ws);
      if (event.type === 'error') reject(new Error(event.error?.message ?? 'auth failed'));
    });
    ws.on('error', reject);
  });
}

function send(ws, event) {
  ws.send(JSON.stringify(event));
}

async function mgmtGet(jwt, path) {
  const res = await fetch(`${SERVER}/api/agents${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  return { status: res.status, body: await res.json() };
}

async function mgmtMutate(jwt, method, path, body) {
  const res = await fetch(`${SERVER}/api/agents${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// ── Simulated agent state ────────────────────────────────────────────────────

const agentState = {
  skills: [
    { name: 'skill-a', description: 'Skill Alpha', enabled: true, type: 'skill' },
    { name: 'skill-b', description: 'Skill Beta', enabled: false, type: 'skill' },
    {
      name: 'skillset-x', description: 'Skillset X', enabled: true, type: 'skillset',
      children: [
        { name: 'skill-x1', description: 'Child skill 1', enabled: true, type: 'skill' },
      ],
    },
  ],
  memory: {
    core: { preferences: { lang: 'en' } },
    extended: [
      { key: 'notes', description: 'Test notes', size: 128 },
    ],
    _content: { notes: 'Hello from extended memory' },
  },
  cron: [
    { id: 'cron-a', schedule: '0 9 * * *', description: 'Daily task', enabled: true, lastRun: null, nextRun: null },
  ],
  mcp: [
    { name: 'test-mcp', enabled: true, type: 'stdio', toolCount: 3, tools: ['tool1', 'tool2', 'tool3'] },
  ],
};

let cronIdCounter = 1;

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

function handleMgmtRequest(event) {
  const { requestId, action, payload } = event;
  try {
    let data;
    switch (action) {
      case 'query_state':
        data = { skills: agentState.skills, memory: { core: agentState.memory.core, extended: agentState.memory.extended }, cron: agentState.cron, mcp: agentState.mcp };
        break;
      case 'query_skills':
        data = agentState.skills;
        break;
      case 'update_skill': {
        const s = findSkill(agentState.skills, payload.name);
        if (!s) return { type: 'mgmt_response', requestId, success: false, mgmtError: `not found: ${payload.name}` };
        s.enabled = payload.enabled;
        data = s;
        break;
      }
      case 'query_memory':
        data = { core: agentState.memory.core, extended: agentState.memory.extended };
        break;
      case 'read_memory':
        data = agentState.memory._content[payload.key] ?? null;
        break;
      case 'query_cron':
        data = agentState.cron;
        break;
      case 'create_cron': {
        const newCron = { id: `cron-new-${cronIdCounter++}`, schedule: payload.schedule, description: payload.description, enabled: payload.enabled ?? true, lastRun: null, nextRun: null };
        agentState.cron.push(newCron);
        data = newCron;
        break;
      }
      case 'delete_cron': {
        const idx = agentState.cron.findIndex(c => c.id === payload.id);
        if (idx === -1) return { type: 'mgmt_response', requestId, success: false, mgmtError: 'not found' };
        agentState.cron.splice(idx, 1);
        data = { deleted: true };
        break;
      }
      case 'query_mcp':
        data = agentState.mcp;
        break;
      case 'update_mcp': {
        const m = agentState.mcp.find(x => x.name === payload.name);
        if (!m) return { type: 'mgmt_response', requestId, success: false, mgmtError: 'not found' };
        m.enabled = payload.enabled;
        data = m;
        break;
      }
      default:
        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown: ${action}` };
    }
    return { type: 'mgmt_response', requestId, success: true, data };
  } catch (err) {
    return { type: 'mgmt_response', requestId, success: false, mgmtError: err.message };
  }
}

// ── Main test ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== M4: Agent Management E2E Test ===\n');

  // ── Setup ──
  console.log('[setup] registering participants...');
  const humanJwt = await registerOrLoginHuman('mgmt-test-human', 'testpass');
  const agentResult = await registerAgent(humanJwt, 'mgmt-test-agent', 'Test Agent');

  console.log('[setup] connecting agent WebSocket...');
  const agentWs = await connectWs({ apiKey: agentResult.apiKey });

  // Wire up management event handler
  agentWs.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'mgmt_request') {
      const response = handleMgmtRequest(event);
      send(agentWs, response);
    }
  });

  await sleep(500);

  // ── Test 1: List agents ──
  console.log('\n[test] 1. List agents');
  const { body: agents } = await mgmtGet(humanJwt, '');
  const testAgent = agents.find(a => a.name === 'mgmt-test-agent');
  assert(testAgent !== undefined, 'mgmt-test-agent found in agent list');
  assert(testAgent?.online === true, 'agent shows as online');

  // ── Test 2: Query skills ──
  console.log('\n[test] 2. Query skills');
  const { status: skillStatus, body: skillBody } = await mgmtGet(humanJwt, `/${testAgent.id}/skills`);
  assert(skillStatus === 200, 'skills endpoint returns 200');
  assert(skillBody.success === true, 'skills query succeeded');
  const skills = skillBody.data;
  assert(Array.isArray(skills) && skills.length === 3, 'has 3 top-level skills');
  const skillsetX = skills.find(s => s.name === 'skillset-x');
  assert(skillsetX?.type === 'skillset' && skillsetX?.children?.length === 1, 'skillset has children');

  // ── Test 3: Toggle skill ──
  console.log('\n[test] 3. Toggle skill (skill-b: off → on)');
  assert(skills.find(s => s.name === 'skill-b')?.enabled === false, 'skill-b starts disabled');
  const { status: toggleStatus, body: toggleBody } = await mgmtMutate(humanJwt, 'PATCH', `/${testAgent.id}/skills/skill-b`, { enabled: true });
  assert(toggleStatus === 200, 'toggle returns 200');
  assert(toggleBody.data?.enabled === true, 'skill-b now enabled');
  // Verify state changed on agent side
  assert(agentState.skills.find(s => s.name === 'skill-b')?.enabled === true, 'agent-side state updated');

  // ── Test 4: Query memory ──
  console.log('\n[test] 4. Query memory');
  const { status: memStatus, body: memBody } = await mgmtGet(humanJwt, `/${testAgent.id}/memory`);
  assert(memStatus === 200, 'memory endpoint returns 200');
  const mem = memBody.data;
  assert(mem.core?.preferences?.lang === 'en', 'core memory correct');
  assert(Array.isArray(mem.extended) && mem.extended.length === 1, 'extended memory has 1 key');
  assert(mem.extended[0].key === 'notes', 'extended key name correct');

  // ── Test 5: Read extended memory ──
  console.log('\n[test] 5. Read extended memory key');
  const { status: readStatus, body: readBody } = await mgmtGet(humanJwt, `/${testAgent.id}/memory/extended/notes`);
  assert(readStatus === 200, 'read memory returns 200');
  assert(readBody.data === 'Hello from extended memory', 'extended memory content correct');

  // ── Test 6: Query cron ──
  console.log('\n[test] 6. Query cron jobs');
  const { status: cronStatus, body: cronBody } = await mgmtGet(humanJwt, `/${testAgent.id}/cron`);
  assert(cronStatus === 200, 'cron endpoint returns 200');
  assert(Array.isArray(cronBody.data) && cronBody.data.length === 1, 'has 1 cron job');
  assert(cronBody.data[0].description === 'Daily task', 'cron description correct');

  // ── Test 7: Create cron ──
  console.log('\n[test] 7. Create cron job');
  const { status: createCronStatus, body: createCronBody } = await mgmtMutate(humanJwt, 'POST', `/${testAgent.id}/cron`, {
    schedule: '*/5 * * * *',
    description: 'New test cron',
  });
  assert(createCronStatus === 200, 'create cron returns 200');
  assert(createCronBody.data?.description === 'New test cron', 'created cron has correct description');
  const newCronId = createCronBody.data?.id;
  assert(agentState.cron.length === 2, 'agent now has 2 cron jobs');

  // ── Test 8: Delete cron ──
  console.log('\n[test] 8. Delete cron job');
  const { status: delCronStatus } = await mgmtMutate(humanJwt, 'DELETE', `/${testAgent.id}/cron/${newCronId}`);
  assert(delCronStatus === 200, 'delete cron returns 200');
  assert(agentState.cron.length === 1, 'agent back to 1 cron job');

  // ── Test 9: Query MCP ──
  console.log('\n[test] 9. Query MCP servers');
  const { status: mcpStatus, body: mcpBody } = await mgmtGet(humanJwt, `/${testAgent.id}/mcp`);
  assert(mcpStatus === 200, 'mcp endpoint returns 200');
  assert(Array.isArray(mcpBody.data) && mcpBody.data.length === 1, 'has 1 MCP server');
  assert(mcpBody.data[0].name === 'test-mcp', 'MCP server name correct');
  assert(mcpBody.data[0].toolCount === 3, 'MCP tool count correct');

  // ── Test 10: Toggle MCP ──
  console.log('\n[test] 10. Toggle MCP server (test-mcp: on → off)');
  const { status: mcpToggleStatus, body: mcpToggleBody } = await mgmtMutate(humanJwt, 'PATCH', `/${testAgent.id}/mcp/test-mcp`, { enabled: false });
  assert(mcpToggleStatus === 200, 'MCP toggle returns 200');
  assert(mcpToggleBody.data?.enabled === false, 'test-mcp now disabled');
  assert(agentState.mcp[0].enabled === false, 'agent-side MCP state updated');

  // ── Test 11: Agent disconnect → offline ──
  console.log('\n[test] 11. Agent disconnect → offline status');
  agentWs.close();
  await sleep(500);
  const { body: agentsAfter } = await mgmtGet(humanJwt, '');
  const offlineAgent = agentsAfter.find(a => a.name === 'mgmt-test-agent');
  assert(offlineAgent?.online === false, 'agent shows as offline after disconnect');

  // ── Test 12: Offline agent → 503 ──
  console.log('\n[test] 12. Offline agent returns 503');
  const { status: offlineStatus } = await mgmtGet(humanJwt, `/${testAgent.id}/skills`);
  assert(offlineStatus === 503, 'skills query returns 503 when offline');

  // ── Summary ──
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${'='.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
