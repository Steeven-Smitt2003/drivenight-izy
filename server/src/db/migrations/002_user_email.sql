ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

CREATE UNIQUE INDEX users_by_email ON users (email) WHERE email IS NOT NULL;
