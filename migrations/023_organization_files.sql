CREATE TABLE IF NOT EXISTS organization_files (
    id                BIGSERIAL PRIMARY KEY,
    customer_id       INTEGER     NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    uploaded_by       BIGINT      REFERENCES platform_users(id) ON DELETE SET NULL,
    original_filename TEXT        NOT NULL,
    content_type      TEXT        NOT NULL DEFAULT 'application/octet-stream',
    size_bytes        INTEGER     NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
    sha256            TEXT        NOT NULL CHECK (length(sha256) = 64),
    content           BYTEA       NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (octet_length(content) = size_bytes)
);

CREATE INDEX IF NOT EXISTS organization_files_customer_created_idx
    ON organization_files (customer_id, created_at DESC);
