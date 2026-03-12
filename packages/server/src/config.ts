/**
 * Centralized configuration — all tunable values in one place.
 *
 * Every value reads from an environment variable first, falling back
 * to a sensible development default.  In production, set environment
 * variables explicitly.
 */

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const PORT = parseInt(process.env.PORT ?? '4000', 10);

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://localhost:5432/agentelegram';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * JWT signing secret.
 * MUST be set via JWT_SECRET env var in production.
 * The dev fallback is intentionally weak to remind you to change it.
 */
export const JWT_SECRET = process.env.JWT_SECRET ?? 'agentelegram-dev-secret';

/**
 * JWT token lifetime (e.g. '7d', '24h', '30m').
 * Cast to `ms.StringValue` so jsonwebtoken's `expiresIn` option accepts it.
 */
export const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ?? '7d') as import('ms').StringValue;

/** bcrypt salt rounds. */
export const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS ?? '10', 10);

/**
 * Length of the key_prefix stored alongside the bcrypt hash for O(1) lookup.
 * Includes the "ag-" prefix, so "ag-a1b2c" = 8 chars total.
 */
export const KEY_PREFIX_LEN = 8;

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Timeout (ms) for the client to send the auth message after connecting. */
export const WS_AUTH_TIMEOUT_MS = parseInt(
  process.env.WS_AUTH_TIMEOUT_MS ?? '10000',
  10,
);

/** Timeout (ms) for an agent to respond to a management request. */
export const WS_MGMT_TIMEOUT_MS = parseInt(
  process.env.WS_MGMT_TIMEOUT_MS ?? '15000',
  10,
);

/** Delay (ms) before the frontend auto-reconnects after disconnect. */
export const WS_RECONNECT_DELAY_MS = parseInt(
  process.env.WS_RECONNECT_DELAY_MS ?? '2000',
  10,
);
