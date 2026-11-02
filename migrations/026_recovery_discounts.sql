-- Merchant approval is durable before the Shopify mutation; uncertain results never auto-retry.
CREATE TABLE IF NOT EXISTS recovery_discounts (
    id UUID PRIMARY KEY,
    shop_id UUID NOT NULL REFERENCES recovery_shops(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
    code TEXT NOT NULL CHECK(code ~ '^[A-Z0-9_-]{3,32}$'),
    percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 30),
    min_subtotal_cents INTEGER NOT NULL CHECK(min_subtotal_cents>=0),
    valid_days INTEGER NOT NULL CHECK(valid_days BETWEEN 1 AND 30),
    expires_at TIMESTAMPTZ NOT NULL,
    usage_limit INTEGER NOT NULL CHECK(usage_limit BETWEEN 1 AND 1000),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed','unknown')),
    shopify_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(shop_id,request_id),
    UNIQUE(shop_id,code)
);
CREATE INDEX IF NOT EXISTS recovery_discounts_available ON recovery_discounts(shop_id,expires_at) WHERE status='confirmed';
