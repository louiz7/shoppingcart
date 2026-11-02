-- Control plane for the deterministic calling agent (case-policy engine).
--
-- Design principle: the LLM only leads the conversation and picks which tool
-- to call. Every real-world decision (eligibility, disclosure, plan terms,
-- discounts, escalation) is derived from these tables by deterministic code
-- in src/policy/engine.js + src/routes/agent-tools.js — never by the model.
--
-- Money is stored as integer cents (deliberate divergence from usage_events'
-- NUMERIC: plan arithmetic must be exact, not approximately-rounded).

-- One person we may call. PII lives here — never in prompts or room metadata.
CREATE TABLE IF NOT EXISTS debtors (
    id                  SERIAL PRIMARY KEY,
    customer_id         INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    external_ref        TEXT        NOT NULL,
    name                TEXT        NOT NULL,
    phone_e164          TEXT        NOT NULL,
    email               TEXT,
    locale              TEXT        NOT NULL DEFAULT 'de',
    -- Fields verify_identity compares claims against, e.g.
    -- {"dob": "1980-04-12", "postcode": "10115"}. Matching happens
    -- server-side; the LLM only relays what the person said.
    verification_fields JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, external_ref)
);

CREATE TABLE IF NOT EXISTS cases (
    id                       SERIAL PRIMARY KEY,
    customer_id              INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    debtor_id                INTEGER     NOT NULL REFERENCES debtors(id) ON DELETE CASCADE,
    external_ref             TEXT        NOT NULL,
    currency                 TEXT        NOT NULL DEFAULT 'EUR',
    original_amount_cents    INTEGER     NOT NULL CHECK (original_amount_cents >= 0),
    amount_cents_outstanding INTEGER     NOT NULL CHECK (amount_cents_outstanding >= 0),
    invoice_number           TEXT,
    due_date                 DATE,
    disputed                 BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, external_ref)
);

CREATE INDEX IF NOT EXISTS cases_customer_debtor_idx ON cases(customer_id, debtor_id);

-- Current state only. History is derivable from events (append-only below).
-- NEW -> CONTACTABLE -> IN_PROGRESS -> VERIFIED -> PLAN_OFFERED ->
--   PLAN_ACTIVE -> PAID / ESCALATED / STOPPED
CREATE TABLE IF NOT EXISTS case_state (
    case_id       INTEGER     PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    state         TEXT        NOT NULL DEFAULT 'NEW',
    substate      TEXT,
    last_event_id BIGINT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_attempts (
    id           SERIAL PRIMARY KEY,
    customer_id  INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    case_id      INTEGER     NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    channel      TEXT        NOT NULL DEFAULT 'voice',
    direction    TEXT        NOT NULL DEFAULT 'outbound',
    livekit_room TEXT,
    sip_call_id  TEXT,
    started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at     TIMESTAMPTZ,
    outcome      TEXT,
    disposition  TEXT
);

CREATE INDEX IF NOT EXISTS call_attempts_case_idx ON call_attempts(customer_id, case_id);
CREATE INDEX IF NOT EXISTS call_attempts_room_idx ON call_attempts(livekit_room);

-- APPEND-ONLY audit spine: every tool call, policy decision, and lifecycle
-- event. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS events (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    case_id         INTEGER     REFERENCES cases(id) ON DELETE CASCADE,
    call_attempt_id INTEGER     REFERENCES call_attempts(id) ON DELETE SET NULL,
    actor           TEXT        NOT NULL, -- 'agent_llm' | 'policy' | 'system' | 'human'
    channel         TEXT        NOT NULL DEFAULT 'voice',
    kind            TEXT        NOT NULL, -- tool name or lifecycle event
    request         JSONB,
    result          JSONB,
    decision        TEXT,                 -- 'allow' | 'deny'
    reason_code     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_case_idx ON events(case_id, created_at);
CREATE INDEX IF NOT EXISTS events_customer_idx ON events(customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppression (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    debtor_id   INTEGER     REFERENCES debtors(id) ON DELETE CASCADE,
    case_id     INTEGER     REFERENCES cases(id) ON DELETE CASCADE,
    scope       TEXT        NOT NULL, -- 'debtor' | 'case' | 'number'
    phone_e164  TEXT,                 -- for scope='number'
    reason_code TEXT        NOT NULL,
    source      TEXT        NOT NULL, -- 'policy' | 'human' | 'agent_signal'
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS suppression_active_idx ON suppression(customer_id, debtor_id) WHERE active;

-- Client-configurable business rules AS DATA: call windows, frequency caps,
-- max_discount_pct ceiling, allowed_actions_by_state, disclosure rules,
-- signal_effects. Defaults live in src/policy/engine.js; this JSONB overrides.
CREATE TABLE IF NOT EXISTS policy_config (
    id          SERIAL PRIMARY KEY,
    customer_id INTEGER     NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    config      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    version     INTEGER     NOT NULL DEFAULT 1,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each row is one concrete, client-approved offer the agent may surface.
-- discount_pct: the fixed discount THIS template grants (0 for plain plans).
--   A "pay today, 10% off" incentive is just a row with max_installments=1,
--   max_term_days=0, discount_pct=10 — no separate mechanism.
-- trigger_signal: if set (e.g. 'cannot_pay_in_full'), the template is only
--   eligible after that signal was reported via report_signal in the CURRENT
--   call attempt. NULL = always eligible.
CREATE TABLE IF NOT EXISTS plan_templates (
    id               SERIAL PRIMARY KEY,
    customer_id      INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    code             TEXT        NOT NULL,
    name             TEXT        NOT NULL,
    active           BOOLEAN     NOT NULL DEFAULT TRUE,
    min_amount_cents INTEGER     NOT NULL DEFAULT 0,
    max_installments INTEGER     NOT NULL DEFAULT 1 CHECK (max_installments >= 1),
    max_term_days    INTEGER     NOT NULL DEFAULT 0,
    discount_pct     INTEGER     NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
    trigger_signal   TEXT,
    params           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, code)
);

CREATE INDEX IF NOT EXISTS plan_templates_customer_idx ON plan_templates(customer_id) WHERE active;

CREATE TABLE IF NOT EXISTS payment_plans (
    id                SERIAL PRIMARY KEY,
    customer_id       INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    case_id           INTEGER     NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    template_id       INTEGER     NOT NULL REFERENCES plan_templates(id),
    installments      INTEGER     NOT NULL,
    installment_cents INTEGER     NOT NULL,
    first_due_date    DATE        NOT NULL,
    total_cents       INTEGER     NOT NULL,
    discount_pct      INTEGER     NOT NULL DEFAULT 0,
    status            TEXT        NOT NULL DEFAULT 'active',
    created_by        TEXT        NOT NULL DEFAULT 'agent_llm',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_plans_case_idx ON payment_plans(customer_id, case_id);

-- Short-lived, single-case tokens minted at dial time. The token — not a
-- case_id — is what travels in room metadata and authenticates every tool
-- call, so call A structurally cannot reach case B's data.
-- Stored as SHA-256 (not bcrypt like api_keys): the token is 32 random bytes
-- (high entropy, brute-force irrelevant) and sits in the voice hot path where
-- bcrypt's ~100ms per tool call would be real conversational latency.
CREATE TABLE IF NOT EXISTS call_tokens (
    id              SERIAL PRIMARY KEY,
    customer_id     INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    case_id         INTEGER     NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    call_attempt_id INTEGER     NOT NULL REFERENCES call_attempts(id) ON DELETE CASCADE,
    token_hash      TEXT        NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked         BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
