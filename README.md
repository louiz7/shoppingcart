# Cart Recovery pilot

The isolated Shoppingcart implementation is documented in [docs/SHOPPINGCART.md](docs/SHOPPINGCART.md). Open the authenticated dashboard at `/recovery`. Live calls and messages remain gated; the older Rescova platform documentation below is retained for the shared infrastructure.

# Rescova

Rescova is a multi-tenant receivables platform with an AI voice agent (“Evi”),
campaign orchestration, debtor and call management, human review workflows,
and an authenticated customer dashboard.

Evi leads the conversation, but the model is not the source of truth for
amounts, payment terms, discounts, case state, suppression, or escalation.
Those decisions are derived and enforced by backend policy code and
tenant-scoped PostgreSQL data.

- Marketing site and callback demo: <https://rescova.de>
- Customer platform: <https://app.rescova.de>
- Backend API: <https://api.rescova.de>

## Current product capabilities

### Customer dashboard

The authenticated SvelteKit platform includes:

- **Overview** — active debtors, open claims, realized payments for 7 days,
  30 days, and year-to-date, completion rates, and recent open tasks.
- **Tasks (`Postfach`)** — open rule-compliant tasks, special cases, and
  escalations. A debtor detail page shows case data, recent audited activity,
  the latest call summary, and a proposed payment plan. Operators can resolve
  manual tasks and approve payment plans negotiated by Evi.
- **Debtors** — tenant-scoped debtor directory with campaign tabs for all
  campaigns and an explicit “Ohne Kampagne” bucket for legacy/unassigned
  records.
- **Call list** — calls grouped into today, yesterday, and older calls, with
  customer-facing outcome labels, actual call duration, aggregate metrics,
  campaign tabs, and an unassigned bucket. Durations use `ended_at`, not room
  timeout estimates.
- **Campaign overview** — all campaigns with contact count, progress, reach
  rate, received payments, and current status.
- **Campaign detail** — performance funnel, campaign configuration, live
  member status, attempt count, manual payment recording, start/pause/resume,
  and permanent deletion.
- **User administration** — tenant admins can create or reset users with the
  roles `admin`, `operator`, and `viewer`.
- **Email automation** — tenant admins can connect Microsoft 365 through
  delegated Graph OAuth or another mailbox through IMAP/SMTP. Incoming mail is
  matched tenant-locally to a debtor/case and produces an editable draft;
  sending requires an explicit dashboard approval.
- **Responsive navigation** — sidebar/mobile behavior and consistent back
  navigation across platform views.

Operational campaign and call views refresh automatically every five seconds
while the browser tab is visible.

### Campaign lifecycle

Campaign creation and calling are deliberately separate:

1. An operator uploads a CSV or XLSX file and configures the campaign.
2. Rescova validates the complete import and creates the campaign as a
   `draft`. No calls are placed during creation.
3. The operator reviews the campaign detail and selects **Kampagne starten**.
4. Starting the campaign creates one scheduled job per eligible member.
5. The scheduler places calls only when both campaign scheduling rules and
   tenant policy allow them.
6. A campaign can be paused and resumed. Pending work remains queued while it
   is paused.
7. A campaign completes automatically after no member remains pending,
   scheduled, or currently being contacted.

Campaign statuses are `draft`, `active`, `paused`, `completed`, and
`cancelled`. Member statuses are translated into customer-facing German
labels; after an unsuccessful attempt with another attempt still scheduled,
the dashboard displays **Wird erneut angerufen**.

Deleting a campaign is permanent. Its campaign-scoped members, jobs, events,
and templates follow their database foreign-key rules, while underlying
debtors and cases remain available and historical calls/payments lose only
their campaign association. A campaign whose template is referenced by a
payment plan can currently be protected from deletion by that foreign key.

### Campaign import format

Imports accept `.csv` and `.xlsx` files up to 10 MB and between 1 and 10,000
data rows. CSV delimiter detection supports commas and semicolons, including
UTF-8 BOM files. Column names are case-insensitive and trimmed.

The campaign import uses these columns:

| Field | Accepted headers | Format |
|---|---|---|
| First name | `Vorname`, `First Name` | Non-empty text |
| Last name | `Name`, `Nachname`, `Familienname`, `Last Name` | Non-empty text |
| Invoice | `Rechnungsnummer`, `Invoice`, `Invoice Number` | Unique within the file |
| Email | `E-Mail-Adresse`, `Email`, `E-Mail` | Must contain `@` |
| Amount | `Rechnungsbetrag`, `Betrag`, `Amount` | Positive amount, e.g. `249,00` or `249.00` |
| Phone | `Telefonnummer`, `Telefon`, `Phone` | E.164, e.g. `+4917612345678`; spaces and common separators are normalized |
| Due date | `Fälligkeitsdatum`, `Faelligkeitsdatum`, `Due Date`, `due_date` | `DD.MM.YYYY` or `YYYY-MM-DD` |
| File number | `Aktenzeichen` | Text |
| Sub-file number | `unteraktennummer` | Text |
| Note | `Notiz` | Text |

Example semicolon-separated CSV:

```csv
Vorname;Name;Rechnungsnummer;E-Mail-Adresse;Rechnungsbetrag;Telefonnummer;Fälligkeitsdatum;Aktenzeichen;unteraktennummer;Notiz
Max;Mustermann;RE-2026-00123;max.mustermann@beispiel.de;349,9;+49 151 23456789;15.08.2026;;;
```

The import is atomic: if any row is invalid, contains a duplicate invoice, or
conflicts with an existing invoice that has a different original amount, the
campaign is not partially created. The UI reports upload selection
immediately and returns validation or server errors visibly.

Within one organisation, imports reuse an existing debtor when the normalized
name and E.164 phone number match. Different invoices remain separate cases
under that debtor and are shown individually in the debtor detail. This avoids
duplicate directory entries without treating a shared phone number alone as a
person identifier.

### Scheduling and retry behavior

The Node process runs a PostgreSQL-backed campaign scheduler:

- Jobs are claimed transactionally with `FOR UPDATE ... SKIP LOCKED`.
- Only active campaigns and eligible members can be claimed.
- Organisation admins maintain campaign defaults centrally under
  **Einstellungen**. New campaigns copy these values; later changes to the
  organisation defaults never silently alter an existing campaign.
- The campaign snapshot is the sole runtime source for weekdays, time window,
  timezone, total attempts, rolling 24-hour/7-day caps, and retry interval.
  A visible warning marks campaign-specific overrides in create/edit views.
- Rolling caps are counted debtor-wide across all of that debtor's cases, so
  multiple claims cannot accidentally multiply contact attempts.
- Jobs and retries are moved directly to their next timezone/DST-aware eligible
  instant. Editing an active campaign triggers recalculation of pending jobs.
- Disputes, suppression, non-dialable case states, and a zero balance remain
  non-overridable safety stops.
- Admin-only demo campaigns are explicitly marked as demos. They can start at
  any time and ignore historical rolling contact caps, while the hard safety
  stops above still apply.
- Stale jobs left in `processing` for more than ten minutes are recovered on
  scheduler startup.
- Paused campaigns cannot launch new calls.
- Full payment, disputes, suppression, and other terminal states stop or
  cancel remaining automation as appropriate.
- A confirmed callback is stored as its own durable campaign job. It runs at
  the agreed local time without the normal retry delay or rolling attempt
  caps, while payment, dispute, suppression, campaign status, and the
  configured calling window remain hard safety gates. More than 15 minutes
  late callbacks are not placed unexpectedly; they create a manual task.

The scheduler polls every `CAMPAIGN_SCHEDULER_POLL_MS` (default: 5 seconds).
Automated campaign attempts and callbacks share one global, database-backed
call slot: the next contact is claimed only after the previous campaign call
has definitively ended. A PostgreSQL advisory lock keeps this sequential even
when multiple backend replicas are running. Manual case calls and website
widget calls do not consume this campaign slot.

### Calling and conversation flow

```text
Dashboard/API
    │ create/start campaign or POST /v1/cases/:id/call
    ▼
Node backend ── policy gate ── PostgreSQL campaign job/call attempt
    │
    ▼
LiveKit room + outbound SIP participant
    │ TLS signaling + SRTP media
    ▼
Twilio Frankfurt Elastic SIP trunk ── debtor phone
    ▲
    │ audio
Python LiveKit agent ── Deepslate realtime speech model
    │
    └── function tools ── loopback Tool Gateway ── policy + DB + audit log
```

For a case call, the backend:

1. Re-checks dial eligibility.
2. Creates a `call_attempts` record.
3. Mints a short-lived, single-case call token stored as a SHA-256 hash.
4. Creates a LiveKit room containing routing/persona data and the call token,
   but no debtor PII.
5. Dials the debtor through the configured outbound SIP trunk.
6. Lets the Python worker bridge LiveKit audio to Deepslate and invoke only
   the exposed tools.

The signed LiveKit SIP-participant lifecycle is authoritative: dialing starts
an attempt, LiveKit's confirmed active/answered state marks the connection,
and `participant_left` closes it. Ringing and an agent outcome tool cannot inflate the
displayed or recorded conversation duration. `room_finished` and the scheduler
reconciler are safety nets for lost webhooks; because their exact disconnect
time is unknown, recovered legacy durations are excluded instead of guessed.
Duplicate and concurrent end events are idempotent and can create at most one
campaign retry.

### Twilio outbound SIP provisioning

The application connects LiveKit directly to Twilio; the former Asterisk hop is
not part of the active call path. Provision Twilio alongside the current carrier
so rollback remains available:

1. Attach a Twilio Credential List to the Elastic SIP trunk, enable Secure
   Trunking, and configure the `SIP_TRUNK_*` and `SIP_AUTH_*` environment values.
2. Leave `SIP_TRUNK_SETUP_ID` empty and run `node scripts/setup-sip-trunk.js`.
   This creates a new LiveKit trunk without changing `LIVEKIT_SIP_TRUNK_ID`.
3. Store the returned ID as `SIP_TRUNK_SETUP_ID` for future provisioning updates.
4. Once a Twilio-owned or verified number exists, set `SIP_CALLER_ID` to its
   E.164 value and rerun the setup script to restrict the trunk to that number.
5. Test the new trunk, then set `LIVEKIT_SIP_TRUNK_ID` to the returned ID and
   restart the backend to cut over. Restore the previous runtime ID to roll back.

The Twilio Trunk SID identifies the provider-side trunk but is not required by
the application at runtime. Real provider credentials belong in deployment
secrets and must never be committed.

### Agent tools and deterministic controls

| Exposed tool | Backend behavior |
|---|---|
| `get_case_context` | Mandatory first action. Loads tenant-scoped case data and allowed actions. The model must invoke it silently and never expose tool names or internal processing to the caller. Identity verification is temporarily bypassed, so dialable cases move directly to `VERIFIED`. |
| `report_signal` | Records signals such as dispute, already paid, wrong person, do-not-call, hardship, anger, inability to pay in full, or callback request. Policy decides whether to escalate, suppress, stop, or unlock offers. |
| `schedule_callback` | Stores a clearly requested callback immediately. A future clock time can resolve to today without a second confirmation round; ambiguous dates still require clarification. The server validates timezone and calling window and creates one idempotent callback job for the current case. |
| `get_plan_options` | Returns only active, campaign-specific, policy-compliant templates. Triggered options appear only after the required signal was recorded in the same call. |
| `create_payment_plan` | Accepts an opaque option token issued for the current call, re-loads its template, recomputes every term, and creates a plan in `pending_approval`. |
| `log_call_outcome` | Stores an enum-constrained disposition and a bounded free-text conversation summary. A payment promise creates a visible task reminding the operator that the payment still has to be verified and recorded. The phone lifecycle closes the attempt independently. |
| `escalate_to_human` | Moves the case into human review and creates a platform task. |
| `mark_disputed` | Marks the claim disputed, stops automation, and creates an urgent review task. |
| `end_call` | Closes the LiveKit room after a configurable grace period so Evi can finish the spoken goodbye. |

The `verify_identity` backend route remains in the codebase but is not exposed
to the active Python agent. The current product intentionally does not ask for
date of birth, postcode, address, or other identity attributes. Re-enabling
verification requires restoring the agent tool and changing the initial
`get_case_context` transition.

### Payment options and human approval

`policy_config` stores tenant business rules as JSONB. `plan_templates` is the
closed catalog of offers Evi may present. No matching template means no offer,
and an invented or modified option token is rejected.

Campaign creation can generate:

- A campaign-specific installment template, including maximum installments,
  minimum eligible balance, and configured fee percentage.
- Optional 24-hour and 7-day single-payment discount templates.

Discounts are checked against the tenant-level `max_discount_pct` ceiling.
When Evi records an agreement, the plan is not immediately activated: it is
stored as `pending_approval`, creates a dashboard task, and requires an
operator to approve it. Approval changes the case to `PLAN_ACTIVE` and is
recorded in the append-only event log. While approval is pending, direct and
campaign calls are blocked, queued retries are cancelled, and another plan
cannot replace the pending agreement. A `plan_agreed` outcome is accepted only
when the same call actually created a plan. If the claim is subsequently
disputed, any pending or approved plan is invalidated atomically, its approval
task is dismissed, and stale approval requests are rejected.

Operators can also record partial or full payments manually. A payment promise
creates one open `payment_confirmation` task per case; recording the full
payment resolves that reminder together with the case. A full payment
sets the case to `PAID`, resolves the campaign member and open tasks, and
cancels pending campaign work. Agreements and payment promises stop automated
follow-up but remain labelled as pending or promised; only a fully recorded
payment is displayed as **Bezahlt**.

### Public website functionality

- The callback widget uses `POST /v1/outbound-call` to provision an ephemeral
  demo case and place a real Evi call. It is CORS allow-listed and rate-limited
  per IP and target number.
- The pilot form uses `POST /v1/pilot-lead` and sends validated lead details
  to a configured Telegram chat. It is also CORS allow-listed and rate-limited.

Organisation onboarding and policy/catalog configuration are intentionally
manual operations for now. Create organisations with `npm run seed`, platform
users with `npm run platform:user`, and policy templates with
`npm run seed:policy`; there is no public configuration endpoint.

## Architecture and repository layout

```text
src/
  index.js                       Express wiring and service startup
  campaign-scheduler.js          PostgreSQL job claiming, retries, reconciliation
  services/case-call-service.js  LiveKit room/SIP call creation
  policy/engine.js               Pure deterministic policy and plan math
  personas.js                    Evi's case-call instructions and voice settings
  routes/
    case-calls.js                Authenticated policy-gated case dialing
    agent-tools.js               Internal deterministic Tool Gateway
    livekit-webhook.js           Signed call finalization and billing webhook
    outbound-call.js             Public callback-demo endpoint
    pilot-lead.js                Public Telegram lead endpoint
    dashboard.js                 Legacy usage API
    webhooks.js                  Deepslate usage webhooks
  auth.js, db.js, usage.js

agent/
  agent.py                       LiveKit worker and Deepslate audio/tool bridge

dashboard/
  src/routes/                    Authenticated SvelteKit customer platform
  src/lib/server/                Platform auth, queries, and DB access

website/                         Astro marketing site and public forms/widgets
migrations/                      Ordered idempotent PostgreSQL migrations
scripts/                         Customer, policy, case, user, and SIP setup tools
test/                            Node policy/configuration tests
deploy/                          systemd and nginx configuration
.github/workflows/deploy.yml     Production deployment on pushes to main
```

### Technology stack

- **Backend:** Node.js, Express, PostgreSQL via plain `pg`
- **Dashboard:** SvelteKit with adapter-node
- **Marketing site:** Astro
- **Voice transport:** LiveKit rooms and outbound SIP
- **Telephony:** Twilio Elastic SIP Trunking connected directly to LiveKit
- **Realtime agent:** Python `livekit-agents` + Deepslate speech-to-speech
- **Hosting:** Hetzner VPS, systemd, nginx, Let's Encrypt
- **Deployment:** GitHub Actions, rsync, remote migrations/build/restart

## Data model

All operational queries and tables carry or verify `customer_id` for tenant
isolation.

- `customers`, `api_keys`, `usage_events` — tenant identity, API access, and
  usage/billing records.
- `platform_users`, `platform_sessions` — dashboard users and hashed sessions.
- `debtors`, `cases`, `case_state` — contact PII, monetary claims in integer
  cents, and current workflow state.
- `campaigns`, `campaign_imports`, `campaign_members`, `campaign_jobs`,
  `campaign_events` — campaign configuration, import audit, member progress,
  scheduled work, and campaign activity.
- `call_attempts`, `call_tokens` — call lifecycle and single-case tool access.
- `events` — append-only audit spine for tool actions and policy decisions,
  including denied actions.
- `policy_config`, `plan_templates`, `payment_plans` — deterministic tenant
  rules, offer catalog, and human-approved payment arrangements.
- `suppression` — debtor, case, or phone-number contact blocks.
- `platform_tasks`, `payments` — human work queue and manually recorded money.

Principal case states are:

```text
NEW → CONTACTABLE → IN_PROGRESS → VERIFIED → PLAN_OFFERED → PLAN_ACTIVE
                                                        └→ PAID
Any active state may move to ESCALATED or STOPPED when policy requires it.
```

Identity verification is currently bypassed, so active case calls generally
move directly from a dialable state to `VERIFIED` on first context load.

## Authentication and authorization

### Customer API

Customer-facing case APIs use bearer keys. Keys are random, shown once,
bcrypt-hashed at rest, and looked up through a non-secret prefix.

```http
Authorization: Bearer dlh_<customer-key>
```

### Customer platform

- All routes except `/login` require a valid platform session.
- Passwords use versioned scrypt hashes.
- Session tokens are random and stored only as SHA-256 hashes.
- Cookies are HTTP-only, `SameSite=Lax`, and secure in production.
- Sessions expire after 14 days.
- Login attempts are limited to five failures per IP/email pair in 15 minutes
  in the current process.
- `viewer` is read-only; `operator` can run operational actions; `admin` can
  additionally manage tenant users.

## Local setup

### Requirements

- Node.js 22
- PostgreSQL
- Python 3 with the dependencies from `agent/requirements.txt`
- A LiveKit project and configured outbound SIP trunk for real calls
- Deepslate credentials for the realtime voice agent

### Backend and database

```bash
cp .env.example .env
npm install
npm run migrate

# Create tenant + API key (the plaintext key is printed once)
npm run seed -- "Acme Inc" billing@acme.com

# Create default tenant policy and offer catalog
npm run seed:policy -- 1

# Create an individual test case
npm run seed:case -- 1 "Max Mustermann" +4917612345678 24900 RE-1

# Create/reset a dashboard admin
PLATFORM_USER_PASSWORD='at-least-12-characters' npm run platform:user -- \
  1 admin@example.com "Admin Name" admin

npm start
```

The API listens on `127.0.0.1:3000` by default. To place a direct authenticated
case call:

```bash
curl -X POST http://127.0.0.1:3000/v1/cases/1/call \
  -H "Authorization: Bearer dlh_<customer-key>"
```

For production lifecycle events, open the matching project in LiveKit Cloud,
then go to **Settings → Webhooks → Create new webhook**. Use
`https://api.rescova.de/webhooks/livekit` as the URL and select the same API
key configured as `LIVEKIT_API_KEY` for signing. After saving, use
**Actions → Send a test event**; the endpoint accepts only a valid LiveKit
signature. A single project webhook delivers the participant and room events
used by the call lifecycle.

### Agent worker

```bash
cp agent/.env.example agent/.env
cd agent
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python agent.py dev
```

### Email connectors

The email worker polls every connected account through one of two adapters:

- **Microsoft 365:** delegated Microsoft Graph OAuth with `User.Read`,
  `Mail.ReadWrite`, `Mail.Send`, and `offline_access`. `Mail.ReadWrite` is
  needed to prepare a durable reply draft before sending it.
- **Generic mailbox:** IMAP via IMAPFlow and SMTP via Nodemailer, using TLS and
  a mailbox password/app password.

Create a Microsoft Entra app registration for organisational accounts, add
the exact Web redirect URI
`https://app.rescova.de/admin/email/microsoft/callback`, create a client
secret, and grant the delegated permissions above. Configure
`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and
`MICROSOFT_REDIRECT_URI` in the shared server `.env`. A customer's tenant
admin may have to grant tenant consent when connecting the mailbox.

Generate `EMAIL_CREDENTIALS_KEY` once with `openssl rand -hex 32`. The API and
dashboard must use the same key; changing or losing it makes stored OAuth
tokens and mailbox passwords unreadable. Credentials are encrypted with
AES-256-GCM before they enter PostgreSQL. They are always tenant-scoped, and
OAuth state is one-time, session/user/tenant-bound, and expires after ten
minutes.

New mailboxes start in `draft_only` mode. The first IMAP sync establishes a
cursor and does not import the existing mailbox history. Graph begins at
connection time with a small overlap and database deduplication. Automated,
bulk, bounce, self-sent, and oversized IMAP messages are ignored. Attachments
are detected but neither stored nor processed in this first version.

Email automation is a paid tenant add-on. `customers.email_automation_enabled`
defaults to `FALSE`; the sidebar still shows the feature as a disabled add-on,
while backend routes, OAuth actions, and the worker all enforce the same flag.
The internal organisation containing the active `milan@rescova.de` admin is
enabled by migration. Additional customers must be enabled deliberately as
part of provisioning the service.

After running migrations, open **Einstellungen → E-Mail-Automatisierung** as a
tenant admin. Connect a test mailbox, send a new email to it, wait up to
`EMAIL_POLL_INTERVAL_MS`, edit the generated draft, and approve it. Check the
API logs with `journalctl -u rescova-api -f` if the account status changes to
`Fehler`.

### Dashboard

```bash
cd dashboard
npm install
npm run dev
```

The dashboard uses the shared root `DATABASE_URL`. In production it runs as a
standalone adapter-node process on `127.0.0.1:3001`.

### Marketing site

```bash
cp website/.env.example website/.env
cd website
npm install
npm run dev
```

`PUBLIC_API_BASE_URL` is embedded at Astro build time. Its origin must also be
present in the backend `ALLOWED_ORIGINS` list.

## Environment variables

The checked-in `.env.example`, `agent/.env.example`, and
`website/.env.example` are the starting templates. The table below also lists
supported optional values that use code defaults when omitted.

### Backend

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string shared with the dashboard |
| `PORT`, `BIND_HOST`, `NODE_ENV` | API listener and runtime mode |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit API, rooms, tokens, and signed webhooks |
| `LIVEKIT_SIP_TRUNK_ID`, `SIP_CALLER_ID` | Active outbound LiveKit trunk and Twilio-owned or verified E.164 caller ID; calls remain disabled until both are set |
| `SIP_TRUNK_SETUP_ID` | New Twilio LiveKit trunk ID used only by `scripts/setup-sip-trunk.js` for updates; keeping it separate prevents overwriting the active carrier during migration |
| `SIP_TRUNK_NAME`, `SIP_TRUNK_ADDRESS` | Direct LiveKit-to-Twilio route (`twilio-frankfurt`, `rescova-neu.pstn.frankfurt.twilio.com`) |
| `SIP_TRANSPORT`, `SIP_MEDIA_ENCRYPTION`, `SIP_DESTINATION_COUNTRY` | Twilio signaling/media security and LiveKit destination routing (`TLS`, `REQUIRE`, `DE`) |
| `SIP_AUTH_USERNAME`, `SIP_AUTH_PASSWORD` | Twilio Credential List authentication used only by `scripts/setup-sip-trunk.js` |
| `INTERNAL_TOOL_SECRET` | Shared loopback Tool Gateway secret |
| `CALL_TOKEN_TTL_MIN` | Per-call case-token lifetime |
| `END_CALL_GRACE_MS` | Delay before deleting the room after Evi's goodbye |
| `CAMPAIGN_SCHEDULER_ENABLED` | Set to `0` to disable the scheduler |
| `CAMPAIGN_SCHEDULER_POLL_MS` | Scheduler polling interval |
| `CALL_RECONCILE_INTERVAL_MS`, `CALL_RECONCILE_GRACE_MS` | Lost-webhook reconciliation cadence and absence grace period |
| `EMAIL_WORKER_ENABLED`, `EMAIL_POLL_INTERVAL_MS` | Email worker switch and mailbox polling interval |
| `EMAIL_CREDENTIALS_KEY` | Shared 32-byte AES-GCM key for encrypted mailbox credentials |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` | Microsoft Entra OAuth application and exact callback URI |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_REDIRECT_URI` | Dropsize Shopify OAuth app and exact callback URI |
| `SHOPIFY_CREDENTIALS_KEY` | Optional separate 32-byte AES-GCM key for Shopify tokens; defaults to `EMAIL_CREDENTIALS_KEY` |
| `OPENAI_API_KEY`, `OPENAI_EMAIL_MODEL` | OpenAI Responses API key and lightweight model for Dropsize email drafts (`gpt-5-mini` by default) |
| `PRICE_PER_MINUTE` | Internal voice usage cost calculation |
| `ALLOWED_ORIGINS` | Comma-separated public website CORS allow-list |
| `DEMO_CUSTOMER_ID`, `OUTBOUND_CALL_DEMO_AMOUNT_CENTS` | Public callback demo tenant and fictional amount |
| `OUTBOUND_CALL_*` | Public callback rate limits and comma-separated exempt test numbers |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Pilot-lead delivery |
| `PILOT_LEAD_*` | Public pilot-lead endpoint rate limits |

### Agent

The agent needs matching `LIVEKIT_*`, `DEEPSLATE_*`, `TOOL_GATEWAY_URL`, and
`INTERNAL_TOOL_SECRET` values. Evi's prompt, greeting, and hosted voice are
supplied only through server-generated case-room metadata. Rooms without a
case token or complete Evi metadata are rejected before a model session starts.

## Tests and verification

```bash
# Backend policy/configuration tests
npm test

# Svelte/TypeScript validation
npm run check --prefix dashboard

# Production dashboard build
npm run build --prefix dashboard

# Marketing site build
npm run build --prefix website
```

The backend test suite covers policy merging, call windows and next-window
calculation, frequency caps, suppression/eligibility, signal-gated offers,
discount ceilings, plan math, and configuration validation.

## Deployment

Every push to `main` triggers `.github/workflows/deploy.yml`:

1. Build the Astro marketing site with Node 22.
2. Rsync backend, dashboard source, migrations, agent code, and static assets
   to `/opt/rescova` while preserving server-managed secrets and data.
3. Install production backend dependencies.
4. Apply every SQL migration in filename order.
5. Install dashboard dependencies and build the adapter-node application.
6. Restart the API and dashboard systemd services.
7. Restart the agent only when files under `agent/` changed, avoiding needless
   interruption of active phone calls.
8. Validate and reload nginx, then health-check `app.rescova.de`.

GitHub deployment secrets are `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, and
`DEPLOY_USER`; Telegram credentials are synchronized separately. Python
dependencies are not installed by CI, so changes to `agent/requirements.txt`
still require a manual virtual-environment update on the server.

## Daily development log

`.github/workflows/daily-devlog.yml` runs every day at 23:55 in the
`Europe/Berlin` timezone. It collects that day's commit authors, messages, and
changed file paths, turns them into a short developer-journal entry, and
commits the result to `devlog/YYYY-MM-DD.md` as `rescova-devlog[bot]`.

Configure the repository secret `OPENAI_API_KEY` before enabling the workflow.
The optional repository variable `OPENAI_MODEL` overrides the default
`gpt-5-nano` model. The workflow uses the OpenAI Responses API directly and
does not install an SDK or any additional npm packages. GitHub Actions must
also have read/write workflow permission for repository contents; protected
branch rules must allow the GitHub Actions bot to push to `main`.

Useful production commands:

```bash
journalctl -u rescova-api -f
journalctl -u rescova-dashboard -f
journalctl -u rescova-agent -f
curl https://api.rescova.de/healthz
```

Set `DEEPSLATE_DIAG=1` in `agent/.env` for detailed audio/VAD diagnostics.
Agent VAD behavior can be tuned through `VAD_MIN_VOLUME`,
`VAD_CONFIDENCE_THRESHOLD`, `VAD_START_DURATION_MS`, and
`VAD_STOP_DURATION_MS`. `FULL_DUPLEX_BARGE_IN_ENABLED=1` lets sustained caller
speech interrupt Evi after `BARGE_IN_MIN_MS`; set it to `0` and restart the
agent to restore the previous half-duplex echo guard.

## Security properties

- Every dashboard and operational query is tenant-scoped.
- Tools authenticate with a short-lived token bound to one call attempt and
  one case; model-supplied case IDs are never trusted.
- The Tool Gateway requires both a raw loopback socket and a shared secret.
- Monetary values are stored as integer cents and recomputed server-side.
- Plan selection uses opaque, call-scoped option tokens with a 30-minute TTL.
- Payment plans require human approval before activation.
- Policy actions are deny-by-default for unknown case states or actions.
- Events form an append-only audit trail of allowed and denied tool actions.
- LiveKit webhook signatures are verified before call finalization or billing.
- The agent receives no case PII in room metadata; it fetches scoped data
  through the Tool Gateway after joining.
- Public website endpoints use explicit CORS allow-lists, bounded inputs, and
  in-memory rate limits.

## Known limitations and planned work

- **Identity verification is temporarily disabled.** The gateway route still
  exists, but the active agent does not expose or request it.
- **SMS and payment-link delivery are not implemented.** Evi cannot promise
  that a link or missed-call notification will be sent. Email ingestion and
  human-approved replies are available, but fully automatic AI sending is
  intentionally disabled until classification and policy evaluation are
  production-tested. Any future SMS
  implementation must include consent evidence, opt-out handling, real
  no-answer detection, delivery callbacks, idempotency, and cooldowns.
- **No automatic payment-provider reconciliation exists.** Payments are
  currently recorded manually in the campaign detail.
- **The scheduler is a single-process poller.** PostgreSQL locking makes job
  claiming safe, but throughput is currently one claimed job per poll tick.
- **Some safeguards are process-local.** Login and public-endpoint rate limits
  plus offered-plan token memory reset when the process restarts.
- **Campaign deletion may be blocked by an existing payment plan.** Payment
  plans intentionally retain their template reference; the UI does not yet
  provide an archival path for that case.
- **Messaging consent is not represented in the current debtor schema.** Do
  not activate automated SMS or email based only on an uploaded phone number
  or email address.

## Health endpoint

```http
GET /healthz
```

```json
{ "ok": true }
```

## Retired Deepslate reseller surface

The generic `/v1/*` REST proxy and public `/realtime` WebSocket proxy are
retired. Unknown `/v1` paths return `404`. The active Evi worker connects
directly to Deepslate with server-side credentials; explicit Rescova routes
such as `/v1/cases/:id/call`, `/v1/outbound-call`, and `/v1/pilot-lead` remain
available with their documented authentication and rate limits.
