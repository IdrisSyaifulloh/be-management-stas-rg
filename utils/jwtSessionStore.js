const crypto = require("crypto");
const { query } = require("../db/pool");

const JWT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let ensureJwtSessionsTablePromise = null;

function generateSessionId() {
  return `JTS-${crypto.randomUUID()}`;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function getJwtSessionExpiresAt(date = new Date()) {
  return new Date(date.getTime() + JWT_SESSION_TTL_MS);
}

async function ensureJwtSessionsTable() {
  if (!ensureJwtSessionsTablePromise) {
    ensureJwtSessionsTablePromise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS jwt_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          user_agent TEXT,
          ip TEXT,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          last_seen_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_jwt_sessions_user_active
        ON jwt_sessions(user_id, expires_at DESC)
        WHERE revoked_at IS NULL
      `);

      await query(`
        CREATE INDEX IF NOT EXISTS idx_jwt_sessions_expires_at
        ON jwt_sessions(expires_at)
      `);
    })();
  }

  await ensureJwtSessionsTablePromise;
}

async function createJwtSession({ id, userId, token, expiresAt, userAgent = null, ip = null }) {
  if (!id || !userId || !token || !expiresAt) {
    const error = new Error("id, userId, token, dan expiresAt wajib diisi.");
    error.statusCode = 400;
    throw error;
  }

  await ensureJwtSessionsTable();

  await query(
    `
    INSERT INTO jwt_sessions (id, user_id, token_hash, user_agent, ip, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [id, userId, hashToken(token), userAgent, ip, expiresAt]
  );

  return {
    id,
    userId,
    expiresAt
  };
}

async function verifyJwtSession({ id, userId, token }) {
  if (!id || !userId || !token) return false;

  await ensureJwtSessionsTable();

  const result = await query(
    `
    UPDATE jwt_sessions
    SET last_seen_at = NOW()
    WHERE id = $1
      AND user_id = $2
      AND token_hash = $3
      AND revoked_at IS NULL
      AND expires_at > NOW()
    RETURNING id
    `,
    [id, userId, hashToken(token)]
  );

  return result.rowCount > 0;
}

async function revokeJwtSession({ id, userId = null, token = null }) {
  if (!id && !token) return false;

  await ensureJwtSessionsTable();

  const params = [id || null, userId || null, token ? hashToken(token) : null];
  const result = await query(
    `
    UPDATE jwt_sessions
    SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE ($1::text IS NULL OR id = $1)
      AND ($2::text IS NULL OR user_id = $2)
      AND ($3::text IS NULL OR token_hash = $3)
      AND revoked_at IS NULL
    `,
    params
  );

  return result.rowCount > 0;
}

module.exports = {
  JWT_SESSION_TTL_MS,
  createJwtSession,
  ensureJwtSessionsTable,
  generateSessionId,
  getJwtSessionExpiresAt,
  revokeJwtSession,
  verifyJwtSession
};
