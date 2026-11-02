'use strict';

/**
 * Places a real outbound call: creates a LiveKit room carrying Mia's persona
 * in room metadata, then dials `targetNumber` into it via the configured SIP
 * trunk. agent/agent.py (already running, connected to this LiveKit project)
 * auto-joins the new room and reads the persona from room metadata.
 *
 * Usage: node scripts/outbound-call.js +4917645997563
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const { SipClient, RoomServiceClient } = require('livekit-server-sdk');

const targetNumber = process.argv[2];
if (!targetNumber) {
    console.error('Usage: node scripts/outbound-call.js <targetNumber E.164>');
    process.exit(1);
}
const required = [
    'LIVEKIT_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'LIVEKIT_SIP_TRUNK_ID',
    'SIP_CALLER_ID',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
}
if (!/^\+[1-9]\d{6,14}$/.test(process.env.SIP_CALLER_ID)) {
    console.error('SIP_CALLER_ID must be E.164, for example +492111234567');
    process.exit(1);
}

const httpUrl = process.env.LIVEKIT_URL.replace('wss://', 'https://');
const sip = new SipClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
const rooms = new RoomServiceClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

const { system_prompt } = JSON.parse(fs.readFileSync('/tmp/mia_prompt.json', 'utf8'));
const persona = {
    system_prompt,
    greeting: 'Beginne das Gespräch jetzt genau wie in deiner Anweisung unter "GESPRÄCHSABLAUF" Schritt 1 beschrieben.',
    // Matches "Rescova MVP Agent - Mia Test"'s own llm-generation-strategy
    // (DIENST-Apleona-DEMO-2026): hosted voice c3dfa73f..., temperature 0.3.
    hosted_voice_id: 'c3dfa73f-a1ab-4aad-b48a-0e9b9fe4a69f',
    temperature: 0.3,
};

const roomName = `dlh-outbound-mia-${crypto.randomBytes(4).toString('hex')}`;

async function main() {
    await rooms.createRoom({ name: roomName, metadata: JSON.stringify(persona) });
    console.log('created room:', roomName);

    const participant = await sip.createSipParticipant(
        process.env.LIVEKIT_SIP_TRUNK_ID,
        targetNumber,
        roomName,
        {
            participantIdentity: 'sip-mia-test',
            participantName: 'Mia Test Call',
            fromNumber: process.env.SIP_CALLER_ID,
        },
    );
    console.log('SIP participant created:', JSON.stringify(participant, null, 2));
}

main().catch((err) => {
    console.error('outbound call failed:', err.message);
    process.exit(1);
});
