'use strict';

/**
 * Creates or updates the LiveKit outbound SIP trunk that connects directly to
 * Twilio Elastic SIP Trunking. Provider credentials are read exclusively from
 * environment variables.
 *
 * Run after configuring SIP_* and LiveKit variables:
 * node scripts/setup-sip-trunk.js
 *
 * The script deliberately does not read LIVEKIT_SIP_TRUNK_ID when deciding
 * whether to update a trunk. This makes the initial Twilio setup side-by-side:
 * the currently active carrier trunk is left untouched. Set
 * SIP_TRUNK_SETUP_ID to the newly-created Twilio LiveKit trunk ID only when
 * updating that trunk later.
 */

require('dotenv').config();
const { SipClient } = require('livekit-server-sdk');
const { SIPMediaEncryption, SIPTransport } = require('@livekit/protocol');

const transports = {
    AUTO: SIPTransport.SIP_TRANSPORT_AUTO,
    UDP: SIPTransport.SIP_TRANSPORT_UDP,
    TCP: SIPTransport.SIP_TRANSPORT_TCP,
    TLS: SIPTransport.SIP_TRANSPORT_TLS,
};
const mediaEncryptionModes = {
    DISABLE: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_DISABLE,
    ALLOW: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_ALLOW,
    REQUIRE: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_REQUIRE,
};
function buildTrunkConfig(env) {
    const transportName = (env.SIP_TRANSPORT || 'TLS').toUpperCase();
    const mediaEncryptionName = (env.SIP_MEDIA_ENCRYPTION || 'REQUIRE').toUpperCase();
    if (!(transportName in transports) || !(mediaEncryptionName in mediaEncryptionModes)) {
        throw new Error('SIP_TRANSPORT must be AUTO, UDP, TCP, or TLS; SIP_MEDIA_ENCRYPTION must be DISABLE, ALLOW, or REQUIRE');
    }

    const callerId = env.SIP_CALLER_ID || '';
    if (callerId && !/^\+[1-9]\d{6,14}$/.test(callerId)) {
        throw new Error('SIP_CALLER_ID must be E.164, for example +492111234567');
    }

    return {
        name: env.SIP_TRUNK_NAME || 'twilio-frankfurt',
        address: env.SIP_TRUNK_ADDRESS,
        // A wildcard lets us provision the trunk before Twilio assigns the
        // number. Runtime calling remains disabled until SIP_CALLER_ID is set.
        numbers: [callerId || '*'],
        transport: transports[transportName],
        mediaEncryption: mediaEncryptionModes[mediaEncryptionName],
        authUsername: env.SIP_AUTH_USERNAME,
        authPassword: env.SIP_AUTH_PASSWORD,
        destinationCountry: env.SIP_DESTINATION_COUNTRY || 'DE',
    };
}

async function main() {
    const required = [
        'LIVEKIT_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'SIP_TRUNK_ADDRESS',
        'SIP_AUTH_USERNAME',
        'SIP_AUTH_PASSWORD',
    ];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const trunkConfig = buildTrunkConfig(process.env);
    const httpUrl = process.env.LIVEKIT_URL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const sip = new SipClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    let trunk;
    if (process.env.SIP_TRUNK_SETUP_ID) {
        const [existing] = await sip.listSipOutboundTrunk({
            trunkIds: [process.env.SIP_TRUNK_SETUP_ID],
        });
        if (!existing) throw new Error('SIP_TRUNK_SETUP_ID does not exist');
        if (!existing.address || !existing.address.toLowerCase().endsWith('.twilio.com')) {
            throw new Error('Refusing to update a non-Twilio LiveKit SIP trunk');
        }

        Object.assign(existing, trunkConfig);
        trunk = await sip.updateSipOutboundTrunk(existing.sipTrunkId, existing);
        console.log(`Updated outbound trunk ${trunk.sipTrunkId} (${trunk.name})`);
    } else {
        trunk = await sip.createSipOutboundTrunk(
            trunkConfig.name,
            trunkConfig.address,
            trunkConfig.numbers,
            trunkConfig,
        );
        console.log(`Created outbound trunk ${trunk.sipTrunkId} (${trunk.name})`);
        console.log(`Set SIP_TRUNK_SETUP_ID=${trunk.sipTrunkId} for future setup updates`);
        console.log(`Set LIVEKIT_SIP_TRUNK_ID=${trunk.sipTrunkId} only when cutting over`);
    }

    if (!process.env.SIP_CALLER_ID) {
        console.warn('SIP_CALLER_ID is not set; the trunk is provisioned but outbound calling remains disabled');
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('Failed to configure Twilio SIP trunk:', err.message);
        process.exit(1);
    });
}

module.exports = { buildTrunkConfig };
