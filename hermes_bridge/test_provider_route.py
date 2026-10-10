"""Synthetic metadata only: no installed credentials, clients or model calls."""

import unittest
from unittest.mock import Mock

from hermes_bridge import inventory_agent as bridge


def credentials():
    return {
        "provider": bridge.PROVIDER,
        "base_url": bridge.CODEX_BASE_URL,
        "source": bridge.CREDENTIAL_SOURCE,
        "auth_mode": "chatgpt",
        "api_key": "synthetic-not-a-token",
        "last_refresh": None,
    }


class ProviderRouteTests(unittest.TestCase):
    def test_read_only_official_shape_and_minimal_constructor_kwargs(self):
        resolver = Mock(return_value=credentials())
        runtime = bridge.resolve_inventory_runtime(resolver)
        resolver.assert_called_once_with(read_only=True)
        self.assertEqual(
            set(bridge.validate_inventory_runtime(runtime)),
            {"provider", "base_url", "api_mode", "api_key"},
        )

    def test_wrong_endpoint_source_and_auth_never_reach_constructor(self):
        original = bridge.resolve_inventory_runtime(Mock(return_value=credentials()))
        alternatives = {
            "base_url": [
                "https://api.openai.com/v1",
                bridge.CODEX_BASE_URL + "/",
                bridge.CODEX_BASE_URL + "?redirect=1",
                "https://chatgpt.com.evil.invalid/backend-api/codex",
                "http://chatgpt.com/backend-api/codex",
            ],
            "provider": ["openai", "auto"],
            "api_mode": ["chat_completions", "codex_app_server", None],
            "source": ["explicit", "env", "credential_pool", None],
            "auth_mode": ["api_key", None],
            "api_key": ["", None, lambda: "synthetic"],
        }
        for field, values in alternatives.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    runtime = {**original, field: value}
                    with self.assertRaisesRegex(
                        ValueError, "^inventory_provider_route_rejected$"
                    ):
                        bridge.validate_inventory_runtime(runtime)
        for extra in (
            "credential_pool",
            "request_overrides",
            "command",
            "args",
            "_fallback_notice",
        ):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    bridge.validate_inventory_runtime({**original, extra: None})

    def test_pool_credentials_unknown_metadata_and_error_detail_fail_closed(self):
        for changed in (
            {**credentials(), "source": "credential_pool"},
            {**credentials(), "base_url": "https://api.openai.com/v1"},
            {**credentials(), "request_overrides": {}},
            None,
        ):
            with self.assertRaisesRegex(
                ValueError, "^inventory_provider_route_rejected$"
            ):
                bridge.resolve_inventory_runtime(Mock(return_value=changed))
        with self.assertRaises(ValueError) as error:
            bridge.resolve_inventory_runtime(
                Mock(side_effect=RuntimeError("synthetic-sensitive-detail"))
            )
        self.assertEqual(
            str(error.exception), "inventory_provider_credentials_unavailable"
        )
        self.assertTrue(error.exception.__suppress_context__)
