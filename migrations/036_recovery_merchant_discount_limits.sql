-- Merchants choose offer terms; keep only percentage and positive integer validity constraints.
-- Existing explicit shop rules and approved discount terms are unchanged.
ALTER TABLE recovery_discounts DROP CONSTRAINT IF EXISTS recovery_discounts_percent_check;
ALTER TABLE recovery_discounts ADD CONSTRAINT recovery_discounts_percent_check CHECK (percent BETWEEN 1 AND 100);
ALTER TABLE recovery_discounts DROP CONSTRAINT IF EXISTS recovery_discounts_valid_days_check;
ALTER TABLE recovery_discounts ADD CONSTRAINT recovery_discounts_valid_days_check CHECK (valid_days >= 1);
ALTER TABLE recovery_discounts DROP CONSTRAINT IF EXISTS recovery_discounts_usage_limit_check;
ALTER TABLE recovery_discounts ADD CONSTRAINT recovery_discounts_usage_limit_check CHECK (usage_limit >= 1);
