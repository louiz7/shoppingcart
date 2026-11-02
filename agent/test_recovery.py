"""Offline SDK contract checks; these tests never connect to LiveKit or OpenAI."""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from livekit.agents import AgentServer, llm
from livekit.plugins import openai

AGENT_PATH = Path(__file__).with_name('recovery.py')


class RecoveryContracts(unittest.IsolatedAsyncioTestCase):
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
            'confirm_identity', 'get_cart_context', 'get_offer', 'send_checkout_link',
            'get_order_status', 'stop_contact', 'log_outcome', 'end_call',
        })
        for tool in agent.tools:
            schema = llm.utils.function_arguments_to_pydantic_model(tool).model_json_schema()
            self.assertIsInstance(schema, dict)
        # Configuration only: no AgentSession is started and no model socket is opened.
        model = openai.realtime.GPTLiveModel(api_key='test-only-not-a-real-key', model='gpt-live-1', voice='flitz',
            responses_options={'model': 'gpt-5.6-luna', 'instructions': module.BACKEND_INSTRUCTIONS, 'parallel_tool_calls': False})
        self.assertIsNotNone(model)

    async def test_disabled_worker_exits_before_shared_project_registration(self):
        process = await asyncio.create_subprocess_exec(sys.executable, str(AGENT_PATH), 'dev',
            env={**os.environ, 'RECOVERY_LIVE_ENABLED': '0'}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn(b'Recovery live mode disabled', stderr)
        self.assertNotIn(b'connected', stdout.lower())


if __name__ == '__main__':
    unittest.main()
