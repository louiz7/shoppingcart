-- Cart recovery is separate from debt collection. Nothing activates outbound work.
CREATE TABLE IF NOT EXISTS recovery_shops (
    id UUID PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    domain TEXT NOT NULL UNIQUE,
    storefront_domain TEXT,
    brand TEXT NOT NULL,
    brand_voice TEXT NOT NULL DEFAULT 'Freundlich, klar und respektvoll. Siezen.',
    mode TEXT NOT NULL DEFAULT 'simulation' CHECK (mode IN ('simulation', 'live')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    approved_at TIMESTAMPTZ,
    credentials_encrypted TEXT,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    rules JSONB NOT NULL DEFAULT '{}',
    sync_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (id, customer_id)
);
CREATE TABLE IF NOT EXISTS recovery_contacts (
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    contact_key TEXT NOT NULL,
    phone TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
    consented_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    evidence TEXT,
    revoked_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    stop_reason TEXT,
    arm TEXT CHECK (arm IN ('control', 'treatment')),
    enrolled_at TIMESTAMPTZ,
    experiment_rules JSONB,
    PRIMARY KEY (shop_id, contact_key)
);
CREATE TABLE IF NOT EXISTS recovery_checkouts (
    id UUID PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    checkout_token TEXT,
    contact_key TEXT,
    phone TEXT,
    email TEXT,
    currency TEXT NOT NULL DEFAULT 'EUR',
    subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
    snapshot JSONB NOT NULL DEFAULT '{}',
    source_updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'calling', 'contacted', 'stopped', 'converted', 'expired')),
    arm TEXT CHECK (arm IN ('control', 'treatment')),
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (shop_id, external_id),
    UNIQUE (id, shop_id),
    FOREIGN KEY (shop_id, contact_key) REFERENCES recovery_contacts(shop_id, contact_key)
);
CREATE INDEX IF NOT EXISTS recovery_checkouts_due ON recovery_checkouts (source_updated_at) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS recovery_orders (
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    checkout_token TEXT,
    checkout_external_id TEXT,
    phone TEXT,
    currency TEXT NOT NULL,
    paid BOOLEAN NOT NULL,
    net_cents INTEGER NOT NULL DEFAULT 0,
    source_updated_at TIMESTAMPTZ NOT NULL,
    ordered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (shop_id, external_id)
);
CREATE TABLE IF NOT EXISTS recovery_calls (
    id UUID PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    checkout_id UUID NOT NULL,
    contact_key TEXT NOT NULL,
    room TEXT NOT NULL UNIQUE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'dialing', 'connected', 'ended', 'failed', 'unknown', 'simulated')),
    connected_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    outcome TEXT,
    summary TEXT,
    identity_verified BOOLEAN NOT NULL DEFAULT FALSE,
    cost_cents INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (checkout_id, shop_id) REFERENCES recovery_checkouts(id, shop_id) ON DELETE CASCADE,
    FOREIGN KEY (shop_id, contact_key) REFERENCES recovery_contacts(shop_id, contact_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS recovery_calls_one_active_contact ON recovery_calls(shop_id, contact_key)
    WHERE status IN ('reserved', 'dialing', 'connected', 'unknown');
CREATE TABLE IF NOT EXISTS recovery_actions (
    id UUID PRIMARY KEY,
    checkout_id UUID NOT NULL REFERENCES recovery_checkouts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('offer', 'sms')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'accepted', 'delivered', 'failed', 'unknown', 'simulated')),
    data JSONB NOT NULL DEFAULT '{}',
    provider_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (checkout_id, kind)
);
CREATE TABLE IF NOT EXISTS recovery_events (
    id UUID PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    call_id UUID REFERENCES recovery_calls(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    data JSONB NOT NULL DEFAULT '{}',
    duration_ms INTEGER CHECK (duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS recovery_events_shop_time ON recovery_events(shop_id, created_at DESC);
CREATE TABLE IF NOT EXISTS recovery_webhooks (
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (shop_id, event_id)
);
CREATE TABLE IF NOT EXISTS recovery_oauth_states (
    state_hash TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    shop_domain TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE recovery_calls ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS recovery_sms_receipts (
    action_id UUID NOT NULL REFERENCES recovery_actions(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('accepted','delivered','failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(action_id,provider_id)
);
ALTER TABLE recovery_shops ADD COLUMN IF NOT EXISTS webhooks_ready BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE recovery_contacts ADD COLUMN IF NOT EXISTS consent_checkout_id UUID;
ALTER TABLE recovery_checkouts ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_calls_one_active_shop ON recovery_calls(shop_id)
    WHERE status IN ('reserved','dialing','connected','unknown');
CREATE INDEX IF NOT EXISTS recovery_calls_contact_time ON recovery_calls(shop_id,contact_key,created_at DESC);
CREATE INDEX IF NOT EXISTS recovery_orders_contact_time ON recovery_orders(shop_id,phone,ordered_at);
CREATE INDEX IF NOT EXISTS recovery_events_call_time ON recovery_events(call_id,created_at DESC);
ALTER TABLE recovery_orders ADD COLUMN IF NOT EXISTS contact_key TEXT;
UPDATE recovery_orders SET contact_key=encode(sha256(convert_to(shop_id::text||':'||phone,'UTF8')),'hex')
    WHERE contact_key IS NULL AND phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS recovery_orders_contact_key_time ON recovery_orders(shop_id,contact_key,ordered_at);
ALTER TABLE recovery_shops ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'EUR' CHECK(currency IN ('EUR','USD'));
-- Unknown historical dial/payment times stay unknown; never infer them from creation timestamps.
ALTER TABLE recovery_calls ADD COLUMN IF NOT EXISTS dialed_at TIMESTAMPTZ;
ALTER TABLE recovery_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS recovery_calls_dialed_time ON recovery_calls(shop_id,dialed_at) WHERE dialed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS recovery_calls_checkout_connection ON recovery_calls(shop_id,checkout_id,connected_at) WHERE connected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS recovery_orders_paid_time ON recovery_orders(shop_id,paid_at) WHERE paid AND paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS recovery_checkouts_token ON recovery_checkouts(shop_id,checkout_token) WHERE checkout_token IS NOT NULL;
