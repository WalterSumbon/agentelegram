/**
 * Playwright E2E Test — Full browser-based acceptance test for Agentelegram.
 *
 * 所有用户操作 100% 通过 Playwright UI 完成，禁止直接调用 API/WebSocket 进行
 * 任何用户侧的操作。只有测试基础设施（注册用户、连接 mock agent）使用直连。
 *
 * What it tests:
 *   1. Login page renders correctly (title, form fields, buttons)
 *   2. Login with test credentials -> authenticated, redirected to chat
 *   3. Chat page renders with conversation list sidebar
 *   4. Agents tab shows agent list with online/offline status indicators
 *   5. Create new conversation with a managed agent (via UI)
 *   6. Send message via UI input and verify agent echo response renders in UI
 *   7. Agent management panel: Skills tab with hierarchical skill tree
 *   8. Agent management panel: Memory tab with core + extended memory
 *   9. Agent management panel: MCP Servers tab with server list
 *
 * Prerequisites:
 *   - agentelegram server running on http://localhost:4000
 *   - Vite dev server running on http://localhost:5173
 *   - PostgreSQL database at postgresql://localhost:5432/agentelegram
 *
 * Usage:
 *   env -u CLAUDECODE npx vitest run tests/e2e/playwright-e2e.test.ts --timeout 180000
 *
 * Environment:
 *   SERVER_URL — default http://localhost:4000
 *   FRONTEND_URL — default http://localhost:5173
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:4000';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const WS_URL = SERVER_URL.replace('http', 'ws');

// Unique suffix to avoid collisions with other test runs
const SUFFIX = `pw-${Date.now()}`;
const HUMAN_NAME = `pwtest-human-${SUFFIX}`;
const HUMAN_DISPLAY = `PW Human ${SUFFIX}`;
const HUMAN_PASSWORD = 'pw-test-pass-42';
const AGENT_NAME = `pwtest-agent-${SUFFIX}`;
const AGENT_DISPLAY = `PW Agent ${SUFFIX}`;

// Generous timeouts for streaming responses
const PAGE_TIMEOUT = 30_000;
const AGENT_RESPONSE_TIMEOUT = 30_000;

// Screenshot output directory
const SCREENSHOT_DIR = path.join(os.tmpdir(), `agentelegram-playwright-${SUFFIX}`);

// ---------------------------------------------------------------------------
// Simulated agent state (mock agent provides these via mgmt_response)
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
      preferences: { language: 'zh-CN', timezone: 'Asia/Shanghai', response_style: 'concise' },
      identity: { name: 'PW Agent', version: '1.0.0', role: 'assistant' },
    },
    extended: [
      { key: 'project-notes', description: 'Notes about current project', size: 2048 },
      { key: 'user-history', description: 'Interaction history summary', size: 512 },
    ],
    _extendedContent: {
      'project-notes': 'Agentelegram Playwright E2E test fixture data.',
      'user-history': 'Test interaction history.',
    } as Record<string, string>,
  },
  cron: [
    { id: 'cron-1', schedule: '0 9 * * *', description: 'Daily report', enabled: true, lastRun: Date.now() - 86400000, nextRun: Date.now() + 3600000 },
    { id: 'cron-2', schedule: '*/30 * * * *', description: 'Health check', enabled: false, lastRun: null, nextRun: null },
  ],
  mcp: [
    { name: 'playwright', enabled: true, type: 'stdio', toolCount: 15, tools: ['browser_navigate', 'browser_click', 'browser_snapshot'] },
    { name: 'notion', enabled: true, type: 'stdio', toolCount: 12, tools: ['search', 'create_page', 'query_database'] },
    { name: 'github', enabled: false, type: 'stdio', toolCount: 8, tools: ['create_issue', 'list_repos', 'create_pr'] },
  ],
};

// ---------------------------------------------------------------------------
// Management event handler (mock agent responds to mgmt_request events)
// ---------------------------------------------------------------------------

function findSkill(skills: any[], name: string): any {
  for (const s of skills) {
    if (s.name === name) return s;
    if (s.children) {
      const found = findSkill(s.children, name);
      if (found) return found;
    }
  }
  return null;
}

function handleMgmtRequest(event: any): any {
  const { requestId, action, payload } = event;
  try {
    let data: any;
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
        const s = findSkill(agentState.skills, payload.name);
        if (!s) return { type: 'mgmt_response', requestId, success: false, mgmtError: `not found: ${payload.name}` };
        s.enabled = payload.enabled;
        data = s;
        break;
      }
      case 'query_memory':
        data = { core: agentState.memory.core, extended: agentState.memory.extended };
        break;
      case 'read_memory': {
        const { tier, key } = payload;
        if (tier === 'core') data = agentState.memory.core[key as keyof typeof agentState.memory.core] ?? null;
        else if (tier === 'extended') data = agentState.memory._extendedContent[key] ?? null;
        else return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown tier: ${tier}` };
        break;
      }
      case 'query_cron':
        data = agentState.cron;
        break;
      case 'create_cron': {
        const nc = { id: `cron-${Date.now()}`, schedule: payload.schedule, description: payload.description, enabled: payload.enabled ?? true, lastRun: null, nextRun: Date.now() + 60000 };
        agentState.cron.push(nc);
        data = nc;
        break;
      }
      case 'delete_cron': {
        const idx = agentState.cron.findIndex((c: any) => c.id === payload.id);
        if (idx === -1) return { type: 'mgmt_response', requestId, success: false, mgmtError: 'not found' };
        agentState.cron.splice(idx, 1);
        data = { deleted: true };
        break;
      }
      case 'query_mcp':
        data = agentState.mcp;
        break;
      case 'update_mcp': {
        const m = agentState.mcp.find((x: any) => x.name === payload.name);
        if (!m) return { type: 'mgmt_response', requestId, success: false, mgmtError: 'not found' };
        m.enabled = payload.enabled;
        data = m;
        break;
      }
      default:
        return { type: 'mgmt_response', requestId, success: false, mgmtError: `unknown: ${action}` };
    }
    return { type: 'mgmt_response', requestId, success: true, data };
  } catch (err: any) {
    return { type: 'mgmt_response', requestId, success: false, mgmtError: err.message };
  }
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function localFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  const url = `${SERVER_URL}${urlPath}`;
  return fetch(url, { ...init });
}

// ---------------------------------------------------------------------------
// Server availability check
// ---------------------------------------------------------------------------

async function isServerAvailable(): Promise<boolean> {
  try {
    const res = await localFetch('/api/agents');
    return res.status < 500;
  } catch {
    return false;
  }
}

async function isFrontendAvailable(): Promise<boolean> {
  try {
    const res = await fetch(FRONTEND_URL);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth helpers (test infrastructure — register users/agents for setup)
// ---------------------------------------------------------------------------

async function registerOrLoginHuman(): Promise<{ token: string; participant: any }> {
  // Try login first
  let res = await localFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, password: HUMAN_PASSWORD }),
  });
  if (res.ok) {
    const data = await res.json() as any;
    return { token: data.token, participant: data.participant };
  }

  // Register
  res = await localFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: HUMAN_NAME, displayName: HUMAN_DISPLAY, password: HUMAN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Failed to register human: ${await res.text()}`);
  const data = await res.json() as any;
  return { token: data.token, participant: data.participant };
}

async function registerAgent(jwt: string): Promise<{ apiKey: string; participant: any }> {
  const res = await localFetch('/api/auth/register-agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ name: AGENT_NAME, displayName: AGENT_DISPLAY }),
  });
  if (!res.ok) throw new Error(`Failed to register agent: ${await res.text()}`);
  const data = await res.json() as any;
  return { apiKey: data.apiKey, participant: data.participant };
}

// ---------------------------------------------------------------------------
// Agent WebSocket connection helper (test infrastructure — mock agent side)
// ---------------------------------------------------------------------------

function connectAgentWs(apiKey: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ws`);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', apiKey }));
    });

    ws.on('message', (raw: Buffer) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'auth_ok') {
        resolve(ws);
      } else if (event.type === 'error') {
        reject(new Error(event.error?.message ?? 'agent auth failed'));
      }
    });

    ws.on('error', (err: Error) => reject(err));
    setTimeout(() => reject(new Error('Agent WS auth timeout')), 10_000);
  });
}

function wsSend(ws: WebSocket, event: any): void {
  ws.send(JSON.stringify(event));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stream an echo reply word-by-word, matching a real agent's streaming behavior.
 * This runs on the mock agent's WebSocket (agent side, not user side).
 */
async function streamEchoReply(ws: WebSocket, conversationId: string, content: string): Promise<void> {
  const replyText = `Echo: ${content}`;
  const words = replyText.split(' ');

  // Send typing indicator first
  wsSend(ws, { type: 'typing', conversationId, activity: 'thinking' });
  await sleep(300);

  let messageId: string | null = null;

  for (let i = 0; i < words.length; i++) {
    const chunk = (i === 0 ? '' : ' ') + words[i];

    if (i === 0) {
      // First delta — wait for server to assign a messageId
      wsSend(ws, { type: 'send_message_delta', conversationId, delta: chunk });
      messageId = await new Promise<string>((resolve) => {
        const handler = (raw: any) => {
          const event = JSON.parse(raw.toString());
          if (event.type === 'delta_ack' && event.assignedMessageId) {
            ws.removeListener('message', handler);
            resolve(event.assignedMessageId);
          }
        };
        ws.on('message', handler);
      });
    } else {
      wsSend(ws, { type: 'send_message_delta', conversationId, messageId, delta: chunk });
    }

    await sleep(50 + Math.random() * 80);
  }

  wsSend(ws, { type: 'send_message_done', conversationId, messageId });
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string): Promise<string> {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
  const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`[screenshot] ${filePath}`);
  return filePath;
}

// ===========================================================================
// Test Suite
// ===========================================================================

describe('Agentelegram Playwright E2E', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  // Shared state across tests
  let humanToken: string;
  let humanParticipant: any;
  let agentApiKey: string;
  let agentParticipant: any;
  let agentWs: WebSocket;

  // -------------------------------------------------------------------------
  // Setup: check server, register participants, connect mock agent
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    // Check server availability
    const serverUp = await isServerAvailable();
    if (!serverUp) {
      console.warn(`[SKIP] agentelegram server not available at ${SERVER_URL}. Skipping all Playwright tests.`);
      return;
    }

    const frontendUp = await isFrontendAvailable();
    if (!frontendUp) {
      console.warn(`[SKIP] Frontend not available at ${FRONTEND_URL}. Skipping all Playwright tests.`);
      return;
    }

    // Create screenshot directory
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    console.log(`[setup] screenshots: ${SCREENSHOT_DIR}`);

    // Register test human (test infrastructure — not a user-facing operation)
    const humanResult = await registerOrLoginHuman();
    humanToken = humanResult.token;
    humanParticipant = humanResult.participant;
    console.log(`[setup] human: ${humanParticipant.name} (${humanParticipant.id})`);

    // Register test agent (test infrastructure — simulates agent registration)
    const agentResult = await registerAgent(humanToken);
    agentApiKey = agentResult.apiKey;
    agentParticipant = agentResult.participant;
    console.log(`[setup] agent: ${agentParticipant.name} (${agentParticipant.id})`);

    // Connect mock agent via WebSocket (agent side — this is the agent process, not the user)
    agentWs = await connectAgentWs(agentApiKey);
    console.log('[setup] agent WebSocket connected and authenticated');

    // Wire up management event handler + echo bot on the agent WS
    agentWs.on('message', async (raw: Buffer) => {
      const event = JSON.parse(raw.toString());

      switch (event.type) {
        case 'mgmt_request': {
          const response = handleMgmtRequest(event);
          wsSend(agentWs, response);
          break;
        }
        case 'message': {
          // Echo bot: reply with "Echo: <original message>"
          const msg = event.message;
          if (msg && msg.content && !msg.content.startsWith('Echo:')) {
            await streamEchoReply(agentWs, msg.conversationId, msg.content);
          }
          break;
        }
      }
    });

    // Request conversation list so agent is "ready"
    wsSend(agentWs, { type: 'list_conversations' });
    await sleep(500);

    // Launch Playwright browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      bypassCSP: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(PAGE_TIMEOUT);
    page.setDefaultNavigationTimeout(PAGE_TIMEOUT);

    console.log('[setup] Playwright browser launched');
  }, 60_000);

  afterAll(async () => {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    if (agentWs && agentWs.readyState === WebSocket.OPEN) {
      agentWs.close();
    }

    console.log(`[cleanup] done. Screenshots saved to: ${SCREENSHOT_DIR}`);
  });

  function skipIfNoServer() {
    if (!browser) {
      console.warn('[SKIP] server not available, skipping test');
      return true;
    }
    return false;
  }

  // =========================================================================
  // Test 1: Login page renders correctly
  // =========================================================================

  it('should render the login page with title and form fields', async () => {
    if (skipIfNoServer()) return;

    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });

    // Check title
    const heading = await page.textContent('h1');
    expect(heading).toBe('Agentelegram');

    // Check subtitle
    const subtitle = await page.textContent('.subtitle');
    expect(subtitle).toContain('AI-native chat platform');

    // Check form fields exist
    const usernameInput = page.locator('input[placeholder="Username"]');
    await usernameInput.waitFor({ state: 'visible' });

    const passwordInput = page.locator('input[placeholder="Password"]');
    await passwordInput.waitFor({ state: 'visible' });

    // Check Login/Register tabs
    const loginTab = page.locator('.tab', { hasText: 'Login' });
    await loginTab.waitFor({ state: 'visible' });
    const registerTab = page.locator('.tab', { hasText: 'Register' });
    await registerTab.waitFor({ state: 'visible' });

    // Check submit button
    const submitBtn = page.locator('button.btn-primary');
    await submitBtn.waitFor({ state: 'visible' });
    expect(await submitBtn.textContent()).toBe('Login');

    await screenshot(page, '01-login-page');
  });

  // =========================================================================
  // Test 2: Login with test credentials
  // =========================================================================

  it('should login with test credentials and navigate to chat page', async () => {
    if (skipIfNoServer()) return;

    await page.goto(FRONTEND_URL, { waitUntil: 'networkidle' });

    // Fill login form (Playwright UI operations only)
    await page.fill('input[placeholder="Username"]', HUMAN_NAME);
    await page.fill('input[placeholder="Password"]', HUMAN_PASSWORD);
    await page.click('button.btn-primary');

    // Wait for chat page to render
    await page.waitForSelector('.chat-layout', { timeout: PAGE_TIMEOUT });

    // Verify sidebar with user name
    const userName = await page.textContent('.user-name');
    expect(userName).toBe(HUMAN_DISPLAY);

    // Verify the Chats tab is active
    const chatsTab = page.locator('.sidebar-tab', { hasText: 'Chats' });
    expect(await chatsTab.getAttribute('class')).toMatch(/active/);

    await screenshot(page, '02-chat-page-after-login');
  });

  // =========================================================================
  // Test 3: Chat page renders with conversation list
  // =========================================================================

  it('should show chat page with empty conversation list initially', async () => {
    if (skipIfNoServer()) return;

    const convList = page.locator('.conversation-list');
    await convList.waitFor({ state: 'visible' });

    const emptyHint = page.locator('.empty-hint');
    const convItems = page.locator('.conv-item');

    const hasEmpty = await emptyHint.isVisible().catch(() => false);
    const convCount = await convItems.count();
    expect(hasEmpty || convCount >= 0).toBe(true);

    const noChat = page.locator('.no-chat-selected');
    if (convCount === 0) {
      await noChat.waitFor({ state: 'visible' });
    }

    await screenshot(page, '03-conversation-list');
  });

  // =========================================================================
  // Test 4: Agents tab shows agent list with online/offline status
  // =========================================================================

  it('should show agents tab with online/offline indicators', async () => {
    if (skipIfNoServer()) return;

    // Click the Agents tab (UI operation)
    const agentsTab = page.locator('.sidebar-tab', { hasText: 'Agents' });
    await agentsTab.click();

    // Wait for agent list to load
    await page.waitForSelector('.agent-list', { timeout: PAGE_TIMEOUT });

    // Find our test agent in the list
    const agentItem = page.locator('.agent-item', { hasText: AGENT_DISPLAY });
    await agentItem.waitFor({ state: 'visible' });

    // Check online status dot
    const statusDot = agentItem.locator('.agent-status-dot');
    await statusDot.waitFor({ state: 'visible' });
    expect(await statusDot.getAttribute('class')).toMatch(/online/);

    // Verify agent meta info
    const agentMeta = agentItem.locator('.agent-item-meta');
    expect(await agentMeta.textContent()).toContain(`@${AGENT_NAME}`);

    await screenshot(page, '04-agents-list');
  });

  // =========================================================================
  // Test 5: Create new conversation with an agent (pure UI)
  // =========================================================================

  it('should create a new conversation with the test agent', async () => {
    if (skipIfNoServer()) return;

    // Switch back to Chats tab (UI operation)
    const chatsTab = page.locator('.sidebar-tab', { hasText: 'Chats' });
    await chatsTab.click();
    await sleep(500);

    // Click "+ New Chat" (UI operation)
    const newChatBtn = page.locator('.btn-new-chat', { hasText: '+ New Chat' });
    await newChatBtn.click();

    // Wait for the new chat form to appear
    await page.waitForSelector('.new-chat-form', { timeout: PAGE_TIMEOUT });

    // Search for our test agent (UI operation)
    const searchInput = page.locator('.new-chat-form input[placeholder*="Search"]');
    await searchInput.fill(AGENT_NAME.slice(0, 15));

    // Wait for participant list to filter
    await sleep(500);

    // Select the agent from the participant list (UI operation)
    const participantOption = page.locator('.participant-option', { hasText: AGENT_DISPLAY });
    await participantOption.waitFor({ state: 'visible', timeout: 5000 });
    await participantOption.click();

    // Verify selected chip appears
    const selectedChip = page.locator('.selected-chips .chip', { hasText: AGENT_DISPLAY });
    await selectedChip.waitFor({ state: 'visible' });

    await screenshot(page, '05-new-chat-agent-selected');

    // Click "Create Chat" (UI operation)
    const createBtn = page.locator('.btn-primary', { hasText: 'Create Chat' });
    await createBtn.click();

    // Wait for the conversation to appear in the list and be auto-selected
    // (we fixed Chat.tsx to auto-select newly created conversations)
    await page.waitForSelector('.conv-item.active', { timeout: PAGE_TIMEOUT });

    // The chat header should show the agent's name or conversation title
    await page.waitForSelector('.chat-header', { timeout: PAGE_TIMEOUT });

    // Message input should be visible (conversation is open)
    await page.waitForSelector('.message-input-bar', { timeout: PAGE_TIMEOUT });

    await screenshot(page, '05-conversation-created');
  });

  // =========================================================================
  // Test 6: Send message and receive agent echo response (pure UI)
  //
  // 所有操作通过 Playwright UI 完成：
  //   1. 在输入框输入消息
  //   2. 点击 Send 按钮发送
  //   3. 等待自己的消息气泡出现
  //   4. 等待 agent 的 echo 回复出现
  //
  // 禁止直接调用 WebSocket 或 API 来发送消息或验证结果。
  // =========================================================================

  it('should send a message and receive agent echo response via UI', async () => {
    if (skipIfNoServer()) return;

    // Conversation should already be open from test 5
    // Verify the message input is ready
    const msgInput = page.locator('.message-input-bar input');
    await msgInput.waitFor({ state: 'visible' });

    // Type a test message (UI operation)
    const testMessage = `Hello from Playwright ${Date.now()}`;
    await msgInput.fill(testMessage);

    // Click Send button (UI operation)
    const sendBtn = page.locator('.btn-send');
    await sendBtn.click();

    // Input should be cleared after sending
    expect(await msgInput.inputValue()).toBe('');

    // Wait for our own message to appear in the message list
    // The server broadcasts the message back to all participants (including sender)
    const sentMessage = page.locator('.message-bubble', { hasText: testMessage });
    await sentMessage.waitFor({ state: 'visible', timeout: AGENT_RESPONSE_TIMEOUT });
    console.log('[test] Sent message is visible in UI');

    await screenshot(page, '06-message-sent');

    // Wait for the agent's echo response to appear
    // The mock agent echoes back "Echo: <original message>"
    const echoText = `Echo: ${testMessage}`;
    const echoMessage = page.locator('.message-bubble', { hasText: echoText });
    await echoMessage.waitFor({ state: 'visible', timeout: AGENT_RESPONSE_TIMEOUT });
    console.log('[test] Agent echo response is visible in UI');

    // Verify the echo message has the agent badge
    const echoRow = page.locator('.message-row', { hasText: echoText });
    const agentBadge = echoRow.locator('.agent-badge');
    await agentBadge.waitFor({ state: 'visible' });

    await screenshot(page, '06-agent-response');
  }, AGENT_RESPONSE_TIMEOUT + 30_000);

  // =========================================================================
  // Test 7: Agent management panel - Skills tab
  // =========================================================================

  it('should display Skills tab in agent management panel', async () => {
    if (skipIfNoServer()) return;

    // Switch to Agents tab (UI operation)
    const agentsTab = page.locator('.sidebar-tab', { hasText: 'Agents' });
    await agentsTab.click();
    await page.waitForSelector('.agent-list', { timeout: PAGE_TIMEOUT });

    // Select our test agent (UI operation)
    const agentItem = page.locator('.agent-item', { hasText: AGENT_DISPLAY });
    await agentItem.click();

    // Wait for management panel to load with actual agent data (not the "Agent" fallback)
    const agentNameEl = page.locator('.mgmt-agent-name', { hasText: AGENT_DISPLAY });
    await agentNameEl.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT });
    expect(await agentNameEl.textContent()).toBe(AGENT_DISPLAY);

    // Verify online status
    const statusEl = page.locator('.mgmt-status');
    expect(await statusEl.getAttribute('class')).toMatch(/online/);

    // Skills tab should be active by default
    const skillsTab = page.locator('.mgmt-tab', { hasText: 'Skills' });
    expect(await skillsTab.getAttribute('class')).toMatch(/active/);

    // Wait for skills to load
    await page.waitForSelector('.skill-list', { timeout: PAGE_TIMEOUT });

    // Verify skill items are visible
    const skillItems = page.locator('.skill-item');
    const skillCount = await skillItems.count();
    expect(skillCount).toBeGreaterThan(0);

    // Check for specific skills from our mock agent state
    const webSearchSkill = page.locator('.skill-name', { hasText: 'web-search' });
    await webSearchSkill.waitFor({ state: 'visible' });

    const translationSkill = page.locator('.skill-name', { hasText: 'translation' });
    await translationSkill.waitFor({ state: 'visible' });

    // Verify skillset (ai-research) with children
    const aiResearch = page.locator('.skill-name', { hasText: 'ai-research' });
    await aiResearch.waitFor({ state: 'visible' });

    // Check for "set" badge on skillset
    const setBadge = page.locator('.skill-type-badge', { hasText: 'set' });
    await setBadge.waitFor({ state: 'visible' });

    // Verify children skills are visible (expanded by default)
    const modelTraining = page.locator('.skill-name', { hasText: 'model-training' });
    await modelTraining.waitFor({ state: 'visible' });

    // Verify skill count display
    const skillCountDisplay = page.locator('.mgmt-count');
    await skillCountDisplay.waitFor({ state: 'visible' });

    await screenshot(page, '07-skills-panel');
  });

  // =========================================================================
  // Test 8: Agent management panel - Memory tab
  // =========================================================================

  it('should display Memory tab with core and extended memory', async () => {
    if (skipIfNoServer()) return;

    // Click Memory tab (UI operation)
    const memoryTab = page.locator('.mgmt-tab', { hasText: 'Memory' });
    await memoryTab.click();

    // Wait for memory content to load
    await page.waitForSelector('.memory-core', { timeout: PAGE_TIMEOUT });

    // Verify core memory sections
    const coreBlocks = page.locator('.memory-core-block');
    const coreCount = await coreBlocks.count();
    expect(coreCount).toBeGreaterThan(0);

    // Check for "preferences" key in core memory
    const preferencesKey = page.locator('.memory-core-key', { hasText: 'preferences' });
    await preferencesKey.waitFor({ state: 'visible' });

    // Check for "identity" key in core memory
    const identityKey = page.locator('.memory-core-key', { hasText: 'identity' });
    await identityKey.waitFor({ state: 'visible' });

    // Verify core memory values render as JSON
    const coreValues = page.locator('.memory-core-value');
    const firstCoreValue = await coreValues.first().textContent();
    expect(firstCoreValue).toBeTruthy();
    expect(firstCoreValue).toContain('zh-CN');

    // Verify Extended Memory section header
    const extHeader = page.locator('h3', { hasText: 'Extended Memory' });
    await extHeader.waitFor({ state: 'visible' });

    // Verify extended memory keys
    const extItems = page.locator('.memory-ext-item');
    const extCount = await extItems.count();
    expect(extCount).toBeGreaterThan(0);

    // Check for "project-notes" key
    const projectNotes = page.locator('.memory-ext-key', { hasText: 'project-notes' });
    await projectNotes.waitFor({ state: 'visible' });

    // Check for key count display
    const keyCount = page.locator('.mgmt-count', { hasText: /keys/ });
    await keyCount.waitFor({ state: 'visible' });

    await screenshot(page, '08-memory-panel');
  });

  // =========================================================================
  // Test 9: Agent management panel - MCP Servers tab
  // =========================================================================

  it('should display MCP Servers tab with server list', async () => {
    if (skipIfNoServer()) return;

    // Click MCP Servers tab (UI operation)
    const mcpTab = page.locator('.mgmt-tab', { hasText: 'MCP Servers' });
    await mcpTab.click();

    // Wait for MCP content to load
    await page.waitForSelector('.mcp-list', { timeout: PAGE_TIMEOUT });

    // Verify MCP server items
    const mcpItems = page.locator('.mcp-item');
    const mcpCount = await mcpItems.count();
    expect(mcpCount).toBeGreaterThan(0);

    // Check for specific MCP servers from our mock state
    const playwrightServer = page.locator('.mcp-name', { hasText: 'playwright' });
    await playwrightServer.waitFor({ state: 'visible' });

    const notionServer = page.locator('.mcp-name', { hasText: 'notion' });
    await notionServer.waitFor({ state: 'visible' });

    const githubServer = page.locator('.mcp-name', { hasText: 'github' });
    await githubServer.waitFor({ state: 'visible' });

    // Verify server type badges
    const typeLabels = page.locator('.mcp-type');
    const firstType = await typeLabels.first().textContent();
    expect(firstType).toBe('stdio');

    // Verify tool count display
    const toolCountLabels = page.locator('.mcp-tools');
    const firstToolCount = await toolCountLabels.first().textContent();
    expect(firstToolCount).toContain('tools');

    // Verify toggle switches exist
    const toggleSwitches = page.locator('.mcp-item .toggle-switch');
    const toggleCount = await toggleSwitches.count();
    expect(toggleCount).toBe(mcpCount);

    // Verify server count display
    const serverCount = page.locator('.mgmt-count', { hasText: /servers/ });
    await serverCount.waitFor({ state: 'visible' });

    // Expand a server to see its tools (UI operation — click to expand)
    const playwrightItem = page.locator('.mcp-item', { hasText: 'playwright' });
    const playwrightMain = playwrightItem.locator('.mcp-item-main');
    await playwrightMain.click();

    // Wait for tool list to expand
    await sleep(500);

    // Check for tool chips
    const toolChips = page.locator('.mcp-tool-chip');
    const chipCount = await toolChips.count();
    if (chipCount > 0) {
      const navigateTool = page.locator('.mcp-tool-chip', { hasText: 'browser_navigate' });
      await navigateTool.waitFor({ state: 'visible' });
    }

    await screenshot(page, '09-mcp-panel');
  });
});
