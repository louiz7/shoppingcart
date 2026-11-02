-- Approved and historical payment plans are business records in their own
-- right. Deleting the campaign that supplied their offer template must not
-- delete or block those plans. Pending plans are still protected by the
-- dashboard action before a campaign can be deleted.

ALTER TABLE payment_plans
    DROP CONSTRAINT IF EXISTS payment_plans_template_id_fkey;

ALTER TABLE payment_plans
    ALTER COLUMN template_id DROP NOT NULL;

ALTER TABLE payment_plans
    ADD CONSTRAINT payment_plans_template_id_fkey
    FOREIGN KEY (template_id) REFERENCES plan_templates(id) ON DELETE SET NULL;
