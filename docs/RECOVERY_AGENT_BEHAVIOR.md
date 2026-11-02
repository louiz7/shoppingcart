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

API and worker must be released together: older workers do not send `userEventId` and fail closed on contact confirmation/SMS. Production releases use GitHub Actions. A telephone acceptance test verifies audible delivery, interruptions, live tool round trips, SMS receipt and actual checkout discount behavior.

## Owner test and latency follow-up, 2026-11-02

The owner test completed on the test shop: connected call, grounded product/price lookup, approved discount, one SMS with the correct discount parameter, signed delivery receipt, and confirmed room cleanup. In a fresh browser the test shop's visitor password intercepted the link. After entering it and reopening the original link, checkout displayed the code and merchandise reduced from USD 749.95 to USD 674.96. No payment was submitted. Temporary contact services were stopped and the original shop/contact settings restored.

Measured API durations: contact confirmation 13 ms, context 687 ms, offer 591 ms, SMS 1,200 ms. All seven tool samples: p50 465 ms, p95 1,046 ms. The SDK's 13 user-end-to-speech-start samples had p50 2,232 ms and p95 9,975 ms. These measure any speech onset, including acknowledgments; they are not time to a complete substantive answer. Historical logs cannot isolate backend-model reasoning time from voice-model scheduling.

The follow-up removes the routine acknowledgment stage from the conversational guidance and makes delegation conditional on missing/currently changed facts or a new action. `confirm_contact` now returns the refreshed cart in the same model tool invocation, eliminating one model round trip. Existing backend authorization and fresh action checks remain intact. Offers should be brief, without reading codes/URLs; both models receive the current UTC time to avoid the incorrect relative expiry year heard during the test.

`tool_result_to_speech_latency` now measures from the worker's completed fact/action tool to the next SDK speech-start event and records the tool name separately from HTTP tool latency. It drops samples when the customer starts speaking, can include acknowledgments, and is not an independent measurement of semantic answer completion. A lower-reasoning experiment passed all 14 semantic cases but showed no reliable latency benefit in the small sample; production keeps provider-default reasoning with concise backend output. No second telephone test has yet validated the follow-up's audible pacing.

Guidance applied: [OpenAI Live prompting](https://developers.openai.com/api/docs/guides/live-prompting), [LiveKit state and effects](https://github.com/livekit/agent-skills/blob/main/skills/building-livekit-agents/references/state-and-effects.md), and [Handle Objection](https://github.com/anthropics/knowledge-work-plugins/blob/main/sales/skills/handle-objection/SKILL.md). Existing customer claims must remain grounded in that shop's data.
