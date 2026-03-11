/**
 * Agent Management REST API routes.
 *
 * These endpoints allow the frontend to query and modify agent state.
 * The server acts as a proxy: REST request → WebSocket mgmt_request → Agent
 * → WebSocket mgmt_response → REST response.
 *
 * All routes require JWT authentication (human user).
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth } from './auth.js';
import { getPool } from './db.js';
import { sendMgmtRequest, isParticipantOnline } from './ws-handler.js';
import type { MgmtAction } from '@agentelegram/shared';

export const managementRouter = Router();

// All management routes require JWT
managementRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// Helper: forward a management action to an agent and return the result
// ---------------------------------------------------------------------------

async function forwardToAgent(
  res: Response,
  agentId: string,
  action: MgmtAction,
  payload?: Record<string, unknown>,
): Promise<void> {
  // Verify participant exists and is an agent
  const db = getPool();
  const check = await db.query(
    `SELECT type FROM participants WHERE id = $1`,
    [agentId]
  );
  if (check.rows.length === 0) {
    res.status(404).json({ error: 'participant not found' });
    return;
  }
  if (check.rows[0].type !== 'agent') {
    res.status(400).json({ error: 'participant is not an agent' });
    return;
  }

  try {
    const data = await sendMgmtRequest(agentId, action, payload);
    res.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (message === 'agent is offline') {
      res.status(503).json({ error: 'agent is offline', online: false });
    } else if (message === 'management request timed out') {
      res.status(504).json({ error: 'agent did not respond in time' });
    } else {
      res.status(502).json({ error: message });
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/agents — list all agents with online status
// ---------------------------------------------------------------------------

managementRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const db = getPool();
    const result = await db.query(
      `SELECT id, name, display_name, avatar_url, created_at
       FROM participants WHERE type = 'agent'
       ORDER BY created_at`
    );

    const agents = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      createdAt: Number(r.created_at),
      online: isParticipantOnline(r.id),
    }));

    res.json(agents);
  } catch (err) {
    console.error('[mgmt] failed to list agents:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/agents/:id — agent overview (online status + full state if online)
// ---------------------------------------------------------------------------

managementRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const agentId = req.params.id as string;

    const db = getPool();
    const check = await db.query(
      `SELECT id, name, display_name, avatar_url, created_at
       FROM participants WHERE id = $1 AND type = 'agent'`,
      [agentId]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    const row = check.rows[0];
    const online = isParticipantOnline(agentId);
    const agent = {
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      createdAt: Number(row.created_at),
      online,
    };

    if (!online) {
      res.json({ agent, state: null });
      return;
    }

    // Agent is online — request full state
    try {
      const state = await sendMgmtRequest(agentId, 'query_state');
      res.json({ agent, state });
    } catch {
      // Agent online but didn't respond — return partial info
      res.json({ agent, state: null });
    }
  } catch (err) {
    console.error('[mgmt] failed to get agent:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

managementRouter.get('/:id/skills', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'query_skills');
});

managementRouter.patch('/:id/skills/:skillName', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  await forwardToAgent(res, req.params.id as string, 'update_skill', {
    name: req.params.skillName as string,
    enabled,
  });
});

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

managementRouter.get('/:id/memory', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'query_memory');
});

managementRouter.get('/:id/memory/:tier/:key', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'read_memory', {
    tier: req.params.tier as string,
    key: req.params.key as string,
  });
});

managementRouter.put('/:id/memory/:tier/:key', async (req: Request, res: Response) => {
  const { value, description } = req.body;
  if (value === undefined) {
    res.status(400).json({ error: 'value is required' });
    return;
  }
  await forwardToAgent(res, req.params.id as string, 'write_memory', {
    tier: req.params.tier as string,
    key: req.params.key as string,
    value,
    description,
  });
});

managementRouter.delete('/:id/memory/:tier/:key', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'delete_memory', {
    tier: req.params.tier as string,
    key: req.params.key as string,
  });
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

managementRouter.get('/:id/cron', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'query_cron');
});

managementRouter.post('/:id/cron', async (req: Request, res: Response) => {
  const { schedule, description, enabled } = req.body;
  if (!schedule || !description) {
    res.status(400).json({ error: 'schedule and description are required' });
    return;
  }
  await forwardToAgent(res, req.params.id as string, 'create_cron', {
    schedule,
    description,
    enabled: enabled ?? true,
  });
});

managementRouter.patch('/:id/cron/:cronId', async (req: Request, res: Response) => {
  const { schedule, description, enabled } = req.body;
  await forwardToAgent(res, req.params.id as string, 'update_cron', {
    id: req.params.cronId as string,
    ...(schedule !== undefined && { schedule }),
    ...(description !== undefined && { description }),
    ...(enabled !== undefined && { enabled }),
  });
});

managementRouter.delete('/:id/cron/:cronId', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'delete_cron', {
    id: req.params.cronId as string,
  });
});

// ---------------------------------------------------------------------------
// MCP Servers
// ---------------------------------------------------------------------------

managementRouter.get('/:id/mcp', async (req: Request, res: Response) => {
  await forwardToAgent(res, req.params.id as string, 'query_mcp');
});

managementRouter.patch('/:id/mcp/:mcpName', async (req: Request, res: Response) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  await forwardToAgent(res, req.params.id as string, 'update_mcp', {
    name: req.params.mcpName as string,
    enabled,
  });
});
