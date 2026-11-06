# Ecom deployment

Application releases run only through `.github/workflows/ecom-deploy.yml` in `louiz7/shoppingcart`: push to `main` or run the workflow manually on `main`. Build and test jobs receive no deployment or provider secrets. The deploy job uses the `ecom-production` environment and only the repository secrets `ECOM_DEPLOY_SSH_KEY` and `ECOM_DEPLOY_KNOWN_HOSTS`.

The workflow runs isolated PostgreSQL integration tests, offline voice and deployment-boundary tests, Svelte checks/build and the isolated API dependency audit. It packages only the Ecom sources and locked production dependencies. The root application's legacy mail/telephony dependencies are excluded from this runtime. The dashboard's existing production dependencies retain a moderate advisory; legacy routes are blocked by `RECOVERY_ONLY=1`.

## Infrastructure

| Component | Isolated location |
| --- | --- |
| Application releases | `/opt/rescova-ecom/releases/<commit>-<timestamp>` |
| Current release | `/opt/rescova-ecom/current` |
| Runtime secrets | `/etc/rescova-ecom/app.env`, root-owned, group-readable only by `rescova-ecom` |
| API / dashboard | `rescova-ecom-api`, `rescova-ecom-dashboard`; loopback 3610 / 3673 |
| PostgreSQL | `rescova-ecom-db`; own data directory `/var/lib/rescova-ecom-db`, loopback 3643 |
| Voice worker | `rescova-ecom-agent`; disabled until contact activation is approved and verified |
| Python environments | `/opt/rescova-ecom/venvs/<requirements-hash>` |
| Nginx / certificate | Own `rescova-ecom` vhost and `ecom.rescova.de` certificate |
| Deployment log | `/var/log/rescova-ecom-deploy.log`, root-only |

The initial infrastructure bootstrap installs the service units, exact nginx vhost, root-owned release receiver and dedicated deploy identity. The SSH key permits only `sudo -n /usr/local/sbin/rescova-ecom-deploy` through a forced command with SSH restrictions. It grants no shell, forwarding, root key reuse or access to other application deployment commands. Server configuration is provisioned separately from application artifacts; a code release cannot replace system units, nginx or runtime secrets.

The receiver validates the archive and manifest, caps compressed and expanded size, rejects links/traversal/special files, strips permissions, snapshots this database, and runs migrations as the Ecom application user. New call reservations are fenced for the deployment; existing or ambiguous calls prevent a restart. Only Ecom services restart. Failed activation restores the previous code symlink; database migrations are not automatically reversed. Three recent database snapshots and release artifacts are retained locally; this is rollback protection, not off-server backup.

## Configuration

Keep `NODE_ENV=production`, `RECOVERY_ONLY=1`, `RECOVERY_API_URL` and `TOOL_GATEWAY_URL` set to `http://127.0.0.1:3610`. Nginx overwrites `X-Real-IP`; the dashboard uses `ADDRESS_HEADER=x-real-ip` for its durable authentication limits. Credentials stay on the server, never in Git or the release archive. New `.env` edits on a developer laptop do not automatically rotate server secrets. Recovery defaults to the EU OpenAI endpoint because this project requires EU residency; if `OPENAI_BASE_URL` is supplied, it must match the key’s project region. A global-endpoint HTTP 401 mentioning project geography is not a missing-model-permission error.

The HTML document sets `Referrer-Policy` through a `same-origin` meta tag. This preserves native form origins for SvelteKit's CSRF checks and suppresses cross-origin referrers. Nginx's `no-referrer` remains the fallback for non-HTML responses; do not remove the document policy or disable CSRF to work around login failures.

Initial contact flags are all off: `RECOVERY_LIVE_ENABLED=0`, `RECOVERY_SMS_ENABLED=0`, `RECOVERY_WORKER_ENABLED=0`, `GPT_LIVE_DEMO_ENABLED=0`. The worker uses the dedicated dispatch name `rescova-ecom-hetzner`. Existing local consent was revoked in the server copy so a previous one-off owner test cannot become a scheduled contact.

Add `https://ecom.rescova.de/admin/integrations/shopify/callback` to the active Shopify app version's allowed redirect URLs for new merchant installations. Existing encrypted shop credentials remain usable. Operational Shopify webhook URLs must be registered against the server origin; mandatory privacy topics are configured in the Shopify app. Twilio receipts use `/webhooks/recovery/twilio`; LiveKit's signed project callback uses `/webhooks/livekit`. Preserve other destinations in the shared LiveKit project.

For a rollback, revert the faulty application change on `main`; that commit runs through the same release workflow. The workflow deliberately refuses other branches and tags. Because additive schema migrations remain applied, verify compatibility before reverting application code. Never run the inherited `deploy/deploy.sh` against this installation.

Dedicated merchant numbers use a server-only `RECOVERY_SHOP_TELEPHONY` JSON object keyed by the authenticated `recovery_shops.id`. Each entry has `trunkId` (LiveKit `ST_…`) and `callerId` (owned E.164 number); optional `smsFrom` selects a separately verified SMS-capable sender. Without `smsFrom`, the existing `TWILIO_SMS_FROM` remains in use, including for voice-only landlines. Shops without an entry retain the existing Recovery defaults. Malformed mappings disable dispatch rather than silently falling back. Neither merchants nor the agent can supply a caller ID. Optional `smsSenderIdDE` enables a branded alphanumeric SMS sender only for `+49` recipients (1–11 ASCII letters/digits, starting with a letter). Other destinations retain `smsFrom` or `TWILIO_SMS_FROM`; voice still uses `callerId`. This is an explicit destination rule, not a retry/failover after dispatch. Germany supports dynamic branded senders without pre-registration according to [Twilio's country guidelines](https://www.twilio.com/en-us/guidelines/de/sms). Do not extend this rule to other countries without checking their registration requirements. Branded SMS are one-way: reply-based STOP is unavailable; maintain an alternative opt-out process before customer launch. Existing in-call/merchant suppression still applies to every SMS.

Before adding an entry, verify Twilio ownership/capabilities, the correct regional trunk and the LiveKit outbound trunk's number allowlist. Read the values back after changing configuration; keep all live flags off until the separately authorized test. The current Twilio trunk lives in Ireland (`trunking.dublin.ie1.twilio.com` with region-specific credentials); querying US1 does not show it. Source releases still go through GitHub Actions; server secrets/configuration are not copied from local `.env` by deployment.

## Mailbox detection and merchant-managed activation

Live calls wait for the named agent's call-bound `recovery.amd_ready` attribute before creating the SIP participant. The agent runs LiveKit AMD with GPT-4.1-mini and Cartesia Ink Whisper through LiveKit Inference, using the configured German/English language. Audio remains muted during detection. Machine/IVR results invoke the authenticated `not_reached` endpoint, persist a terminal outcome, and delete only that call's room. Late mailbox greetings use `end_on_voicemail`. No greeting, SMS, follow-up ticket or contact suppression is created for a mailbox. Failed hangups are reconciled; voicemail/no-answer calls do not count toward attributed purchases. A human greeting or later reply cancels the 45-second unanswered-opening limit.

`RECOVERY_MERCHANT_MANAGED_CONTACT_SHOPS` is an optional, server-only comma-separated UUID allowlist. Enable it only following explicit operator authorization that the merchant manages contact permissions. A live shop must also have its campaign start watermark, accepted terms and merchant approval. The allowlist permits future checkouts without per-contact opt-in records; it never writes fabricated opt-in timestamps or evidence. Each reserved call records `call_authorization.source=merchant_managed`. All other shops retain individual evidence requirements. Revocations, blocklists, purchase checks, time windows, attempt limits and the control group still apply. Removing the UUID restores the individual-evidence requirement. Activating global flags alone does not enable a shop.

### Internal call-start email alerts

Off by default. Reuses RescovaBR's Gmail API/OAuth flow for `louiz@rescova.de`.
Configure `RECOVERY_CALL_ALERT_ENABLED=1`, `RECOVERY_CALL_ALERT_SHOP_ID`,
`RECOVERY_CALL_ALERT_TO=louiz@rescova.de`, and an explicit UTC
`RECOVERY_CALL_ALERT_START_AT` so old calls are not replayed. Copy the existing
`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` privately into the
protected server environment. Also set a public HTTPS `RECOVERY_DASHBOARD_URL`.
Never commit credentials. Gmail profile verification must match the owner mailbox
before sending. The transport cannot send to customers or arbitrary recipients.

The isolated API polls confirmed `dialed_at` receipts every five seconds in a
separate loop, including labeled owner test calls. Simulated calls, unconfirmed
reservations, other shops and calls older than 24 hours are excluded. Alerts contain
only shop, start time, call ID and dashboard link, no customer details or transcripts.

`recovery_call_alerts` has one durable claim per call. `accepted` means Gmail
accepted the message, not proof of inbox delivery. OAuth/profile failures happen
before claims and can be retried. `failed` and `unknown` sends require operator
inspection; ambiguous sends are never automatically retried. Interrupted sends
become `unknown` after two minutes. This prioritizes avoiding duplicate alerts over
guaranteed delivery during provider failures. Disabling alerts stops new polls;
a send already in progress can finish. Calls and customer SMS run independently.
