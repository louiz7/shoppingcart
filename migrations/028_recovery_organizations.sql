ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_rescova_internal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE recovery_calls ADD COLUMN IF NOT EXISTS confirmed_duration_seconds NUMERIC(12,3)
    CHECK (confirmed_duration_seconds >= 0);
ALTER TABLE recovery_orders ADD COLUMN IF NOT EXISTS recovery_checkout_id UUID;
DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='recovery_orders_checkout_proof') THEN
        ALTER TABLE recovery_orders ADD CONSTRAINT recovery_orders_checkout_proof
            FOREIGN KEY(recovery_checkout_id,shop_id) REFERENCES recovery_checkouts(id,shop_id);
    END IF;
END $$;
UPDATE recovery_orders o SET recovery_checkout_id=c.id FROM recovery_checkouts c
    WHERE o.shop_id=c.shop_id AND o.recovery_checkout_id IS NULL AND
        ((o.checkout_token IS NOT NULL AND o.checkout_token=c.checkout_token) OR o.checkout_external_id=c.external_id);

CREATE TABLE IF NOT EXISTS recovery_auth_attempts (
    kind TEXT NOT NULL CHECK (kind IN ('login_ip','login_email','register_ip','register_email')),
    subject_hash TEXT NOT NULL CHECK (length(subject_hash)=64),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts>=1),
    PRIMARY KEY(kind,subject_hash)
);
CREATE INDEX IF NOT EXISTS recovery_auth_attempts_expiry ON recovery_auth_attempts(window_started_at);
