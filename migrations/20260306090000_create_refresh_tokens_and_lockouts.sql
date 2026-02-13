-- Refresh tokens table for rotation + reuse detection
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  tenant_id UUID NULL,
  role TEXT NOT NULL,
  hashed_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  replaced_by_id UUID NULL,
  ip TEXT NULL,
  user_agent TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- Auth lockouts for brute-force protection
CREATE TABLE IF NOT EXISTS auth_lockouts (
  id UUID PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  tenant_id UUID NULL,
  fail_count INT NOT NULL DEFAULT 0,
  lock_until TIMESTAMPTZ NULL,
  last_ip TEXT NULL,
  last_user_agent TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_lockouts_subject UNIQUE(subject_type, subject_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_lockouts_lock_until ON auth_lockouts(lock_until);
