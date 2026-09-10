"""Offline tests for probe persistence and command delivery; no machine configuration is changed."""
import asyncio
import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("websockets", types.SimpleNamespace())
SPEC = importlib.util.spec_from_file_location("probe", pathlib.Path(__file__).parents[1] / "scripts/machine_tools_probe.py")
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class ProbeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(pathlib.Path(self.directory.name) / "state.json")
        probe.state_lock = asyncio.Lock()
        probe.command_tasks = set()

    async def asyncTearDown(self):
        if probe.command_tasks:
            await asyncio.gather(*probe.command_tasks)
        self.directory.cleanup()

    async def test_restart_does_not_repeat_running_command(self):
        pathlib.Path(self.path).write_text(json.dumps({"running": {"id": {"command": "true"}}, "outbox": {}}))
        state = probe.load_state(self.path)
        self.assertEqual(state["running"], {})
        self.assertEqual(state["outbox"]["id"]["exitCode"], -2)
        await probe.save_state(self.path, state)
        self.assertEqual(probe.load_state(self.path), state)

    async def test_duplicate_delivery_reuses_outbox_and_expired_work_is_not_executed(self):
        messages = [{"type": "command", "id": "a", "command": "true"},
                    {"type": "command", "id": "a", "command": "true"},
                    {"type": "command", "id": "expired", "command": "true", "expiresAt": 1}]
        sent = []
        calls = []

        class Socket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def send(self, payload):
                sent.append(json.loads(payload))

            async def __aiter__(self):
                for message in messages:
                    yield json.dumps(message)
                    await asyncio.sleep(0.02)

        async def snapshot(_config):
            return {}

        async def run(command):
            calls.append(command)
            return 0, "ok", "", False

        state = {"running": {}, "outbox": {}}
        with patch.object(probe, "websockets", types.SimpleNamespace(connect=lambda *_args, **_kwargs: Socket())), \
                patch.object(probe, "collect_snapshot", snapshot), patch.object(probe, "run_command", run):
            await probe.connect({"probeUrl": "ws://example.invalid/probe", "reportToken": ""}, state, self.path)
        self.assertEqual(calls, ["true"])
        self.assertTrue(state["outbox"]["expired"]["expired"])
        self.assertGreaterEqual(len([item for item in sent if item.get("id") == "a"]), 2)

    async def test_buffered_duplicates_and_delivery_after_ack_execute_once(self):
        calls = []
        state = {"running": {}, "outbox": {}}

        class Socket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def send(self, _payload):
                pass

            async def __aiter__(self):
                message = json.dumps({"type": "command", "id": "buffered", "command": "synthetic"})
                yield message
                yield message
                await asyncio.gather(*probe.command_tasks)
                yield json.dumps({"type": "result-ack", "id": "buffered"})
                yield message

        async def snapshot(_config):
            return {}

        async def run(command):
            calls.append(command)
            return 0, "ok", "", False

        with patch.object(probe, "websockets", types.SimpleNamespace(connect=lambda *_args, **_kwargs: Socket())), \
                patch.object(probe, "collect_snapshot", snapshot), patch.object(probe, "run_command", run):
            await probe.connect({"probeUrl": "ws://example.invalid/probe", "reportToken": ""}, state, self.path)
        self.assertEqual(calls, ["synthetic"])
        self.assertEqual(state["outbox"], {})
        self.assertTrue(probe.load_state(self.path)["completed"]["buffered"])

    async def test_persistence_failure_prevents_command_execution(self):
        calls = []

        class Socket:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def send(self, _payload):
                pass

            async def __aiter__(self):
                yield json.dumps({"type": "command", "id": "blocked", "command": "synthetic"})

        async def snapshot(_config):
            return {}

        async def run(command):
            calls.append(command)
            return 0, "", "", False

        async def broken_save(*_args):
            raise OSError("disk full")

        with patch.object(probe, "websockets", types.SimpleNamespace(connect=lambda *_args, **_kwargs: Socket())), \
                patch.object(probe, "collect_snapshot", snapshot), patch.object(probe, "run_command", run), \
                patch.object(probe, "save_state", broken_save):
            with self.assertRaisesRegex(OSError, "disk full"):
                await probe.connect({"probeUrl": "ws://example.invalid/probe", "reportToken": ""}, {"running": {}, "outbox": {}}, self.path)
        self.assertEqual(calls, [])

    async def test_command_timeout_is_reported(self):
        with patch.object(probe, "COMMAND_TIMEOUT", 0.05):
            code, _stdout, stderr, timed_out = await probe.run_command("sleep 2")
        self.assertEqual(code, 124)
        self.assertIn("timed out", stderr)
        self.assertTrue(timed_out)

    async def test_exit_code_124_does_not_imply_timeout(self):
        code, _stdout, _stderr, timed_out = await probe.run_command("exit 124")
        self.assertEqual(code, 124)
        self.assertFalse(timed_out)


if __name__ == "__main__":
    unittest.main()
