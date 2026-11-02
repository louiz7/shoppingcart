-- A rolling cap cannot exceed the campaign's total attempt ceiling.
-- Preserve the total ceiling and lower legacy rolling caps, which is the
-- safer direction for existing campaigns.

UPDATE organization_campaign_defaults
   SET max_attempts_per_24h = LEAST(max_attempts_per_24h, max_contact_attempts),
       max_attempts_per_7d = GREATEST(
           LEAST(max_attempts_per_24h, max_contact_attempts),
           LEAST(max_attempts_per_7d, max_contact_attempts)
       )
 WHERE max_attempts_per_24h > max_contact_attempts
    OR max_attempts_per_7d > max_contact_attempts;

UPDATE campaigns
   SET max_attempts_per_24h = LEAST(max_attempts_per_24h, max_contact_attempts),
       max_attempts_per_7d = GREATEST(
           LEAST(max_attempts_per_24h, max_contact_attempts),
           LEAST(max_attempts_per_7d, max_contact_attempts)
       )
 WHERE max_attempts_per_24h > max_contact_attempts
    OR max_attempts_per_7d > max_contact_attempts;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'organization_campaign_defaults_attempt_hierarchy_check'
           AND conrelid = 'organization_campaign_defaults'::regclass
    ) THEN
        ALTER TABLE organization_campaign_defaults
            ADD CONSTRAINT organization_campaign_defaults_attempt_hierarchy_check
            CHECK (
                max_attempts_per_24h <= max_attempts_per_7d
                AND max_attempts_per_7d <= max_contact_attempts
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_attempt_hierarchy_check'
           AND conrelid = 'campaigns'::regclass
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_attempt_hierarchy_check
            CHECK (
                max_attempts_per_24h <= max_attempts_per_7d
                AND max_attempts_per_7d <= max_contact_attempts
            );
    END IF;
END $$;
