'use strict';

const dns = require('dns').promises;
const net = require('net');

const MAX_BODY_CHARS = 20_000;

function normalizeAddress(value) {
    const match = String(value || '').trim().toLowerCase().match(/<([^<>]+)>$/);
    const address = (match ? match[1] : String(value || '')).trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : '';
}

function plainText(value) {
    return String(value || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_BODY_CHARS);
}

function privateAddress(address) {
    if (address === '::1' || address === '0.0.0.0' || address.startsWith('fe80:') ||
        address.startsWith('fc') || address.startsWith('fd')) return true;
    const parts = address.split('.').map(Number);
    if (parts.length !== 4) return false;
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

async function resolvePublicMailHost(host) {
    const normalized = String(host || '').trim().toLowerCase();
    if (!normalized || normalized.length > 253 || normalized === 'localhost' ||
        normalized.endsWith('.local') || /[^a-z0-9.:-]/.test(normalized)) {
        throw new Error('invalid_mail_host');
    }
    const results = net.isIP(normalized)
        ? [{ address: normalized }]
        : await dns.lookup(normalized, { all: true, verbatim: true });
    if (!results.length || results.some((result) => privateAddress(result.address))) {
        throw new Error('private_mail_host_denied');
    }
    return { hostname: normalized, address: results[0].address };
}

async function assertPublicMailHost(host) {
    return (await resolvePublicMailHost(host)).hostname;
}

function boundedHeader(value, max = 998) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

module.exports = {
    normalizeAddress, plainText, assertPublicMailHost, resolvePublicMailHost,
    boundedHeader, MAX_BODY_CHARS,
};
