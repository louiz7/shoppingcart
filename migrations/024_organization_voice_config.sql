CREATE TABLE IF NOT EXISTS organization_voice_config (
    customer_id         INTEGER     PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    display_name        TEXT        NOT NULL CHECK (length(display_name) BETWEEN 2 AND 160),
    prompt_instructions TEXT        NOT NULL DEFAULT '' CHECK (length(prompt_instructions) <= 10000),
    enabled             BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_by          BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO organization_voice_config (customer_id, display_name)
SELECT id, name
  FROM customers
ON CONFLICT (customer_id) DO NOTHING;

UPDATE organization_voice_config config
   SET display_name = 'BFI Inkasso', updated_at = NOW()
  FROM customers customer
 WHERE customer.id = config.customer_id
   AND lower(trim(customer.name)) = 'bfi'
   AND lower(trim(config.display_name)) = 'bfi';

CREATE OR REPLACE FUNCTION ensure_organization_voice_config()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO organization_voice_config (customer_id, display_name)
    VALUES (NEW.id, NEW.name)
    ON CONFLICT (customer_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_ensure_voice_config ON customers;
CREATE TRIGGER customers_ensure_voice_config
AFTER INSERT ON customers
FOR EACH ROW EXECUTE FUNCTION ensure_organization_voice_config();
