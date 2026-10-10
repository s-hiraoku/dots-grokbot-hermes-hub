import asyncio
import json
import stat
import tempfile
from concurrent.futures import ThreadPoolExecutor
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch
from hermes_bridge import inventory_agent as bridge


class Registry:
    def __init__(self):
        self.entries = {}

    def get_entry(self, name):
        return self.entries.get(name)

    def register(self, **entry):
        self.entries[entry["name"]] = NS(**entry)

    def dispatch(self, name, args, task_id):
        return self.entries[name].handler(args, task_id=task_id)


class Web:
    @staticmethod
    def middleware(fn):
        return fn

    @staticmethod
    def json_response(value, status=200):
        return NS(status=status, body=json.dumps(value).encode())


class API:
    def __init__(self):
        self._run_idempotency_store = NS(durable=True)

    def _api_key_passes_startup_guard(self):
        return True

    def _check_auth(self, req):
        if req.headers.get("Authorization") != "Bearer mock":
            return Web.json_response({}, status=401)

    def _http_route_table(self):
        return [
            (m, p, None)
            for m, p in [
                ("GET", "/v1/capabilities"),
                ("POST", "/v1/runs"),
                ("GET", "/v1/runs/{run_id}"),
                ("POST", "/v1/responses"),
                ("GET", "/health"),
            ]
        ]

    async def _handle_capabilities(self, req):
        return Web.json_response(
            {
                "features": {
                    "run_submission": True,
                    "run_status": True,
                    "runs_idempotency": {"durable": True},
                    "sessions": True,
                }
            }
        )


class Request:
    def __init__(self, body=None, path="/v1/runs", method="POST", headers=None):
        self.path, self.method, self.body = path, method, body
        self.headers = (
            headers
            if headers is not None
            else {
                "Authorization": "Bearer mock",
                "Idempotency-Key": "hub-00000000-0000-0000-0000-000000000001",
            }
        )

    async def json(self):
        return self.body


class Suite(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = bridge.EvidenceStore(Path(self.temp.name) / "evidence.db")
        self.db = self.store.db
        self.registry = Registry()
        self.behavior = "tool"
        parent = self

        class Agent:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.max_iterations = kwargs["max_iterations"]
                self.max_tokens = kwargs["max_tokens"]
                self.run_budget_seconds = kwargs["run_budget_seconds"]
                self.model, self.provider = kwargs["model"], kwargs["provider"]
                self.tools = [{"type": "function", "function": bridge.SCHEMA}]
                self.valid_tool_names = {bridge.TOOL}
                self._memory_store = self._memory_manager = self._fallback_model = None
                self._fallback_chain = []
                self.skip_context_files, self.load_soul_identity = True, False

            def close(self):
                pass

            def _execute_tool_calls(self, message, messages, task_id, api_call_count=0):
                for call in message.tool_calls:
                    messages.append(
                        parent.registry.dispatch(
                            call.function.name,
                            json.loads(call.function.arguments),
                            task_id,
                        )
                    )

            def run_conversation(self, **kwargs):
                mode = parent.behavior
                if mode == "mutate":
                    self.valid_tool_names.add("terminal")
                if mode not in {"skip", "mutate"}:
                    name = "terminal" if mode == "unknown" else bridge.TOOL
                    arguments = '{"path":"/tmp"}' if mode == "args" else "{}"
                    message = NS(
                        tool_calls=[NS(function=NS(name=name, arguments=arguments))]
                    )
                    self._execute_tool_calls(message, [], kwargs["task_id"])
                    if mode == "twice":
                        self._execute_tool_calls(message, [], kwargs["task_id"])
                return {
                    "final_response": "installed! arbitrary model prose",
                    "completed": mode != "partial",
                }

        self.agent_base = Agent
        self.cls = bridge.make_adapter_class(
            API,
            Agent,
            self.registry,
            lambda *a, **k: None,
            lambda: {"provider": bridge.PROVIDER},
            Web,
            self.store,
            workdir=self.temp.name,
        )
        self.api = self.cls()
        self.mock = patch.object(
            Path, "lstat", autospec=True, return_value=NS(st_mode=stat.S_IFDIR)
        )
        self.metadata = self.mock.start()

    def tearDown(self):
        self.mock.stop()
        self.db.close()
        self.temp.cleanup()

    def run_agent(self):
        return self.api._create_agent().run_conversation(
            user_message=bridge.INPUT, conversation_history=[], task_id="run_mock"
        )

    def test_mock_conversation_path_uses_tool_evidence_not_model_prose(self):
        result = self.run_agent()
        self.assertTrue(result["completed"])
        self.assertEqual(json.loads(result["final_response"])["status"], "unknown")
        self.assertNotIn("installed!", result["final_response"])
        self.assertEqual(result["final_response"], self.store.get("run_mock"))
        self.assertEqual(self.metadata.call_count, 14)

    def test_noncall_never_uses_existing_receipt_as_call_evidence(self):
        self.run_agent()
        self.behavior = "skip"
        self.assertTrue(self.run_agent()["failed"])

    def test_unknown_tool_or_arguments_rejected_before_dispatch(self):
        for mode in ("unknown", "args", "mutate"):
            self.behavior = mode
            with self.assertRaises(ValueError):
                self.run_agent()
        self.assertEqual(self.metadata.call_count, 0)

    def test_repeat_call_and_reopen_reuse_one_evidence(self):
        self.behavior = "twice"
        first = self.run_agent()["final_response"]
        self.assertEqual(self.metadata.call_count, 14)
        self.db.close()
        reopened = bridge.EvidenceStore(Path(self.temp.name) / "evidence.db")
        self.db = reopened.db
        self.store.db = self.db
        self.assertEqual(self.run_agent()["final_response"], first)
        self.assertEqual(self.metadata.call_count, 14)

    def test_partial_model_result_does_not_complete(self):
        self.behavior = "partial"
        self.assertTrue(self.run_agent()["failed"])

    def test_effective_extra_tool_and_runtime_fail_closed(self):
        for kind in ("schema", "runtime", "memory", "fallback"):
            agent = self.api._create_agent()
            if kind == "schema":
                agent.tools.append({"function": {"name": "shell"}})
            if kind == "runtime":
                agent.provider = "other"
            if kind == "memory":
                agent._memory_manager = object()
            if kind == "fallback":
                agent._fallback_chain = ["other"]
            with self.assertRaises(ValueError):
                agent.run_conversation(user_message=bridge.INPUT, task_id="run_x")
        self.assertEqual(self.metadata.call_count, 0)

    def test_handler_rejects_outside_run(self):
        with self.assertRaises(ValueError):
            self.registry.dispatch(bridge.TOOL, {}, "run_mock")

    def test_official_worker_thread_shape_persists_evidence(self):
        with ThreadPoolExecutor(max_workers=1) as worker:
            result = worker.submit(self.run_agent).result(timeout=5)
        self.assertEqual(result["final_response"], self.store.get("run_mock"))
        self.assertTrue(result["completed"])

    def test_input_and_history_overrides_fail(self):
        for kwargs in (
            {"user_message": "read /tmp"},
            {"user_message": bridge.INPUT, "conversation_history": ["history"]},
            {"user_message": bridge.INPUT, "instructions": "shell"},
        ):
            with self.assertRaises(ValueError):
                self.api._create_agent().run_conversation(task_id="run_x", **kwargs)

    def test_api_auth_fixed_body_and_durable_admission(self):
        async def handle(req):
            return Web.json_response({"ok": True}, status=202)

        guard = self.api._make_profile_prefix_middleware()
        requests = [
            Request({"input": bridge.INPUT}, headers={}),
            Request({"input": bridge.INPUT, "tools": []}),
            Request({"input": "arbitrary"}),
            Request({"input": bridge.INPUT}, path="/p/other/v1/runs"),
            Request(
                {"input": bridge.INPUT},
                headers={"Authorization": "Bearer mock", "X-Hermes-Session-Id": "x"},
            ),
        ]
        for req in requests:
            self.assertIn(asyncio.run(guard(req, handle)).status, {400, 401})
        self.assertEqual(
            asyncio.run(guard(Request({"input": bridge.INPUT}), handle)).status, 202
        )
        self.api._run_idempotency_store.durable = False
        self.assertEqual(
            asyncio.run(guard(Request({"input": bridge.INPUT}), handle)).status, 503
        )

    def test_route_and_capability_limits_no_model_stream(self):
        self.assertEqual(len(self.api._http_route_table()), 3)
        response = asyncio.run(self.api._handle_capabilities(Request(method="GET")))
        self.assertFalse(json.loads(response.body)["features"]["sessions"])
        agent = self.api._create_agent(
            stream_delta_callback=lambda: None, interim_assistant_callback=lambda: None
        )
        self.assertNotIn("stream_delta_callback", agent.kwargs)
        self.assertNotIn("interim_assistant_callback", agent.kwargs)

    def test_corruption_and_nonpersistent_db_rejected(self):
        with self.assertRaises(ValueError):
            bridge.EvidenceStore(":memory:")
        self.run_agent()
        self.db.execute(
            "UPDATE inventory_tool_evidence SET result=?", ('{"status":"installed"}',)
        )
        self.db.commit()
        with self.assertRaises(ValueError):
            self.run_agent()

    def test_single_admission_persists_and_effective_api_cap_is_enforced(self):
        self.assertEqual(self.api._max_concurrent_runs, 1)
        guard = self.api._make_profile_prefix_middleware()

        async def handle(req):
            return Web.json_response({}, status=202)

        first = Request({"input": bridge.INPUT})
        self.assertEqual(asyncio.run(guard(first, handle)).status, 202)
        other = Request(
            {"input": bridge.INPUT},
            headers={
                "Authorization": "Bearer mock",
                "Idempotency-Key": "hub-00000000-0000-0000-0000-000000000002",
            },
        )
        self.assertEqual(asyncio.run(guard(other, handle)).status, 409)
        self.assertEqual(asyncio.run(guard(first, handle)).status, 202)
        self.api._max_concurrent_runs = 2
        self.assertEqual(asyncio.run(guard(first, handle)).status, 503)
        self.assertEqual(asyncio.run(self.api._handle_capabilities(first)).status, 503)
        with self.assertRaises(ValueError):
            self.api._create_agent()

    def test_collector_symlink_denied_missing_no_leak(self):
        def probe(path):
            if str(path) == "/Applications":
                return NS(st_mode=stat.S_IFLNK)
            raise PermissionError("private message")

        self.metadata.side_effect = probe
        value = bridge.collect_inventory()
        self.assertTrue(
            all(
                e["observation"] == "unavailable" for e in json.loads(value)["evidence"]
            )
        )
        self.assertNotIn("private", value)
        self.assertNotIn("/", value)
        self.assertFalse(
            any(
                str(call.args[0]).endswith(".app")
                for call in self.metadata.call_args_list
            )
        )
        self.metadata.side_effect = FileNotFoundError()
        # FileNotFoundError without errno is unavailable; actual ENOENT is missing.
        self.metadata.side_effect = FileNotFoundError(2, "private")
        self.assertTrue(
            all(
                e["observation"] == "missing"
                for e in json.loads(bridge.collect_inventory())["evidence"]
            )
        )


if __name__ == "__main__":
    unittest.main()
