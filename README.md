<p align="center">
  <img src="https://getagentdom.com/og-image.png" alt="AgentDOM" width="100%" />
</p>

<h1 align="center">AgentDOM</h1>

<p align="center">
  <strong>The universal runtime that makes every website, desktop app, and API accessible to AI agents — zero human in the loop.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentdom"><img src="https://img.shields.io/npm/v/agentdom?color=f97316&label=npm&style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agentdom"><img src="https://img.shields.io/npm/dw/agentdom?color=f97316&style=flat-square" alt="weekly downloads" /></a>
  <a href="https://github.com/RagavRida/agentdom/stargazers"><img src="https://img.shields.io/github/stars/RagavRida/agentdom?style=flat-square&color=f97316" alt="Stars" /></a>
  <a href="https://github.com/RagavRida/agentdom/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT" /></a>
  <a href="https://github.com/RagavRida/agentdom/actions"><img src="https://img.shields.io/github/actions/workflow/status/RagavRida/agentdom/publish.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://pypi.org/project/agentdom/"><img src="https://img.shields.io/pypi/v/agentdom?color=3b82f6&style=flat-square&label=PyPI" alt="PyPI" /></a>
</p>

<p align="center">
  <a href="https://getagentdom.com">Website</a> ·
  <a href="https://getagentdom.com/docs">Docs</a> ·
  <a href="https://getagentdom.com/docs/quickstart">Quickstart</a> ·
  <a href="https://getagentdom.com/docs/python">Python SDK</a> ·
  <a href="https://getagentdom.com/docs/publisher">Publisher Guide</a> ·
  <a href="https://github.com/RagavRida/agentdom/blob/main/CHANGELOG.md">Changelog</a>
</p>

---

## About

AgentDOM is the missing infrastructure layer between AI agents and the internet.

- **Runtime** ([npm](https://npmjs.com/package/agentdom) | [pip](https://pypi.org/project/agentdom/)): Routes any intent to the right execution layer — REST API, browser, desktop, or CLI
- **Publisher SDK** (`npx agentdom-publisher`): Expose your software to AI agents via `.well-known/agentdom.json` in minutes
- **mcp-use bridge** (`npx agentdom-publisher mcpuse`): Turn any manifest into a working Claude/Cursor MCP server instantly

## Quick Start

### As a CLI

```bash
npm install -g agentdom

agentdom doctor              # check system health
agentdom auth github.com     # authenticate with a provider
agentdom tokens              # list authed providers
agentdom validate --all      # validate bundled manifests
agentdom serve               # start the MCP server (stdio)
agentdom serve --http        # start the HTTP API server instead
```

Run `agentdom --help` for the full list of subcommands.

### As a Library

```bash
npm install agentdom
```

```js
const { auth, registry, compiler } = require('agentdom');

const config = registry.resolve('github.com');
const token  = await auth.token('github.com');
```

Top-level exports: `auth`, `keychain`, `registry`, `runtime`, `planner`,
`policy`, `memory`, `resilience`, `connectionPool`, `tokenCache`,
`compiler`, `discover`, `platform`. Each subtree is lazy-loaded — only
the modules you touch are required.

### As an MCP Server (Claude Desktop / Cursor)

Add to `claude_desktop_config.json` (or the equivalent for your IDE):

```json
{
  "mcpServers": {
    "agentdom": { "command": "agentdom", "args": ["serve"] }
  }
}
```

## Install

```bash
# No install needed — use npx directly
npx agentdom@latest onboard

# Or install globally
npm install -g agentdom
```

Python:

```bash
pip install agentdom
# or: pip install "agentdom[flask]"  pip install "agentdom[fastapi]"
```

**Runtime:** Node 18+

## Quick start

```bash
# Step 1 — Guided setup wizard (one-time)
npx agentdom@latest onboard

# Step 2 — Connect integrations
npx agentdom@latest setup github.com      # Device flow — enter code at URL
npx agentdom@latest setup linear.app      # OAuth PKCE — browser opens once
npx agentdom@latest setup resend.com      # API key — paste once

# Step 3 — Run goals autonomously
npx agentdom@latest run "Create a Linear ticket for the iOS crash and assign to @alice"
npx agentdom@latest run "Send a weekly digest email to team@company.com via Resend"
npx agentdom@latest run "Open a GitHub PR for branch fix/login and request review from @bob"

# Health check
npx agentdom@latest doctor
```

## How intent routing works

```
dispatch_intent("issues.create", args, "github.com")
        │
        ├─ 1. API manifest?    → instant REST call (< 200ms)
        ├─ 2. CLI tool?        → local command execution
        ├─ 3. Web UI only?     → Chrome CDP + DOM automation
        └─ 4. Desktop app?     → macOS Accessibility bridge
```

No screenshots. No coordinate clicking. No hand-written integrations.

## Supported integrations (ready today)

| Provider | Auth | Capabilities |
|---|---|---|
| `github.com` | Device Flow | repos, issues, PRs, actions **(811)** |
| `stripe.com` | API Key | payments, customers, subscriptions **(442)** |
| `linear.app` | OAuth 2.0 | issues, teams, cycles, comments (8) |
| `hubspot.com` | OAuth 2.0 | contacts, deals, companies (8) |
| `vercel.com` | API Key | deployments, projects, env vars (8) |
| `slack.com` | OAuth 2.0 | messages, channels, reactions (6) |
| `notion.so` | OAuth 2.0 | pages, databases, blocks (6) |
| `supabase.com` | API Key | projects, secrets, SQL (7) |
| `resend.com` | API Key | emails, domains, broadcasts (5) |
| `cal.com` | OAuth 2.0 | bookings, availability (6) |
| `openai.com` | API Key | chat, embeddings, images (5) |
| `anthropic.com` | API Key | messages, models (2) |
| `openrouter.ai` | API Key | 300+ LLMs via one key (3) |

## Claude Desktop & Cursor (MCP)

```bash
claude mcp add agentdom -- node $(npm root -g)/agentdom/desktop-mcp-server.js
```

Or manually in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["/path/to/agentdom/desktop-mcp-server.js"]
    }
  }
}
```

## Embed in your own app

**Express:**

```js
const { agentdom } = require('agentdom/express');

app.use(agentdom({
  host: 'api.myapp.com',
  capabilities: [{
    intent: 'todos.create',
    description: 'Create a todo item',
    args: { title: { type: 'string', required: true } },
    handler: async (req, body) => db.todos.create(body.title),
  }],
}));
// Serves: GET  /.well-known/agentdom.json
//         POST /api/agentdom/todos.create
```

**Next.js (App Router):**

```js
// app/api/agentdom/[...intent]/route.js
import { AgentDOM } from 'agentdom/nextjs';

export const { GET, POST } = AgentDOM({
  host: 'myapp.com',
  capabilities: [{
    intent: 'users.invite',
    description: 'Invite a team member',
    args: { email: { type: 'string', required: true } },
    handler: async (req, body) => inviteUser(body.email),
  }],
});
```

**Python (Flask / FastAPI):**

```python
from agentdom import AgentDOM

agent = AgentDOM(host="api.myapp.com")

@agent.capability("orders.ship", description="Ship a pending order",
                  args={"order_id": {"type": "string", "required": True}})
async def ship_order(args):
    return await shipping_service.ship(args["order_id"])

agent.register(app)   # Flask or FastAPI
```

## Generate a mcp-use server from any manifest

```bash
# Generates a full TypeScript mcp-use server scaffold from any AgentDOM host
npx agentdom-publisher mcpuse --host=github.com --out=./github-mcp

# Python variant
npx agentdom-publisher mcpuse --host=github.com --lang=python

cd ./github-mcp && npm install && npm start
# → Inspector: http://localhost:3000/inspector
# → Connect to Claude Desktop or any MCP client
```

## Publisher SDK — add AI agent support to your API

```bash
# Generate manifest from your OpenAPI spec
npx agentdom-publisher init --openapi=./openapi.json --host=api.myapp.com

# Validate locally
npx agentdom-publisher validate

# Verify live deployment
npx agentdom-publisher verify --host=api.myapp.com

# Test a real dispatch
npx agentdom-publisher test --host=api.myapp.com --intent=contacts.list --token=sk-...

# Submit to the AgentDOM public registry
npx agentdom-publisher submit --host=api.myapp.com

# Generate mcp-use server scaffold
npx agentdom-publisher mcpuse --host=api.myapp.com --out=./my-mcp-server
```

## CI / Docker / serverless (headless)

```bash
# Export credentials as a portable base64 string (human runs this once)
agentdom wallet export --base64 --providers=linear.app,resend.com
# → AGENTDOM_WALLET_B64=eyJ3YWxsZXQi...

# Agent receives it at runtime — no human needed
docker run -e AGENTDOM_WALLET_B64=$AGENTDOM_WALLET_B64 \
           -e OPENROUTER_API_KEY=$OPENROUTER_API_KEY \
           your-agent-image
```

## Policy engine

```bash
agentdom policy show                    # view current rules
agentdom policy set external=allow      # allow all external API calls
agentdom policy set send=prompt         # ask before emails/messages
agentdom approve <id>                   # approve a pending action
agentdom deny <id>                      # deny it
```

## Deploy to AWS

```bash
./deploy-aws.sh sk-or-v1-YOUR_KEY
```

One command: ECS Fargate + ALB + CloudFront + S3 + Secrets Manager + CloudWatch. See [AWS-DEPLOY.md](https://github.com/RagavRida/agentdom/blob/main/AWS-DEPLOY.md).

## All CLI commands

```
npx agentdom@latest onboard              Interactive setup wizard
npx agentdom@latest setup <provider>     One-time credential setup
npx agentdom@latest run "<goal>"         Execute a natural language goal
npx agentdom@latest doctor               Health check
npx agentdom@latest wallet list          Show stored credentials
npx agentdom@latest wallet export        Export for CI/Docker
npx agentdom@latest policy show          View policy rules
npx agentdom@latest approve <id>         Approve a pending action
npx agentdom@latest memory stats         Episodic memory stats
npx agentdom@latest launch               Browser REPL (interactive)
npx agentdom@latest --version            Print version
npx agentdom@latest --help               Show this help
```

## Security

Credentials are stored in `~/.agentdom/wallet.json` (mode `0600`) or OS Keychain. Never logged, never sent to AgentDOM servers. See [SECURITY.md](https://github.com/RagavRida/agentdom/blob/main/SECURITY.md).

## License

MIT © [Ragavendhra Machikatla](https://github.com/RagavRida)
