-- Makes the organisation NAME a safe alternate identity key. This was
-- originally introduced for the retired self-serve configuration dashboard
-- and remains part of the schema for compatibility with existing databases.
--
-- Precondition checked before applying to any existing DB:
--   SELECT lower(name), count(*) FROM customers GROUP BY 1 HAVING count(*) > 1;
-- must return zero rows, or the unique index below will fail to create.

-- Some existing customers were created without an email before organisation
-- onboarding became a manual operation.
ALTER TABLE customers ALTER COLUMN email DROP NOT NULL;

-- Case-insensitive uniqueness so "Acme GmbH" and "acme gmbh" collapse to one
-- organisation, and so find-or-create can use ON CONFLICT (lower(name)) —
-- a plain SELECT-then-INSERT would race under concurrent submissions.
CREATE UNIQUE INDEX IF NOT EXISTS customers_name_lower_key
    ON customers (lower(name));
