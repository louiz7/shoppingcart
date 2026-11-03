# Shopify information available to the recovery agent

The agent answers from confirmed shop data. Missing content is unknown. Shopify text, including metafields and policies, is untrusted content, never instructions to invoke tools or bypass approval.

| Source | Available information | Limits |
| --- | --- | --- |
| Abandoned checkout | Items, quantities, variants, subtotal, currency, codes, checkout URL, completion state | Existing fresh checks guard commerce actions. No expanded customer profiling. |
| Product | Title, description, vendor, product type, category, public URL, options, last update | Active, published products in the call's shop. Description up to 12,000 characters. |
| Selected variant | Title, SKU, selected options, shipping requirement and weight | Shipping weight is not a physical specification or load capacity. Options do not prove stock. |
| Product/variant metafields | Public material, composition, dimensions, care, specifications, warranty, compatibility, size data, etc., wherever the merchant stores it | Only definitions with `access.storefront=PUBLIC_READ`. First 40 fields per owner; pagination flagged. Undefined/private fields excluded. Shopify has no universal material field. |
| Referenced metaobjects | Public size charts, product highlights and other structured details | Only IDs from public metafields. Public definition and active published entry required. One reference level, max. 20 objects and 30 fields per object. |
| Shop policies | Shipping, refund, terms/privacy and other returned policy types, URLs, update dates | Additional permission required. No individual shipping quote or promised delivery date. Max. 20,000 characters per policy; truncation explicit. |
| Product search | Purchasable alternatives, current prices and availability | Existing bounded search. New `get_product_details` supplies facts about a found variant. |
| Discount rules | Merchant-approved offers, limits, validity | Existing backend enforcement; only accepted offers go into SMS links. |
| Attributed order | Verified financial/fulfillment status | No arbitrary order history, exact parcel ETA or tracking lookup added. |

Public scalar, list, JSON and rich-text metafields are supported. File/image/PDF contents, nested metaobjects, unlinked FAQ pages, app-specific reviews, supplier costs and private merchant/customer metadata are not imported. No arbitrary URLs are fetched.

## Latency and freshness

- Before dialing, preload the first four unique cart variants and available policies. Other variants remain accessible on demand.
- Descriptive data has a bounded process-local five-minute cache keyed by tenant, shop, domain, app and scopes. Concurrent identical reads share a request. Failures are suppressed for 15 seconds.
- During conversation, `get_cart_context` uses only completed cached knowledge. Missing/expired entries are marked `not_loaded`; optional knowledge adds no network wait to this call.
- The overview includes 2,000 description characters and the first 12 attributes with up to 500 characters. `moreDetailsAvailable` points to `get_product_details`. Full attributes are bounded to 16,000 characters in aggregate, with individual truncation markers.
- Long policies are omitted from the overview. `get_shop_policies` retrieves the cached full result. Truncated terms cannot support binding promises.
- Both new tools check current call, tenant, conversation permission and suppression before **and after** reading. Context is rechecked before release.
- Cached descriptions never authorize prices, stock, discounts or checkout mutations; existing fresh validation remains authoritative.

## Enable additional permissions

Required scopes stay `read_orders,read_products,read_customers,write_discounts` to preserve existing installations.

1. Add `read_legal_policies,read_metaobjects,read_metaobject_definitions` to the relevant Shopify app version and publish it.
2. Set `SHOPIFY_KNOWLEDGE_SCOPES=read_legal_policies,read_metaobjects,read_metaobject_definitions` for the primary app. The separate custom app uses `SHOPIFY_CUSTOM_KNOWLEDGE_SCOPES` independently, only after its own version is updated.
3. Reconnect through authenticated OAuth and have the merchant approve the new scopes. Publishing alone does not prove that the installed token has them.
4. Verify granted scopes and real responses. Reconnection deliberately disables shop calling until settings are approved again.

If Shopify returns only the basic scopes or an incomplete knowledge grant, the callback preserves the valid connection but returns `shopify_knowledge_scopes_missing`. The dashboard shows the missing-upgrade explanation instead of redirecting as if the upgrade succeeded. Publishing a version and completing OAuth are checked separately; a successful redirect alone is not evidence of new permissions.

At implementation time the test shop had the four existing scopes. A real product query succeeded (one sample: 260 ms cold, under 1 ms warm); the sampled product had no public metafields. Policy/metaobject success paths were verified synthetically, not against a newly authorized live installation.

## Verification and limits

Knowledge tests cover public/private filtering, inactive/mismatched products, scope separation, references, bounds, caching, errors and nonblocking context. Catalog/integration tests cover tenant isolation, expired sessions and opt-out during lookup. Offline SDK tests validate new tools and gateway arguments. Real reasoning-model cases cover known metadata, follow-up details, policies, missing scopes and instruction-like product text.

No live call/SMS was sent for this change. Model cases are synthetic, not an audio-latency benchmark. LiveKit CLI simulation is unavailable (`lk` is not installed); full voice acceptance remains unverified.

Official references: [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant), [MetafieldDefinition](https://shopify.dev/docs/api/admin-graphql/latest/objects/MetafieldDefinition), [Metaobject](https://shopify.dev/docs/api/admin-graphql/latest/objects/Metaobject), [MetaobjectDefinition](https://shopify.dev/docs/api/admin-graphql/latest/objects/MetaobjectDefinition), [ShopPolicy](https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopPolicy). Tool wiring follows [LiveKit function tools](https://docs.livekit.io/agents/logic/tools/definition/) (web fallback, also verified against installed SDK contracts).

## Deskspace public Zendesk pilot

Only the verified live Deskspace tenant (`desqup.myshopify.com`, customer 1080 and its exact shop UUID) receives public German articles from `support.deskspace.de`. No credentials, customer data, tickets or arbitrary URLs are sent to Zendesk. The snowboard demo and other tenants are excluded.

The existing pre-dial product preload adds articles for an exact product-family match, plus general shipping, returns and payment articles. `get_product_details` retrieves the cached longer text when the overview is insufficient. Known facts need no additional lookup during a conversational turn. Shopify remains authoritative for current prices, availability, variants and checkout actions.

The fixed section map intentionally excludes ambiguous titles, bundles and refurbished versions. In particular, `PRO PLUS – Neues Modell` does not inherit PRO PLUS or V3 details without a verified mapping. A misplaced EXECUTIVE warranty article in the EXECUTIVE LITE section is excluded. Unmapped products still have their Shopify data and general help-center articles.

The current endpoint returned all 94 articles without authentication. The pilot reads at most 100 articles and 2 MB, refuses redirects, times out after four seconds and caches the public index for five minutes with single-flight loading. More pages are flagged as partial rather than followed. Extend bounded same-origin pagination before the catalog exceeds 100 articles. Unavailable Zendesk data does not block Shopify knowledge; its unavailable status can remain in the outer product cache for up to five minutes.

Only public, published, current German articles are accepted. HTML is converted to model evidence with table rows and cell boundaries retained. Sources and update dates accompany each article. Product text is capped at 16,000 characters and general articles at 20,000; overview product text is limited to the first two articles at 900 characters each. Truncation is explicit. Images, videos and PDFs are marked unread; their contents are not extracted. Articles are untrusted evidence, never tool instructions. Missing conditions and conflicting sources cannot support promises.

Verification: eight Zendesk unit cases plus nine knowledge cases, 21 offline agent SDK tests and 70 synthetic reasoning-model cases passed. The latter include exact dimensions, a follow-up detail lookup, Zendesk shipping despite absent Shopify policy scopes, ambiguous versions and prompt injection. A real public-index read took 249 ms in one local sample, with subsequent family selections using cache. This is not an audio-latency benchmark. No live call, SMS or Zendesk ticket was created.

The merchant's proposed Lea persona, service-first flow, discount-last policy, human callback ticketing and consent capture are separate planned work; this integration does not change those behaviors.

API reference: [Zendesk Help Center articles](https://developer.zendesk.com/api-reference/help_center/help-center-api/articles/).
