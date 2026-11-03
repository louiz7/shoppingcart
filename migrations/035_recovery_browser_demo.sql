-- Browser sessions are isolated from customer contacts, calls, orders and revenue.
CREATE TABLE IF NOT EXISTS recovery_demo_sessions (
    id uuid PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    browser_hash text NOT NULL UNIQUE,
    client_hash text NOT NULL,
    shop_id uuid NOT NULL REFERENCES recovery_shops(id),
    room text NOT NULL UNIQUE,
    data jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS recovery_demo_created ON recovery_demo_sessions(created_at);
