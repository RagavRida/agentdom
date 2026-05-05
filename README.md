<div align="center">

# AgentDOM

**The universal protocol for AI agents to interact with any software.**

[![npm version](https://img.shields.io/npm/v/agentdom?color=orange&label=agentdom)](https://www.npmjs.com/package/agentdom)
[![npm downloads](https://img.shields.io/npm/dm/agentdom?color=orange)](https://www.npmjs.com/package/agentdom)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-green)](package.json)

**[Website](https://getagentdom.com)** · **[Docs](https://getagentdom.com/docs)** · **[npm](https://www.npmjs.com/package/agentdom)** · **[Publisher Guide](docs/PUBLISHER-GUIDE.md)**

</div>

> Agents are already browsing the web, making purchases, and managing CRMs. But they're doing it on top of software designed for humans — clicking buttons, scraping screenshots, guessing CSS selectors.
>
> **AgentDOM gives agents machine-readable access to any software — REST APIs, SaaS tools, desktop apps, and CLIs — through a single semantic interface.**

```bash
npm install -g agentdom
agentdom auth linear.app        # one-time OAuth consent
agentdom goal "Create a bug report in Linear for the login crash"
```

Agents are already browsing the web, making purchases, and managing CRMs. But they're doing it on top of software designed for humans — clicking buttons, scraping screens, guessing CSS selectors. **AgentDOM replaces that with a machine-native foundation.**

Instead of visual interfaces (forms, buttons, dashboards), agents get:
- **Machine-readable interfaces** — `dispatch_intent("issues.create", {...})` 
- **Secure auth** — OAuth tokens in your OS Keychain, never in a cloud
- **Universal surface coverage** — REST APIs, GraphQL, native desktop, browser UI, CLI

---

## How It Works

```
Agent Goal: "Create a Linear ticket for the login crash"
              ↓
         AgentDOM Planner
         (generates plan, validates, checks policy)
              ↓
         Dispatch Router
         (finds cheapest transport: API < CLI < UI)
              ↓
         Auth Wallet
         (Keychain token for linear.app, zero prompts after first consent)
              ↓
         POST https://api.linear.app/graphql
         → { success: true, issue: { id: "ENG-42", url: "..." } }
```

No browser. No screenshot. No HTML parsing. **One round trip.**

---

## Quick Start

```bash
# Install globally
npm install -g agentdom

# Authenticate with a SaaS provider (one-time, browser opens for OAuth)
agentdom auth linear.app
agentdom auth resend.com     # prompts for API key
agentdom auth github.com     # device flow

# Run a goal (AI-planned, auto-dispatched)
agentdom goal "Create a high-priority bug in Linear titled 'Login crash on iOS'"

# Dispatch a single intent directly
agentdom intent issues.create --provider=linear.app --title="Login crash" --priority=1

# Check what's in your wallet
agentdom wallet list

# Policy: approve/deny pending actions
agentdom policy show
agentdom approve <id>
agentdom deny <id>

# Memory: what happened in past sessions
agentdom memory stats
agentdom memory recall --provider=linear.app
```

---

## MCP Integration (Claude, Cursor, any MCP client)

```bash
# Claude Code
claude mcp add agentdom-desktop -- node $(npm root -g)/agentdom/desktop-mcp-server.js

# claude_desktop_config.json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["$(npm root -g)/agentdom/desktop-mcp-server.js"]
    }
  }
}
```

Once connected, the agent gets **50+ tools automatically** — no configuration:

| Tool | What it does |
|------|-------------|
| `dispatch_intent` | Execute any semantic intent on any connected provider |
| `wallet_auth` | Connect a SaaS provider via OAuth/API key |
| `wallet_list` | List all authenticated providers |
| `policy_list` | Show current permission policy |
| `policy_approve` | Approve a pending action |
| `memory_recall` | Search past agent runs |
| `clickElement` | Click any UI element by label (no selectors) |
| `typeText` | Type into any input field |
| `observe` | Read desktop state, clipboard, running apps |
| `scan_app` | Discover all capabilities of a running app |
| ... | 40+ more covering web, desktop, system |

---

## The Standard: `.well-known/agentdom.json`

Like `robots.txt` for crawlers, vendors publish a machine-readable capability manifest:

```json
{
  "version": "1.0",
  "host": "linear.app",
  "auth": { "method": "oauth2", "auth_url": "...", "token_url": "..." },
  "capabilities": [
    {
      "intent": "issues.create",
      "transport": "api",
      "method": "POST",
      "endpoint": "https://api.linear.app/graphql",
      "args": { "title": { "type": "string", "required": true } },
      "side_effects": ["external"]
    }
  ]
}
```

**Vendors who haven't published this yet?** AgentDOM automatically generates polyfill manifests from their public OpenAPI spec and hosts them at `agentdom.dev/manifests/{host}.json`. **Zero vendor cooperation required.**

---

## Supported Providers (Polyfill Manifests)

| Provider | Auth | Key Intents |
|----------|------|-------------|
| `linear.app` | OAuth2 PKCE | issues.create/list/update, teams.list, comments.create |
| `resend.com` | API Key | emails.send, domains.list |
| `cal.com` | OAuth2 PKCE | bookings.create/list/cancel, availability.list |
| `github.com` | Device Flow | 800+ operations auto-compiled from OpenAPI |
| `stripe.com` | API Key | 440+ operations |
| ... more every week | | |

---

## Auth Wallet — Tokens Never Leave Your Machine

```bash
agentdom auth hubspot.com
# → Opens browser → OAuth PKCE flow → Token stored in macOS Keychain
# → All future calls use this token silently, auto-refreshed
```

**Unlike Composio or Zapier**, AgentDOM is local-first:
- Tokens stored in OS Keychain (macOS/Windows/Linux)
- No cloud proxy — 1 network hop instead of 2
- Works fully offline (bundled manifests + cached tokens)
- Open standard — self-hostable, no account required

---

## Policy Engine — Human-in-the-Loop When It Matters

```json
// ~/.agentdom/policy.json
{
  "per_class": {
    "read":        "allow",
    "write_local": "allow",
    "send":        "prompt",    // emails need approval
    "external":    "prompt",    // API writes need approval
    "delete":      "deny",      // never auto-delete
    "payment":     "deny"       // never auto-charge
  }
}
```

When an action needs approval:
```
[AgentDOM Policy] Action requires approval.
  Effects:  external
  Intent:   contacts.create
  Provider: hubspot.com
  Run:  agentdom approve abc123   (or: agentdom deny abc123)
```

---

## Surface Coverage

| Surface | How | Status |
|---------|-----|--------|
| SaaS REST APIs | Keychain token + HTTP | ✅ |
| GraphQL APIs | POST + auth | ✅ |
| Web apps (browser) | Chrome DevTools Protocol | ✅ |
| Shadow DOM, iframes | CDP traversal | ✅ |
| React/Vue inputs | Native setter bypass | ✅ |
| Electron apps | CDP + Accessibility API | ✅ |
| macOS native apps | Accessibility API (AX) | ✅ |
| CLI tools | Process bridge | ✅ |
| Linux desktop | AT-SPI | 🔜 |
| Windows desktop | UIAutomation | 🔜 |

---

## Architecture

```
Agent (Claude / GPT / LangGraph / Custom)
    │  MCP (stdio/SSE)
    ▼
AgentDOM MCP Server (local process)
    ├── Planner        plan → validate → execute → verify → replan
    ├── Policy Engine  allow / prompt / deny per side-effect class
    ├── Memory         cross-session episodic store
    ├── Dispatch Router  intent → cheapest transport
    │   ├── API Bridge    REST/GraphQL + Keychain token
    │   ├── CDP Bridge    browser / Electron via Chrome DevTools
    │   └── AX Bridge     macOS / desktop accessibility
    └── Auth Wallet    OS Keychain + OAuth PKCE + auto-refresh
```

---

## For Publishers: Publish Your Own Manifest

```bash
npx agentdom-publisher init --openapi=./openapi.json --host=api.myapp.com
# → generates .well-known/agentdom.json
# → deploy to https://api.myapp.com/.well-known/agentdom.json
```

Agents will instantly discover and use your product without any additional integration work. Display the AgentDOM Native badge to signal readiness.

---

## License

MIT — free to use, self-host, and extend.

---

*AgentDOM is the foundation for the agentic economy. Agents need machine-readable software. We're building it.*

**[agentdom.dev](https://agentdom.dev)** · [GitHub](https://github.com/RagavRida/agentdom) · [npm](https://www.npmjs.com/package/agentdom)
