'use strict';

function parseSipFailure(error) {
    const message = String(error?.message || '');
    const messageMatch = /sip status:\s*(\d{3})(?::\s*([^\n]+))?/i.exec(message);
    const explicitCode = Number(error?.sipStatusCode || error?.statusCode);
    const sipStatusCode = Number.isInteger(explicitCode)
        ? explicitCode
        : messageMatch ? Number(messageMatch[1]) : null;
    const statusText = String(error?.sipStatus || messageMatch?.[2] || '').trim();

    if (sipStatusCode) {
        const suffix = statusText
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return {
            sipStatusCode,
            reason: `sip_${sipStatusCode}${suffix ? `_${suffix}` : ''}`.slice(0, 200),
        };
    }

    return {
        sipStatusCode: null,
        reason: String(error?.sipStatus || error?.code || message || 'provider_error').slice(0, 200),
    };
}

module.exports = { parseSipFailure };
