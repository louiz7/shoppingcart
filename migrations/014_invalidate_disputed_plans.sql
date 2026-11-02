-- A disputed claim cannot retain an approvable or active payment plan.
-- Runtime transactions enforce this ordering for new events; repair any
-- historical conflicts created before that guard existed.

UPDATE payment_plans pp
   SET status = 'superseded'
  FROM cases c
 WHERE pp.case_id = c.id
   AND pp.customer_id = c.customer_id
   AND c.disputed
   AND pp.status IN ('pending_approval', 'approved', 'active');

UPDATE platform_tasks task
   SET status = 'dismissed',
       resolved_at = COALESCE(resolved_at, NOW()),
       updated_at = NOW()
  FROM cases c
 WHERE task.case_id = c.id
   AND task.customer_id = c.customer_id
   AND c.disputed
   AND task.kind = 'plan_approval'
   AND task.status IN ('open', 'in_progress');
