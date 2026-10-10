"""Manual one-shot launcher candidate; never called by preparation/mock tests.

Requires prior approval, complete private manifest, a new dedicated profile and
runtime-injected API_SERVER_KEY. Does not create credentials or profile files.
"""

import asyncio
import hashlib
import json
import os
import signal
import stat
import sys
import threading
from pathlib import Path

MODEL = "gpt-6.1-sol"
PROVIDER = "openai-codex"
TOOL = "hub_shift_log_inventory"

PROFILE = Path.home() / ".hermes/profiles/hub-inventory-once"


def read_private(path, limit=16384):
    before = path.lstat()
    if (
        not stat.S_ISREG(before.st_mode)
        or before.st_uid != os.getuid()
        or before.st_mode & 0o077
        or before.st_size > limit
    ):
        raise ValueError("inventory_private_manifest_required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as file:
        opened = os.fstat(file.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_ctime_ns) != (
            before.st_dev,
            before.st_ino,
            before.st_ctime_ns,
        ):
            raise ValueError("inventory_private_manifest_changed")
        data = file.read(limit + 1)
    after = path.lstat()
    if len(data) > limit or (after.st_dev, after.st_ino, after.st_ctime_ns) != (
        before.st_dev,
        before.st_ino,
        before.st_ctime_ns,
    ):
        raise ValueError("inventory_private_manifest_changed")
    return data


def validate_manifest(manifest, *, profile, wrapper, python, credential_digest):
    expected = {
        "contract": "hermes-agent-inventory-v1",
        "endpoint": "http://127.0.0.1:8645/",
        "profileRoot": str(profile),
        "sourceRoot": manifest.get("sourceRoot"),
        "wrapperPath": str(wrapper),
        "pythonPath": str(python),
        "model": MODEL,
        "provider": PROVIDER,
        "tools": [TOOL],
        "maxIterations": 3,
        "maxTokens": 256,
        "runBudgetSeconds": 60,
        "concurrency": 1,
        "evidencePath": str(profile / "inventory-evidence.sqlite"),
        "runStorePath": str(profile / "runs_idempotency.db"),
        "memory": False,
        "history": False,
        "fallback": False,
        "startup": "manual-one-shot",
        "maxTasks": 1,
        "apiKeyDigest": credential_digest,
        "sourceCommit": "f97608f178d1ffeca59860195ab7da295f7c8e5f",
        "codeTrees": manifest.get("codeTrees"),
    }
    source = manifest.get("sourceRoot")
    if (
        not isinstance(source, str)
        or not Path(source).is_absolute()
        or str(Path(source).resolve()) != source
    ):
        raise ValueError("inventory_source_path_rejected")
    trees = manifest.get("codeTrees")
    if (
        not isinstance(trees, list)
        or not 1 <= len(trees) <= 6
        or not any(t.get("root") == source for t in trees)
        or not any(t.get("root") == str(wrapper.parent) for t in trees)
        or not any(
            str(python).startswith(t.get("root", "") + "/")
            or str(python) == t.get("root")
            for t in trees
        )
    ):
        raise ValueError("inventory_code_closure_rejected")
    if manifest != expected or len(credential_digest) != 64:
        raise ValueError("inventory_manifest_rejected")
    return expected


def verify_code_trees(trees):
    """Hash reviewed immutable public code closure before importing Hermes."""
    for tree in trees:
        if tree.get("excludedSystemSitePackages"):
            raise ValueError("inventory_unmeasured_system_packages_rejected")
        root = Path(tree["root"])
        if not root.is_absolute() or str(root.resolve()) != str(root):
            raise ValueError("inventory_code_root_rejected")
        entries = []
        totals = [0, 0]

        def walk(path, relative):
            before = path.lstat()
            totals[0] += 1
            if (
                totals[0] > 100000
                or os.access(path, os.W_OK)
                or (not tree.get("systemRuntime") and before.st_mode & 0o222)
            ):
                raise ValueError("inventory_mutable_code_rejected")
            if tree.get("systemRuntime") and before.st_uid != 0:
                raise ValueError("inventory_system_owner_rejected")
            alias = (
                tree.get("aliases", {}).get(relative)
                if tree.get("systemRuntime")
                else None
            )
            if stat.S_ISLNK(before.st_mode):
                if (
                    not alias
                    or str(path.resolve()) != alias
                    or not any(
                        t.get("systemRuntime")
                        and (alias == t["root"] or alias.startswith(t["root"] + "/"))
                        for t in trees
                    )
                ):
                    raise ValueError("inventory_code_symlink_rejected")
                entries.append([relative, "approved-system-alias", alias])
            elif stat.S_ISDIR(before.st_mode):
                entries.append([relative, "directory"])
                for child in sorted(path.iterdir(), key=lambda child: child.name):
                    if child.name == ".git":
                        continue
                    sub = relative + "/" + child.name if relative else child.name
                    if (
                        child.name.startswith(".env") and child.name != ".env.example"
                    ) or (
                        child.name in {"logs", "runtime", "secrets"}
                        and sub not in tree.get("reviewedResources", [])
                    ):
                        raise ValueError("inventory_private_code_root_rejected")
                    if tree.get("systemRuntime") and sub == tree.get(
                        "excludedSystemSitePackages"
                    ):
                        entries.append([sub, "excluded-disabled-system-site-packages"])
                    else:
                        walk(child, sub)
            elif stat.S_ISREG(before.st_mode):
                totals[1] += before.st_size
                if before.st_size > 67108864 or totals[1] > tree.get(
                    "maxBytes", 536870912
                ):
                    raise ValueError("inventory_code_size_rejected")
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as file:
                    opened = os.fstat(file.fileno())
                    if (opened.st_dev, opened.st_ino, opened.st_ctime_ns) != (
                        before.st_dev,
                        before.st_ino,
                        before.st_ctime_ns,
                    ):
                        raise ValueError("inventory_code_changed")
                    data = file.read(67108865)
                entries.append([relative, hashlib.sha256(data).hexdigest()])
            else:
                raise ValueError("inventory_code_type_rejected")
            after = path.lstat()
            if (before.st_dev, before.st_ino, before.st_ctime_ns) != (
                after.st_dev,
                after.st_ino,
                after.st_ctime_ns,
            ):
                raise ValueError("inventory_code_changed")

        walk(root, "")
        actual = hashlib.sha256(
            json.dumps(entries, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
        if actual != tree["sha256"]:
            raise ValueError("inventory_code_hash_rejected")


def verify_import_paths(paths, trees):
    roots = [Path(tree["root"]).resolve() for tree in trees]
    for entry in paths:
        if not entry or not Path(entry).is_absolute():
            raise ValueError("inventory_implicit_import_path_rejected")
        path = Path(entry).resolve()
        if not any(path == root or path.is_relative_to(root) for root in roots):
            raise ValueError("inventory_unmeasured_import_path_rejected")


async def main():
    # Deliberately no CLI fields/tasks/paths to widen the reviewed launch contract.
    if len(sys.argv) != 1 or not sys.flags.isolated:
        raise ValueError("inventory_launch_arguments_rejected")
    if (
        PROFILE.is_symlink()
        or PROFILE.resolve() != PROFILE
        or PROFILE.stat().st_mode & 0o077
        or PROFILE.stat().st_uid != os.getuid()
    ):
        raise ValueError("inventory_private_profile_required")
    manifest_path = PROFILE / "inventory-manifest.json"
    scope_path = PROFILE / "credential.scope"
    manifest_bytes = read_private(manifest_path)
    if hashlib.sha256(manifest_bytes).hexdigest() != os.environ.get(
        "HUB_INVENTORY_MANIFEST_SHA256"
    ):
        raise ValueError("inventory_approved_manifest_required")
    scope_bytes = read_private(scope_path, 65)
    key = os.environ.get("API_SERVER_KEY", "")
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise ValueError("inventory_runtime_key_required")
    digest = hashlib.sha256(key.encode()).hexdigest()
    if scope_bytes.decode().strip() != digest:
        raise ValueError("inventory_credential_scope_rejected")
    manifest = validate_manifest(
        json.loads(manifest_bytes),
        profile=PROFILE,
        wrapper=Path(__file__).resolve(),
        python=Path(sys.executable).resolve(),
        credential_digest=digest,
    )
    verify_import_paths(sys.path, manifest["codeTrees"])
    verify_code_trees(manifest["codeTrees"])
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from inventory_agent import EvidenceStore, load_official_adapter

    os.environ["HERMES_HOME"] = str(PROFILE)
    os.environ["HERMES_PROFILE"] = "hub-inventory-once"
    os.chdir(PROFILE / "empty-workdir")
    sys.path.insert(0, manifest["sourceRoot"])
    from hermes_constants import set_hermes_home_override

    set_hermes_home_override(PROFILE)
    from gateway.config import PlatformConfig

    store = EvidenceStore(manifest["evidencePath"])
    api_class = load_official_adapter(
        store, workdir=PROFILE / "empty-workdir", expected_home=PROFILE
    )
    api = api_class(
        PlatformConfig(
            enabled=True,
            extra={
                "host": "127.0.0.1",
                "port": 8645,
                "key": key,
                "max_concurrent_runs": 1,
            },
        )
    )
    # Official durable store path must exactly match manifest; never use a memory fallback.
    actual_store = getattr(api._run_idempotency_store, "_db_path", None)
    if (
        actual_store is None
        or str(Path(actual_store).resolve()) != manifest["runStorePath"]
    ):
        raise ValueError("inventory_run_store_path_unverified")
    preflight = api._create_agent()
    preflight.close()
    watchdog = threading.Timer(125, lambda: os._exit(70))
    watchdog.daemon = True
    watchdog.start()
    if not await api.connect():
        raise ValueError("inventory_start_failed")
    pid_path = PROFILE / "inventory.pid"
    pid_path.write_text(str(os.getpid()))
    pid_path.chmod(0o600)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stopped.set)
    try:
        # No daemon or retry; operator stops after explicit Hub retrieval. Hard process
        # lifetime additionally ends the listener after 120 seconds.
        try:
            await asyncio.wait_for(stopped.wait(), timeout=120)
        except asyncio.TimeoutError:
            pass
    finally:
        await api.disconnect()
        store.db.close()
        pid_path.unlink(missing_ok=True)
        os.environ.pop("API_SERVER_KEY", None)
        watchdog.cancel()


if __name__ == "__main__":
    asyncio.run(main())
