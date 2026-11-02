-- Dropsize Shopify connection and immutable context captured for each email draft.

CREATE TABLE IF NOT EXISTS shopify_oauth_states (
    id          BIGSERIAL PRIMARY KEY,
    state_hash  TEXT        NOT NULL UNIQUE,
    customer_id INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    shop_domain TEXT        NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopify_oauth_states_expiry_idx
    ON shopify_oauth_states (expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS shopify_connections (
    id                    BIGSERIAL PRIMARY KEY,
    customer_id           INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    shop_domain           TEXT        NOT NULL,
    shop_name             TEXT,
    status                TEXT        NOT NULL DEFAULT 'connected'
                                       CHECK (status IN ('connected', 'error', 'disabled')),
    granted_scopes        TEXT[]      NOT NULL DEFAULT '{}'::text[],
    credentials_encrypted TEXT        NOT NULL,
    last_verified_at      TIMESTAMPTZ,
    last_error            TEXT,
    created_by            BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id),
    UNIQUE (shop_domain)
);

ALTER TABLE email_drafts
    ADD COLUMN IF NOT EXISTS shopify_context JSONB;
