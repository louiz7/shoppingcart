-- Organisation values are templates for new campaigns. Once copied, the
-- campaign row is the sole scheduling source for that campaign.

CREATE TABLE IF NOT EXISTS organization_campaign_defaults (
    customer_id                 INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    timezone                    TEXT       NOT NULL DEFAULT 'Europe/Berlin',
    weekdays                    SMALLINT[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
    start_time                  TIME       NOT NULL DEFAULT '09:00',
    end_time                    TIME       NOT NULL DEFAULT '20:00',
    max_contact_attempts        INTEGER    NOT NULL DEFAULT 6 CHECK (max_contact_attempts BETWEEN 1 AND 20),
    max_attempts_per_24h        INTEGER    NOT NULL DEFAULT 1 CHECK (max_attempts_per_24h BETWEEN 1 AND 20),
    max_attempts_per_7d         INTEGER    NOT NULL DEFAULT 3 CHECK (max_attempts_per_7d BETWEEN 1 AND 100),
    retry_interval_minutes      INTEGER    NOT NULL DEFAULT 60 CHECK (retry_interval_minutes BETWEEN 1 AND 10080),
    updated_by                  BIGINT     REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_time < end_time),
    CHECK (array_length(weekdays, 1) >= 1),
    CHECK (max_attempts_per_7d >= max_attempts_per_24h)
);

CREATE OR REPLACE FUNCTION ensure_organization_campaign_defaults()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO organization_campaign_defaults (customer_id)
    VALUES (NEW.id)
    ON CONFLICT (customer_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_campaign_defaults_trigger ON customers;
CREATE TRIGGER customers_campaign_defaults_trigger
AFTER INSERT ON customers
FOR EACH ROW EXECUTE FUNCTION ensure_organization_campaign_defaults();

INSERT INTO organization_campaign_defaults (
    customer_id, timezone, weekdays, start_time, end_time,
    max_contact_attempts, max_attempts_per_24h, max_attempts_per_7d,
    retry_interval_minutes
)
SELECT c.id,
       CASE WHEN EXISTS (
                SELECT 1 FROM pg_timezone_names tz
                 WHERE tz.name = NULLIF(pc.config->>'timezone', '')
            ) THEN pc.config->>'timezone'
            ELSE 'Europe/Berlin' END,
       CASE
           WHEN jsonb_typeof(pc.config->'call_window'->'days') = 'array'
           THEN ARRAY(
               SELECT value::smallint
                 FROM jsonb_array_elements_text(pc.config->'call_window'->'days') value
                WHERE value ~ '^[0-6]$'
           )
           ELSE ARRAY[1,2,3,4,5]::smallint[]
       END,
       CASE WHEN pc.config#>>'{call_window,start_hour}' ~ '^(?:[0-9]|1[0-9]|2[0-3])$'
                  AND pc.config#>>'{call_window,end_hour}' ~ '^(?:[1-9]|1[0-9]|2[0-3])$'
                  AND (pc.config#>>'{call_window,start_hour}')::int < (pc.config#>>'{call_window,end_hour}')::int
            THEN make_time((pc.config#>>'{call_window,start_hour}')::int, 0, 0)
            ELSE '09:00'::time END,
       CASE WHEN pc.config#>>'{call_window,start_hour}' ~ '^(?:[0-9]|1[0-9]|2[0-3])$'
                  AND pc.config#>>'{call_window,end_hour}' ~ '^(?:[1-9]|1[0-9]|2[0-3])$'
                  AND (pc.config#>>'{call_window,start_hour}')::int < (pc.config#>>'{call_window,end_hour}')::int
            THEN make_time((pc.config#>>'{call_window,end_hour}')::int, 0, 0)
            ELSE '20:00'::time END,
       6,
       CASE WHEN pc.config#>>'{frequency_caps,max_attempts_per_day}' ~ '^[0-9]+$'
            THEN LEAST(6, GREATEST(1, (pc.config#>>'{frequency_caps,max_attempts_per_day}')::int))
            ELSE 1 END,
       GREATEST(
           CASE WHEN pc.config#>>'{frequency_caps,max_attempts_per_day}' ~ '^[0-9]+$'
                THEN LEAST(6, GREATEST(1, (pc.config#>>'{frequency_caps,max_attempts_per_day}')::int))
                ELSE 1 END,
           CASE WHEN pc.config#>>'{frequency_caps,max_attempts_per_week}' ~ '^[0-9]+$'
                THEN LEAST(6, GREATEST(1, (pc.config#>>'{frequency_caps,max_attempts_per_week}')::int))
                ELSE 3 END
       ),
       60
  FROM customers c
  LEFT JOIN policy_config pc ON pc.customer_id = c.id
ON CONFLICT (customer_id) DO NOTHING;

-- Repair a malformed/empty day array or a weekly value below its daily value
-- before constraints are relied on by application writes.
UPDATE organization_campaign_defaults
   SET weekdays = ARRAY[1,2,3,4,5]::smallint[]
 WHERE array_length(weekdays, 1) IS NULL;

UPDATE organization_campaign_defaults
   SET max_attempts_per_24h = LEAST(max_attempts_per_24h, max_contact_attempts),
       max_attempts_per_7d = GREATEST(
           LEAST(max_attempts_per_24h, max_contact_attempts),
           LEAST(max_attempts_per_7d, max_contact_attempts)
       );

ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS max_attempts_per_24h INTEGER,
    ADD COLUMN IF NOT EXISTS max_attempts_per_7d INTEGER,
    ADD COLUMN IF NOT EXISTS retry_interval_minutes INTEGER;

UPDATE campaigns ca
   SET timezone = 'Europe/Berlin'
 WHERE NOT EXISTS (SELECT 1 FROM pg_timezone_names tz WHERE tz.name = ca.timezone);

UPDATE campaigns ca
   SET max_attempts_per_24h = COALESCE(ca.max_attempts_per_24h, defaults.max_attempts_per_24h, 1),
       max_attempts_per_7d = COALESCE(ca.max_attempts_per_7d, defaults.max_attempts_per_7d, 3),
       retry_interval_minutes = COALESCE(ca.retry_interval_minutes, defaults.retry_interval_minutes, 60)
  FROM organization_campaign_defaults defaults
 WHERE defaults.customer_id = ca.customer_id
   AND (ca.max_attempts_per_24h IS NULL OR ca.max_attempts_per_7d IS NULL OR ca.retry_interval_minutes IS NULL);

UPDATE campaigns
   SET max_attempts_per_24h = COALESCE(max_attempts_per_24h, 1),
       max_attempts_per_7d = GREATEST(COALESCE(max_attempts_per_7d, 3), COALESCE(max_attempts_per_24h, 1)),
       retry_interval_minutes = COALESCE(retry_interval_minutes, 60);

ALTER TABLE campaigns
    ALTER COLUMN max_attempts_per_24h SET DEFAULT 1,
    ALTER COLUMN max_attempts_per_7d SET DEFAULT 3,
    ALTER COLUMN retry_interval_minutes SET DEFAULT 60,
    ALTER COLUMN max_attempts_per_24h SET NOT NULL,
    ALTER COLUMN max_attempts_per_7d SET NOT NULL,
    ALTER COLUMN retry_interval_minutes SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_attempts_24h_check'
           AND conrelid = 'campaigns'::regclass
    ) THEN
        ALTER TABLE campaigns ADD CONSTRAINT campaigns_attempts_24h_check
            CHECK (max_attempts_per_24h BETWEEN 1 AND 20);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_attempts_7d_check'
           AND conrelid = 'campaigns'::regclass
    ) THEN
        ALTER TABLE campaigns ADD CONSTRAINT campaigns_attempts_7d_check
            CHECK (max_attempts_per_7d BETWEEN 1 AND 100 AND max_attempts_per_7d >= max_attempts_per_24h);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'campaigns_retry_interval_check'
           AND conrelid = 'campaigns'::regclass
    ) THEN
        ALTER TABLE campaigns ADD CONSTRAINT campaigns_retry_interval_check
            CHECK (retry_interval_minutes BETWEEN 1 AND 10080);
    END IF;
END $$;
