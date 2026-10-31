CREATE TABLE users (
 id UUID PRIMARY KEY,
 username_normalized VARCHAR(32) NOT NULL UNIQUE CHECK (username_normalized ~ '^[a-z0-9_]{3,32}$'),
 password_hash VARCHAR(512) NOT NULL,
 auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 0),
 created_at TIMESTAMPTZ(3) NOT NULL,
 updated_at TIMESTAMPTZ(3) NOT NULL,
 deleted_at TIMESTAMPTZ(3)
);
CREATE TABLE sessions (
 id UUID PRIMARY KEY,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 token_digest CHAR(64) NOT NULL UNIQUE,
 auth_epoch INTEGER NOT NULL CHECK (auth_epoch >= 0),
 expires_at TIMESTAMPTZ(3) NOT NULL,
 revoked_at TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE TABLE captcha_challenges (
 id UUID PRIMARY KEY,
 visitor_digest CHAR(64) NOT NULL,
 answer_digest CHAR(64) NOT NULL,
 expires_at TIMESTAMPTZ(3) NOT NULL,
 consumed_at TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX captcha_challenges_expires_at_idx ON captcha_challenges(expires_at);
CREATE TABLE auth_attempts (
 identity_digest CHAR(64) PRIMARY KEY,
 consecutive_failures INTEGER NOT NULL CHECK (consecutive_failures >= 0),
 cooldown_until TIMESTAMPTZ(3),
 updated_at TIMESTAMPTZ(3) NOT NULL
);
CREATE TABLE auth_rate_buckets (
 scope VARCHAR(32) NOT NULL,
 subject_digest CHAR(64) NOT NULL,
 window_start TIMESTAMPTZ(3) NOT NULL,
 attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
 expires_at TIMESTAMPTZ(3) NOT NULL,
 PRIMARY KEY(scope, subject_digest, window_start)
);
CREATE INDEX auth_rate_buckets_expires_at_idx ON auth_rate_buckets(expires_at);
