import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from hermes_bridge.serve_inventory import (
    validate_manifest,
    verify_code_trees,
    verify_import_paths,
)


class LaunchTests(unittest.TestCase):
    def test_immutable_code_hash_and_drift_refusal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            file = root / "source.py"
            file.write_text("reviewed public fixture")
            entries = [
                ["", "directory"],
                ["source.py", hashlib.sha256(file.read_bytes()).hexdigest()],
            ]
            tree = {
                "root": str(root),
                "sha256": hashlib.sha256(
                    json.dumps(entries, separators=(",", ":")).encode()
                ).hexdigest(),
            }
            file.chmod(0o400)
            root.chmod(0o500)
            try:
                verify_code_trees([tree])
                with self.assertRaises(ValueError):
                    verify_code_trees([{**tree, "sha256": "f" * 64}])
                file.chmod(0o600)
                with self.assertRaises(ValueError):
                    verify_code_trees([tree])
            finally:
                root.chmod(0o700)

    def test_unmeasured_or_implicit_python_import_roots_are_rejected(self):
        trees = [{"root": "/reviewed/runtime"}]
        verify_import_paths(
            ["/reviewed/runtime/lib", "/reviewed/runtime/python.zip"], trees
        )
        for paths in ([""], ["relative"], ["/unmeasured/site-packages"]):
            with self.assertRaises(ValueError):
                verify_import_paths(paths, trees)

    def test_launch_manifest_exact_budgets_model_tools_and_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            wrapper = root / "serve_inventory.py"
            python = root / "python"
            trees = [{"root": str(root), "sha256": "a" * 64}]
            manifest = {
                "contract": "hermes-agent-inventory-v1",
                "endpoint": "http://127.0.0.1:8645/",
                "profileRoot": str(root),
                "sourceRoot": str(root),
                "wrapperPath": str(wrapper),
                "pythonPath": str(python),
                "model": "gpt-6.1-sol",
                "provider": "openai-codex",
                "tools": ["hub_shift_log_inventory"],
                "maxIterations": 3,
                "maxTokens": 256,
                "runBudgetSeconds": 60,
                "concurrency": 1,
                "evidencePath": str(root / "inventory-evidence.sqlite"),
                "runStorePath": str(root / "runs_idempotency.db"),
                "memory": False,
                "history": False,
                "fallback": False,
                "startup": "manual-one-shot",
                "maxTasks": 1,
                "apiKeyDigest": "a" * 64,
                "sourceCommit": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
                "codeTrees": trees,
            }
            kwargs = {
                "profile": root,
                "wrapper": wrapper,
                "python": python,
                "credential_digest": "a" * 64,
            }
            self.assertEqual(validate_manifest(manifest, **kwargs), manifest)
            for defect in (
                {"model": "other"},
                {"tools": ["shell"]},
                {"maxTasks": 2},
                {"maxTokens": 257},
                {"endpoint": "http://0.0.0.0:8645/"},
                {"history": True},
                {"codeTrees": []},
            ):
                with self.assertRaises(ValueError):
                    validate_manifest({**manifest, **defect}, **kwargs)


if __name__ == "__main__":
    unittest.main()
