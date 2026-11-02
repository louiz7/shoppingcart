-- Treat an exact tenant-local combination of normalized name and phone number
-- as one debtor. Multiple claims remain separate rows in cases.

BEGIN;

CREATE TEMP TABLE debtor_merge_map AS
SELECT id AS duplicate_id, canonical_id
  FROM (
      SELECT id,
             MIN(id) OVER (
                 PARTITION BY customer_id,
                              lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')),
                              regexp_replace(phone_e164, '[^0-9+]', '', 'g')
             ) AS canonical_id
        FROM debtors
       WHERE regexp_replace(phone_e164, '[^0-9+]', '', 'g') <> ''
  ) ranked
 WHERE id <> canonical_id;

-- Preserve useful data held by every duplicate. Existing values on the
-- oldest (canonical) debtor win if both rows contain the same field.
DO $$
DECLARE
    merge_row RECORD;
BEGIN
    FOR merge_row IN
        SELECT map.canonical_id, duplicate.email, duplicate.verification_fields
          FROM debtor_merge_map map
          JOIN debtors duplicate ON duplicate.id = map.duplicate_id
         ORDER BY duplicate.created_at, duplicate.id
    LOOP
        UPDATE debtors canonical
           SET email = COALESCE(canonical.email, merge_row.email),
               verification_fields = COALESCE(merge_row.verification_fields, '{}'::jsonb)
                                     || canonical.verification_fields
         WHERE canonical.id = merge_row.canonical_id;
    END LOOP;
END $$;

UPDATE cases c
   SET debtor_id = map.canonical_id,
       updated_at = NOW()
  FROM debtor_merge_map map
 WHERE c.debtor_id = map.duplicate_id;

UPDATE suppression s
   SET debtor_id = map.canonical_id
  FROM debtor_merge_map map
 WHERE s.debtor_id = map.duplicate_id;

DELETE FROM debtors duplicate
 USING debtor_merge_map map
 WHERE duplicate.id = map.duplicate_id;

DROP TABLE debtor_merge_map;

-- Prevent concurrent imports from recreating an exact name/phone duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS debtors_customer_name_phone_key
    ON debtors (
        customer_id,
        lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')),
        regexp_replace(phone_e164, '[^0-9+]', '', 'g')
    );

COMMIT;
