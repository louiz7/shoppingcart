-- New shops start with the founder persona. Existing merchant choices are preserved.
ALTER TABLE recovery_shops ALTER COLUMN agent_profile SET DEFAULT
    '{"name":"Rescova","persona":"founder","voice":"male","language":"de"}'::jsonb;
