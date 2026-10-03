-- Initialize local PostgreSQL database with test data
-- This mimics the Neon database structure for local testing

-- Create test users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create test sessions table (Better Auth)
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TIMESTAMPTZ NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);
CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_expires_at ON session(expires_at);

-- Insert test user
INSERT INTO users (id, email, full_name)
VALUES 
    ('test-user-1', 'test@classroomio.com', 'Test User')
ON CONFLICT (id) DO NOTHING;

-- Insert test session
INSERT INTO session (id, user_id, expires_at, token)
VALUES 
    ('test-session-1', 'test-user-1', NOW() + INTERVAL '1 hour', 'test-session-token-123')
ON CONFLICT (id) DO NOTHING;

-- Create test organization table
CREATE TABLE IF NOT EXISTS organization (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO organization (id, name)
VALUES ('test-org-1', 'Test Organization')
ON CONFLICT (id) DO NOTHING;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO neondb_owner;
