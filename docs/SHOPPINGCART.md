# Rescova Cart Recovery — local pilot

The recovery product lives in `src/recovery`, `/recovery` in the SvelteKit dashboard, and the named `agent/recovery.py` worker. It reuses the existing PostgreSQL tenant/session authentication, Shopify credential encryption format, LiveKit SIP transport and signed lifecycle webhook. Debt collection data and the pinned Deepslate worker are separate.

## Run locally

Node 22.18+, PostgreSQL 15 binaries, Python 3.13 for the optional voice worker. Use the prepared ignored `.env` files; never point these commands at Rescova production.

```sh
npm ci
npm ci --prefix dashboard
npm run shoppingcart:db
npm run migrate
npm run shoppingcart:seed
npm start
# Another terminal:
npm run dev --prefix dashboard -- --host 127.0.0.1 --port 5173
```

Open <http://localhost:5173/login?next=/recovery>. Credentials are generated once in `.local/login.txt`, with file mode 0600. The seed creates only synthetic AFTERHOURS checkouts. It grants neither contact permission nor merchant activation. Existing login credentials and stop records are preserved when re-running the seed. The local database listens only at `127.0.0.1:55433`; files are in `.local/postgres`. Set `PG_BIN` if the PostgreSQL binaries are elsewhere. Stop this cluster with `pg_ctl -D .local/postgres stop` from the same installation.

The dashboard server also needs `INTERNAL_TOOL_SECRET` matching the API and `RECOVERY_API_URL=http://127.0.0.1:3110`. These belong in `dashboard/.env`; they never go to the browser. The internal admin and tool gateways check the actual socket address and a constant-time secret comparison.

`/recovery` is the minimal merchant overview: actual calls started today and paid orders linked to a connected recovery conversation. Dates follow each shop's timezone, including daylight-saving changes; simulation is excluded. Each original checkout is linked by its Shopify identifier, and paid orders are counted once within seven days after connection. The payment date is the first confirmed-paid webhook source timestamp, which can be later than transaction settlement when an already-paid order is first observed through an edit. Legacy orders without known payment time are not rebased onto today. Configuration and detailed pilot results live at `/recovery/admin`, restricted to the existing tenant admin role.

This public repository is an independent source snapshot; the older Rescova history and local handoff/configuration are excluded. Inherited deployment and scheduled devlog jobs are restricted to `louiz7/rescova` and do not run for this repository.

## What is implemented

- Merchant-scoped shops, checkouts, callback evidence, attempts, offers, messages, events and order ledger.
- Shopify OAuth with short-lived, one-use server-side state, callback HMAC, fixed domain allowlist and encrypted tokens. The existing Dropsize-only support integration keeps its restrictions.
- Abandoned checkout pagination and fresh checkout/product/availability reads before calling and sending. Closed orders, including order events received before the checkout, suppress contact. Shopify marketing consent does not establish phone permission.
- Explicit merchant approval and independently gated live calls; callback evidence bound to the exact checkout and phone, a verified contact timezone, expiry, abandonment delay, weekdays, contact-wide cooldown/attempt limits and permanent suppression after refusal.
- Named LiveKit dispatch on the existing Twilio trunk; no trunk, caller ID or provider account is provisioned or changed by this code.
- GPT-Live (`gpt-live-1`, voice `flitz`) with separate voice/backend instructions. The backend model performs grounded tool calls. Customer details are withheld until transcript-backed identity confirmation. No card/payment collection or checkout submission.
- Server-checked percentage offers, one code per checkout, customer and variant restriction, one redemption, no stacking, expiry and cart fingerprint validation. Existing discounts, missing variants and changed prices fail closed.
- Checkout SMS to the original number only after an explicit recent request in the trusted worker transcript; immediately before provider dispatch, the server rechecks the same request, offer, cart fingerprint, checkout URL and current merchant rules. Provider acceptance and confirmed delivery are distinct. One durable SMS intent per checkout. Authorization failures before dispatch are recorded as failed; ambiguous provider outcomes remain unknown and are not automatically retried.
- Signed, per-shop capability-bound operational Shopify webhook destinations, plus signed privacy webhooks with the shop domain checked in the signed body. Raw-body HMAC validation happens before parsing. Event IDs deduplicate effects. Twilio delivery receipts are signed, persisted even if they arrive before the send acknowledgement, and applied monotonically.
- Merchant dashboard with normal controls for brand voice, windows, offer rules, activation, contact evidence/stops, outcomes, estimated costs, control-group contribution and p50/p95 observations. No fabricated live metrics.

## Shopify installation prerequisites

The pilot shop `test-store-slzn5m7l.myshopify.com` (USD) is installed and connected locally with encrypted credentials and all four required scopes. Real product reads and the abandoned-checkout query succeeded on 2026-11-02; the shop returned zero abandoned checkouts. Calls remain disabled and public webhook delivery/protected customer data behavior still require verification. API version is pinned to `2026-10`. Requested scopes: `read_orders`, `read_products`, `read_customers`, `write_discounts`. The installing user needs the relevant abandoned-checkout permission. The pilot accepts EUR and USD stores, with checkouts in the same currency as the connected store. Money and cost estimates stay in each shop's currency; the dashboard does not add EUR and USD totals. A changed store currency requires review rather than relabeling historical amounts.

Keep the existing app's production installation/configuration intact. The recovery flow can use the already prepared callback `http://localhost:5173/admin/integrations/shopify/callback`; it checks recovery state first and otherwise retains the existing Dropsize callback. Confirm this additional URL is registered in the app. `RECOVERY_SHOPIFY_REDIRECT_URI` can override the prepared `SHOPIFY_REDIRECT_URI`.

If Shopify's Redirect URLs field rejects the local address, an OAuth-only relay is available via `npm run shoppingcart:oauth-relay`. It listens on `127.0.0.1:3111`, verifies the Shopify signature, timestamp and configured test-shop domain, and returns a browser redirect to the unchanged local callback. It neither exchanges tokens nor exposes dashboard/API/webhook routes; the local authenticated admin session and one-use tenant-bound OAuth state remain required. No tunnel starts automatically. Only after explicit permission to expose this temporary endpoint, use `ngrok http http://127.0.0.1:3111 --inspect=false --log=false`, set `RECOVERY_SHOPIFY_REDIRECT_URI` to the resulting HTTPS origin plus `/admin/integrations/shopify/callback`, restart the local API, and whitelist that exact URL in the Shopify app while preserving existing configuration. Start the flow again from the dashboard in the same Chrome session. The ngrok service transports the OAuth callback; stop the tunnel after installation. By default this relay does not expose webhook routes. The tested Shopify-only webhook forwarding mode is separately gated by `RECOVERY_SHOPIFY_WEBHOOK_RELAY_ENABLED=1` and is not activated without explicit permission to publish webhook reception. It accepts raw signed payloads only for `RECOVERY_TEST_SHOP_DOMAIN`, preserves raw bytes/signature/event headers, and forwards only the existing capability-bound Shopify and privacy webhook paths to the fixed loopback API. Dashboard, internal tools, Twilio and LiveKit endpoints remain unavailable. After that approval, enable this flag, restart only the relay, set `RECOVERY_PUBLIC_URL` to its HTTPS origin and register the shop subscriptions. Real Shopify delivery still needs confirmation.

Set `RECOVERY_PUBLIC_URL` to the pilot API's public **HTTPS** origin for webhook delivery. OAuth stores the connection disabled and attempts to register only its own operational webhook subscriptions. If public HTTPS is missing, the connection remains disabled with an actionable error. The dashboard's **Webhooks einrichten** action retries registration after configuration; existing subscriptions for other products are preserved. Topics: checkouts create/update/delete; orders create/paid/updated/cancelled; app uninstalled. Creating a checkout is not treated as proof of abandonment; the delay and fresh completedAt check remain mandatory.

Shopify's mandatory privacy topics must be configured through the app configuration/Partner Dashboard to `/webhooks/recovery/shopify/privacy`. See `shopify.recovery.example.toml`. Do not deploy this example over the shared production app. Privacy requests are persisted for operator follow-up. Redaction clears identifying snapshots, transcripts, evidence and summaries while preserving suppression and call-cleanup records. Data export requests still require an operator to fulfill them.

## Live voice and messages

All these flags default off: `RECOVERY_WORKER_ENABLED`, `RECOVERY_LIVE_ENABLED`, `RECOVERY_SMS_ENABLED`, `GPT_LIVE_DEMO_ENABLED`. Existing collection/email workers remain disabled in the prepared environment. Changing a flag is configuration, not evidence of legal or operational approval.

```sh
python3 -m venv .venv-recovery
.venv-recovery/bin/pip install -r agent/requirements-recovery.txt
# Only after explicit pilot/live authorization and configuration:
.venv-recovery/bin/python agent/recovery.py dev
```

The separate virtual environment is necessary: the inherited Deepslate worker pins LiveKit Agents 1.6.5, while GPT-Live requires the 1.8 API. The recovery worker registers **only** `LIVEKIT_AGENT_NAME` (prepared: `shoppingcart-local`), and the backend explicitly dispatches that same name. The module refuses its main entry point while `RECOVERY_LIVE_ENABLED` is off. Import and schema tests do not open a connection to the shared LiveKit project. The existing unnamed Evi worker rejects recovery room metadata.

The existing `twilio-frankfurt` LiveKit trunk and a matching Twilio-owned caller ID were verified through read-only provider APIs and assigned locally to `RECOVERY_SIP_TRUNK_ID` / `RECOVERY_CALLER_ID`. Generic collection settings `LIVEKIT_SIP_TRUNK_ID` and `SIP_CALLER_ID` remain empty; recovery does not fall back to them. No provider configuration was changed and no call was placed. The Twilio account reports one SMS-capable owned sender, assigned locally to `TWILIO_SMS_FROM`; sending remains separately disabled. Configure the LiveKit project's signed webhook to reach the existing `/webhooks/livekit` endpoint. The new handler routes only `recovery-*` rooms into recovery lifecycle processing.

For SMS, configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, the public callback URL, and separately enable `RECOVERY_SMS_ENABLED`. No Twilio call or message was sent to validate these values. `accepted` is not a delivery confirmation. A contact stop is durably committed and cancels pending work; hangup failures are retried by the worker. An external request already in flight cannot be guaranteed retractable. Unknown call/message/offer intents stay blocked for manual provider reconciliation rather than being retried blindly.

The SMS uses Shopify's original abandoned-checkout URL, preserving its signed query parameters and buyer context. A discount is optional; when offered, its shop, currency, cart fingerprint, backend limits and expiry are rechecked before sending. The customer must explicitly request the link during the verified conversation. A durable intent prevents duplicate sends; ambiguous timeouts require reconciliation rather than a retry. Twilio status callbacks verify the exact configured public URL, all signed form parameters, account and message identifiers; duplicate and out-of-order receipts cannot reverse terminal states. A sent native checkout URL cannot be revoked by this app. Its availability is controlled by Shopify, separately from discount expiry. Recreating a cart is unnecessary for the currently supported recovery URL flow.

The browser demo is a separately gated, authenticated simulation using the existing AFTERHOURS scenario, with an honest AI introduction. It has no shop tools and cannot send links or create orders. It requires explicit user microphone interaction, limits session creation to three attempts per tenant/hour and closes after three minutes. Do not enable the browser flag until the chosen OpenAI account is approved for the intended audio processing. The API key is kept on the server.

## Pilot measurement and retention

Treatment assignment is stable per shop/phone and persisted when an otherwise eligible contact is enrolled; the same person does not cross into both groups. The holdout is at least 10%, default 20%. No contact is made to controls. The report uses intention-to-treat over complete seven-day windows, one row per enrolled contact, and all confirmed paid orders in that window. Contributions use actual order subtotals after discounts and the merchant's frozen contribution estimate. The report subtracts treatment conversation costs and scales the control baseline by group size; it shows no incremental value when either group or cost evidence is missing. This is an estimate, not statistical significance or accounting profit. Inventory cost, shipping cost, provider/model billing reconciliation and confidence intervals must be validated against merchant finance data before making business claims.

Timing records separate server tool round trips from user speech end to LiveKit agent playout state. They are SDK observations, not a calibrated end-to-end acoustic measurement on the recipient's handset. Real p50/p95 values require the same call/audio baseline, recorded samples, interruptions, actual tool delays and provider/device verification. No live latency numbers have been measured here.

The recovery worker purges transcripts/events, call summaries, checkout snapshots, checkout links, raw order phone data and expired evidence at 30 days. Contacts without a recent checkout also lose their raw phone/evidence even if no consent expiry was recorded. Pseudonymous order amounts, checkout/call references, conversation costs and shop-scoped contact keys remain so cleanup cannot erase purchases/costs from historical cohorts. These are pseudonymous records, not anonymous statistics; their retention/deletion policy, backups, contractual retention, data-subject exports and processor/residency settings require a separate operational/privacy review before a real pilot. Suppression keys prevent re-contact. The worker must run for retention and cleanup even while campaigns are paused. Raw audio is not recorded by this implementation; provider retention remains governed by the provider account settings.

## Verification and release gates

```sh
npm test
npm run test:recovery
npm run check --prefix dashboard
npm run build --prefix dashboard
python3 -m py_compile agent/recovery.py
.venv-recovery/bin/python -m unittest discover -s agent -p test_recovery.py
```

`test:recovery` insists on the dedicated local DB endpoint, creates and removes synthetic tenants, forbids external fetches and mocks every provider mutation. It exercises real PostgreSQL transactions and uniqueness constraints. It is not a real Shopify/Twilio/LiveKit/audio acceptance test.

Before enabling a pilot: install the selected testshop; verify current API queries, consent provenance, webhook delivery, discount application at the actual checkout, signed message delivery and order reconciliation; run explicitly authorized owner-number calls in the isolated dispatch; listen to refusals, wrong-person, voicemail, interruption, expiry, timeout and exactly-once goodbye cases; validate p50/p95 and provider costs; obtain the legal/privacy approval for this contact process. The inherited application dependency audit has unresolved advisories and needs its own scoped remediation before public production use. No publication, deployment, shared infrastructure change or live contact is authorized by this document.

Official references used: [Shopify abandoned checkout](https://shopify.dev/docs/api/admin-graphql/latest/objects/AbandonedCheckout), [Shopify webhook verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries), [Shopify discount creation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/discountCodeBasicCreate), [OpenAI GPT-Live prompting](https://developers.openai.com/api/docs/guides/live-prompting), [GPT-Live in LiveKit](https://docs.livekit.io/agents/models/realtime/gpt-live/).
