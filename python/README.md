# agentdom

**The universal runtime that makes every website, desktop app, and API accessible to AI agents — zero human in the loop.**

[![PyPI version](https://img.shields.io/pypi/v/agentdom?color=f97316&style=flat-square)](https://pypi.org/project/agentdom/)
[![Python versions](https://img.shields.io/pypi/pyversions/agentdom?style=flat-square)](https://pypi.org/project/agentdom/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/RagavRida/agentdom/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/agentdom?label=npm&color=f97316&style=flat-square)](https://www.npmjs.com/package/agentdom)

[Website](https://getagentdom.com) · [Docs](https://getagentdom.com/docs/python) · [GitHub](https://github.com/RagavRida/agentdom) · [npm package](https://www.npmjs.com/package/agentdom)

---

## Install

```bash
pip install agentdom
```

With framework support:

```bash
pip install "agentdom[flask]"    # Flask integration
pip install "agentdom[fastapi]"  # FastAPI integration
pip install "agentdom[dispatch]" # dispatch_intent() support (requires httpx)
pip install "agentdom[all]"      # everything
```

## Quick start — dispatch an intent

```python
import asyncio
from agentdom import dispatch_intent

async def main():
    # Create a GitHub issue — routes via REST API, no browser needed
    result = await dispatch_intent(
        "issues.create",
        {
            "title": "Login crash on iOS 17",
            "body":  "Reproducible on iPhone 15 Pro",
            "labels": ["bug", "mobile"],
        },
        host="github.com",
    )
    print(result)  # → {"id": 42, "url": "https://github.com/..."}

asyncio.run(main())
```

Or synchronously:

```python
from agentdom import dispatch_intent_sync

result = dispatch_intent_sync("repos.list", {"username": "octocat"}, host="github.com")
```

## Embed AgentDOM in your app

### Flask

```python
from flask import Flask
from agentdom import AgentDOM

app = Flask(__name__)
agent = AgentDOM(
    host="api.myapp.com",
    auth={"method": "api_key", "key_header": "Authorization"},
)

@agent.capability("todos.create", description="Create a new todo item",
                  args={"title": {"type": "string", "required": True}})
def create_todo(args):
    return {"id": 1, "title": args["title"]}

@agent.capability("todos.list", description="List all todo items")
def list_todos(args):
    return [{"id": 1, "title": "Buy milk"}]

agent.register(app)

# Now your app automatically serves:
#   GET  /.well-known/agentdom.json  → manifest
#   POST /api/agentdom/todos.create  → your handler
#   POST /api/agentdom/todos.list    → your handler
```

### FastAPI

```python
from fastapi import FastAPI
from agentdom import AgentDOM

app = FastAPI()
agent = AgentDOM(host="api.myapp.com")

@agent.capability("orders.ship", description="Ship a pending order",
                  args={"order_id": {"type": "string", "required": True}})
async def ship_order(args):
    # async handlers are fully supported
    return await shipping_service.ship(args["order_id"])

agent.register(app)
```

### Standalone manifest

```python
from agentdom import AgentDOM

agent = AgentDOM(host="api.myapp.com")

@agent.capability("items.create", description="Create an item")
def create_item(args):
    return {"created": True}

# Get the manifest dict to serve however you like
manifest = agent.manifest()
print(manifest)
# → {"version": "1.0", "host": "api.myapp.com", "capabilities": [...], ...}
```

## Auth configuration

```python
# API key
agent = AgentDOM(
    host="api.myapp.com",
    auth={
        "method": "api_key",
        "key_header": "Authorization",
        "key_format": "Bearer {token}",
    },
)

# OAuth 2.0
agent = AgentDOM(
    host="api.myapp.com",
    auth={
        "method": "oauth2",
        "auth_url":  "https://api.myapp.com/oauth/authorize",
        "token_url": "https://api.myapp.com/oauth/token",
        "scopes":    ["read", "write"],
    },
)

# No auth (public API)
agent = AgentDOM(host="api.myapp.com", auth={"method": "none"})
```

## Environment variables

| Variable | Description |
|---|---|
| `AGENTDOM_API_URL` | Override the AgentDOM API server URL |
| `AGENTDOM_TOKEN` | Default auth token for dispatch_intent |
| `<HOST>_TOKEN` | Per-host token (e.g. `GITHUB_COM_TOKEN`) |

## Agent Token Protocol

Publishers can declare an `agent_tokens` endpoint so agents provision their own scoped tokens automatically:

```python
agent = AgentDOM(
    host="api.myapp.com",
    auth={
        "method": "api_key",
        "agent_tokens": {
            "issue":  "POST https://api.myapp.com/agent-tokens",
            "revoke": "DELETE https://api.myapp.com/agent-tokens/{id}",
            "scopes": ["read", "write"],
            "max_ttl_seconds": 86400,
        },
    },
)
```

## Supported providers

| Provider | Auth | Capabilities |
|---|---|---|
| `github.com` | Device Flow | repos, issues, PRs, actions (811) |
| `linear.app` | OAuth 2.0 | issues, teams, cycles (8) |
| `slack.com` | OAuth 2.0 | messages, channels (6) |
| `notion.so` | OAuth 2.0 | pages, databases (6) |
| `stripe.com` | API Key | payments, customers (442) |
| `resend.com` | API Key | emails, domains (5) |

More providers at [getagentdom.com/providers](https://getagentdom.com/providers).

## License

MIT © [Ragavendhra Machikatla](https://github.com/RagavRida)
