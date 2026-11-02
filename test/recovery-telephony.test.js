'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const telephony = require('../src/recovery/telephony');

test('recovery requires its own caller settings and keeps every live action gated off', async (t) => {
    const updates = { LIVEKIT_URL:'wss://synthetic.invalid', LIVEKIT_API_KEY:'synthetic', LIVEKIT_API_SECRET:'synthetic',
        LIVEKIT_AGENT_NAME:'shoppingcart-local', OPENAI_API_KEY:'synthetic',
        LIVEKIT_SIP_TRUNK_ID:'ST_generic', SIP_CALLER_ID:'+4900000000001',
        RECOVERY_SIP_TRUNK_ID:'', RECOVERY_CALLER_ID:'', RECOVERY_LIVE_ENABLED:'0', RECOVERY_SMS_ENABLED:'0' };
    const previous = Object.fromEntries(Object.keys(updates).map((key) => [key,process.env[key]]));
    Object.assign(process.env, updates);
    t.after(() => {
        for (const [key,value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    assert.equal(telephony.configured(), false);
    process.env.RECOVERY_SIP_TRUNK_ID = 'ST_recovery';
    process.env.RECOVERY_CALLER_ID = '+4900000000002';
    process.env.LIVEKIT_SIP_TRUNK_ID = ''; process.env.SIP_CALLER_ID = '';
    assert.equal(telephony.configured(), true);
    const { RoomServiceClient } = require('livekit-server-sdk');
    const rooms = t.mock.method(RoomServiceClient.prototype, 'createRoom', async () => { throw new Error('External actions forbidden'); });
    await assert.rejects(telephony.dial({ room:'recovery-synthetic', id:'synthetic' }, '+4900000000003', 'synthetic'), /live_calls_disabled/);
    await assert.rejects(telephony.sendSms('+4900000000003', 'Synthetic', 'synthetic'), /sms_disabled/);
    assert.equal(rooms.mock.calls.length, 0);
});
