"""
AgentDOM Python SDK
===================

The universal runtime that makes every website, desktop app,
and API accessible to AI agents — zero human in the loop.

    pip install agentdom

Usage (Flask):
    from agentdom import AgentDOM

    agent = AgentDOM(host="api.myapp.com")

    @agent.capability("todos.create", description="Create a todo")
    def create_todo(args):
        return {"id": 1, "title": args["title"]}

    agent.register(app)

Usage (FastAPI):
    from agentdom import AgentDOM

    agent = AgentDOM(host="api.myapp.com")

    @agent.capability("items.list", description="List items")
    async def list_items(args):
        return [{"id": 1, "name": "Widget"}]

    agent.register(fastapi_app)

Usage (standalone dispatch):
    from agentdom import dispatch_intent

    result = await dispatch_intent("issues.create", {
        "title": "Bug report",
        "body": "Reproducible on iOS 17"
    }, host="github.com")
"""

from agentdom.core import AgentDOM, AgentCapability
from agentdom.dispatch import dispatch_intent

__version__ = "1.0.0"
__all__ = ["AgentDOM", "AgentCapability", "dispatch_intent", "__version__"]
