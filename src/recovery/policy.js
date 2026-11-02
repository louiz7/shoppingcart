'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_RULES = Object.freeze({
    timezone: 'Europe/Berlin', weekdays: [1, 2, 3, 4, 5], start: '10:00', end: '18:00',
    delayMinutes: 60, maxAttempts: 2, cooldownHours: 24, expiryDays: 7,
    holdoutPercent: 20, maxDiscountPercent: 10, minSubtotalCents: 5000,
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
        ['expiryDays', 1, 14], ['holdoutPercent', 10, 50], ['maxDiscountPercent', 0, 30],
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
        if (attempts.length >= p.maxAttempts) return 'attempt_limit';
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

// Conservative transcript proof: a generic SMS request is never discount agreement.
function discountAgreement(turns, offer) {
    let prompt = '', accepted = null;
    const discount = /\b(rabatt|rabattcode|discount|code)\b/i;
    const negative = /\b(nein|nicht|kein\w*|ohne|später|vielleicht|aber|wenn|statt|regulär|no|not|without|later|maybe|never|but|if|instead|full price|don['’]?t)\b/i;
    const affirmative = /^\s*(ja|yes|sure|okay|ok|klar|gerne|einverstanden|agreed|abgemacht|sounds good)\b/i;
    const agreementQuestion = /einverstanden|akzeptier|annehmen|nutzen|\bagree\b|\baccept\b|\buse\b/i;
    const percentages = (text) => [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:%|prozent|percent)/gi)]
        .map((match) => Number(match[1].replace(',', '.')));
    const quoted = (text) => discount.test(text) && percentages(text).length === 1 &&
        percentages(text)[0] === offer.percent && agreementQuestion.test(text) &&
        !/\b(oder|or)\b/i.test(text) && !negative.test(text);
    const words = Object.fromEntries([
        'null|eins|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|dreizehn|vierzehn|fünfzehn|sechzehn|siebzehn|achtzehn|neunzehn|zwanzig|einundzwanzig|zweiundzwanzig|dreiundzwanzig|vierundzwanzig|fünfundzwanzig|sechsundzwanzig|siebenundzwanzig|achtundzwanzig|neunundzwanzig|dreißig',
        'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty one|twenty two|twenty three|twenty four|twenty five|twenty six|twenty seven|twenty eight|twenty nine|thirty',
    ].flatMap((language) => language.split('|').map((word, value) => [word,value])));
    const numberWords = new RegExp(`\\b(${Object.keys(words).sort((a,b) => b.length-a.length).join('|')})\\b`, 'gi');
    for (const turn of turns) {
        const text = String(turn.data?.text || '').replaceAll('-', ' ').replace(numberWords, (word) => String(words[word.toLowerCase()]));
        if (turn.kind === 'assistant_transcript') {
            if (discount.test(text) && agreementQuestion.test(text)) accepted = null;
            prompt = text;
            continue;
        }
        if (negative.test(text)) accepted = null;
        else if (affirmative.test(text) && quoted(prompt) &&
            percentages(text).every((value) => value === offer.percent)) accepted = turn.data.eventId;
        prompt = '';
    }
    return accepted;
}

function cartHash(snapshot) {
    return createHash('sha256').update(JSON.stringify({ currency: snapshot.currency, subtotalCents: snapshot.subtotalCents,
        discountCodes: snapshot.discountCodes, items: snapshot.items?.map((i) => [i.variantId, i.quantity,
            i.originalUnitCents, i.currentPriceCents, i.available]) })).digest('hex');
}

function conversationPermission(text, prompt) {
    const answer = String(text || '').toLowerCase().replace(/\u2019/g,"'");
    const timing = /(?:\bpasst (?:es|das) (?:gerade|kurz)\b|\bis (?:now|this) (?:a )?good time\b)/i.test(String(prompt));
    const help = /(?:\bfrage\b.*\bprodukten\b.*\bhelfen\b|\bproduct question\b.*\bhelp\b)/i.test(String(prompt));
    const affirmative = /^\s*(ja|yes|sure|okay|ok|klar|gerne|natürlich|of course|go ahead|passt|es passt|das passt)\b/i.test(answer);
    const productQuestion = /^\s*(was|wie|wann|wo|welch\w*|kann|könn\w*|ist|sind|hat|haben|gibt|kostet|what|how|when|where|which|can|could|is|are|does|do)\b/i.test(answer) &&
        /\b(produkt\w*|artikel|größe\w*|groesse\w*|preis\w*|kostet|rabatt\w*|versand\w*|liefer\w*|material\w*|farbe\w*|passform|retour\w*|rückgabe|hoodie|shirt|product\w*|item\w*|size\w*|price\w*|cost\w*|shipping|delivery|return\w*|discount\w*|fit|colou?r\w*|available|stock|waterproof)\b|wie fällt .*aus|how much/i.test(answer);
    return (timing || help) && (affirmative || (help && productQuestion)) &&
        !/\b(nein|nicht|kein|keine|falsch|später|mailbox|no|not|never|wrong|later|busy|voicemail|don'?t|can'?t)\b/i.test(answer) && !stopSignal(answer);
}

function explicitSmsRequest(text) {
    const normalized = String(text || '').toLowerCase().replace(/\u2019/g,"'").replace(/[.!?,]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/\b(nein|nicht|kein|keine|stop|widerruf|no|not|never|without|cannot|refuse|decline|cancel|don'?t|didn'?t|can'?t|won'?t|wouldn'?t|shouldn'?t|couldn'?t|haven'?t|hasn'?t|isn'?t|wasn'?t|aren'?t|weren'?t)\b/.test(normalized)) return false;
    return /\b(schick|schicke|sende|send|senden|text)\b.*\b(link|sms)\b/.test(normalized) ||
        /\b(ja|bitte|yes|please)\b.*\b(link|sms)\b/.test(normalized);
}

function stopSignal(text) {
    return /^\s*(nein|no)[\s.!?,]*$/i.test(String(text)) || /\b(kein interesse|nicht interessiert|nicht mehr anrufen|nicht anrufen|keine anrufe|falsche nummer|falsche person|kontaktverbot|widerrufe|stop|nein danke|not interested|no thanks|no thank you|do not (call|contact)|don['\u2019]?t (call|contact)|stop (calling|contacting)|wrong (number|person)|remove (me|my number)|revoke (my )?consent|withdraw (my )?consent)\b/i.test(String(text));
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
    eligibility, offer, checkoutUrl, cartHash, discountAgreement, conversationPermission, explicitSmsRequest, stopSignal, experimentReport };
