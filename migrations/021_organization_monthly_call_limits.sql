-- Optional hard monthly call-minute ceiling. This is deliberately separate
-- from included_minutes, which remains a billing/overage allowance.

CREATE TABLE IF NOT EXISTS organization_monthly_call_limits (
    customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    effective_month   DATE    NOT NULL,
    max_minutes       INTEGER CHECK (max_minutes IS NULL OR max_minutes > 0),
    updated_by        BIGINT  REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, effective_month),
    CHECK (effective_month = date_trunc('month', effective_month)::date)
);

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS pause_reason TEXT,
    ADD COLUMN IF NOT EXISTS limit_pause_month DATE;

CREATE INDEX IF NOT EXISTS campaigns_limit_pause_idx
    ON campaigns (customer_id, limit_pause_month)
    WHERE pause_reason = 'monthly_minute_limit_reached';
