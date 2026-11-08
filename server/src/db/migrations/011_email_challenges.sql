CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL CHECK (flow IN ('signup', 'email-change')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (
    (flow = 'signup' AND user_id IS NULL) OR
    (flow = 'email-change' AND user_id IS NOT NULL)
  )
);

CREATE INDEX email_challenges_by_expiry ON email_challenges (expires_at_ms);

CREATE TABLE email_otp_rate_limits (
  email_hash TEXT PRIMARY KEY,
  window_started_at_ms INTEGER NOT NULL,
  send_count INTEGER NOT NULL CHECK (send_count >= 0)
);
