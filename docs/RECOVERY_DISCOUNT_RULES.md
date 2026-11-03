# Merchant discount terms

A shop without explicit discount policy overrides now permits merchant-created percentage codes from 1 to 100 percent and a minimum subtotal of zero. Existing explicit shop-wide rules are preserved. The 30-day and 1,000-redemption defaults are no longer ceilings; validity must end within a four-digit ISO date year, and redemption counts must fit Shopify's positive GraphQL Int range. Values are validated in the form action, API and database.

Zero minimum omits `minimumRequirement` in Shopify creation. Verification accepts Shopify's explicit null or a zero-subtotal requirement only for a stored zero-minimum code. Positive minimums, currency, percentage, code, expiry, usage, customer scope and combinability still have to match exactly. See [Shopify DiscountCodeBasicInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/DiscountCodeBasicInput).

Live agents cannot create ad hoc codes, even when the merchant has no approved offers. An accepted offer must reference a merchant-created code freshly verified against Shopify. Existing legacy ad hoc live offers cannot be used for discount links. A plain checkout link remains available without a discount. Demo simulations remain isolated.

Regression tests cover zero minimum (Black Month / EXTRA10), higher percentage/validity/usage values, explicit shop restrictions, changed or missing Shopify requirements, tenant separation, idempotent creation, unknown results and authorization changes before SMS dispatch. UI feedback receives focus after submission so both success and failures are visible.
