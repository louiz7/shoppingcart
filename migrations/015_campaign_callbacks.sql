-- Explicit callbacks reuse the durable campaign job queue but remain
-- distinguishable from automatic campaign attempts. Existing jobs retain
-- their current behavior through the default value.

ALTER TABLE campaign_jobs
    ADD COLUMN IF NOT EXISTS job_kind TEXT NOT NULL DEFAULT 'campaign_attempt';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaign_jobs_kind_check'
           AND conrelid = 'campaign_jobs'::regclass
    ) THEN
        ALTER TABLE campaign_jobs
            ADD CONSTRAINT campaign_jobs_kind_check
            CHECK (job_kind IN ('campaign_attempt', 'callback'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_jobs_one_pending_callback
    ON campaign_jobs (member_id)
    WHERE status = 'pending' AND job_kind = 'callback';

CREATE INDEX IF NOT EXISTS campaign_jobs_pending_callback_due
    ON campaign_jobs (scheduled_at)
    WHERE status = 'pending' AND job_kind = 'callback';
