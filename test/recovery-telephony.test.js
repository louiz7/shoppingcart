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

test('dedicated routing is selected only by the authenticated shop ID, including SMS', async t => {
    const shop='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    const updates={LIVEKIT_URL:'wss://synthetic.invalid',LIVEKIT_API_KEY:'synthetic',LIVEKIT_API_SECRET:'synthetic',
        LIVEKIT_AGENT_NAME:'synthetic',OPENAI_API_KEY:'synthetic',RECOVERY_LIVE_ENABLED:'1',RECOVERY_SMS_ENABLED:'1',
        RECOVERY_SIP_TRUNK_ID:'ST_default',RECOVERY_CALLER_ID:'+4900000000001',TWILIO_SMS_FROM:'+4900000000002',
        TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'synthetic',RECOVERY_PUBLIC_URL:'https://synthetic.invalid',
        RECOVERY_SHOP_TELEPHONY:JSON.stringify({[shop]:{trunkId:'ST_dedicated',callerId:'+4900000000003',smsFrom:'+4900000000004'}})};
    const before=Object.fromEntries(Object.keys(updates).map(k=>[k,process.env[k]]));Object.assign(process.env,updates);
    t.after(()=>{for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
    const {RoomServiceClient,AgentDispatchClient,SipClient}=require('livekit-server-sdk');
    t.mock.method(RoomServiceClient.prototype,'createRoom',async()=>({}));
    t.mock.method(AgentDispatchClient.prototype,'createDispatch',async()=>({}));
    const dial=t.mock.method(SipClient.prototype,'createSipParticipant',async()=>({}));
    await telephony.dial({shop_id:shop,room:'recovery-synthetic',id:'synthetic'},'+4900000000005','synthetic');
    await telephony.dial({shop_id:other,room:'recovery-other',id:'synthetic'},'+4900000000005','synthetic');
    assert.equal(dial.mock.calls[0].arguments[0],'ST_dedicated');assert.equal(dial.mock.calls[0].arguments[3].fromNumber,'+4900000000003');
    assert.equal(dial.mock.calls[1].arguments[0],'ST_default');assert.equal(dial.mock.calls[1].arguments[3].fromNumber,'+4900000000001');
    const request=t.mock.method(global,'fetch',async()=>({ok:true,json:async()=>({sid:'SM'+'b'.repeat(32),status:'queued'})}));
    await telephony.sendSms('+4900000000005','Synthetic',shop,shop);
    assert.equal(request.mock.calls[0].arguments[1].body.get('From'),'+4900000000004');
    assert.equal(telephony.assertSmsReady(other).sender,'+4900000000002');
    // Voice-only numbers keep the independently configured SMS sender.
    process.env.RECOVERY_SHOP_TELEPHONY=JSON.stringify({[shop]:{trunkId:'ST_dedicated',callerId:'+4900000000003'}});
    assert.equal(telephony.assertSmsReady(shop).sender,'+4900000000002');
    for(const bad of ['{','[]',JSON.stringify({[shop]:{trunkId:'ST_dedicated'}}),JSON.stringify({[shop]:{trunkId:'ST_dedicated',callerId:'+4900000000003',smsFrom:'bad'}})]){
        process.env.RECOVERY_SHOP_TELEPHONY=bad;
        assert.equal(telephony.configured(shop),false);
        await assert.rejects(telephony.dial({shop_id:shop},'+4900000000005','synthetic'),/live_calls_disabled/);
        await assert.rejects(telephony.sendSms('+4900000000005','Synthetic',shop,shop),{code:'sms_not_configured',smsDispatched:false});
    }
    assert.equal(dial.mock.calls.length,2);assert.equal(request.mock.calls.length,1);
});
