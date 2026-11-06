-- Internal operator notifications are independent of customer SMS and call outcomes.
CREATE TABLE IF NOT EXISTS recovery_call_alerts (
    call_id UUID PRIMARY KEY REFERENCES recovery_calls(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('sending','accepted','failed','unknown')),
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    last_error TEXT
);
