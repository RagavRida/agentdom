"""
AgentDOM Python SDK
===================

Makes any Python web app instantly accessible to AI agents.
Supports Flask, FastAPI, and plain WSGI/ASGI.

Install:
    pip install agentdom

Usage (Flask):
    from agentdom import AgentDOM
    agent = AgentDOM(host="api.myapp.com", auth={"method": "api_key", ...})

    @agent.capability("todos.create", description="Create a todo", args={"title": "string"})
    def create_todo(args):
        return {"id": 1, "title": args["title"]}

    agent.register(app)  # attaches /.well-known/agentdom.json + /api/agentdom/<intent>

Usage (FastAPI):
    from agentdom import AgentDOM
    agent = AgentDOM(host="api.myapp.com")

    @agent.capability("items.list", description="List items")
    def list_items(args):
        return [{"id": 1, "name": "Widget"}]

    agent.register(fastapi_app)

Usage (standalone manifest):
    manifest = agent.manifest()   # dict ready to serve as JSON
"""

import json
import datetime
import functools
from typing import Callable, Dict, Any, Optional, List


class AgentCapability:
    def __init__(self, intent: str, description: str, handler: Callable,
                 args: dict = None, side_effects: list = None,
                 method: str = "POST"):
        self.intent = intent
        self.description = description
        self.handler = handler
        self.args = args or {}
        self.side_effects = side_effects or ["write_local"]
        self.method = method


class AgentDOM:
    def __init__(self,
                 host: str,
                 name: str = None,
                 description: str = None,
                 auth: dict = None,
                 api_base_path: str = "/api/agentdom"):
        self.host = host
        self.name = name or host
        self.description = description or f"AgentDOM manifest for {host}"
        self.auth = auth or {"method": "none"}
        self.api_base_path = api_base_path
        self._capabilities: List[AgentCapability] = []

    def capability(self, intent: str, description: str = "",
                   args: dict = None, side_effects: list = None,
                   method: str = "POST"):
        """Decorator to register a capability handler."""
        def decorator(fn: Callable):
            cap = AgentCapability(
                intent=intent,
                description=description,
                handler=fn,
                args=args or {},
                side_effects=side_effects or ["write_local"],
                method=method
            )
            self._capabilities.append(cap)
            return fn
        return decorator

    def manifest(self) -> dict:
        """Build and return the agentdom.json manifest dict."""
        return {
            "version": "1.0",
            "host": self.host,
            "name": self.name,
            "description": self.description,
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "generated_by": "agentdom-python-sdk",
            "auth": self.auth,
            "capabilities": [
                {
                    "intent": cap.intent,
                    "description": cap.description,
                    "transport": "api",
                    "method": cap.method,
                    "endpoint": f"https://{self.host}{self.api_base_path}/{cap.intent}",
                    "args": {
                        k: {"type": v if isinstance(v, str) else v.get("type", "string"),
                            "required": v.get("required", False) if isinstance(v, dict) else True,
                            "description": v.get("description", "") if isinstance(v, dict) else ""}
                        for k, v in cap.args.items()
                    },
                    "side_effects": cap.side_effects,
                }
                for cap in self._capabilities
            ],
        }

    def register(self, app):
        """Auto-detect Flask or FastAPI and register all routes."""
        app_type = type(app).__module__

        if "flask" in app_type:
            self._register_flask(app)
        elif "fastapi" in app_type:
            self._register_fastapi(app)
        else:
            raise ValueError("Pass a Flask or FastAPI app instance. For ASGI/WSGI, use .asgi_app() or .wsgi_app().")

    def _register_flask(self, app):
        """Attach routes to a Flask app."""
        from flask import request, jsonify

        manifest = self.manifest()

        @app.route("/.well-known/agentdom.json", methods=["GET"])
        def agentdom_manifest():
            return jsonify(manifest)

        cap_map = {cap.intent: cap for cap in self._capabilities}

        @app.route(f"{self.api_base_path}/<path:intent>", methods=["POST"])
        def agentdom_intent(intent):
            cap = cap_map.get(intent)
            if not cap:
                return jsonify({"error": f"Intent '{intent}' not found",
                                "available": list(cap_map.keys())}), 404
            try:
                body = request.get_json(silent=True) or {}
                result = cap.handler(body)
                return jsonify({"success": True, "result": result})
            except Exception as e:
                return jsonify({"success": False, "error": str(e)}), 500

    def _register_fastapi(self, app):
        """Attach routes to a FastAPI app."""
        from fastapi import Request
        from fastapi.responses import JSONResponse

        manifest = self.manifest()

        @app.get("/.well-known/agentdom.json")
        async def agentdom_manifest():
            return JSONResponse(manifest, headers={"Cache-Control": "public, max-age=3600"})

        cap_map = {cap.intent: cap for cap in self._capabilities}

        @app.post(f"{self.api_base_path}/{{intent:path}}")
        async def agentdom_intent(intent: str, request: Request):
            cap = cap_map.get(intent)
            if not cap:
                return JSONResponse({"error": f"Intent '{intent}' not found",
                                    "available": list(cap_map.keys())}, status_code=404)
            try:
                body = await request.json()
            except Exception:
                body = {}
            try:
                import asyncio
                if asyncio.iscoroutinefunction(cap.handler):
                    result = await cap.handler(body)
                else:
                    result = cap.handler(body)
                return JSONResponse({"success": True, "result": result})
            except Exception as e:
                return JSONResponse({"success": False, "error": str(e)}, status_code=500)
