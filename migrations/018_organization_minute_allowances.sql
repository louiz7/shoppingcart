-- Versioned monthly minute allowances for stable historical billing. Changes
-- are effective from a calendar month and never rewrite earlier invoices.

CREATE TABLE IF NOT EXISTS organization_minute_allowances (
    customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    effective_month  DATE    NOT NULL,
    included_minutes INTEGER NOT NULL CHECK (included_minutes >= 0),
    updated_by       BIGINT  REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (customer_id, effective_month),
    CHECK (effective_month = date_trunc('month', effective_month)::date)
);

CREATE INDEX IF NOT EXISTS organization_minute_allowances_lookup_idx
    ON organization_minute_allowances (customer_id, effective_month DESC);
