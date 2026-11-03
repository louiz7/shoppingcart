"""Offline SDK contract checks; these tests never connect to LiveKit or OpenAI."""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from livekit.agents import AgentServer, llm
from livekit.plugins import openai

AGENT_PATH = Path(__file__).with_name('recovery.py')


class OfflineRecoveryCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # CI must exercise the same fixture as local runs, without reading .env or inheriting provider credentials.
        environment = patch.dict(os.environ, {
            'PATH': os.environ.get('PATH', os.defpath),
            'PYTHON_DOTENV_DISABLED': '1',
            'INTERNAL_TOOL_SECRET': 'synthetic-offline-internal-secret',
            'TOOL_GATEWAY_URL': 'http://127.0.0.1:3110',
            'LIVEKIT_AGENT_NAME': 'synthetic-recovery-worker',
            'RECOVERY_LIVE_ENABLED': '1',
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        dotenv = patch('dotenv.load_dotenv', return_value=False)
        dotenv.start()
        self.addCleanup(dotenv.stop)


class RecoveryContracts(OfflineRecoveryCase):
    async def test_named_dispatch_and_all_tools_have_valid_sdk_schemas(self):
        registered = []
        original = AgentServer.rtc_session

        def register(server, *args, **kwargs):
            registered.append(kwargs.get('agent_name'))
            return original(server, *args, **kwargs)

        with patch.object(AgentServer, 'rtc_session', register):
            spec = importlib.util.spec_from_file_location('recovery_test_module', AGENT_PATH)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertEqual(registered, [os.environ.get('LIVEKIT_AGENT_NAME', 'shoppingcart-local')])
        self.assertTrue(registered[0])
        agent = module.RecoveryAgent('synthetic-token', {'brand': 'Test', 'brandVoice': 'Friendly'}, None)
        self.assertEqual({tool.info.name for tool in agent.tools}, {
            'confirm_contact', 'get_cart_context', 'get_offer', 'send_checkout_link', 'send_help_article',
            'get_order_status', 'stop_contact', 'log_outcome', 'end_call', 'search_products', 'prepare_checkout',
            'get_product_details', 'get_shop_policies',
        })
        for tool in agent.tools:
            schema = llm.utils.function_arguments_to_pydantic_model(tool).model_json_schema()
            self.assertIsInstance(schema, dict)
            if tool.info.name == 'send_checkout_link':
                self.assertEqual(schema['properties']['use_discount']['default'], False)
                self.assertEqual(schema['properties']['use_discount']['type'], 'boolean')
            if tool.info.name == 'get_offer':
                self.assertIn('discount_id', schema['properties'])
        agent.tool = AsyncMock(return_value='{"confirmed":true}')
        await agent.get_offer(None, discount_id='approved-catalogue-id')
        agent.tool.assert_awaited_once_with('offer', {'percent': 0, 'discountId': 'approved-catalogue-id'})
        # Configuration only: no AgentSession is started and no model socket is opened.
        model = openai.realtime.GPTLiveModel(api_key='test-only-not-a-real-key', model='gpt-live-1', voice='flitz',
            responses_options={'model': 'gpt-5.6-luna', 'instructions': module.BACKEND_INSTRUCTIONS, 'parallel_tool_calls': False})
        self.assertIsNotNone(model)

    async def test_alternative_cart_tools_preserve_selected_variants_and_default_no_discount(self):
        import recovery
        agent = recovery.RecoveryAgent('synthetic', {'brand':'Test','brandVoice':'Friendly'}, None)
        agent.tool = AsyncMock(return_value='{}')
        await agent.prepare_checkout(None, [recovery.CheckoutItem(variant_id='gid://shopify/ProductVariant/2', quantity=2)])
        agent.tool.assert_awaited_with('prepare_checkout', {'items':[{'variantId':'gid://shopify/ProductVariant/2','quantity':2}], 'discountId':None})
        await agent.send_checkout_link(None, prepared_checkout_id='server-proposal')
        agent.tool.assert_awaited_with('send_link', {'useDiscount':False,'preparedCheckoutId':'server-proposal'}, context=None)
        await agent.send_help_article(None, 'gid://shopify/ProductVariant/2', '123')
        agent.tool.assert_awaited_with('send_help_article', {'variantId':'gid://shopify/ProductVariant/2','articleId':'123'}, context=None)
        await agent.search_products(None, 'Snowboard', max_price_cents=50000)
        agent.tool.assert_awaited_with('search_products', {'query':'Snowboard','maxPriceCents':50000})
        await agent.get_product_details(None, 'gid://shopify/ProductVariant/2')
        agent.tool.assert_awaited_with('product_details', {'variantId':'gid://shopify/ProductVariant/2'})
        await agent.get_shop_policies(None)
        agent.tool.assert_awaited_with('shop_policies')

    async def test_disabled_worker_exits_before_shared_project_registration(self):
        process = await asyncio.create_subprocess_exec(sys.executable, str(AGENT_PATH), 'dev',
            env={**os.environ, 'RECOVERY_LIVE_ENABLED': '0'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn(b'Recovery live mode disabled', stderr)
        self.assertNotIn(b'connected', stdout.lower())


class WorkerLifecycle(OfflineRecoveryCase):
    async def asyncSetUp(self):
        spec = importlib.util.spec_from_file_location('recovery_lifecycle_test', AGENT_PATH)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def fixture(self, failure=None, finish='session', profile=None):
        module = self.module
        initial = {'brand': 'Synthetic shop', 'brandVoice': 'Friendly'}
        if profile is not None:
            initial['agentProfile'] = profile
        participant = SimpleNamespace(identity='synthetic-buyer', attributes={'sip.callStatus': 'active'})
        room = module.rtc.EventEmitter()
        room.remote_participants = {participant.identity: participant}
        ctx = SimpleNamespace(room=room,
            job=SimpleNamespace(room=SimpleNamespace(metadata=json.dumps({'mode': 'recovery', 'call_token': 'a' * 64}))),
            connect=AsyncMock(), wait_for_participant=AsyncMock(return_value=participant), shutdown=Mock(), failure=failure)
        if failure == 'connect':
            ctx.connect.side_effect = RuntimeError('synthetic connection failure')
        if failure == 'sip_timeout':
            ctx.wait_for_participant.side_effect = TimeoutError('synthetic SIP timeout')
        if failure == 'early_hangup':
            participant.attributes['sip.callStatus'] = 'ringing'
            room.remote_participants = {}

        class Response:
            status = 409 if failure == 'context_denied' else 200

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                pass

            async def json(self):
                if failure == 'context_malformed':
                    raise ValueError('synthetic malformed context')
                return {'recorded': True} if self.name == 'transcript' else ({'ended': True} if self.name == 'end' else initial)

            async def text(self):
                return '{"ended":true}'

        class HTTP:
            requests = None
            closed = False

            def __init__(self):
                self.initial = initial
                self.requests = []
                self.payloads = []

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                self.closed = True

            def post(self, url, **kwargs):
                name = url.rsplit('/', 1)[-1]
                self.requests.append(name)
                self.urls = getattr(self, 'urls', []) + [url]
                self.payloads.append((name, kwargs.get('json')))
                if failure == 'context_transport' and name == 'connected':
                    raise module.aiohttp.ClientConnectionError('synthetic offline gateway')
                if failure == 'end_transport' and name == 'end':
                    raise module.aiohttp.ClientConnectionError('synthetic offline cleanup')
                response = Response()
                response.name = name
                return response

        class Session(module.rtc.EventEmitter):
            def __init__(self):
                super().__init__()
                self.started = asyncio.Event()
                self.close_calls = 0
                self.greeting_calls = 0
                self.start_options = None
                self.greeting_options = None

            async def start(self, **options):
                self.start_options = options
                self.started.set()
                if failure == 'session_start':
                    raise RuntimeError('synthetic model setup failure')
                if finish == 'during_start':
                    self.emit('close', None)

            async def generate_reply(self, **options):
                self.greeting_options = options
                self.greeting_calls += 1
                if failure == 'greeting':
                    raise RuntimeError('synthetic greeting failure')
                if finish in ('tool_latency','tool_latency_interrupted'):
                    await self.start_options['agent'].get_cart_context(None)
                    if finish == 'tool_latency_interrupted':
                        self.emit('user_state_changed',SimpleNamespace(new_state='speaking',old_state='listening'))
                    self.emit('agent_state_changed',SimpleNamespace(new_state='speaking',old_state='thinking'))
                    self.emit('agent_state_changed',SimpleNamespace(new_state='speaking',old_state='listening'))
                    self.emit('close',None)
                if finish == 'conversation_items':
                    for item in [module.llm.AgentHandoff(old_agent_id=None, new_agent_id='synthetic-agent'),
                                 module.llm.FunctionCall(call_id='synthetic-call', name='synthetic-tool', arguments='{}'),
                                 module.llm.ChatMessage(role='user', content=['Synthetic user text']),
                                 module.llm.ChatMessage(role='assistant', content=[]),
                                 module.llm.ChatMessage(role='assistant', content=['Synthetic assistant greeting'])]:
                        self.emit('conversation_item_added', SimpleNamespace(item=item))
                    self.emit('close', None)
                elif finish == 'provider_error':
                    self.emit('close', SimpleNamespace(reason=module.CloseReason.ERROR))
                if finish == 'session':
                    self.emit('close', None)
                elif finish == 'buyer':
                    room.emit('participant_disconnected', participant)
                elif finish == 'room':
                    room.emit('disconnected', None)

            async def aclose(self):
                self.close_calls += 1
                if failure == 'session_close':
                    raise RuntimeError('synthetic close failure')

        return ctx, HTTP(), Session()

    async def run_fixture(self, ctx, http, session):
        # Every network-bearing SDK/HTTP boundary is replaced before entrypoint runs.
        with patch.object(self.module.aiohttp, 'ClientSession', return_value=http), \
                patch.object(self.module.openai.realtime, 'GPTLiveModel', return_value=object(),
                    side_effect=RuntimeError('synthetic model construction failure') if ctx.failure == 'model' else None) as model, \
                patch.object(self.module, 'AgentSession', return_value=session):
            await asyncio.wait_for(self.module.entrypoint(ctx), 2)
            if model.called:
                self.assertEqual(model.call_args.kwargs['base_url'],
                    os.environ.get('OPENAI_BASE_URL') or 'https://eu.api.openai.com/v1')
                self.assertEqual(model.call_args.kwargs['voice'],self.module.profile_options(http.initial)['preset'])
                self.assertNotIn('reasoning',model.call_args.kwargs['responses_options'])
                self.assertEqual(model.call_args.kwargs['responses_options']['text'],{'verbosity':'low'})

    async def test_profile_selects_fixed_language_voice_and_disclosed_founder_greeting(self):
        voices = {'de': {'male': 'flitz','female': 'nuri'},'en': {'male': 'meridian','female': 'gleam'}}
        for language, choices in voices.items():
            for voice, preset in choices.items():
                with self.subTest(language=language,voice=voice):
                    greeting = ('Hallo, hier ist Alex, die KI-Assistenz im Auftrag des Gründungsteams von Synthetic shop.'
                        if language=='de' else "Hi, I'm Alex, the AI assistant calling on behalf of the founding team at Synthetic shop.")
                    profile = {'name': 'Alex','persona': 'founder','voice': voice,'language': language,'greeting': greeting}
                    ctx,http,session = self.fixture(profile=profile)
                    self.assertEqual(self.module.profile_options(http.initial)['preset'],preset)
                    model = openai.realtime.GPTLiveModel(api_key='synthetic-offline-not-a-real-key',model='gpt-live-1',voice=preset)
                    self.assertIsNotNone(model)
                    agent = self.module.RecoveryAgent('synthetic-token',http.initial,http)
                    self.assertIn('niemals ein Mensch',agent.instructions)
                    self.assertIn('Sprich Deutsch.' if language=='de' else 'Speak English',agent.instructions)
                    await self.run_fixture(ctx,http,session)
                    self.assertIn(greeting,json.loads(session.greeting_options['instructions'].split(': ',1)[1]))
        for change in [{'voice':'arbitrary-provider-voice'},{'persona':'human'},{'language':'fr'}]:
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError,'invalid_agent_profile'):
                    self.module.profile_options({'agentProfile':{**profile,**change}})

    async def test_browser_demo_uses_same_agent_but_isolated_transport_and_tools(self):
        ctx, http, session = self.fixture(finish='conversation_items',profile={
            'name':'Jake','persona':'founder','voice':'male','language':'de',
            'greeting':'Hey, hier ist Jake, Gründer von Synthetic shop.'})
        ctx.job.room.metadata = json.dumps({'mode':'recovery_demo','call_token':'a'*64})
        with patch.dict(os.environ, {'RECOVERY_LIVE_ENABLED':'0','RECOVERY_BROWSER_DEMO_ENABLED':'1'}):
            await self.run_fixture(ctx,http,session)
        ctx.wait_for_participant.assert_awaited_once_with(identity='demo-visitor')
        self.assertTrue(session.start_options['agent'].demo)
        self.assertIn('klar gekennzeichneten KI-Demo',session.start_options['agent'].instructions)
        self.assertIn('Auf direkte Fragen zu deiner Identität sage ehrlich',session.start_options['agent'].instructions)
        self.assertIn('Hey, hier ist Jake, Gründer',session.greeting_options['instructions'])
        self.assertTrue(all('/internal/recovery/demo/tools/' in url for url in http.urls))
        self.assertEqual(http.requests.count('end'),1)

    async def test_demo_enabled_does_not_enable_phone_jobs(self):
        ctx,http,session=self.fixture()
        with patch.dict(os.environ, {'RECOVERY_LIVE_ENABLED':'0','RECOVERY_BROWSER_DEMO_ENABLED':'1'}):
            await self.run_fixture(ctx,http,session)
        ctx.connect.assert_not_awaited()
        ctx.shutdown.assert_called_once_with(reason='recovery_mode_disabled')

    async def test_explicit_openai_endpoint_is_preserved(self):
        with patch.dict(os.environ, {'OPENAI_BASE_URL': 'https://us.api.openai.com/v1'}):
            await self.run_fixture(*self.fixture())

    async def test_startup_failures_and_preanswer_hangup_always_attempt_backend_cleanup(self):
        for failure in ['connect', 'sip_timeout', 'context_transport', 'context_denied',
                        'context_malformed', 'early_hangup', 'model', 'session_start', 'greeting']:
            with self.subTest(failure=failure):
                ctx, http, session = self.fixture(failure)
                if failure in ['context_denied', 'early_hangup']:
                    await self.run_fixture(ctx, http, session)
                else:
                    with self.assertRaises((RuntimeError, TimeoutError, ValueError, self.module.aiohttp.ClientError)):
                        await self.run_fixture(ctx, http, session)
                self.assertEqual(http.requests.count('end'), 1)
                self.assertTrue(http.closed)
                ctx.shutdown.assert_called_once()
                self.assertEqual(session.close_calls, int(failure in ['session_start', 'greeting']))

    async def test_close_disconnect_and_cleanup_failure_do_not_leave_worker_sleeping(self):
        for failure, finish in [(None, 'session'), (None, 'buyer'), (None, 'room'),
                                (None, 'during_start'), ('session_close', 'session'), ('end_transport', 'session')]:
            with self.subTest(failure=failure, finish=finish):
                ctx, http, session = self.fixture(failure, finish)
                await asyncio.wait_for(self.run_fixture(ctx, http, session), 1)
                self.assertEqual(http.requests.count('end'), 1)
                self.assertEqual(session.close_calls, 1)
                self.assertEqual(session.greeting_calls, int(finish != 'during_start'))
                self.assertTrue(http.closed)
                ctx.shutdown.assert_called_once()

    async def test_cancellation_still_cleans_up_and_propagates(self):
        ctx, http, session = self.fixture(finish='stay_connected')
        task = asyncio.create_task(self.run_fixture(ctx, http, session))
        try:
            await asyncio.wait_for(session.started.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(http.requests.count('end'), 1)
        self.assertIs(session.start_options['record'], False)
        self.assertEqual(session.close_calls, 1)
        self.assertTrue(http.closed)
        ctx.shutdown.assert_called_once()

    async def test_handoff_and_tool_events_never_break_assistant_transcript_recording(self):
        ctx, http, session = self.fixture(finish='conversation_items')
        with self.assertNoLogs('livekit', level='ERROR'):
            await self.run_fixture(ctx, http, session)
        transcripts = [payload for name, payload in http.payloads if name == 'transcript']
        self.assertEqual(len(transcripts), 2)
        self.assertEqual([item['role'] for item in transcripts], ['user', 'assistant'])
        self.assertEqual(transcripts[1]['text'], 'Synthetic assistant greeting')
        self.assertEqual(http.requests.count('end'), 1)

    async def test_fatal_voice_service_failure_records_generic_result_before_cleanup(self):
        ctx, http, session = self.fixture(finish='provider_error')
        await self.run_fixture(ctx, http, session)
        self.assertEqual(http.requests, ['connected', 'outcome', 'end'])
        result = next(payload for name, payload in http.payloads if name == 'outcome')
        self.assertEqual(result['outcome'], 'human_needed')
        self.assertNotIn('credit', result['summary'])
        self.assertEqual(session.close_calls, 1)
        ctx.shutdown.assert_called_once()

    async def test_committed_messages_are_serialized_and_bound_to_tool_calls(self):
        agent = self.module.RecoveryAgent('test', {'brand':'Test','brandVoice':'Friendly'}, None)
        started, release = asyncio.Event(), asyncio.Event()
        writes = []

        async def backend(http, token, name, data=None, demo=False):
            if name == 'transcript' and not started.is_set():
                started.set()
                await release.wait()
            writes.append((name, data))
            return '{"recorded":true}'

        with patch.object(self.module, 'backend_tool', side_effect=backend):
            first = agent.record_message(llm.ChatMessage(role='assistant', content=['Soll ich dir den Link schicken?']))
            await started.wait()
            second = agent.record_message(llm.ChatMessage(role='user', content=['Das wäre super.']))
            action = asyncio.create_task(agent.tool('send_link', {'useDiscount':False}))
            await asyncio.sleep(0)
            self.assertEqual(writes, [])
            release.set()
            await asyncio.gather(first, second, action)
        self.assertEqual([name for name, _ in writes], ['transcript','transcript','send_link'])
        self.assertEqual(writes[-1][1]['userEventId'], writes[1][1]['eventId'])
        self.assertFalse(writes[-1][1]['useDiscount'])

    async def test_contact_confirmation_returns_cart_in_one_model_tool_call(self):
        agent = self.module.RecoveryAgent('test', {'brand':'Test','brandVoice':'Friendly'}, None)
        cart = '{"contactConfirmed":true,"cart":{"items":[]}}'
        agent.tool = AsyncMock(side_effect=['{"contactConfirmed":true}',cart])
        self.assertEqual(await agent.confirm_contact(None),cart)
        self.assertEqual([call.args[0] for call in agent.tool.await_args_list],['confirm_contact','context'])
        agent.tool = AsyncMock(return_value='{"error":"conversation_changed"}')
        self.assertEqual(json.loads(await agent.confirm_contact(None))['error'],'conversation_changed')
        self.assertEqual(agent.tool.await_count,1)

    async def test_tool_to_next_speech_metric_is_recorded_once_without_replacing_response_metric(self):
        ctx,http,session = self.fixture(finish='tool_latency')
        await self.run_fixture(ctx,http,session)
        metrics = [payload for name,payload in http.payloads if name=='latency']
        self.assertEqual(len(metrics),1)
        self.assertEqual(metrics[0]['kind'],'tool_result_to_speech_latency')
        self.assertEqual(metrics[0]['tool'],'context')
        self.assertGreaterEqual(metrics[0]['ms'],0)

    async def test_customer_speech_does_not_inflate_post_tool_silence(self):
        ctx,http,session = self.fixture(finish='tool_latency_interrupted')
        await self.run_fixture(ctx,http,session)
        self.assertEqual([payload for name,payload in http.payloads if name=='latency'],[])

    async def test_new_user_turn_or_interrupted_response_invalidates_pending_action(self):
        for tool, interrupted in [(tool, interrupted) for tool in ('send_link', 'send_help_article') for interrupted in (False, True)]:
            with self.subTest(tool=tool, interrupted=interrupted):
                agent = self.module.RecoveryAgent('test', {'brand':'Test','brandVoice':'Friendly'}, None)
                agent.latest_user_event = 'old-user-event'
                release = asyncio.Event()
                agent.transcript_tail = asyncio.create_task(release.wait())
                context = SimpleNamespace(speech_handle=SimpleNamespace(interrupted=interrupted))
                with patch.object(self.module,'backend_tool',new=AsyncMock()) as backend:
                    action = asyncio.create_task(agent.tool(tool,context=context))
                    await asyncio.sleep(0)
                    if not interrupted:
                        agent.latest_user_event = 'new-user-event'
                    release.set()
                    self.assertEqual(json.loads(await action)['error'],'conversation_changed')
                    backend.assert_not_awaited()

    async def test_failed_transcript_blocks_effect_but_never_blocks_contact_stop(self):
        agent = self.module.RecoveryAgent('test', {'brand':'Test','brandVoice':'Friendly'}, None)
        with patch.object(self.module,'backend_tool',new=AsyncMock(return_value='{"error":"tool_unavailable"}')) as backend:
            with self.assertRaisesRegex(RuntimeError,'transcript_not_persisted'):
                await agent.record_message(llm.ChatMessage(role='user',content=['Ja, gerne.']))
            self.assertEqual(json.loads(await agent.tool('send_link'))['error'],'conversation_evidence_required')
            await agent.stop_contact(None)
            self.assertEqual([call.args[2] for call in backend.await_args_list],['transcript','stop'])

    async def test_gateway_preserves_safe_error_codes_and_hides_raw_errors(self):
        class Response:
            status = 409
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def json(self): return self.payload
        response = Response()
        http = SimpleNamespace(post=Mock(return_value=response))
        for value, expected in [('cart_changed','cart_changed'),('provider failed: secret=unsafe','action_not_confirmed')]:
            response.payload = {'error':value,'secret':'must not leave gateway'}
            with self.assertLogs(self.module.__name__, level='WARNING') as logs:
                result = json.loads(await self.module.backend_tool(http,'private-session-token','send_link'))
            self.assertEqual(result,{'error':expected,'status':409})
            self.assertEqual(logs.records[0].getMessage(),
                f'Recovery tool rejected: tool=send_link code={expected} status=409 demo=False')

    async def test_invalid_metadata_never_connects_or_opens_http(self):
        for metadata in ['{broken', '[]', 'null', '{"mode":"recovery","call_token":"bad"}', '{"mode":"collection"}']:
            with self.subTest(metadata=metadata):
                ctx, http, session = self.fixture()
                ctx.job.room.metadata = metadata
                await self.run_fixture(ctx, http, session)
                ctx.connect.assert_not_awaited()
                self.assertEqual(http.requests, [])
                ctx.shutdown.assert_called_once_with(reason='recovery_invalid_metadata')

    async def test_gateway_never_sends_credentials_to_a_remote_or_ambiguous_destination(self):
        _, http, _ = self.fixture()
        for value in ['https://external.example.invalid', 'http://external.example.invalid',
                      'http://localhost@external.example.invalid', 'http://user:secret@localhost',
                      'http://localhost/path', 'http://localhost?next=external', 'http://localhost#fragment']:
            with self.subTest(value=value), patch.dict(os.environ, {'TOOL_GATEWAY_URL': value}):
                with self.assertRaises(ValueError):
                    await self.module.backend_tool(http, 'a' * 64, 'context')
                self.assertEqual(http.requests, [])
        for value in ['http://127.0.0.1:3110', 'http://localhost:3110/', 'http://[::1]:3110']:
            with self.subTest(value=value), patch.dict(os.environ, {'TOOL_GATEWAY_URL': value}):
                self.assertEqual(self.module.gateway_url(), value.rstrip('/'))


if __name__ == '__main__':
    unittest.main()
