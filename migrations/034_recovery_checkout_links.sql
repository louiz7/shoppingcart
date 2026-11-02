-- A changed, explicitly accepted cart may receive its own SMS; identical targets remain deduplicated.
ALTER TABLE recovery_actions DROP CONSTRAINT IF EXISTS recovery_actions_checkout_id_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_actions_one_offer ON recovery_actions(checkout_id) WHERE kind='offer';
CREATE UNIQUE INDEX IF NOT EXISTS recovery_actions_sms_target ON recovery_actions(checkout_id,(COALESCE(data->>'targetKey','original'))) WHERE kind='sms';
