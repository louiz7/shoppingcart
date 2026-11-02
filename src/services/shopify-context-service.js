'use strict';

const db = require('../db');
const { decryptShopifyCredentials } = require('./shopify-crypto');

const API_VERSION = '2026-07';
const QUERY = `query EmailCustomerContext($query: String!) {
  customers(first: 3, query: $query) {
    nodes {
      id displayName email tags note numberOfOrders
      orders(first: 10, reverse: true, sortKey: PROCESSED_AT) {
        nodes {
          id name createdAt processedAt cancelledAt
          displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 20) { nodes { name quantity sku } }
          fulfillments {
            status displayStatus createdAt updatedAt deliveredAt inTransitAt estimatedDeliveryAt
            trackingInfo { company number url }
            events(first: 10, reverse: true) {
              nodes { status happenedAt estimatedDeliveryAt message }
            }
          }
          refunds { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
        }
      }
    }
  }
}`;

const ORDER_QUERY = `query EmailOrderContext($query: String!) {
  orders(first: 10, query: $query) {
    nodes {
      id name email createdAt processedAt cancelledAt
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 20) { nodes { name quantity sku } }
      fulfillments {
        status displayStatus createdAt updatedAt deliveredAt inTransitAt estimatedDeliveryAt
        trackingInfo { company number url }
        events(first: 10, reverse: true) {
          nodes { status happenedAt estimatedDeliveryAt message }
        }
      }
      refunds { id createdAt totalRefundedSet { shopMoney { amount currencyCode } } }
      customer { id displayName email tags note numberOfOrders }
    }
  }
}`;

function exactEmailQuery(email) {
    return `email:"${String(email).replace(/["\\]/g, '')}"`;
}

function orderNameQuery(references) {
    return references.map((reference) => `name:${reference}`).join(' OR ');
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function customerSummary(customer) {
    if (!customer) return null;
    return {
        id: customer.id, display_name: customer.displayName, email: customer.email,
        tags: customer.tags || [], note: customer.note || null, number_of_orders: customer.numberOfOrders,
    };
}

function orderReferences(subject, body) {
    const text = `${subject || ''}\n${body || ''}`;
    return [...new Set([...text.matchAll(/(?:#|bestell(?:ung|nummer)?\s*[:#-]?\s*)([a-z0-9-]{3,32})/gi)]
        .map((match) => match[1].toLowerCase()))].slice(0, 10);
}

function selectOrder(orders, references) {
    if (!orders.length) return { order: null, match: 'no_orders' };
    if (references.length) {
        const matches = orders.filter((order) => references.includes(String(order.name || '').replace(/^#/, '').toLowerCase()));
        if (matches.length === 1) return { order: matches[0], match: 'reference' };
        if (matches.length > 1) return { order: null, match: 'ambiguous_order' };
        return { order: null, match: 'reference_not_found' };
    }
    return orders.length === 1 ? { order: orders[0], match: 'only_order' } : { order: orders[0], match: 'most_recent' };
}

async function loadShopifyContext(customerId, message) {
    const { rows } = await db.query(
        `SELECT sc.shop_domain, sc.credentials_encrypted
           FROM shopify_connections sc
           JOIN customers c ON c.id = sc.customer_id
          WHERE sc.customer_id = $1 AND sc.status = 'connected'
            AND LOWER(TRIM(c.name)) = 'dropsize' AND c.is_active`,
        [customerId],
    );
    if (!rows[0]) return null;
    const credentials = decryptShopifyCredentials(rows[0].credentials_encrypted);
    const endpoint = `https://${rows[0].shop_domain}/admin/api/${API_VERSION}/graphql.json`;
    const shopifyRequest = async (query, variables) => {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': credentials.access_token },
            body: JSON.stringify({ query, variables }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`shopify_context_http_${response.status}`);
        const payload = await response.json();
        if (payload.errors?.length) throw new Error(`shopify_context_graphql_${payload.errors[0].message || 'error'}`);
        return payload.data;
    };
    const references = orderReferences(message.subject, message.body_text);
    if (references.length) {
        const data = await shopifyRequest(ORDER_QUERY, { query: orderNameQuery(references) });
        const directSelection = selectOrder(data?.orders?.nodes || [], references);
        if (directSelection.order) {
            const order = directSelection.order;
            const sender = normalizeEmail(message.from_address);
            const orderEmails = [order.email, order.customer?.email].map(normalizeEmail).filter(Boolean);
            if (orderEmails.includes(sender)) {
                const { customer, ...safeOrder } = order;
                return {
                    version: 1, fetched_at: new Date().toISOString(), shop_domain: rows[0].shop_domain,
                    match_status: 'matched', order_match: 'reference_and_email', references,
                    customer: customerSummary(customer), order: safeOrder,
                };
            }
            return {
                version: 1, fetched_at: new Date().toISOString(), shop_domain: rows[0].shop_domain,
                match_status: 'order_found_identity_mismatch', order_match: 'reference', references,
            };
        }
    }
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': credentials.access_token },
        body: JSON.stringify({ query: QUERY, variables: { query: exactEmailQuery(message.from_address) } }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`shopify_context_http_${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`shopify_context_graphql_${payload.errors[0].message || 'error'}`);
    const customers = payload.data?.customers?.nodes || [];
    if (customers.length !== 1) {
        return { version: 1, fetched_at: new Date().toISOString(), shop_domain: rows[0].shop_domain,
            match_status: customers.length ? 'ambiguous_customer' : 'unmatched_customer' };
    }
    const customer = customers[0];
    const selection = selectOrder(customer.orders?.nodes || [], references);
    return {
        version: 1,
        fetched_at: new Date().toISOString(),
        shop_domain: rows[0].shop_domain,
        match_status: selection.order ? 'matched' : selection.match,
        order_match: selection.match,
        references,
        customer: customerSummary(customer),
        order: selection.order || null,
    };
}

function contextualDraft(context) {
    if (!context || context.match_status !== 'matched' || !context.order) return null;
    const order = context.order;
    const financial = {
        PAID: 'bezahlt', PENDING: 'noch ausstehend', REFUNDED: 'erstattet',
        PARTIALLY_REFUNDED: 'teilweise erstattet', VOIDED: 'storniert',
    }[order.displayFinancialStatus] || String(order.displayFinancialStatus || 'unbekannt').toLowerCase();
    const fulfillment = {
        FULFILLED: 'vollständig versendet', PARTIALLY_FULFILLED: 'teilweise versendet',
        UNFULFILLED: 'noch nicht versendet', RESTOCKED: 'zurückgebucht',
    }[order.displayFulfillmentStatus] || String(order.displayFulfillmentStatus || 'unbekannt').toLowerCase();
    const tracking = (order.fulfillments || []).flatMap((item) => item.trackingInfo || [])
        .find((item) => item.number || item.url);
    const trackingSentence = tracking
        ? ` Die Sendungsverfolgung lautet${tracking.company ? ` bei ${tracking.company}` : ''}: ${tracking.url || tracking.number}.`
        : '';
    return `Vielen Dank für Ihre Nachricht zu Ihrer Bestellung ${order.name}. Laut unserem aktuellen Stand ist die Zahlung ${financial} und die Bestellung ${fulfillment}.${trackingSentence}`;
}

module.exports = { loadShopifyContext, contextualDraft, orderReferences, orderNameQuery, selectOrder };
