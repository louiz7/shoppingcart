'use strict';

const db = require('../../db');
const { encryptCredentials, decryptCredentials } = require('../email-crypto');
const { normalizeAddress, plainText, boundedHeader } = require('../email-utils');

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const TOKEN_ROOT = 'https://login.microsoftonline.com';
const REQUEST_TIMEOUT_MS = 30_000;

async function graphFetch(path, accessToken, options = {}) {
    const response = await fetch(path.startsWith('https://') ? path : `${GRAPH_ROOT}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            Prefer: 'IdType="ImmutableId"',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        const error = new Error(`microsoft_graph_${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
    }
    if (response.status === 202 || response.status === 204) return null;
    return response.json();
}

async function accessToken(account) {
    const credentials = decryptCredentials(account.credentials_encrypted);
    if (credentials.access_token && Number(credentials.expires_at || 0) > Date.now() + 60_000) {
        return credentials.access_token;
    }
    if (!credentials.refresh_token) throw new Error('microsoft_refresh_token_missing');
    const tenant = String(account.config?.tenant_id || 'organizations');
    const body = new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID || '',
        client_secret: process.env.MICROSOFT_CLIENT_SECRET || '',
        grant_type: 'refresh_token',
        refresh_token: credentials.refresh_token,
        scope: 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send',
    });
    const response = await fetch(`${TOKEN_ROOT}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: 'POST', body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`microsoft_token_refresh_${response.status}`);
    const refreshed = await response.json();
    const nextCredentials = {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || credentials.refresh_token,
        expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000,
    };
    await db.query(
        `UPDATE email_accounts SET credentials_encrypted = $1, updated_at = NOW()
          WHERE id = $2 AND customer_id = $3`,
        [encryptCredentials(nextCredentials), account.id, account.customer_id],
    );
    return nextCredentials.access_token;
}

function graphAddress(recipient) {
    return normalizeAddress(recipient?.emailAddress?.address || '');
}

async function verify(account) {
    const token = await accessToken(account);
    const profile = await graphFetch('/me?$select=id,displayName,mail,userPrincipalName', token);
    return {
        email: normalizeAddress(profile.mail || profile.userPrincipalName),
        displayName: boundedHeader(profile.displayName, 160),
        providerUserId: String(profile.id),
    };
}

async function sync(account) {
    const token = await accessToken(account);
    // Deliberate overlap avoids losing mail that arrives while a sync is in progress.
    // The database uniqueness constraint makes the overlap idempotent.
    const previousSync = new Date(account.last_synced_at || account.created_at || Date.now()).getTime();
    const since = new Date(previousSync - 2 * 60_000).toISOString();
    const select = 'id,conversationId,internetMessageId,subject,body,bodyPreview,from,toRecipients,receivedDateTime,internetMessageHeaders,hasAttachments';
    const query = new URLSearchParams({
        '$select': select,
        '$filter': `receivedDateTime gt ${since}`,
        '$orderby': 'receivedDateTime asc',
        '$top': '50',
    });
    let next = `/me/mailFolders/inbox/messages?${query}`;
    const graphMessages = [];
    for (let page = 0; next && page < 100; page += 1) {
        const payload = await graphFetch(next, token);
        graphMessages.push(...(payload.value || []));
        next = payload['@odata.nextLink'] || null;
        if (page === 99 && next) throw new Error('microsoft_sync_page_limit');
    }
    return graphMessages.map((message) => ({
        providerMessageId: String(message.id),
        providerThreadId: String(message.conversationId || message.internetMessageId || message.id),
        internetMessageId: boundedHeader(message.internetMessageId, 500) || null,
        from: graphAddress(message.from),
        to: (message.toRecipients || []).map(graphAddress).filter(Boolean),
        subject: boundedHeader(message.subject, 500),
        bodyText: plainText(message.body?.contentType === 'html' ? message.body.content :
            (message.body?.content || message.bodyPreview)),
        headers: Object.fromEntries((message.internetMessageHeaders || [])
            .slice(0, 100).map((header) => [boundedHeader(header.name, 100).toLowerCase(), boundedHeader(header.value)])),
        receivedAt: message.receivedDateTime ? new Date(message.receivedDateTime) : new Date(),
        hasAttachments: Boolean(message.hasAttachments),
    }));
}

async function prepareReply(account, sourceMessage, draft) {
    const token = await accessToken(account);
    const reply = await graphFetch(
        `/me/messages/${encodeURIComponent(sourceMessage.source_provider_message_id)}/createReply`, token,
        { method: 'POST' },
    );
    await graphFetch(`/me/messages/${encodeURIComponent(reply.id)}`, token, {
        method: 'PATCH',
        body: JSON.stringify({
            body: { contentType: 'Text', content: String(draft.body_text || '').slice(0, 20_000) },
        }),
    });
    return boundedHeader(reply.id, 500);
}

async function sendPrepared(account, _sourceMessage, _draft, providerDraftId, preparedNow = false) {
    const token = await accessToken(account);
    try {
        await graphFetch(`/me/messages/${encodeURIComponent(providerDraftId)}/send`, token, {
            method: 'POST',
        });
    } catch (error) {
        // A successful Graph send removes the draft. If our process died before the
        // local commit, the retry sees 404 and can safely finish without resending.
        if (error.status !== 404 || preparedNow) throw error;
    }
    return { providerMessageId: `graph-sent:${providerDraftId}` };
}

module.exports = { verify, sync, prepareReply, sendPrepared };
