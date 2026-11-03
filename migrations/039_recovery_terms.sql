CREATE TABLE IF NOT EXISTS recovery_terms_acceptances (
    id UUID PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    document_hash TEXT NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
    document_text TEXT NOT NULL,
    accepted_by INTEGER REFERENCES platform_users(id) ON DELETE SET NULL,
    actor_email TEXT,
    actor_name TEXT NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(customer_id,version,document_hash)
);

ALTER TABLE recovery_terms_acceptances ALTER COLUMN actor_email DROP NOT NULL;
ALTER TABLE recovery_terms_acceptances ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard','external'));
ALTER TABLE recovery_terms_acceptances ADD COLUMN IF NOT EXISTS evidence TEXT;
