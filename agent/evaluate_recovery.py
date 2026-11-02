"""Opt-in real reasoning-model checks with synthetic dialogs; no business tools execute.

Run with the recovery virtualenv: python agent/evaluate_recovery.py
Uses the configured OpenAI key/endpoint and incurs model usage. Never dials or sends SMS.
"""
import asyncio
import json
import os
import time

from openai import AsyncOpenAI
from livekit.agents import llm
from recovery import BACKEND_INSTRUCTIONS, RecoveryAgent


CASES = [
    ('de_sms_natural', False, [('assistant', 'Soll ich dir den Link per SMS schicken?'), ('user', 'Das wäre super.')], 'send_checkout_link', False),
    ('en_sms_natural', False, [('assistant', 'Would you like the checkout link by text?'), ('user', 'Please do.')], 'send_checkout_link', False),
    ('ready_buyer', False, [('user', 'Ich brauche keine Beratung, schick mir einfach den Checkout per SMS.')], 'send_checkout_link', False),
    ('prepared_not_accepted', True, [('assistant', 'Soll ich dir den Link per SMS schicken?'), ('user', 'Ja, gerne.')], 'send_checkout_link', False),
    ('discount_and_sms', True, [('assistant', 'Mit den zehn Prozent kostet es 90 Euro. Soll ich dir den Link mit diesem Rabatt per SMS schicken?'), ('user', 'So machen wir es.')], 'send_checkout_link', True),
    ('en_discount_and_sms', True, [('assistant', 'The ten percent offer brings it to 90 euros. Shall I text you the checkout with that discount?'), ('user', 'Sounds good, go ahead.')], 'send_checkout_link', True),
    ('decline_discount', True, [('assistant', 'Zehn Prozent Rabatt sind möglich. Soll ich dir damit den Link per SMS schicken?'), ('user', 'Nein, den Rabatt brauche ich nicht, den Link schon.')], 'send_checkout_link', False),
    ('retract_discount', True, [('assistant', 'Zehn Prozent Rabatt sind bestätigt.'), ('user', 'Die nehme ich.'), ('assistant', 'Soll ich dir den Link per SMS senden?'), ('user', 'Ja, aber doch ohne Rabatt, bitte.')], 'send_checkout_link', False),
    ('conditional_acceptance', True, [('assistant', 'Soll ich dir den Checkout mit zehn Prozent Rabatt per SMS schicken?'), ('user', 'Nur wenn die Lieferung bis morgen garantiert ist.')], None, None),
    ('ambiguous_choice', True, [('assistant', 'Möchtest du den Rabatt oder lieber den normalen Link?'), ('user', 'Ja.')], None, None),
    ('sms_refusal', False, [('assistant', 'Soll ich dir den Link per SMS schicken?'), ('user', 'Nein, den habe ich schon offen. Was ist das für ein Material?')], None, None),
    ('scoped_no', False, [('assistant', 'Suchst du Größe M?'), ('user', 'Nein, ich suche L.')], None, None),
    ('contact_stop', False, [('user', 'Bitte streicht mich von eurer Anrufliste.')], 'stop_contact', None),
    ('wrong_person', False, [('user', 'You have the wrong person, I never visited that shop.')], 'stop_contact', None),
]


async def main():
    agent = RecoveryAgent('synthetic-no-tools', {'brand':'Synthetic Shop','brandVoice':'Friendly'}, None)
    schemas = []
    for tool in agent.tools:
        schemas.append({'type':'function', 'name':tool.info.name, 'description':tool.info.description,
            'parameters':llm.utils.function_arguments_to_pydantic_model(tool).model_json_schema(), 'strict':False})
    context = {'contactConfirmed':True, 'supportEmail':'help@example.invalid',
        'cart':{'currency':'EUR','subtotalCents':10000,'items':[{'title':'Synthetic cotton shirt','description':'Cotton, available in M and L.'}]},
        'availableDiscounts':[{'id':'synthetic-discount','percent':10}]}
    limits = asyncio.Semaphore(3)
    async with AsyncOpenAI(base_url=os.environ.get('OPENAI_BASE_URL') or 'https://eu.api.openai.com/v1',
                           timeout=45, max_retries=0) as client:
        async def check(case):
            name, prepared, dialog, expected, discount = case
            history = [{'type':'function_call','call_id':'fixture_context','name':'get_cart_context','arguments':'{}'},
                       {'type':'function_call_output','call_id':'fixture_context','output':json.dumps(context)}]
            if prepared:
                history += [{'type':'function_call','call_id':'fixture_offer','name':'get_offer','arguments':'{"discount_id":"synthetic-discount"}'},
                            {'type':'function_call_output','call_id':'fixture_offer','output':json.dumps({'percent':10,'code':'SYNTHETIC10','merchandiseTotalCents':9000,'currency':'EUR'})}]
            history += [{'role':role,'content':text} for role,text in dialog]
            async with limits:
                start = time.monotonic()
                result = await client.responses.create(model=os.environ.get('OPENAI_RECOVERY_BACKEND_MODEL','gpt-5.6-luna'),
                    instructions=BACKEND_INSTRUCTIONS, input=history, tools=schemas,
                    parallel_tool_calls=False, store=False)
                elapsed = round((time.monotonic()-start)*1000)
            calls = [item for item in result.output if item.type == 'function_call']
            if expected:
                passed = len(calls)==1 and calls[0].name==expected
                if discount is not None and passed:
                    passed = json.loads(calls[0].arguments).get('use_discount',False) is discount
            else:
                passed = not any(item.name in ('send_checkout_link','stop_contact','end_call') for item in calls)
            print(json.dumps({'case':name,'passed':passed,'tools':[item.name for item in calls],
                'ms':elapsed}),flush=True)
            return passed
        results = await asyncio.gather(*(check(case) for case in CASES))
    print(json.dumps({'passed':sum(results),'total':len(results)}))
    if not all(results):
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
