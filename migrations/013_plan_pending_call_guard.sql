-- A negotiated or pending plan is not proof of payment. Stop campaign
-- follow-ups while human approval is pending and repair historical members
-- that were marked resolved even though money remains outstanding.

UPDATE campaign_jobs j
   SET status = 'cancelled',
       completed_at = COALESCE(completed_at, NOW()),
       last_error = 'plan_pending_approval'
  FROM campaign_members cm
  JOIN case_state cs ON cs.case_id = cm.case_id
 WHERE j.member_id = cm.id
   AND j.customer_id = cm.customer_id
   AND j.status = 'pending'
   AND cs.state = 'PLAN_OFFERED'
   AND cs.substate = 'pending_human_approval';

UPDATE campaign_members cm
   SET status = 'reached',
       reached_at = COALESCE(reached_at, NOW()),
       resolved_at = NULL,
       next_contact_at = NULL,
       last_error = 'plan_pending_approval',
       updated_at = NOW()
  FROM cases c
  JOIN case_state cs ON cs.case_id = c.id
 WHERE cm.case_id = c.id
   AND cm.customer_id = c.customer_id
   AND c.amount_cents_outstanding > 0
   AND cs.state = 'PLAN_OFFERED'
   AND cs.substate = 'pending_human_approval'
   AND cm.status IN ('pending', 'scheduled', 'contacting', 'resolved');

UPDATE campaign_members cm
   SET status = 'reached',
       reached_at = COALESCE(
           reached_at,
           (
               SELECT ca.started_at
                 FROM call_attempts ca
                WHERE ca.campaign_member_id = cm.id
                  AND ca.customer_id = cm.customer_id
                  AND ca.disposition IS NOT NULL
                ORDER BY ca.started_at DESC, ca.id DESC
                LIMIT 1
           ),
           NOW()
       ),
       resolved_at = NULL,
       next_contact_at = NULL,
       updated_at = NOW()
  FROM cases c
 WHERE cm.case_id = c.id
   AND cm.customer_id = c.customer_id
   AND cm.status = 'resolved'
   AND c.amount_cents_outstanding > 0
   AND (
       SELECT ca.disposition
         FROM call_attempts ca
        WHERE ca.campaign_member_id = cm.id
          AND ca.customer_id = cm.customer_id
          AND ca.disposition IS NOT NULL
        ORDER BY ca.started_at DESC, ca.id DESC
        LIMIT 1
   ) IN ('payment_promised', 'plan_agreed');

UPDATE campaigns ca
   SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
 WHERE ca.status IN ('active', 'paused')
   AND NOT EXISTS (
       SELECT 1
         FROM campaign_members cm
        WHERE cm.campaign_id = ca.id
          AND cm.status IN ('pending', 'scheduled', 'contacting')
   );
