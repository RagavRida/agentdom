"""
agentdom.dispatch — dispatch_intent() for calling any AgentDOM-compatible service.

This is the consumer-side function. It fetches the manifest from a host,
finds the capability matching the intent, and executes it via the declared transport.
"""

import os
import json
from typing import Any, Optional


async def dispatch_intent(
    intent: str,
    args: dict,
    host: str,
    token: Optional[str] = None,
    agentdom_api: Optional[str] = None,
) -> Any:
    """
    Dispatch an intent to an AgentDOM-compatible host.

    This is the main consumer-side function. It:
      1. Fetches the /.well-known/agentdom.json manifest from the host
      2. Finds the capability matching `intent`
      3. Executes the call via the declared transport (api, browser, desktop)

    Args:
        intent:       Intent name, e.g. "issues.create"
        args:         Intent arguments dict
        host:         Target host, e.g. "github.com"
        token:        Auth token (overrides env var lookup)
        agentdom_api: AgentDOM API server URL (default: https://api.getagentdom.com)

    Returns:
        The result from the remote capability.

    Raises:
        ValueError: If the intent is not found in the manifest.
        httpx.HTTPStatusError: If the HTTP request fails.

    Example:
        from agentdom import dispatch_intent

        result = await dispatch_intent(
            "issues.create",
            {"title": "Bug in login", "body": "Steps to reproduce..."},
            host="github.com",
        )
        print(result)  # → {"id": 42, "url": "https://github.com/..."}
    """
    try:
        import httpx
    except ImportError:
        raise ImportError(
            "agentdom dispatch requires httpx: pip install agentdom[dispatch]"
        )

    api_base = agentdom_api or os.environ.get("AGENTDOM_API_URL", "https://api.getagentdom.com")

    # Resolve auth token from env if not provided
    if not token:
        env_key = host.upper().replace(".", "_") + "_TOKEN"
        token = os.environ.get(env_key) or os.environ.get("AGENTDOM_TOKEN")

    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    payload = {"intent": intent, "host": host, "args": args}

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            f"{api_base}/api/agentdom/dispatch",
            headers=headers,
            json=payload,
        )
        res.raise_for_status()
        data = res.json()
        return data.get("result", data)


def dispatch_intent_sync(
    intent: str,
    args: dict,
    host: str,
    token: Optional[str] = None,
    agentdom_api: Optional[str] = None,
) -> Any:
    """
    Synchronous version of dispatch_intent for non-async code.

    Example:
        from agentdom import dispatch_intent_sync

        result = dispatch_intent_sync(
            "repos.list",
            {"username": "octocat"},
            host="github.com",
        )
    """
    import asyncio
    return asyncio.run(dispatch_intent(intent, args, host, token, agentdom_api))
