"""
agentdom.core — AgentDOM class and capability registration.
"""

import datetime
from typing import Callable, List, Optional


class AgentCapability:
    """A single declared capability (intent + handler)."""

    def __init__(
        self,
        intent: str,
        description: str,
        handler: Callable,
        args: dict = None,
        side_effects: list = None,
        method: str = "POST",
    ):
        self.intent = intent
        self.description = description
        self.handler = handler
        self.args = args or {}
        self.side_effects = side_effects or ["write_local"]
        self.method = method


class AgentDOM:
    """
    Embed AgentDOM into any Python web app.

    Serves /.well-known/agentdom.json automatically and routes
    incoming agent intents to your handler functions.

    Args:
        host:          Your public domain (e.g. "api.myapp.com")
        name:          Human-readable name (defaults to host)
        description:   Short description of your service
        auth:          Auth config dict, e.g. {"method": "api_key", ...}
        api_base_path: Route prefix for intent endpoints (default: /api/agentdom)
    """

    def __init__(
        self,
        host: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        auth: Optional[dict] = None,
        api_base_path: str = "/api/agentdom",
    ):
        if not host:
            raise ValueError("AgentDOM: host is required")
        self.host = host
        self.name = name or host
        self.description = description or f"AgentDOM manifest for {host}"
        self.auth = auth or {"method": "none"}
        self.api_base_path = api_base_path
        self._capabilities: List[AgentCapability] = []

    def capability(
        self,
        intent: str,
        description: str = "",
        args: dict = None,
        side_effects: list = None,
        method: str = "POST",
    ):
        """
        Decorator to register a capability handler.

        Example:
            @agent.capability("todos.create", description="Create a todo")
            def create_todo(args):
                return db.todos.insert(args["title"])
        """
        def decorator(fn: Callable):
            cap = AgentCapability(
                intent=intent,
                description=description,
                handler=fn,
                args=args or {},
                side_effects=side_effects or ["write_local"],
                method=method,
            )
            self._capabilities.append(cap)
            return fn
        return decorator

    def manifest(self) -> dict:
        """
        Build and return the agentdom.json manifest as a Python dict.
        Serve this at GET /.well-known/agentdom.json.
        """
        return {
            "version": "1.0",
            "host": self.host,
            "name": self.name,
            "description": self.description,
            "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
            "generated_by": "agentdom-python/1.0.0",
            "auth": self.auth,
            "capabilities": [
                {
                    "intent": cap.intent,
                    "description": cap.description,
                    "transport": "api",
                    "method": cap.method,
                    "endpoint": f"https://{self.host}{self.api_base_path}/{cap.intent}",
                    "args": {
                        k: {
                            "type": v if isinstance(v, str) else v.get("type", "string"),
                            "required": v.get("required", False) if isinstance(v, dict) else True,
                            "description": v.get("description", "") if isinstance(v, dict) else "",
                        }
                        for k, v in cap.args.items()
                    },
                    "side_effects": cap.side_effects,
                }
                for cap in self._capabilities
            ],
        }

    def register(self, app):
        """
        Auto-detect Flask or FastAPI and register all routes.

        Registers:
          GET  /.well-known/agentdom.json   → serves the manifest
          POST /api/agentdom/<intent>        → dispatches to your handler
        """
        app_module = type(app).__module__

        if "flask" in app_module:
            self._register_flask(app)
        elif "fastapi" in app_module:
            self._register_fastapi(app)
        else:
            raise ValueError(
                "AgentDOM.register() expects a Flask or FastAPI app instance. "
                "For other frameworks, use .manifest() and route manually."
            )

    def _register_flask(self, app):
        """Attach routes to a Flask app."""
        from flask import request, jsonify

        manifest = self.manifest()
        cap_map = {cap.intent: cap for cap in self._capabilities}

        @app.route("/.well-known/agentdom.json", methods=["GET"])
        def agentdom_manifest():
            return jsonify(manifest)

        @app.route(f"{self.api_base_path}/<path:intent>", methods=["POST"])
        def agentdom_intent(intent):
            cap = cap_map.get(intent)
            if not cap:
                return jsonify({
                    "error": f"Intent '{intent}' not found",
                    "available": list(cap_map.keys()),
                }), 404

            try:
                body = request.get_json(silent=True) or {}
                result = cap.handler(body)
                return jsonify({"success": True, "result": result})
            except Exception as exc:
                return jsonify({"success": False, "error": str(exc)}), 500

    def _register_fastapi(self, app):
        """Attach routes to a FastAPI app."""
        from fastapi import Request
        from fastapi.responses import JSONResponse

        manifest = self.manifest()
        cap_map = {cap.intent: cap for cap in self._capabilities}

        @app.get("/.well-known/agentdom.json")
        async def agentdom_manifest():
            return JSONResponse(
                manifest,
                headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"},
            )

        @app.post(f"{self.api_base_path}/{{intent:path}}")
        async def agentdom_intent(intent: str, request: Request):
            import asyncio
            cap = cap_map.get(intent)
            if not cap:
                return JSONResponse(
                    {"error": f"Intent '{intent}' not found", "available": list(cap_map.keys())},
                    status_code=404,
                )
            try:
                body = await request.json()
            except Exception:
                body = {}
            try:
                if asyncio.iscoroutinefunction(cap.handler):
                    result = await cap.handler(body)
                else:
                    result = cap.handler(body)
                return JSONResponse({"success": True, "result": result})
            except Exception as exc:
                return JSONResponse({"success": False, "error": str(exc)}, status_code=500)
