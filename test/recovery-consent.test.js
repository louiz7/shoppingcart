'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../src/recovery/policy');

test('conversation permission means willingness after the short timing question, never verified identity',() => {
    for (const [prompt,answer] of [['Passt es gerade kurz?','Ja, gerne.'],['Is now a good time?','Yes, go ahead.']]) {
        assert.equal(policy.conversationPermission(answer,prompt),true);
        for (const refusal of ['Nein.','Ja, aber nicht jetzt.','Yes, but not now.','Yes, wrong person.',
            'Maybe later.','Voicemail','Ja, später.','No, thanks.']) assert.equal(policy.conversationPermission(refusal,prompt),false,refusal);
    }
    assert.equal(policy.conversationPermission('Ja.','Spreche ich mit der richtigen Person?'),false);
    assert.equal(policy.conversationPermission('Yes.','Would you like a discount?'),false);
});

test('English SMS consent rejects negation and requires an explicit link request', () => {
    for (const text of ['Yes, please send me the link by SMS.','Please text me the checkout link.','Yes, the link by SMS please.']) {
        assert.equal(policy.explicitSmsRequest(text),true,text);
    }
    for (const text of ['Yes','Maybe later','Do not send me the link.','Please don\'t send SMS.',
        'Don’t send me the link.','Never send that link.','No, please send no SMS.',
        'I cannot receive SMS, do not send the link.','Yes send the link, but not now.',
        'You shouldn\'t send the link.','I refuse to have you send me SMS.']) {
        assert.equal(policy.explicitSmsRequest(text),false,text);
    }
});

test('English refusal, contact withdrawal and wrong-person statements suppress contact', () => {
    for (const text of ['No.','No thanks.','I am not interested.','Please do not call me again.',
        'Don\'t contact me.','Don’t call me.','Stop calling me.','You have the wrong number.',
        'Wrong person.','Please remove my number.','I revoke my consent.','I withdraw consent.']) {
        assert.equal(policy.stopSignal(text),true,text);
    }
    assert.equal(policy.stopSignal('Yes, please send me the checkout link.'),false);
});
