# Recovery conversation and tool boundaries

GPT Live and its existing reasoning model interpret conversation intent. There are no runtime keyword lists, fixed acceptance phrases, or additional consent-classifier model calls. The voice prompt provides flexible guidance for objections, listening, interruptions and delegation. The founder persona remains disclosed as AI working for the founding team.

The reasoning agent selects `confirm_contact`, `send_checkout_link(use_discount=...)` and `stop_contact`. A scoped refusal (for example, declining a discount) does not automatically stop all contact. An actual contact stop must invoke `stop_contact` immediately. Discount creation alone never means acceptance; sending defaults to a plain link with the discount parameter removed.

The worker serializes committed LiveKit conversation messages and binds gated tool requests to the current user event. Event IDs are injected by the worker, never supplied by the model. The service checks call/shop ownership, recency, latest-user-event identity, active contact permission, current cart and approved offer, and rechecks authorization before provider dispatch. A discounted send also requires a non-interrupted assistant message after offer creation and before the user's response. The model interprets what those messages mean; these structural checks do not independently prove semantic agreement or that audio reached the listener.

Missing transcript evidence, interrupted responses and changes during a pending action fail closed. Stop and hangup remain available even when transcript persistence fails. Transcript ingestion itself does not classify intent. Unknown provider outcomes remain durable and are not retried. Only delivery receipts establish SMS delivery, and only verified Shopify orders establish purchases.

Product answers use freshly loaded Shopify cart/product data. Empty descriptions and unavailable shipping/return facts remain unknown; the agent may refer to the verified shop support address. There is no invented FAQ or claim of historical objection-handling success. Shopify legal-policy ingestion would require the additional `read_legal_policies` permission and is not enabled by this change.

## Verification

- Backend regressions: `RECOVERY_DB_TEST=1 node --test test/recovery-{policy,integration,sms-flow,discounts}.test.js` against the isolated local database.
- Offline SDK contracts: recovery virtualenv `python -m unittest discover -s agent -p test_recovery.py`.
- Opt-in semantic evaluation: recovery virtualenv `python agent/evaluate_recovery.py`. Uses synthetic DE/EN dialogs, the deployed reasoning instructions and SDK-generated tool schemas. Calls OpenAI only; never executes business tools, dials or sends SMS. Model usage is billable. Not a voice/acoustic or complete E2E test.

API and worker must be released together: older workers do not send `userEventId` and fail closed on contact confirmation/SMS. Production releases use GitHub Actions. The owner call still needs to verify audible delivery, interruptions, live tool round trips, SMS receipt and actual checkout discount behavior.

Guidance applied: [OpenAI Live prompting](https://developers.openai.com/api/docs/guides/live-prompting), [LiveKit state and effects](https://github.com/livekit/agent-skills/blob/main/skills/building-livekit-agents/references/state-and-effects.md), and [Handle Objection](https://github.com/anthropics/knowledge-work-plugins/blob/main/sales/skills/handle-objection/SKILL.md). Existing customer claims must remain grounded in that shop's data.
