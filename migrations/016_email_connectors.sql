-- Tenant-scoped email connectors and a durable, draft-only processing queue.
-- Provider credentials are encrypted by the application before insertion.

CREATE TABLE IF NOT EXISTS email_accounts (
    id                    BIGSERIAL PRIMARY KEY,
    customer_id           INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider              TEXT        NOT NULL CHECK (provider IN ('microsoft_graph', 'imap_smtp')),
    email_address         TEXT        NOT NULL,
    display_name          TEXT,
    status                TEXT        NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending', 'connected', 'error', 'disabled')),
    automation_mode       TEXT        NOT NULL DEFAULT 'draft_only'
                                       CHECK (automation_mode IN ('disabled', 'draft_only')),
    config                JSONB       NOT NULL DEFAULT '{}'::jsonb,
    credentials_encrypted TEXT,
    sync_cursor           TEXT,
    last_synced_at        TIMESTAMPTZ,
    last_error            TEXT,
    created_by            BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, email_address)
);

CREATE INDEX IF NOT EXISTS email_accounts_poll_idx
    ON email_accounts (status, last_synced_at)
    WHERE status IN ('pending', 'connected', 'error');

CREATE TABLE IF NOT EXISTS email_oauth_states (
    id          BIGSERIAL PRIMARY KEY,
    state_hash  TEXT        NOT NULL UNIQUE,
    customer_id INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id     BIGINT      NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_oauth_states_expiry_idx
    ON email_oauth_states (expires_at) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_threads (
    id                 BIGSERIAL PRIMARY KEY,
    customer_id        INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_account_id   BIGINT      NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    provider_thread_id TEXT        NOT NULL,
    debtor_id          INTEGER     REFERENCES debtors(id) ON DELETE SET NULL,
    case_id            INTEGER     REFERENCES cases(id) ON DELETE SET NULL,
    match_status       TEXT        NOT NULL DEFAULT 'unmatched'
                                    CHECK (match_status IN ('unmatched', 'matched', 'ambiguous')),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email_account_id, provider_thread_id)
);

CREATE INDEX IF NOT EXISTS email_threads_customer_case_idx
    ON email_threads (customer_id, case_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_messages (
    id                    BIGSERIAL PRIMARY KEY,
    customer_id           INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_account_id      BIGINT      NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    thread_id             BIGINT      NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
    provider_message_id   TEXT        NOT NULL,
    internet_message_id   TEXT,
    direction             TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_address          TEXT        NOT NULL,
    to_addresses          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    subject               TEXT        NOT NULL DEFAULT '',
    body_text             TEXT        NOT NULL DEFAULT '',
    headers               JSONB       NOT NULL DEFAULT '{}'::jsonb,
    received_at           TIMESTAMPTZ,
    sent_at               TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email_account_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS email_messages_thread_idx
    ON email_messages (thread_id, COALESCE(received_at, sent_at, created_at));

CREATE TABLE IF NOT EXISTS email_jobs (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_account_id BIGINT     NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    email_message_id BIGINT     REFERENCES email_messages(id) ON DELETE CASCADE,
    kind            TEXT        NOT NULL CHECK (kind IN ('classify', 'send_draft')),
    status          TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    attempt_count   INTEGER     NOT NULL DEFAULT 0,
    last_error      TEXT,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (email_message_id, kind)
);

CREATE INDEX IF NOT EXISTS email_jobs_claim_idx
    ON email_jobs (status, scheduled_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS email_drafts (
    id               BIGSERIAL PRIMARY KEY,
    customer_id      INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email_account_id BIGINT      NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
    thread_id        BIGINT      NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
    source_message_id BIGINT     NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
    subject          TEXT        NOT NULL,
    body_text        TEXT        NOT NULL,
    category         TEXT        NOT NULL DEFAULT 'manual_review',
    status           TEXT        NOT NULL DEFAULT 'pending_approval'
                                  CHECK (status IN ('pending_approval', 'approved', 'sending', 'sent', 'rejected', 'failed')),
    approved_by      BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    approved_at      TIMESTAMPTZ,
    sent_at          TIMESTAMPTZ,
    provider_message_id TEXT,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_message_id)
);

CREATE INDEX IF NOT EXISTS email_drafts_customer_status_idx
    ON email_drafts (customer_id, status, created_at DESC);
