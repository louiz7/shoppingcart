# Merchant terms

`src/recovery/terms-document.json` is the single document for the public `/terms` page and the acceptance record. Update its version whenever changing its text. The SHA-256 is calculated over `JSON.stringify(document)` on both servers. Existing acceptances do not silently apply to edited text.

Dashboard acceptance requires an active admin in the current active organization, an explicit checked box and the current version/hash. The backend stores the document text, hash, actor snapshot and timestamp. Repeated submissions retain the first record. Footer links alone do not record acceptance.

Live activation and call/SMS eligibility require a current acceptance. Simulation is unaffected; individual contact permission, opt-outs, merchant approval and live flags still apply independently. Disabling a shop remains possible without acceptance. No migration backfills acceptance for existing shops.

An operator may record a merchant's acceptance obtained outside the dashboard through a controlled database operation using `source='external'`, `accepted_by=NULL` and a factual `evidence` note identifying who reported it and how. `accepted_at` then represents recording time, not a fabricated signature date. The dashboard labels this distinction explicitly. Never impersonate a merchant user or create an online acceptance on their behalf. The owner reported Deskspace's existing acceptance in the project chat on 2026-11-03 and explicitly requested no repeat confirmation.

These terms allocate merchant responsibilities and fault-based indemnity while retaining mandatory Rescova obligations. They do not replace the individual commercial contract, an applicable data-processing agreement, end-customer permission, or legal review. Legal enforceability has not been professionally reviewed.
