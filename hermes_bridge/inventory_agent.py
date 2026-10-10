"""Prepared one-tool Hermes API boundary. No launcher, profile or credentials.

load_official_adapter() must only be called in an explicitly approved dedicated
process. Importing this file alone does not import or start Hermes.
"""

import errno
import json
import re
import sqlite3
import stat
import threading
from pathlib import Path

TOOL = "hub_shift_log_inventory"
TOOLSET = "hub_inventory_only"
INPUT = "hub:shift-log-inventory:v1"
MODEL = "gpt-6.1-sol"
PROVIDER = "openai-codex"
LOCATIONS = (
    ("applications-spaced", "/Applications/Shift Log.app", ("/Applications",)),
    ("applications-camel", "/Applications/ShiftLog.app", ("/Applications",)),
    ("applications-kebab", "/Applications/shift-log.app", ("/Applications",)),
    (
        "homebrew-command",
        "/opt/homebrew/bin/shift-log",
        ("/opt", "/opt/homebrew", "/opt/homebrew/bin"),
    ),
    (
        "local-command",
        "/usr/local/bin/shift-log",
        ("/usr", "/usr/local", "/usr/local/bin"),
    ),
)
SCHEMA = {
    "name": TOOL,
    "description": "Return bounded shift-log installation candidate metadata. Identity remains unknown.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


def collect_inventory():
    """No caller paths, content reads, traversal, execution or symlink following."""
    evidence = []
    for location, path, parents in LOCATIONS:
        observation = "unavailable"
        try:
            for parent in parents:
                info = Path(parent).lstat()
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                    raise ValueError("unsafe_parent")
            mode = Path(path).lstat().st_mode
            observation = (
                "symlink_candidate"
                if stat.S_ISLNK(mode)
                else "directory_candidate"
                if stat.S_ISDIR(mode)
                else "file_candidate"
                if stat.S_ISREG(mode)
                else "other"
            )
        except OSError as error:
            observation = "missing" if error.errno == errno.ENOENT else "unavailable"
        except ValueError:
            pass
        evidence.append({"location": location, "observation": observation})
    return canonical(
        {
            "task_type": "shift_log_inventory",
            "product": "shift-log",
            "status": "unknown",
            "reason": "product_identity_unconfirmed_limited_metadata_only",
            "evidence": evidence,
        }
    )


def canonical(value):
    if not isinstance(value, dict) or set(value) != {
        "task_type",
        "product",
        "status",
        "reason",
        "evidence",
    }:
        raise ValueError("inventory_result_rejected")
    if (value["task_type"], value["product"], value["status"], value["reason"]) != (
        "shift_log_inventory",
        "shift-log",
        "unknown",
        "product_identity_unconfirmed_limited_metadata_only",
    ):
        raise ValueError("inventory_result_rejected")
    evidence = value["evidence"]
    if not isinstance(evidence, list) or len(evidence) != 5:
        raise ValueError("inventory_result_rejected")
    names = [entry[0] for entry in LOCATIONS]
    for index, entry in enumerate(evidence):
        if (
            not isinstance(entry, dict)
            or set(entry) != {"location", "observation"}
            or entry["location"] != names[index]
        ):
            raise ValueError("inventory_result_rejected")
        if entry["observation"] not in {
            "directory_candidate",
            "file_candidate",
            "symlink_candidate",
            "missing",
            "unavailable",
            "other",
        }:
            raise ValueError("inventory_result_rejected")
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


class EvidenceStore:
    """Dedicated persistent DB, supplied by trusted operator. No automatic cleanup."""

    def __init__(self, database_path):
        self.db = sqlite3.connect(str(database_path), check_same_thread=False)
        self.lock = threading.RLock()
        main = next(
            (
                row
                for row in self.db.execute("PRAGMA database_list")
                if row[1] == "main"
            ),
            None,
        )
        if main is None or not main[2]:
            self.db.close()
            raise ValueError("persistent_database_required")
        mode = self.db.execute("PRAGMA journal_mode").fetchone()[0]
        if mode not in {"delete", "truncate", "persist", "wal"}:
            self.db.close()
            raise ValueError("durable_journal_required")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS inventory_tool_evidence (task_id TEXT PRIMARY KEY, result TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS inventory_admission (singleton INTEGER PRIMARY KEY CHECK(singleton=1), key TEXT NOT NULL)"
        )
        self.db.commit()

    def admit(self, key):
        with self.lock:
            self.db.execute(
                "INSERT OR IGNORE INTO inventory_admission VALUES (1, ?)", (key,)
            )
            self.db.commit()
            return (
                self.db.execute(
                    "SELECT key FROM inventory_admission WHERE singleton=1"
                ).fetchone()[0]
                == key
            )

    def get(self, task_id):
        with self.lock:
            row = self.db.execute(
                "SELECT result FROM inventory_tool_evidence WHERE task_id=?", (task_id,)
            ).fetchone()
            if row is None:
                return None
            text = canonical(json.loads(row[0]))
            if text != row[0]:
                raise ValueError("inventory_receipt_corrupt")
            return text

    def save(self, task_id, text):
        canonical(json.loads(text))
        with self.lock:
            self.db.execute(
                "INSERT OR IGNORE INTO inventory_tool_evidence VALUES (?, ?)",
                (task_id, text),
            )
            self.db.commit()
            return self.get(task_id)


def make_adapter_class(
    api_base,
    agent_base,
    registry,
    create_toolset,
    resolve_runtime,
    web,
    store,
    *,
    workdir,
    inspect_environment=lambda: None,
):
    """Dependency seam for mock tests; production binding uses official classes below."""
    active = {}
    lock = threading.RLock()
    if registry.get_entry(TOOL) is not None:
        raise ValueError("inventory_tool_already_registered")

    def handler(args, *, task_id=None):
        with lock:
            state = active.get(task_id)
            if state is None:
                raise ValueError("inventory_tool_outside_run")
            agent = state["agent"]
            agent._inventory_assert()
            if type(args) is not dict or args:
                state["invalid"] = True
                raise ValueError("inventory_arguments_rejected")
            text = store.get(task_id)
            if text is None:
                text = store.save(task_id, collect_inventory())
            state["called"] = True  # Set only after durable evidence exists.
            return text

    registry.register(
        name=TOOL,
        toolset=TOOLSET,
        schema=SCHEMA,
        handler=handler,
        max_result_size_chars=4096,
    )
    create_toolset(
        TOOLSET, "One fixed metadata inventory tool", tools=[TOOL], includes=[]
    )
    if registry.get_entry(TOOL) is None:
        raise ValueError("inventory_tool_registration_failed")

    class InventoryAgent(agent_base):
        def _inventory_assert(self):
            inspect_environment()
            entry = registry.get_entry(TOOL)
            if entry is None or entry.handler is not handler:
                raise ValueError("inventory_handler_replaced")
            schemas = self.tools or []
            if (
                len(schemas) != 1
                or schemas[0].get("function") != SCHEMA
                or self.valid_tool_names != {TOOL}
            ):
                raise ValueError("inventory_effective_tools_rejected")
            if (
                self.max_iterations != 3
                or self.max_tokens != 256
                or self.run_budget_seconds != 60
            ):
                raise ValueError("inventory_budget_rejected")
            if self.model != MODEL or self.provider != PROVIDER:
                raise ValueError("inventory_runtime_rejected")
            if (
                self._memory_store is not None
                or self._memory_manager is not None
                or not self.skip_context_files
                or self.load_soul_identity
            ):
                raise ValueError("inventory_context_rejected")
            if (
                not self._skip_mcp_refresh
                or self._fallback_model is not None
                or self._fallback_chain
            ):
                raise ValueError("inventory_refresh_fallback_rejected")

        def _execute_tool_calls(self, message, messages, task_id, api_call_count=0):
            self._inventory_assert()
            with lock:
                state = active.get(task_id)
                if state is None or state["agent"] is not self:
                    raise ValueError("inventory_dispatch_binding_rejected")
                calls = message.tool_calls
                if not calls:
                    state["invalid"] = True
                    raise ValueError("inventory_empty_dispatch")
                for call in calls:
                    try:
                        if (
                            call.function.name != TOOL
                            or type(json.loads(call.function.arguments)) is not dict
                            or json.loads(call.function.arguments) != {}
                        ):
                            raise ValueError("inventory_dispatch_rejected")
                    except (ValueError, TypeError, AttributeError):
                        state["invalid"] = True
                        raise ValueError("inventory_dispatch_rejected") from None
            # All calls have been validated before any official inline/registry dispatch.
            return super()._execute_tool_calls(
                message, messages, task_id, api_call_count
            )

        def run_conversation(self, *args, **kwargs):
            self._inventory_assert()
            if (
                args
                or kwargs.get("user_message") != INPUT
                or kwargs.get("conversation_history")
            ):
                raise ValueError("inventory_conversation_rejected")
            if set(kwargs) - {
                "user_message",
                "conversation_history",
                "task_id",
                "turn_author",
            }:
                raise ValueError("inventory_conversation_overrides_rejected")
            task_id = kwargs.get("task_id")
            if not isinstance(task_id, str) or not re.fullmatch(
                r"[a-zA-Z0-9_-]{1,124}", task_id
            ):
                raise ValueError("inventory_task_binding_rejected")
            state = {"agent": self, "called": False, "invalid": False}
            with lock:
                if active:
                    raise ValueError("inventory_concurrency_rejected")
                active[task_id] = state
            try:
                result = super().run_conversation(**kwargs)
                self._inventory_assert()
                if (
                    not isinstance(result, dict)
                    or result.get("failed")
                    or result.get("partial")
                    or result.get("interrupted")
                    or result.get("completed") is False
                ):
                    return {
                        "failed": True,
                        "completed": False,
                        "final_response": "shift_log_inventory_failed",
                    }
                text = store.get(task_id)
                if not state["called"] or state["invalid"] or text is None:
                    return {
                        "failed": True,
                        "completed": False,
                        "final_response": "shift_log_inventory_failed",
                    }
                return {"completed": True, "final_response": text}
            finally:
                with lock:
                    active.pop(task_id, None)

    class InventoryAPI(api_base):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self._max_concurrent_runs = 1

        def _http_route_table(self):
            allowed = {
                ("GET", "/v1/capabilities"),
                ("POST", "/v1/runs"),
                ("GET", "/v1/runs/{run_id}"),
            }
            return [
                (method, path, handle)
                for method, path, handle in super()._http_route_table()
                if (method, path) in allowed
            ]

        def _wire_plugin_handlers(self, app):
            return

        def _make_profile_prefix_middleware(self):
            @web.middleware
            async def guard(request, handle):
                if self._max_concurrent_runs != 1:
                    return web.json_response(
                        {"error": "inventory_concurrency_rejected"}, status=503
                    )
                if not self._api_key_passes_startup_guard():
                    return web.json_response(
                        {"error": "inventory_auth_required"}, status=503
                    )
                auth = self._check_auth(request)
                if auth is not None:
                    return auth
                if request.path.startswith("/p/") or any(
                    key.lower().startswith("x-hermes-session")
                    for key in request.headers
                ):
                    return web.json_response(
                        {"error": "inventory_overrides_rejected"}, status=400
                    )
                if request.method == "POST":
                    try:
                        body = await request.json()
                    except (ValueError, TypeError):
                        return web.json_response(
                            {"error": "inventory_body_rejected"}, status=400
                        )
                    if (
                        request.path != "/v1/runs"
                        or body != {"input": INPUT}
                        or not re.fullmatch(
                            r"hub-[0-9a-f-]{36}",
                            request.headers.get("Idempotency-Key", ""),
                        )
                    ):
                        return web.json_response(
                            {"error": "inventory_body_rejected"}, status=400
                        )
                    if not self._run_idempotency_store.durable:
                        return web.json_response(
                            {"error": "inventory_idempotency_required"}, status=503
                        )
                    if not store.admit(request.headers["Idempotency-Key"]):
                        return web.json_response(
                            {"error": "inventory_one_shot_exhausted"}, status=409
                        )
                return await handle(request)

            return guard

        async def _handle_capabilities(self, request):
            if self._max_concurrent_runs != 1:
                return web.json_response(
                    {"error": "inventory_concurrency_rejected"}, status=503
                )
            response = await super()._handle_capabilities(request)
            if response.status != 200:
                return response
            body = json.loads(response.body)
            body["inventory_policy"] = {
                "contract": "hermes-agent-inventory-v1",
                "fixed_input": INPUT,
                "effective_tool_names": [TOOL],
                "collector": "fixed-lstat-v1",
                "session_overrides": False,
                "personal_context": False,
                "max_iterations": 3,
                "max_tokens": 256,
                "run_budget_seconds": 60,
                "max_concurrent_runs": 1,
            }
            for name in body.get("features", {}):
                if name not in {"run_submission", "run_status", "runs_idempotency"}:
                    body["features"][name] = False
            return web.json_response(body)

        def _create_agent(self, **kwargs):
            if self._max_concurrent_runs != 1:
                raise ValueError("inventory_concurrency_rejected")
            inspect_environment()
            runtime = dict(resolve_runtime())
            if runtime.get("provider") != PROVIDER or runtime.get("_fallback_notice"):
                raise ValueError("inventory_provider_rejected")
            runtime.pop("model", None)
            runtime.pop("_fallback_notice", None)
            callbacks = {
                key: value
                for key, value in kwargs.items()
                if key
                in {
                    "stream_delta_callback",
                    "tool_progress_callback",
                    "interim_assistant_callback",
                }
            }
            # Never emit untrusted model prose as streamed API events.
            callbacks.pop("stream_delta_callback", None)
            callbacks.pop("interim_assistant_callback", None)
            agent = InventoryAgent(
                model=MODEL,
                **runtime,
                **callbacks,
                enabled_toolsets=[TOOLSET],
                disabled_toolsets=[],
                quiet_mode=True,
                max_iterations=3,
                max_tokens=256,
                run_budget_seconds=60,
                platform="api_server",
                skip_context_files=True,
                load_soul_identity=False,
                skip_memory=True,
                skip_background_review=True,
                session_db=None,
                fallback_model=None,
                checkpoints_enabled=False,
                cwd=str(workdir),
            )
            agent._skip_mcp_refresh = True
            agent._persist_disabled = True
            try:
                agent._inventory_assert()
            except Exception:
                agent.close()
                raise
            return agent

    return InventoryAPI


def load_official_adapter(store, *, workdir, expected_home):
    """Explicit binding only. No start/connect, env changes or credential handling."""
    from aiohttp import web
    from gateway.platforms.api_server import APIServerAdapter
    from gateway.run import _resolve_runtime_agent_kwargs, _load_gateway_config
    from hermes_constants import get_hermes_home

    approved_home = Path(expected_home).resolve()
    approved_workdir = Path(workdir).resolve()
    if (
        approved_workdir != approved_home / "empty-workdir"
        or not approved_workdir.is_dir()
    ):
        raise ValueError("inventory_workdir_rejected")

    def inspect_environment():
        if get_hermes_home().resolve() != approved_home:
            raise ValueError("inventory_profile_rejected")
        config = _load_gateway_config()
        if config.get("mcp_servers") or (config.get("plugins") or {}).get("enabled"):
            raise ValueError("inventory_external_extensions_rejected")

    inspect_environment()
    from run_agent import AIAgent
    from tools.registry import registry
    from toolsets import create_custom_toolset

    return make_adapter_class(
        APIServerAdapter,
        AIAgent,
        registry,
        create_custom_toolset,
        _resolve_runtime_agent_kwargs,
        web,
        store,
        workdir=approved_workdir,
        inspect_environment=inspect_environment,
    )
