"""Opt-in real-model alternative-cart scenarios. Synthetic data; no Shopify, calls or SMS effects."""
import asyncio
import json
import os

from openai import AsyncOpenAI
from livekit.agents import llm
from recovery import RecoveryAgent, backend_options


async def main():
    agent = RecoveryAgent('synthetic', {'brand': 'Test', 'brandVoice': 'Friendly'}, None)
    tools = [{'type': 'function', 'name': t.info.name, 'description': t.info.description,
              'parameters': llm.utils.function_arguments_to_pydantic_model(t).model_json_schema(), 'strict': False}
             for t in agent.tools]
    item = {'variantId': 'gid://shopify/ProductVariant/2', 'title': 'Cotton shirt', 'variantTitle': 'Black / M',
            'quantity': 1, 'currentPriceCents': 8000, 'description': 'Black cotton shirt, size M.'}
    discount_id = '11111111-1111-4111-8111-111111111111'
    proposal_id = '22222222-2222-4222-8222-222222222222'
    context = {'contactConfirmed': True, 'cart': {'currency': 'EUR', 'subtotalCents': 10000,
               'items': [{'title': 'Original shirt', 'quantity': 1, 'currentPriceCents': 10000}]},
               'availableDiscounts': [{'id': discount_id, 'percent': 10}]}

    def output(name, value):
        return [{'type': 'function_call', 'call_id': name, 'name': name, 'arguments': '{}'},
                {'type': 'function_call_output', 'call_id': name, 'output': json.dumps(value)}]

    base = output('get_cart_context', context)
    searched = base + output('search_products', {'currency': 'EUR', 'products': [item]})
    prepared = searched + output('prepare_checkout', {'preparedCheckoutId': proposal_id,
        'cart': {'currency': 'EUR', 'items': [item], 'subtotalCents': 8000},
        'offer': {'percent': 0, 'merchandiseTotalCents': 8000}, 'originalCartUnchanged': True})
    discounted = searched + output('prepare_checkout', {'preparedCheckoutId': proposal_id,
        'cart': {'currency': 'EUR', 'items': [item], 'subtotalCents': 8000},
        'offer': {'percent': 10, 'merchandiseTotalCents': 7200}, 'originalCartUnchanged': True})
    cases = [
        ('search_cheaper', base, [('user', 'Habt ihr auch ein schwarzes Shirt unter 90 Euro?')],
         lambda calls: len(calls) == 1 and calls[0][0] == 'search_products'),
        ('prepare_selection', searched, [('assistant', 'Es gibt das schwarze Baumwollshirt in M für 80 Euro.'),
         ('user', 'Das klingt gut. Stell mir davon bitte zwei zusammen statt dem alten.')],
         lambda calls: len(calls) == 1 and calls[0][0] == 'prepare_checkout' and calls[0][1]['items'] == [{'variant_id': item['variantId'], 'quantity': 2}]),
        ('accept_plain', prepared, [('assistant', 'Ein schwarzes Baumwollshirt in M für 80 Euro statt dem alten. Soll ich dir den neuen Checkout per SMS schicken?'),
         ('user', 'Ja, genau so passt es.')],
         lambda calls: calls == [('send_checkout_link', {'prepared_checkout_id': proposal_id, 'use_discount': False})]),
        ('product_question_only', prepared, [('assistant', 'Das schwarze Baumwollshirt in M kostet 80 Euro.'),
         ('user', 'Ist das denn aus Baumwolle?')],
         lambda calls: not any(n == 'send_checkout_link' for n, _ in calls)),
        ('correction', prepared, [('assistant', 'Ein schwarzes Baumwollshirt in M für 80 Euro. Soll ich dir den Checkout schicken?'),
         ('user', 'Ja, aber zwei Stück statt einem bitte.')],
         lambda calls: len(calls) == 1 and calls[0][0] == 'prepare_checkout' and calls[0][1]['items'][0]['quantity'] == 2),
        ('accept_discount', discounted, [('assistant', 'Das schwarze Shirt in M kostet mit zehn Prozent 72 Euro. Soll ich dir diesen neuen Checkout mit Rabatt per SMS senden?'),
         ('user', 'Sounds good, send it over.')],
         lambda calls: calls == [('send_checkout_link', {'prepared_checkout_id': proposal_id, 'use_discount': True})]),
        ('decline_discount', discounted, [('assistant', 'Mit zehn Prozent sind es 72 statt 80 Euro. Soll ich dir den Link mit Rabatt schicken?'),
         ('user', 'Lieber ohne Rabatt, aber schick mir den Link zum schwarzen Shirt in M.')],
         lambda calls: calls == [('send_checkout_link', {'prepared_checkout_id': proposal_id, 'use_discount': False})] or
             (len(calls) == 1 and calls[0][0] == 'prepare_checkout' and not calls[0][1].get('discount_id'))),
        ('no_results', base + output('search_products', {'currency': 'EUR', 'products': [], 'searchIsExhaustive': False}),
         [('user', 'Dann schick mir einfach irgendeine billigere Alternative.')],
         lambda calls: not any(n in ('send_checkout_link', 'prepare_checkout') for n, _ in calls)),
    ]
    async with AsyncOpenAI(base_url=os.environ.get('OPENAI_BASE_URL') or 'https://eu.api.openai.com/v1', timeout=45, max_retries=0) as client:
        results = []
        for name, history, dialog, check in cases:
            response = await client.responses.create(**backend_options(), tools=tools, store=False,
                input=history + [{'role': role, 'content': text} for role, text in dialog])
            calls = [(c.name, json.loads(c.arguments)) for c in response.output if c.type == 'function_call']
            # Defaults may be omitted by the provider.
            calls = [(n, {'prepared_checkout_id': '', 'use_discount': False, **a} if n == 'send_checkout_link' else a) for n, a in calls]
            passed = check(calls)
            results.append(passed)
            print(json.dumps({'case': name, 'passed': passed, 'tools': [n for n, _ in calls]}), flush=True)
    if not all(results):
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
