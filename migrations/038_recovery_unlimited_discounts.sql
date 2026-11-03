-- Shopify uses null for no end date and unlimited total redemptions.
ALTER TABLE recovery_discounts ALTER COLUMN valid_days DROP NOT NULL;
ALTER TABLE recovery_discounts ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE recovery_discounts ALTER COLUMN usage_limit DROP NOT NULL;
ALTER TABLE recovery_discounts DROP CONSTRAINT IF EXISTS recovery_discounts_expiry_pair_check;
ALTER TABLE recovery_discounts ADD CONSTRAINT recovery_discounts_expiry_pair_check
    CHECK ((valid_days IS NULL) = (expires_at IS NULL));
