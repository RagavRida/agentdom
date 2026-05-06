<p align="center">
  <img src="https://getagentdom.com/og-image.png" alt="AgentDOM" width="100%" />
</p>

<h1 align="center">AgentDOM</h1>

<p align="center">
  <strong>Universal AI agent protocol. Any software. Any transport. One function.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentdom"><img src="https://img.shields.io/npm/v/agentdom?color=f97316&label=npm" alt="npm" /></a>
  <a href="https://github.com/RagavRida/agentdom/actions"><img src="https://github.com/RagavRida/agentdom/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/RagavRida/agentdom/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <a href="https://getagentdom.com/docs"><img src="https://img.shields.io/badge/docs-getagentdom.com-orange" alt="Docs" /></a>
</p>

<p align="center">
  <a href="https://getagentdom.com">Website</a> ·
  <a href="https://getagentdom.com/docs">Docs</a> ·
  <a href="./VISION.md">Vision</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="https://discord.gg/agentdom">Discord</a>
</p>

---

## What is AgentDOM?

The web was built for humans. AgentDOM gives AI agents their own interface.

```js
dispatch_intent("issues.create", {
  title: "Login crash on iOS 17",
  priority: 1,
  teamId: "ENG"
}, "linear.app")
// → POST api.linear.app · { success: true, issue: { id: "ENG-42" } }
```

One function. Any software. AgentDOM discovers the fastest available transport — REST API, CLI tool, browser automation, or desktop accessibility — and executes the intent. No screenshots. No scraping. No hand-written integrations.

## Install

```bash
npm install -g agentdom
```

Runtime: Node 22+ (LTS) or Node 24.

## Quick start

```bash
# One-time setup — authenticate with any provider
agentdom setup linear.app         # OAuth PKCE — browser opens once
agentdom setup resend.com         # API key — paste once
agentdom setup github.com         # Device flow — enter code at URL

# Run a goal
agentdom goal "Create a Linear ticket for the login crash and assign to @alice"

# Or dispatch a specific intent
agentdom agent-token resend.com --scopes=emails:send
```

After setup, agents operate headlessly forever — no more human steps.

## Give credentials to an agent (no human at runtime)

```bash
# Package credentials as a single env var (Docker / serverless / CI)
agentdom wallet export --base64 --providers=linear.app,resend.com
# → AGENTDOM_WALLET_B64=eyJ3YWxsZXQi...

# Agent receives and uses — no human involved
docker run -e AGENTDOM_WALLET_B64=$AGENTDOM_WALLET_B64 your-agent
```

## Claude Desktop / Cursor (MCP)

```bash
claude mcp add agentdom-desktop -- node $(npm root -g)/agentdom/desktop-mcp-server.js
```

Or add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["$(npm root -g)/agentdom/desktop-mcp-server.js"]
    }
  }
}
```

## Highlights

- **`dispatch_intent`** — single function, 4 transports: `api → cli → browser → desktop`
- **Headless auth** — credentials resolved from 7 sources: env var → wallet → Keychain → AWS SSM → Vault → 1Password → Agent Token Protocol
- **Agent Token Protocol** — publishers issue scoped, short-lived tokens directly to agents (no browser redirect)
- **Policy engine** — per-effect allow/prompt/deny before any external action
- **Episodic memory** — agents recall past runs across sessions
- **MCP server** — 50+ tools exposed to Claude Code, Cursor, Continue
- **Publisher SDK** — `npx agentdom-publisher init` scaffolds `.well-known/agentdom.json`
- **13 polyfill manifests** — works today, even before publishers adopt the protocol

## Agent Token Protocol

Publishers declare an `agent_tokens` endpoint in their manifest. Agents provision their own scoped tokens — no human browser redirect needed after initial setup.

```json
"auth": {
  "agent_tokens": {
    "issue":  "POST https://api.yourapp.com/agent-tokens",
    "revoke": "DELETE https://api.yourapp.com/agent-tokens/{id}",
    "scopes": ["read", "write"],
    "max_ttl_seconds": 86400
  }
}
```

This is the missing M2M auth standard for AI agents — like AWS IAM roles, but for any software on the internet.

## Supported providers

| Provider | Auth | Intents |
|---|---|---|
| linear.app | OAuth2 | issues, teams, comments (8) |
| hubspot.com | OAuth2 | contacts, deals, companies (8) |
| vercel.com | API Key | deployments, projects, env vars (8) |
| slack.com | OAuth2 | messages, channels, reactions (6) |
| notion.so | OAuth2 | pages, databases, blocks (6) |
| supabase.com | API Key | projects, secrets, SQL (7) |
| resend.com | API Key | emails, domains (5) |
| cal.com | OAuth2 | bookings, availability (6) |
| github.com | Device | repos, issues, PRs, and more (811) |
| stripe.com | API Key | payments, customers, subscriptions (442) |
| openai.com | API Key | chat, embeddings, images (5) |
| anthropic.com | API Key | messages, models (2) |
| openrouter.ai | API Key | 300+ LLMs via one interface (3) |

## For publishers

Add agent support to your API in minutes:

```bash
npx agentdom-publisher init --openapi=./openapi.json --host=api.yourapp.com
npx agentdom-publisher validate
npx agentdom-publisher verify --host=api.yourapp.com
npx agentdom-publisher submit --host=api.yourapp.com
```

See [Publisher Guide](./docs/PUBLISHER-GUIDE.md) for the full walkthrough.

## Policy engine

Before any external action, AgentDOM classifies the intent's side effects and checks your policy:

```json
{
  "per_class": {
    "read":    "allow",
    "external": "prompt",
    "send":    "prompt",
    "delete":  "deny",
    "payment": "deny"
  }
}
```

```bash
agentdom policy show
agentdom approve abc123   # approve a pending action
agentdom deny   abc123   # deny it
```

## Security

Tokens are stored in `~/.agentdom/wallet.json` (mode `0600`) or your OS Keychain. They are never logged, never sent to AgentDOM servers, never included in telemetry.

See [SECURITY.md](./SECURITY.md) for the full security policy and responsible disclosure.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest contribution is adding a polyfill manifest for a new provider.

```bash
node tools/gen-manifest.js --openapi=https://api.example.com/openapi.json --host=api.example.com
```

## License

MIT © [Ragavendhra Machikatla](https://github.com/RagavRida)
