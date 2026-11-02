-- Separate dial/setup time from the actual connected conversation lifetime.
-- Existing timestamps are deliberately not reinterpreted: historic rows do
-- not contain a trustworthy answer timestamp and remain legacy_unknown.

ALTER TABLE call_attempts
    ADD COLUMN IF NOT EXISTS dial_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS hangup_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disconnect_observed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lifecycle_status TEXT,
    ADD COLUMN IF NOT EXISTS disconnect_reason TEXT,
    ADD COLUMN IF NOT EXISTS sip_status_code INTEGER,
    ADD COLUMN IF NOT EXISTS duration_source TEXT;

UPDATE call_attempts
   SET dial_started_at = COALESCE(dial_started_at, started_at),
       lifecycle_status = COALESCE(
           lifecycle_status,
           CASE WHEN ended_at IS NULL THEN 'dialing' ELSE 'ended' END
       ),
       duration_source = COALESCE(duration_source, 'legacy_unknown');

ALTER TABLE call_attempts
    ALTER COLUMN dial_started_at SET DEFAULT NOW(),
    ALTER COLUMN lifecycle_status SET DEFAULT 'dialing',
    ALTER COLUMN duration_source SET DEFAULT 'livekit';

ALTER TABLE call_attempts
    ALTER COLUMN dial_started_at SET NOT NULL,
    ALTER COLUMN lifecycle_status SET NOT NULL,
    ALTER COLUMN duration_source SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'call_attempts_lifecycle_status_check'
           AND conrelid = 'call_attempts'::regclass
    ) THEN
        ALTER TABLE call_attempts
            ADD CONSTRAINT call_attempts_lifecycle_status_check
            CHECK (lifecycle_status IN ('dialing', 'connected', 'ended', 'failed'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'call_attempts_duration_source_check'
           AND conrelid = 'call_attempts'::regclass
    ) THEN
        ALTER TABLE call_attempts
            ADD CONSTRAINT call_attempts_duration_source_check
            CHECK (duration_source IN ('livekit', 'provider_cdr', 'legacy_unknown'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS call_attempts_open_lifecycle_idx
    ON call_attempts (lifecycle_status, dial_started_at)
    WHERE ended_at IS NULL;

-- A provider may redeliver the same participant_left event. Binding the retry
-- to its triggering call attempt makes campaign finalization idempotent even
-- when two workers handle duplicate events concurrently.
ALTER TABLE campaign_jobs
    ADD COLUMN IF NOT EXISTS trigger_call_attempt_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaign_jobs_trigger_call_attempt_fk'
           AND conrelid = 'campaign_jobs'::regclass
    ) THEN
        ALTER TABLE campaign_jobs
            ADD CONSTRAINT campaign_jobs_trigger_call_attempt_fk
            FOREIGN KEY (trigger_call_attempt_id) REFERENCES call_attempts(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_jobs_trigger_call_attempt_unique
    ON campaign_jobs (trigger_call_attempt_id)
    WHERE trigger_call_attempt_id IS NOT NULL;
