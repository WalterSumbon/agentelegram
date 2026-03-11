/**
 * Authentication routes — register & login for human participants.
 */
import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { getPool } from './db.js';

export const JWT_SECRET = process.env.JWT_SECRET ?? 'agentelegram-dev-secret';
const SALT_ROUNDS = 10;

export const authRouter = Router();

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
