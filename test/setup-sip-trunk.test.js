'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTrunkConfig } = require('../scripts/setup-sip-trunk');

const baseEnv = {
    SIP_TRUNK_ADDRESS: 'rescova-neu.pstn.frankfurt.twilio.com',
    SIP_AUTH_USERNAME: 'test-user',
    SIP_AUTH_PASSWORD: 'test-password',
};

test('builds a secure Twilio trunk that can be provisioned before caller ID exists', () => {
    const config = buildTrunkConfig(baseEnv);

    assert.equal(config.name, 'twilio-frankfurt');
    assert.equal(config.address, 'rescova-neu.pstn.frankfurt.twilio.com');
    assert.deepEqual(config.numbers, ['*']);
    assert.equal(config.destinationCountry, 'DE');
    assert.equal(config.authUsername, 'test-user');
    assert.equal(config.authPassword, 'test-password');
    assert.notEqual(config.transport, undefined);
    assert.notEqual(config.mediaEncryption, undefined);
});

test('adds an available Twilio caller ID to the LiveKit trunk', () => {
    const config = buildTrunkConfig({
        ...baseEnv,
        SIP_CALLER_ID: '+492111234567',
    });

    assert.deepEqual(config.numbers, ['+492111234567']);
});

test('rejects caller IDs that are not E.164', () => {
    assert.throws(
        () => buildTrunkConfig({ ...baseEnv, SIP_CALLER_ID: '02111234567' }),
        /SIP_CALLER_ID must be E\.164/,
    );
    assert.throws(
        () => buildTrunkConfig({ ...baseEnv, SIP_CALLER_ID: '+1234567890123456' }),
        /SIP_CALLER_ID must be E\.164/,
    );
});
