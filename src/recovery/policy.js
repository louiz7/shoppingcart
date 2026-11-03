'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_RULES = Object.freeze({
    timezone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5], start: '10:00', end: '18:00',
    delayMinutes: 60, maxAttempts: 2, cooldownHours: 24, expiryDays: 7,
    holdoutPercent: 20, maxDiscountPercent: 100, minSubtotalCents: 0,
    offerHours: 24, contributionPercent: 40, voiceCentsPerMinute: 20,
});

function problem(code, status = 400) {
    return Object.assign(new Error(code), { code, status });
}

function rules(value = {}) {
    const result = { ...DEFAULT_RULES, ...value };
    if (Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_RULES, key))) throw problem('unknown_rule');
    for (const [key, min, max] of [
        ['delayMinutes', 30, 1440], ['maxAttempts', 1, 3], ['cooldownHours', 24, 168],
        ['expiryDays', 1, 14], ['holdoutPercent', 10, 50], ['maxDiscountPercent', 0, 100],
        ['minSubtotalCents', 0, 10000000], ['offerHours', 1, 72],
        ['contributionPercent', 0, 100], ['voiceCentsPerMinute', 0, 10000],
    ]) {
        if (!Number.isSafeInteger(result[key]) || result[key] < min || result[key] > max) {
            throw problem(`invalid_${key}`);
        }
    }
    try { new Intl.DateTimeFormat('en', { timeZone: result.timezone }); }
    catch { throw problem('invalid_timezone'); }
    if (!Array.isArray(result.weekdays) || !result.weekdays.length ||
        result.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw problem('invalid_weekdays');
    if (![result.start, result.end].every((v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) ||
        result.start >= result.end) throw problem('invalid_call_window');
    return result;
}

function cents(value) {
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(value))) throw problem('invalid_money');
    const [whole, fraction = ''] = String(value).split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (result > 2147483647) throw problem('money_out_of_range');
    return result;
}

function phone(value) {
    if (typeof value !== 'string') throw problem('invalid_phone');
    const normalized = value.trim().replace(/[\s()\-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw problem('invalid_phone');
    return normalized;
}

function contactKey(shopId, number) {
    return createHash('sha256').update(`${shopId}:${phone(number)}`).digest('hex');
}

function assignment(shopId, key, percent) {
    const bucket = createHash('sha256').update(`recovery-v1:${shopId}:${key}`).digest().readUInt32BE(0) % 100;
    return bucket < percent ? 'control' : 'treatment';
}

function inWindow(policy, timezone, now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]));
    const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
    const time = `${parts.hour}:${parts.minute}`;
    return policy.weekdays.includes(day) && time >= policy.start && time < policy.end;
}

function eligibility({ shop, checkout, contact, attempts = [], active = false }, now = new Date(), action = 'call', ownerTest = false) {
    const p = rules(shop.rules);
    if (!shop.enabled || !shop.approved_at) return 'merchant_not_approved';
    if (checkout.completed_at || checkout.status === 'converted') return 'already_purchased';
    if (['stopped', 'expired'].includes(checkout.status) || contact?.stopped_at) return 'contact_stopped';
    if (!contact?.consented_at || !contact.evidence || contact.revoked_at || !contact.expires_at ||
        !Number.isFinite(+new Date(contact.expires_at)) || new Date(contact.expires_at) <= now) return 'consent_missing';
    if (!checkout.phone || checkout.phone !== contact.phone) return 'consent_phone_mismatch';
    if (!contact.consent_checkout_id || contact.consent_checkout_id !== checkout.id) return 'consent_checkout_mismatch';
    if (!['EUR','USD'].includes(checkout.currency) || checkout.currency !== (shop.currency || 'EUR')) return 'unsupported_currency';
    if (ownerTest!==true && new Date(checkout.source_updated_at) > new Date(now - p.delayMinutes * 60000)) return 'abandonment_delay';
    if (new Date(checkout.source_updated_at) < new Date(now - p.expiryDays * 86400000)) return 'checkout_expired';
    if (checkout.arm === 'control' || contact.arm === 'control') return 'control_group';
    if (action === 'call') {
        if (ownerTest!==true && !inWindow(p, contact.timezone, now)) return 'outside_call_window';
        if (active) return 'contact_busy';
        // Only service-authorized owner tests exclude prior owner tests; ordinary customer calls count every attempt.
        if (attempts.filter(a => !(ownerTest === true && a.is_test === true)).length >= p.maxAttempts) return 'attempt_limit';
        // Explicitly authorized owner retests may follow a prior owner test; customer cooldowns still apply.
        if (attempts.some((a) => !(ownerTest===true && a.is_test===true) &&
            new Date(a.created_at) > new Date(now - p.cooldownHours * 3600000))) return 'contact_cooldown';
    }
    return null;
}

function offer(policy, subtotalCents, requestedPercent) {
    const p = rules(policy);
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 || !Number.isInteger(requestedPercent) ||
        requestedPercent < 0 || requestedPercent > p.maxDiscountPercent) throw problem('discount_denied', 409);
    if (requestedPercent && subtotalCents < p.minSubtotalCents) throw problem('minimum_subtotal', 409);
    const discountCents = Math.floor(subtotalCents * requestedPercent / 100);
    return { percent: requestedPercent, subtotalCents, discountCents, merchandiseTotalCents: subtotalCents - discountCents,
        shipping: 'confirmed_at_checkout', taxes: 'confirmed_at_checkout' };
}

function checkoutUrl(value, shop, code) {
    let url;
    try { url = new URL(value); } catch { throw problem('invalid_checkout_url'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        ![shop.domain, shop.storefront_domain].filter(Boolean).includes(url.hostname)) throw problem('invalid_checkout_host');
    if (code) url.searchParams.set('discount', code);
    return url.href;
}

function cartHash(snapshot) {
    return createHash('sha256').update(JSON.stringify({ currency: snapshot.currency, subtotalCents: snapshot.subtotalCents,
        discountCodes: snapshot.discountCodes, items: snapshot.items?.map((i) => [i.variantId, i.quantity,
            i.originalUnitCents, i.currentPriceCents, i.available]) })).digest('hex');
}

function experimentReport(rows, costsCents = 0) {
    const groups = ['treatment', 'control'].map((arm) => {
        const cohort = rows.filter((r) => r.arm === arm);
        return { arm, contacts: cohort.length, conversions: cohort.filter((r) => r.purchased).length,
            netContributionCents: cohort.reduce((sum, r) => sum + Number(r.contribution_cents || 0), 0) };
    });
    const [t, c] = groups;
    return { groups, costsCents, incrementalContributionCents: t.contacts && c.contacts
        ? Math.round(t.netContributionCents - c.netContributionCents / c.contacts * t.contacts - costsCents) : null,
    note: 'Intention-to-treat; nur ausgereifte 7-Tage-Kohorten. Deckungsbeitrag ist eine Schätzung nach Händlerquote, keine Kausalitäts- oder Signifikanzzusage.' };
}

module.exports = { DEFAULT_RULES, problem, rules, cents, phone, contactKey, assignment, inWindow,
    eligibility, offer, checkoutUrl, cartHash, experimentReport };
