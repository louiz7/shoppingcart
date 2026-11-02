CREATE TABLE IF NOT EXISTS recovery_deployment_guard (
    id SMALLINT PRIMARY KEY CHECK (id=1),
    paused_until TIMESTAMPTZ
);
INSERT INTO recovery_deployment_guard(id) VALUES(1) ON CONFLICT DO NOTHING;
