-- Demo campaigns are created only through the admin-only demo workflow.
-- They keep hard case/suppression safety checks, but do not inherit real
-- campaign time windows or rolling contact limits.

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Only jobs belonging to campaigns newly converted by THIS migration run may
-- become immediately due. The migration runner executes every file on every
-- deploy, so a broad `WHERE ca.is_demo` update would otherwise pull all
-- legitimate future retries and callbacks forward on each deployment.
WITH newly_marked AS (
    UPDATE campaigns ca
       SET is_demo = TRUE,
           updated_at = NOW()
     WHERE NOT ca.is_demo
       AND EXISTS (
           SELECT 1
             FROM campaign_events ce
            WHERE ce.campaign_id = ca.id
              AND ce.customer_id = ca.customer_id
              AND ce.kind = 'campaign_created'
              AND ce.data @> '{"demo": true}'::jsonb
       )
    RETURNING ca.id, ca.customer_id
), reset_jobs AS (
    UPDATE campaign_jobs j
       SET scheduled_at = NOW(),
           locked_at = NULL,
           last_error = NULL
      FROM newly_marked ca
     WHERE ca.id = j.campaign_id
       AND ca.customer_id = j.customer_id
       AND j.status = 'pending'
    RETURNING j.member_id
)
UPDATE campaign_members cm
   SET next_contact_at = NOW(),
       last_error = NULL,
       updated_at = NOW()
 WHERE cm.id IN (SELECT member_id FROM reset_jobs)
   AND cm.status = 'scheduled';
