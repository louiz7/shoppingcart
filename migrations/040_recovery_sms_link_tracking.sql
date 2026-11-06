CREATE TABLE IF NOT EXISTS recovery_sms_links (
    action_id UUID PRIMARY KEY REFERENCES recovery_actions(id) ON DELETE CASCADE,
    call_id UUID NOT NULL REFERENCES recovery_calls(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
    first_opened_at TIMESTAMPTZ
);
-- Keep aggregate conversion proof after the 30-day SMS retention window.
ALTER TABLE recovery_orders ADD COLUMN IF NOT EXISTS sms_link_opened_at TIMESTAMPTZ;
