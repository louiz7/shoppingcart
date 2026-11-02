-- Authenticated customer platform, campaign orchestration, tasks, and manual
-- payment recording. All operational tables carry customer_id so tenant
-- isolation can be enforced directly in every query.

CREATE TABLE IF NOT EXISTS platform_users (
    id            BIGSERIAL PRIMARY KEY,
    customer_id   INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    email         TEXT        NOT NULL,
    display_name  TEXT        NOT NULL,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL DEFAULT 'operator'
                              CHECK (role IN ('admin', 'operator', 'viewer')),
    active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, email)
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_users_email_lower_idx
    ON platform_users (LOWER(email));

CREATE TABLE IF NOT EXISTS platform_sessions (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_sessions_expiry_idx
    ON platform_sessions (expires_at);

CREATE TABLE IF NOT EXISTS campaigns (
    id                         BIGSERIAL PRIMARY KEY,
    customer_id                INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                       TEXT        NOT NULL,
    status                     TEXT        NOT NULL DEFAULT 'draft'
                                           CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled')),
    channels                   TEXT[]      NOT NULL DEFAULT ARRAY['voice']::TEXT[],
    weekdays                   SMALLINT[]  NOT NULL DEFAULT ARRAY[1,2,3,4,5]::SMALLINT[],
    start_time                 TIME        NOT NULL DEFAULT '08:00',
    end_time                   TIME        NOT NULL DEFAULT '20:00',
    timezone                   TEXT        NOT NULL DEFAULT 'Europe/Berlin',
    max_contact_attempts       INTEGER     NOT NULL DEFAULT 6 CHECK (max_contact_attempts >= 1),
    installments_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    max_installments           INTEGER     CHECK (max_installments >= 2),
    installment_fee_pct        NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (installment_fee_pct >= 0),
    installment_min_cents      INTEGER     NOT NULL DEFAULT 0 CHECK (installment_min_cents >= 0),
    discount_enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
    discount_24h_pct           NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_24h_pct BETWEEN 0 AND 100),
    discount_7d_pct            NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_7d_pct BETWEEN 0 AND 100),
    created_by                 BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at                 TIMESTAMPTZ,
    paused_at                  TIMESTAMPTZ,
    completed_at               TIMESTAMPTZ,
    CHECK (start_time < end_time),
    CHECK (array_length(weekdays, 1) >= 1),
    CHECK (channels <@ ARRAY['voice']::TEXT[])
);

CREATE INDEX IF NOT EXISTS campaigns_customer_status_idx
    ON campaigns (customer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS campaign_imports (
    id             BIGSERIAL PRIMARY KEY,
    customer_id    INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id    BIGINT      REFERENCES campaigns(id) ON DELETE SET NULL,
    filename       TEXT        NOT NULL,
    status         TEXT        NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
    total_rows     INTEGER     NOT NULL DEFAULT 0,
    imported_rows  INTEGER     NOT NULL DEFAULT 0,
    rejected_rows  INTEGER     NOT NULL DEFAULT 0,
    errors         JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_by     BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campaign_members (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id     BIGINT      NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    case_id         INTEGER     NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    status          TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'scheduled', 'contacting', 'reached',
                                                   'resolved', 'failed', 'suppressed', 'cancelled')),
    attempt_count   INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_contact_at TIMESTAMPTZ,
    reached_at      TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (campaign_id, case_id)
);

CREATE INDEX IF NOT EXISTS campaign_members_due_idx
    ON campaign_members (campaign_id, status, next_contact_at);
CREATE INDEX IF NOT EXISTS campaign_members_customer_case_idx
    ON campaign_members (customer_id, case_id);

CREATE TABLE IF NOT EXISTS campaign_jobs (
    id             BIGSERIAL PRIMARY KEY,
    customer_id    INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id    BIGINT      NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    member_id      BIGINT      NOT NULL REFERENCES campaign_members(id) ON DELETE CASCADE,
    attempt_number INTEGER     NOT NULL CHECK (attempt_number >= 1),
    status         TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    scheduled_at   TIMESTAMPTZ NOT NULL,
    locked_at      TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (member_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS campaign_jobs_claim_idx
    ON campaign_jobs (status, scheduled_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS platform_tasks (
    id          BIGSERIAL PRIMARY KEY,
    customer_id INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id BIGINT      REFERENCES campaigns(id) ON DELETE CASCADE,
    case_id     INTEGER     REFERENCES cases(id) ON DELETE CASCADE,
    kind        TEXT        NOT NULL,
    title       TEXT        NOT NULL,
    detail      TEXT,
    priority    TEXT        NOT NULL DEFAULT 'normal'
                             CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    status      TEXT        NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'in_progress', 'resolved', 'dismissed')),
    assigned_to BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS platform_tasks_customer_status_idx
    ON platform_tasks (customer_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS payments (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id  BIGINT      REFERENCES campaigns(id) ON DELETE SET NULL,
    case_id      INTEGER     NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    amount_cents INTEGER     NOT NULL CHECK (amount_cents > 0),
    currency     TEXT        NOT NULL DEFAULT 'EUR',
    paid_at      TIMESTAMPTZ NOT NULL,
    note         TEXT,
    created_by   BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payments_customer_paid_idx
    ON payments (customer_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS payments_campaign_idx
    ON payments (campaign_id, paid_at DESC);

ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS campaign_id BIGINT;
ALTER TABLE call_attempts ADD COLUMN IF NOT EXISTS campaign_member_id BIGINT;
ALTER TABLE plan_templates ADD COLUMN IF NOT EXISTS campaign_id BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'plan_templates'
           AND column_name = 'discount_pct'
           AND data_type = 'numeric'
           AND numeric_precision = 5
           AND numeric_scale = 2
    ) THEN
        ALTER TABLE plan_templates
            ALTER COLUMN discount_pct TYPE NUMERIC(5,2) USING discount_pct::NUMERIC(5,2);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'payment_plans'
           AND column_name = 'discount_pct'
           AND data_type = 'numeric'
           AND numeric_precision = 5
           AND numeric_scale = 2
    ) THEN
        ALTER TABLE payment_plans
            ALTER COLUMN discount_pct TYPE NUMERIC(5,2) USING discount_pct::NUMERIC(5,2);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_attempts_campaign_fk') THEN
        ALTER TABLE call_attempts
            ADD CONSTRAINT call_attempts_campaign_fk
            FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_attempts_campaign_member_fk') THEN
        ALTER TABLE call_attempts
            ADD CONSTRAINT call_attempts_campaign_member_fk
            FOREIGN KEY (campaign_member_id) REFERENCES campaign_members(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plan_templates_campaign_fk') THEN
        ALTER TABLE plan_templates
            ADD CONSTRAINT plan_templates_campaign_fk
            FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS call_attempts_campaign_idx
    ON call_attempts (customer_id, campaign_id, started_at DESC);
CREATE INDEX IF NOT EXISTS plan_templates_campaign_idx
    ON plan_templates (customer_id, campaign_id) WHERE active;

CREATE TABLE IF NOT EXISTS campaign_events (
    id          BIGSERIAL PRIMARY KEY,
    customer_id INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    campaign_id BIGINT      NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    member_id   BIGINT      REFERENCES campaign_members(id) ON DELETE SET NULL,
    actor       TEXT        NOT NULL,
    kind        TEXT        NOT NULL,
    data        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS campaign_events_campaign_idx
    ON campaign_events (campaign_id, created_at DESC);
