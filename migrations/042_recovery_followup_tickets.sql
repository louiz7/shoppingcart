CREATE TABLE IF NOT EXISTS recovery_followup_tickets (
    id UUID PRIMARY KEY,
    call_id UUID NOT NULL UNIQUE REFERENCES recovery_calls(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('unresolved_question','shop_action_required','technical_failure','human_requested')),
    summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 600),
    callback_requested BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by BIGINT REFERENCES platform_users(id) ON DELETE SET NULL
);
