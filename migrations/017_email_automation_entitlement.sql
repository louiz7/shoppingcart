-- Email automation is a paid tenant add-on and is disabled by default.
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS email_automation_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep the internal Rescova organisation enabled across idempotent deploys.
UPDATE customers c
   SET email_automation_enabled = TRUE
 WHERE EXISTS (
    SELECT 1
      FROM platform_users u
     WHERE u.customer_id = c.id
       AND u.active
       AND LOWER(u.email) = 'milan@rescova.de'
 );
