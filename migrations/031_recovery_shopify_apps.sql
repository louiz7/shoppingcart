-- Public app identity is retained after uninstall for correctly authenticated privacy webhooks.
ALTER TABLE recovery_shops ADD COLUMN IF NOT EXISTS shopify_app_client_id TEXT;
ALTER TABLE recovery_oauth_states ADD COLUMN IF NOT EXISTS app_client_id TEXT;
