# AGENT-UI — Direct MCP Connect

How an agent (Claude Desktop, Cursor, Continue, any MCP-compatible client) talks
to AgentDOM **without ever issuing a generic `click(selector)` or `scroll(px)`**.

The agent connects once, AgentDOM scans the live UI, runs it through the
compiler (`scan → IR → optimize → codegen`), and registers a set of **typed,
named tools** the agent invokes by name. Selectors stay on the AgentDOM side.

---

## Try it

The product is the MCP server. Connect any MCP client and tell it what to
do in plain English — the LLM picks the tools.

```bash
# Wire desktop server into Claude Code (the CLI):
claude mcp add agentdom-desktop \
  node /path/to/agent-schema/desktop-mcp-server.js

# Then in any session:
#   "Compute 49×17 in Calculator and tell me the answer."
#   "Open TextEdit and write 'hello world'."
#   "Use discover_surfaces, then drive whichever app offers messaging.send."
```

For Claude Desktop / Cursor / Cline / Continue, drop the same command +
args into the client's `mcpServers` config. No demos to run, no goals to
script — the LLM uses scan_app/launch_electron/discover_surfaces/the
manifest tools directly.

Regression tests (run before release, not for daily use):

```bash
npm run test:compiler  # 16-case IR/optimizer/codegen unit tests
npm run test:mcp       # 16-case live MCP harness (CLI + API + Desktop)
npm run test:launch    # 6-case launcher round-trip (live Chrome)
npm run test:electron  # 9-case CDP bridge round-trip (headless Chrome)
```

## TL;DR

```
Agent (Claude / Cursor)
   │
   │   MCP over stdio
   ▼
AgentDOM MCP server
   │
   │   scan(app) ─▶ compile() ─▶ tools/list_changed
   ▼
Typed tools the agent calls:
   authenticate(email, password)
   create_pet(name, age, species)
   navigate(target)
   ...
```

The agent never sees `click`, `type`, `scroll`, or a CSS/AX selector. Those are
internal primitives the server uses to fulfil the typed tool calls.

---

## 1. The split

| Generic-primitive model (avoid)                                          | Direct-connect model (use)                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `scan()` → returns 200 elements with selectors                          | `compile()` → returns ~12 typed tools                            |
| Agent reasons about which `<button class="btn-primary _xyz">` to click   | Agent calls `submit_login_form({email, password})`               |
| Every action = LLM call to pick a selector + LLM call to fill values     | One LLM call → one tool call                                     |
| Breaks the moment the DOM/AX tree changes                                | `tools/list_changed` fires on UI change; agent gets a fresh list |
| Non-deterministic (LLM might hallucinate selectors)                      | Deterministic — the compiler picks the selector                  |

---

## 2. Install

```bash
npm install -g agentdom
# or, no-install via npx:
npx agentdom --version
```

Two MCP servers ship in the package:

| Server                       | Surface                          | Script                     |
| ---------------------------- | -------------------------------- | -------------------------- |
| `mcp-server.js`              | Web (Puppeteer-driven Chromium)  | `npm run mcp`              |
| `desktop-mcp-server.js`      | macOS / Windows native apps      | `npm run mcp:desktop`      |
| `mcp-cli-server.js`          | Any CLI binary on PATH           | `npm run mcp:cli`          |
| `mcp-api-server.js`          | Any OpenAPI 3.x spec             | `npm run mcp:api`          |

All four speak MCP over stdio. Each exposes a single `scan_*` meta-tool that
auto-emits typed tools via `compile()`.

---

## 3. Wire it into the client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentdom-web": {
      "command": "npx",
      "args": ["-y", "agentdom", "mcp"]
    },
    "agentdom-desktop": {
      "command": "npx",
      "args": ["-y", "agentdom", "mcp:desktop"]
    }
  }
}
```

Restart Claude Desktop. The agent picks up two new connections: one for web,
one for desktop.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["/abs/path/to/agentdom/mcp-server.js"]
    }
  }
}
```

### Continue (VS Code / JetBrains)

Add to `~/.continue/config.json` under `mcpServers` — same shape as above.

---

## 4. The connect flow

```
1. Client launches MCP server  → agentdom prints capabilities, waits for stdio.
2. Client requests tools/list  → server returns base + dynamic tools.
3. Agent calls scan_with_tools(URL)   ← web
   or       scan_app(appName)         ← desktop
4. Server scans → compile() → registers typed tools internally.
5. Server emits notifications/tools/list_changed.
6. Client refreshes tools/list → now sees authenticate, create_*, navigate, etc.
7. Agent calls e.g. authenticate({email, password})
8. Server resolves to the right selector + dispatches the click/type primitives.
9. UI changes → server emits tools/list_changed → client refreshes again.
```

The agent only ever calls **named typed tools**. The scan + click + scroll
primitives are still exposed as escape hatches for cases the compiler doesn't
cover, but the agent shouldn't need them in normal flow.

---

## 5. What the agent gets — by source

### 5.1 Web (`scan_with_tools` against a Puppeteer page)

```jsonc
// After visiting https://crm.example.com/login:
[
  {
    "name": "authenticate",
    "description": "Submit \"Sign In\" form on CRM Login.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "email":    { "type": "string", "description": "Email" },
        "password": { "type": "string", "description": "Password" }
      },
      "required": ["email", "password"]
    }
  },
  {
    "name": "navigate",
    "description": "Follow a navigation link.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "target": { "type": "string", "enum": ["Forgot password?", "Sign up"] }
      },
      "required": ["target"]
    }
  }
]
```

### 5.2 Desktop (`scan_app('Slack')`)

```jsonc
[
  { "name": "click_send",     "inputSchema": { ... } },
  { "name": "type_message",   "inputSchema": { "properties": { "text": {"type": "string"} } } },
  { "name": "navigate",       "inputSchema": { "properties": { "target": { "enum": ["File", "Edit", "View", "Workspace"] } } } }
]
```

When the framework is detected as Electron, the server prepends a `_meta`
notice so the agent knows web-content tools may be partial.

### 5.3 CLI (`scan_cli('docker')`)

Run `<binary> --help` once, get every subcommand and flag as a typed tool:

```jsonc
[
  { "name": "click_run",   "description": "Run docker run." },
  { "name": "click_build", "description": "Run docker build." },
  // ...57 more — verified end-to-end
  { "name": "docker",      "inputSchema": { "properties": { "debug": {"type":"boolean"}, "tlsverify":{"type":"boolean"} } } }
]
```

### 5.4 API (`scan_api(openapi_url)`)

Each operation becomes a tool with full request-body typing, including enums
and required-field flags:

```jsonc
[
  {
    "name": "create",
    "description": "POST /pets — Create a pet.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name":    { "type": "string" },
        "age":     { "type": "number" },
        "species": { "type": "string", "enum": ["cat", "dog", "bird"] }
      },
      "required": ["name"]
    }
  }
]
```

---

## 6. Refresh & invalidation

| Trigger                           | Server action                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------ |
| Page navigation (web)             | Auto re-scan, emit `tools/list_changed`.                                       |
| SPA route change (web)            | Detected via `framenavigated`; same.                                           |
| Modal/sheet opens (desktop)       | Sheet recursion in scan; next tool call triggers re-scan.                      |
| Different app brought to front    | Client re-issues `scan_app(newName)`.                                          |
| Tool call fails (selector stale)  | Server returns `{ isError, hint: "Run scan to refresh"; }`. Agent re-scans.   |

The compiler is fast enough (15–30ms for a typical scan) that re-scanning on
every navigation is the default, not the optimization.

---

## 7. Why this beats screenshot-based agents

| Dimension       | AgentDOM direct-connect                              | Screenshot + LLM-vision                               |
| --------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Latency         | 15–30ms scan + tool dispatch                         | 500–2000ms per LLM vision call                        |
| Cost / action   | $0 (pure local code)                                 | $0.01–0.10 (vision tokens)                            |
| Determinism     | Same UI → same tools                                 | Probabilistic — vision LLM may misread layout         |
| Offline         | Yes                                                  | No — needs vision LLM API                             |
| Form filling    | Native typed tool calls                              | Vision must locate the field, then type into it       |
| Surface support | Web + Desktop (mac/win) + CLI + API                  | Whatever you can screenshot — usually web only        |

---

## 8. Troubleshooting

| Symptom                                              | Cause / fix                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tools/list` returns only the meta tools             | Agent hasn't called `scan_with_tools` / `scan_app` yet. That's expected — first call registers the rest. |
| `App not running. Hint: call openApp() first.`       | Open the target app, or call `openApp(appName)` as a tool first.                                         |
| `Permission needed: System Settings > ...`           | macOS Accessibility not granted to the terminal/Node binary running the server.                         |
| `Element not found. Hint: Run scanApp() to refresh.` | UI changed since last scan. The next scan call re-registers tools.                                       |
| Agent calls `click(selector)` directly               | The agent shouldn't need to. If it does, the server is emitting only primitives — confirm `scan_with_tools` was called and `tools/list_changed` was honored. |

---

## 9. Status today

| Server                              | Meta-tool       | Status |
| ----------------------------------- | --------------- | ------ |
| Web `mcp-server.js`                 | `scan_with_tools` | ✅ Auto-emits typed tools (legacy `ToolSynthesizer`; migration to the new compiler is a follow-up). |
| Desktop `desktop-mcp-server.js`     | `scan_app`      | ✅ Routed through `compiler/`. Forms → `typeIntoField` per arg + `clickElement` on submit; actions → `clickElement`; navigation → `clickElement` on link label. `platform.toMCPTools()` capabilities exposed as escape hatches. |
| CLI `mcp-cli-server.js`             | `scan_cli`      | ✅ Routed through `compiler/`. Forms → `execFileSync(binary, [--flag value, ...])`; actions → `execFileSync(binary, [subcommand])`. Returns `{exitCode, stdout, stderr}`. |
| API `mcp-api-server.js`             | `scan_api`      | ✅ Routed through `compiler/`. Forms/actions → `fetch(base + path, {method, headers, body})`. Splits args by `_internal.fields[].selector` prefix (`path:` / `query:` / `header:` / `body:`). |

All four servers call `compile(scan, { from, to: 'mcp' })` internally — same IR,
same optimizer, same MCP shape. New surfaces should follow this contract rather
than re-implementing tool synthesis.
