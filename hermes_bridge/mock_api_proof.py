"""Offline test helper. Uses mock API/Agent and mock lstat; never starts Hermes."""

import asyncio
import json
import sys
from hermes_bridge.test_inventory_agent import Suite, Request, Web
from hermes_bridge.inventory_agent import INPUT, MODEL, PROVIDER


def main():
    envelope = json.loads(sys.stdin.read(4096))
    fixture = Suite("test_mock_conversation_path_uses_tool_evidence_not_model_prose")
    fixture.setUp()
    try:
        fixture.behavior = envelope["mode"]

        async def handle(request):
            return Web.json_response({"accepted": True}, status=202)

        response = asyncio.run(
            fixture.api._make_profile_prefix_middleware()(
                Request(envelope["body"]), handle
            )
        )
        if response.status != 202:
            raise ValueError("mock_admission_rejected")
        result = fixture.api._create_agent().run_conversation(
            user_message=INPUT, conversation_history=[], task_id="run_integrated"
        )
        sys.stdout.write(
            json.dumps(
                {
                    "status": "failed" if result.get("failed") else "completed",
                    "output": result["final_response"],
                    "runtime": {"model": MODEL, "provider": PROVIDER},
                    "metadata_probes": fixture.metadata.call_count,
                }
            )
        )
    finally:
        fixture.tearDown()


if __name__ == "__main__":
    main()
