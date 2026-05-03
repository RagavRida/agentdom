---
app: Stub API
platform: api
version: 1
notes:
  - Manifest used by the live MCP test harness. Spins up an httpd that echoes JSON bodies back.
tools:
  - name: echo
    description: Send a string to /echo and read the echoed body back.
    params:
      message:
        type: string
        required: true
    steps:
      - request:
          method: POST
          path: /echo
          body:
            message: ${message}
      - read: body.body.message
  - name: ping
    description: Hit GET /echo?q=...; returns the request envelope the stub echoes.
    params:
      q:
        type: string
        required: true
    steps:
      - request:
          method: GET
          path: /echo?q=${q}
      - read: body.path
---

# AgentDOM Manifest — Stub API

Tiny test fixture used by `test/mcp-servers.test.js`. Two tools, both
backed by the in-process stub the test starts on a random local port.

## Why this manifest exists

The auto-emitted tools from the OpenAPI adapter cover the operations
declared in the spec — `createX`, `listX`, `deleteX` etc. The manifest
adds *agent-friendly intents* on top: `echo({message})` is what an agent
wants to call, not `create({message: ..., body:..., headers:...})`.

Same pattern applies to any production API: ship a manifest with the
five-to-fifteen highest-leverage operations as named typed tools, and
let agents compose against those instead of the full surface.
