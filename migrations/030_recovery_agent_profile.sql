ALTER TABLE recovery_shops ADD COLUMN IF NOT EXISTS agent_profile JSONB NOT NULL
    DEFAULT '{"name":"Rescova","persona":"assistant","voice":"male","language":"de"}'::jsonb;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='recovery_agent_profile_valid') THEN
        ALTER TABLE recovery_shops ADD CONSTRAINT recovery_agent_profile_valid CHECK (
            jsonb_typeof(agent_profile)='object' AND
            agent_profile ?& ARRAY['name','persona','voice','language'] AND
            agent_profile - ARRAY['name','persona','voice','language']='{}'::jsonb AND
            jsonb_typeof(agent_profile->'name')='string' AND length(agent_profile->>'name') BETWEEN 1 AND 40 AND
            jsonb_typeof(agent_profile->'persona')='string' AND jsonb_typeof(agent_profile->'voice')='string' AND
            jsonb_typeof(agent_profile->'language')='string' AND
            agent_profile->>'persona' IN ('founder','assistant') AND
            agent_profile->>'voice' IN ('male','female') AND agent_profile->>'language' IN ('de','en')
        );
    END IF;
END $$;
