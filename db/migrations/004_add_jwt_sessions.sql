BEGIN;

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
);

CREATE INDEX IF NOT EXISTS idx_jwt_sessions_user_active
ON jwt_sessions(user_id, expires_at DESC)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jwt_sessions_expires_at
ON jwt_sessions(expires_at);

COMMIT;
