-- Human approval gate for plans negotiated by the calling agent.

ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS approved_by BIGINT;
ALTER TABLE payment_plans ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE payment_plans ALTER COLUMN status SET DEFAULT 'pending_approval';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'payment_plans_approved_by_fk'
    ) THEN
        ALTER TABLE payment_plans
            ADD CONSTRAINT payment_plans_approved_by_fk
            FOREIGN KEY (approved_by) REFERENCES platform_users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Existing active plans have not received explicit human approval. Keep the
-- newest one per case pending and retire any older duplicates.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY created_at DESC, id DESC) AS position
      FROM payment_plans
     WHERE status = 'active'
       AND approved_at IS NULL
)
UPDATE payment_plans pp
   SET status = CASE WHEN ranked.position = 1 THEN 'pending_approval' ELSE 'superseded' END
  FROM ranked
 WHERE pp.id = ranked.id;

INSERT INTO case_state (case_id, state, substate, updated_at)
SELECT pp.case_id, 'PLAN_OFFERED', 'pending_human_approval', NOW()
  FROM payment_plans pp
 WHERE pp.status = 'pending_approval'
ON CONFLICT (case_id) DO UPDATE
    SET state = 'PLAN_OFFERED',
        substate = 'pending_human_approval',
        updated_at = NOW();

CREATE UNIQUE INDEX IF NOT EXISTS payment_plans_one_pending_per_case_idx
    ON payment_plans (case_id) WHERE status = 'pending_approval';

-- Make previously negotiated plans visible in the human task queue.
INSERT INTO platform_tasks (
    customer_id, campaign_id, case_id, kind, title, detail, priority
)
SELECT pp.customer_id,
       latest_call.campaign_id,
       pp.case_id,
       'plan_approval',
       'Zahlungsplan freigeben',
       'Vereinbarter Zahlungsplan #' || pp.id || ' wartet auf Freigabe.',
       'normal'
  FROM payment_plans pp
  LEFT JOIN LATERAL (
      SELECT ca.campaign_id
        FROM call_attempts ca
       WHERE ca.case_id = pp.case_id
         AND ca.customer_id = pp.customer_id
         AND ca.campaign_id IS NOT NULL
       ORDER BY ca.started_at DESC
       LIMIT 1
  ) latest_call ON TRUE
 WHERE pp.status = 'pending_approval'
   AND NOT EXISTS (
       SELECT 1
         FROM platform_tasks t
        WHERE t.customer_id = pp.customer_id
          AND t.case_id = pp.case_id
          AND t.kind = 'plan_approval'
          AND t.status IN ('open', 'in_progress')
   );
