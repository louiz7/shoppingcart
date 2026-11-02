'use strict';

const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const { decryptCredentials } = require('../email-crypto');
const { normalizeAddress, plainText, resolvePublicMailHost, boundedHeader } = require('../email-utils');

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

async function settings(account) {
    const config = account.config || {};
    const credentials = decryptCredentials(account.credentials_encrypted);
    const imapHost = await resolvePublicMailHost(config.imap_host);
    const smtpHost = await resolvePublicMailHost(config.smtp_host);
    const auth = credentials.access_token
        ? { user: credentials.username, accessToken: credentials.access_token }
        : { user: credentials.username, pass: credentials.password };
    return {
        imap: {
            host: imapHost.address,
            servername: imapHost.hostname,
            port: Number(config.imap_port),
            secure: config.imap_secure !== false,
            doSTARTTLS: config.imap_secure === false ? true : undefined,
            auth,
            logger: false,
            socketTimeout: 30_000,
            maxLiteralSize: MAX_MESSAGE_BYTES,
            maxLineLength: 64 * 1024,
        },
        smtp: {
            host: smtpHost.address,
            servername: smtpHost.hostname,
            port: Number(config.smtp_port),
            secure: config.smtp_secure === true,
            requireTLS: config.smtp_secure !== true,
            auth: credentials.access_token ? {
                type: 'OAuth2', user: credentials.username, accessToken: credentials.access_token,
            } : auth,
            tls: { servername: smtpHost.hostname },
            connectionTimeout: 30_000,
            greetingTimeout: 15_000,
            socketTimeout: 30_000,
        },
    };
}

async function verify(account) {
    const resolved = await settings(account);
    const imap = new ImapFlow(resolved.imap);
    const smtp = nodemailer.createTransport(resolved.smtp);
    try {
        await imap.connect();
        await smtp.verify();
        return { email: normalizeAddress(account.email_address), displayName: account.display_name || '' };
    } finally {
        if (imap.usable) await imap.logout().catch(() => {});
        smtp.close();
    }
}

function firstAddress(addresses) {
    return normalizeAddress(addresses?.value?.[0]?.address || '');
}

async function sync(account) {
    const resolved = await settings(account);
    const client = new ImapFlow(resolved.imap);
    const messages = [];
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
            const uidNext = Number(client.mailbox?.uidNext || 1);
            const cursor = Number(account.sync_cursor || 0);
            if (!cursor) return { messages: [], cursor: String(Math.max(0, uidNext - 1)) };
            if (cursor + 1 >= uidNext) return { messages: [], cursor: String(cursor) };
            let highestSeenUid = cursor;
            let fetched = 0;
            for await (const item of client.fetch(`${cursor + 1}:*`, {
                uid: true, envelope: true, size: true, source: true,
            }, { uid: true })) {
                if (!item.uid) continue;
                highestSeenUid = Math.max(highestSeenUid, Number(item.uid));
                fetched += 1;
                if (!item.size || Number(item.size) > MAX_MESSAGE_BYTES || !item.source) {
                    if (fetched >= 50) break;
                    continue;
                }
                const parsed = await simpleParser(item.source, { skipImageLinks: true, maxHtmlLengthToParse: MAX_MESSAGE_BYTES });
                const messageId = boundedHeader(parsed.messageId || item.envelope?.messageId || `imap-uid:${item.uid}`, 500);
                const references = Array.isArray(parsed.references) ? parsed.references :
                    (parsed.references ? [parsed.references] : []);
                const parent = boundedHeader(parsed.inReplyTo || references.at(-1) || '', 500);
                messages.push({
                    providerMessageId: `uid:${item.uid}`,
                    providerThreadId: parent || messageId || `uid:${item.uid}`,
                    internetMessageId: messageId || null,
                    from: firstAddress(parsed.from),
                    to: (parsed.to?.value || []).map((value) => normalizeAddress(value.address)).filter(Boolean),
                    subject: boundedHeader(parsed.subject, 500),
                    bodyText: plainText(parsed.text || parsed.html || ''),
                    headers: {
                        'in-reply-to': parent || null,
                        references: references.map((value) => boundedHeader(value, 500)).slice(-20),
                        'auto-submitted': boundedHeader(parsed.headers.get('auto-submitted'), 100) || null,
                        precedence: boundedHeader(parsed.headers.get('precedence'), 100) || null,
                    },
                    receivedAt: parsed.date || item.envelope?.date || new Date(),
                    hasAttachments: parsed.attachments.length > 0,
                    uid: Number(item.uid),
                });
                if (fetched >= 50) break;
            }
            return { messages, cursor: String(highestSeenUid) };
        } finally {
            lock.release();
        }
    } finally {
        if (client.usable) await client.logout().catch(() => {});
    }
}

async function prepareReply(account, _sourceMessage, draft) {
    const domain = String(account.email_address || '').split('@')[1] || 'rescova.local';
    return `<rescova-${account.customer_id}-${draft.id}@${domain}>`;
}

async function sendPrepared(account, sourceMessage, draft, providerMessageId, _preparedNow = false) {
    const resolved = await settings(account);
    const smtp = nodemailer.createTransport(resolved.smtp);
    const references = Array.isArray(sourceMessage.headers?.references)
        ? sourceMessage.headers.references : [];
    try {
        const result = await smtp.sendMail({
            messageId: providerMessageId,
            from: account.display_name
                ? { name: boundedHeader(account.display_name, 160), address: account.email_address }
                : account.email_address,
            to: sourceMessage.from_address,
            subject: /^re:/i.test(draft.subject) ? draft.subject : `Re: ${draft.subject}`,
            text: draft.body_text,
            inReplyTo: sourceMessage.internet_message_id || undefined,
            references: [...references, sourceMessage.internet_message_id].filter(Boolean),
        });
        return { providerMessageId: boundedHeader(result.messageId, 500) };
    } finally {
        smtp.close();
    }
}

module.exports = { verify, sync, prepareReply, sendPrepared };
