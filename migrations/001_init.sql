-- Schema for the Deliah voice API reseller proxy.

CREATE TABLE IF NOT EXISTS customers (
    id              SERIAL PRIMARY KEY,
    name            TEXT        NOT NULL,
    email           TEXT        UNIQUE NOT NULL,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API keys are stored hashed. The plaintext is shown to the customer ONCE on creation.
-- key_prefix is the first 8 chars of the plaintext key, used to look up the row quickly
-- before doing the bcrypt compare.
CREATE TABLE IF NOT EXISTS api_keys (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    key_prefix      TEXT        NOT NULL UNIQUE,
    key_hash        TEXT        NOT NULL,
    label           TEXT,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS api_keys_customer_idx ON api_keys(customer_id);

-- Per-request usage log. Source of truth for billing.
CREATE TABLE IF NOT EXISTS usage_events (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    api_key_id      INTEGER     REFERENCES api_keys(id) ON DELETE SET NULL,
    method          TEXT        NOT NULL,
    path            TEXT        NOT NULL,
    upstream_status INTEGER,
    duration_ms     INTEGER     NOT NULL,        -- HTTP round-trip time
    voice_seconds   NUMERIC(12,3) NOT NULL DEFAULT 0,  -- billable voice seconds
    cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_events_customer_time_idx
    ON usage_events(customer_id, created_at DESC);
