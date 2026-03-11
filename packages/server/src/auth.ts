/**
 * Authentication routes — register & login for human participants + agent registration.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getPool } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'agentelegram-dev-secret';
const SALT_ROUNDS = 10;

/**
 * Length of the key_prefix stored alongside the bcrypt hash.
 * Includes the "ag-" prefix, so "ag-a1b2c" = 8 chars total.
 * This provides enough cardinality for O(1) lookups while leaking
 * zero practical information (the full key has 128-bit entropy).
 */
const KEY_PREFIX_LEN = 8;

export const authRouter = Router();

// ---------------------------------------------------------------------------
// Middleware: require JWT (Authorization: Bearer <token>)
// ---------------------------------------------------------------------------

interface JwtPayload {
  sub: string;
  name: string;
  type: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing or invalid Authorization header' });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as JwtPayload;
    // Attach to request for downstream handlers
    (req as Request & { auth: JwtPayload }).auth = payload;
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Human auth routes (no middleware required)
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/register
 * Body: { name, displayName, password }
 * Returns: { participant, token }
 */
authRouter.post('/register', async (req, res) => {
  const { name, displayName, password } = req.body;

  if (!name || !displayName || !password) {
    res.status(400).json({ error: 'name, displayName, and password are required' });
    return;
  }

  if (password.length < 4) {
    res.status(400).json({ error: 'password must be at least 4 characters' });
    return;
  }

  const db = getPool();

  // Check if name already taken
  const existing = await db.query('SELECT id FROM participants WHERE name = $1', [name]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'name already taken' });
    return;
  }

  const authHash = await bcrypt.hash(password, SALT_ROUNDS);

  const result = await db.query(
    `INSERT INTO participants (type, name, display_name, auth_hash)
     VALUES ('human', $1, $2, $3)
     RETURNING id, type, name, display_name, avatar_url, created_at`,
    [name, displayName, authHash]
  );

  const row = result.rows[0];
  const participant = {
    id: row.id,
    type: row.type,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: Number(row.created_at),
  };

  const token = jwt.sign({ sub: participant.id, name: participant.name, type: 'human' }, JWT_SECRET, {
    expiresIn: '7d',
  });

  res.status(201).json({ participant, token });
});

/**
 * POST /api/auth/login
 * Body: { name, password }
 * Returns: { participant, token }
 */
authRouter.post('/login', async (req, res) => {
  const { name, password } = req.body;

  if (!name || !password) {
    res.status(400).json({ error: 'name and password are required' });
    return;
  }

  const db = getPool();
  const result = await db.query(
    `SELECT id, type, name, display_name, avatar_url, auth_hash, created_at
     FROM participants WHERE name = $1 AND type = 'human'`,
    [name]
  );

  if (result.rows.length === 0) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const row = result.rows[0];
  const valid = await bcrypt.compare(password, row.auth_hash);
  if (!valid) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }

  const participant = {
    id: row.id,
    type: row.type,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: Number(row.created_at),
  };

  const token = jwt.sign({ sub: participant.id, name: participant.name, type: row.type }, JWT_SECRET, {
    expiresIn: '7d',
  });

  res.json({ participant, token });
});

/**
 * GET /api/auth/me — get current user from JWT
 */
authRouter.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing token' });
    return;
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as { sub: string };
    const db = getPool();
    const result = await db.query(
      `SELECT id, type, name, display_name, avatar_url, created_at
       FROM participants WHERE id = $1`,
      [payload.sub]
    );
    if (result.rows.length === 0) {
      res.status(401).json({ error: 'user not found' });
      return;
    }
    const row = result.rows[0];
    res.json({
      id: row.id,
      type: row.type,
      name: row.name,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      createdAt: Number(row.created_at),
    });
  } catch {
    res.status(401).json({ error: 'invalid token' });
  }
});

// ---------------------------------------------------------------------------
// Agent registration (requires JWT — only logged-in humans can register agents)
// ---------------------------------------------------------------------------

/**
 * POST /api/auth/register-agent
 * Headers: Authorization: Bearer <jwt>
 * Body: { name, displayName }
 * Returns: { participant, apiKey }
 *
 * The raw API key is returned ONCE — it cannot be retrieved later.
 * The server stores only a bcrypt hash + a short prefix for O(1) lookup.
 */
authRouter.post('/register-agent', requireAuth, async (req, res) => {
  const { name, displayName } = req.body;

  if (!name || !displayName) {
    res.status(400).json({ error: 'name and displayName are required' });
    return;
  }

  const db = getPool();

  const existing = await db.query('SELECT id FROM participants WHERE name = $1', [name]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'name already taken' });
    return;
  }

  // Generate a random API key: ag-<32 hex chars>
  const apiKey = `ag-${randomBytes(16).toString('hex')}`;
  const keyPrefix = apiKey.slice(0, KEY_PREFIX_LEN);
  const authHash = await bcrypt.hash(apiKey, SALT_ROUNDS);

  const result = await db.query(
    `INSERT INTO participants (type, name, display_name, auth_hash, key_prefix)
     VALUES ('agent', $1, $2, $3, $4)
     RETURNING id, type, name, display_name, avatar_url, created_at`,
    [name, displayName, authHash, keyPrefix]
  );

  const row = result.rows[0];
  const participant = {
    id: row.id,
    type: row.type,
    name: row.name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: Number(row.created_at),
  };

  // Return raw API key — only time it's visible
  res.status(201).json({ participant, apiKey });
});

// ---------------------------------------------------------------------------
// API key verification (used by ws-handler)
// ---------------------------------------------------------------------------

/**
 * Verify an API key against the database.
 * Uses key_prefix for O(1) lookup instead of scanning all agents.
 * Returns the auth payload if valid, null otherwise.
 */
export async function verifyApiKey(apiKey: string): Promise<{ sub: string; name: string; type: string } | null> {
  const db = getPool();
  const keyPrefix = apiKey.slice(0, KEY_PREFIX_LEN);

  // O(1) lookup by key_prefix — typically returns exactly 1 row
  const result = await db.query(
    `SELECT id, name, type, auth_hash FROM participants WHERE type = 'agent' AND key_prefix = $1`,
    [keyPrefix]
  );

  // Compare against matching rows (usually just 1)
  for (const row of result.rows) {
    const valid = await bcrypt.compare(apiKey, row.auth_hash);
    if (valid) {
      return { sub: row.id, name: row.name, type: row.type };
    }
  }
  return null;
}
