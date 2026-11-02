-- Add webhook token per customer (so Deepslate call_event_hooks can be
-- attributed to a customer) and call_id for idempotent billing of webhooks
-- and realtime sessions.

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS webhook_token TEXT UNIQUE;

ALTER TABLE usage_events
    ADD COLUMN IF NOT EXISTS call_id TEXT,
    ADD COLUMN IF NOT EXISTS source  TEXT NOT NULL DEFAULT 'rest';
        -- source: 'rest' | 'realtime_ws' | 'webhook'

-- Idempotency: one billing row per (customer, call_id, source).
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_call_unique
    ON usage_events(customer_id, source, call_id)
    WHERE call_id IS NOT NULL;
