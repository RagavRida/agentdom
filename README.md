<p align="center">
  <img src="https://getagentdom.com/og-image.png" alt="AgentDOM" width="100%" />
</p>

<h1 align="center">AgentDOM</h1>

<p align="center">
  <strong>The universal runtime that makes every website, desktop app, and API accessible to AI agents — zero human in the loop.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentdom"><img src="https://img.shields.io/npm/v/agentdom?color=f97316&label=npm&style=flat-square" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/agentdom"><img src="https://img.shields.io/npm/dw/agentdom?color=f97316&style=flat-square" alt="npm downloads" /></a>
  <a href="https://github.com/RagavRida/agentdom/stargazers"><img src="https://img.shields.io/github/stars/RagavRida/agentdom?style=flat-square&color=f97316" alt="GitHub Stars" /></a>
  <a href="https://github.com/RagavRida/agentdom/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" /></a>
  <a href="https://github.com/RagavRida/agentdom/actions"><img src="https://img.shields.io/github/actions/workflow/status/RagavRida/agentdom/publish.yml?style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://getagentdom.com/docs"><img src="https://img.shields.io/badge/docs-getagentdom.com-orange?style=flat-square" alt="Docs" /></a>
</p>

<p align="center">
  <a href="https://getagentdom.com">Website</a> ·
  <a href="https://getagentdom.com/docs">Docs</a> ·
  <a href="https://getagentdom.com/docs/quickstart">Quickstart (JS)</a> ·
  <a href="https://getagentdom.com/docs/python">Quickstart (Python)</a> ·
  <a href="./VISION.md">Vision</a> ·
  <a href="./CHANGELOG.md">Changelog</a> ·
  <a href="https://discord.gg/agentdom">Discord</a>
</p>

---

## About

AgentDOM is the missing infrastructure layer between AI agents and the internet.

- **Use the AgentDOM SDK** ([js](https://www.npmjs.com/package/agentdom) | [py](https://pypi.org/project/agentdom/)): Control any website, desktop app, or REST API from your agent
- **Publish with agentdom-publisher** ([npx agentdom-publisher](https://www.npmjs.com/package/agentdom)): Expose your software to AI agents via `.well-known/agentdom.json`
- **Deploy anywhere**: npm, Docker, AWS ECS, or one-click `./deploy-aws.sh`

## Documentation

Visit our [docs](https://getagentdom.com/docs) or jump straight to a quickstart:

- [JavaScript / Node.js Quickstart](https://getagentdom.com/docs/quickstart)
- [Python Quickstart](https://getagentdom.com/docs/python)
- [MCP (Claude Desktop / Cursor)](https://getagentdom.com/docs/mcp)
- [Publisher Guide](https://getagentdom.com/docs/publisher)

## Install

```bash
npm install -g agentdom
```

Or use without installing:

```bash
npx agentdom@latest onboard
```

Python:

```bash
pip install agentdom
```

## Build your first agent in 30 seconds

**JavaScript / Node.js:**

```js
import { dispatch_intent } from 'agentdom';

// Create a GitHub issue — via API, no browser needed
const result = await dispatch_intent('issues.create', {
  title: 'Login crash on iOS 17',
  body:  'Reproducible on iPhone 15 Pro with iOS 17.4',
  labels: ['bug', 'mobile'],
}, 'github.com');

console.log(result); // → { id: 42, url: 'https://github.com/...' }
```

**Python:**

```python
from agentdom import AgentDOM

agent = AgentDOM(host="myapp.com", auth={"method": "api_key"})

@agent.capability("todos.create", description="Create a todo item")
def create_todo(args):
    return db.todos.create(args["title"])

agent.register(flask_app)  # serves /.well-known/agentdom.json automatically
```

**CLI:**

```bash
agentdom onboard                            # interactive setup wizard
agentdom run "Create a Linear ticket for the iOS crash"
agentdom run "Send a weekly digest to team@company.com via Resend"
agentdom doctor                             # health check
```

## How it works

AgentDOM routes every agent intent to the most efficient execution layer:

```
dispatch_intent("issues.create", args, "github.com")
        │
        ├─ 1. API route?      → instant REST call (< 200ms)
        ├─ 2. Desktop app?    → macOS Accessibility bridge
        ├─ 3. Web UI only?    → Chrome CDP + DOM scan
        └─ 4. Done            → result returned to agent
```

No screenshots. No coordinate clicking. No hand-written integrations.

## Transports

| Transport | When used | Speed |
|---|---|---|
| `api` | Manifest declares an API endpoint | ⚡ ~100ms |
| `cli` | Local CLI tools (git, gh, etc.) | ⚡ ~200ms |
| `browser` | Web apps without APIs | 🌐 ~2-5s |
| `desktop` | Native macOS apps | 🖥 ~1-3s |

## Connect to Claude Desktop / Cursor (MCP)

```bash
claude mcp add agentdom -- node $(npm root -g)/agentdom/desktop-mcp-server.js
```

Or add manually to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["PATH_TO/agentdom/desktop-mcp-server.js"]
    }
  }
}
```

## Generate a mcp-use server from any manifest

```bash
# Turn any website's AgentDOM manifest into a working mcp-use server
npx agentdom-publisher mcpuse --host=github.com --out=./github-mcp

# Python variant
npx agentdom-publisher mcpuse --host=github.com --lang=python

# Then:
cd ./github-mcp && npm install && npm start
# Inspector → http://localhost:3000/inspector
```

## Supported integrations (out of the box)

| Provider | Auth | Capabilities |
|---|---|---|
| `github.com` | Device Flow | repos, issues, PRs, actions (811) |
| `linear.app` | OAuth 2.0 | issues, teams, cycles, comments (8) |
| `slack.com` | OAuth 2.0 | messages, channels, reactions (6) |
| `notion.so` | OAuth 2.0 | pages, databases, blocks (6) |
| `stripe.com` | API Key | payments, customers, subscriptions (442) |
| `resend.com` | API Key | emails, domains, broadcasts (5) |
| `vercel.com` | API Key | deployments, projects, env vars (8) |
| `hubspot.com` | OAuth 2.0 | contacts, deals, companies (8) |
| `supabase.com` | API Key | projects, secrets, SQL (7) |
| `cal.com` | OAuth 2.0 | bookings, availability (6) |
| `openai.com` | API Key | chat, embeddings, images (5) |
| `anthropic.com` | API Key | messages, models (2) |
| `openrouter.ai` | API Key | 300+ LLMs via one interface (3) |

## Add AgentDOM to your own app

**Express:**

```js
const { agentdom } = require('agentdom/express');

app.use(agentdom({
  host: 'api.myapp.com',
  capabilities: [{
    intent: 'todos.create',
    description: 'Create a new todo item',
    args: { title: { type: 'string', required: true } },
    handler: async (req, body) => db.todos.create(body.title),
  }],
}));
// Now serves: GET /.well-known/agentdom.json
// And:        POST /api/agentdom/todos.create
```

**Next.js (App Router):**

```js
// app/api/agentdom/[...intent]/route.js
import { AgentDOM } from 'agentdom/nextjs';

export const { GET, POST } = AgentDOM({
  host: 'myapp.com',
  capabilities: [{
    intent: 'users.invite',
    description: 'Invite a new team member',
    args: { email: { type: 'string', required: true } },
    handler: async (req, body) => inviteUser(body.email),
  }],
});
```

**Python (Flask / FastAPI):**

```python
from agentdom import AgentDOM

agent = AgentDOM(host="api.myapp.com", auth={"method": "api_key"})

@agent.capability("orders.ship", description="Ship a pending order")
async def ship_order(args):
    return await shipping_service.ship(args["order_id"])

agent.register(app)  # Flask or FastAPI
```

## Publisher SDK

Add agent support to your existing API in minutes:

```bash
# Generate manifest from your OpenAPI spec
npx agentdom-publisher init --openapi=./openapi.json --host=api.myapp.com

# Validate
npx agentdom-publisher validate

# Verify live deployment
npx agentdom-publisher verify --host=api.myapp.com

# Test a real dispatch
npx agentdom-publisher test --host=api.myapp.com --intent=contacts.list --token=sk-...

# Register in the public AgentDOM registry
npx agentdom-publisher submit --host=api.myapp.com

# Generate mcp-use server
npx agentdom-publisher mcpuse --host=api.myapp.com --out=./my-mcp-server
```

## Policy engine

Before any external action, AgentDOM checks your policy file:

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
agentdom approve <id>   # approve a pending action
agentdom deny   <id>   # deny it
```

## Auth & Wallet

```bash
agentdom onboard                          # guided wizard — sets up LLM + integrations
agentdom wallet export --base64           # → AGENTDOM_WALLET_B64=eyJ...

# Use in CI / Docker / serverless — no human at runtime
docker run -e AGENTDOM_WALLET_B64=$AGENTDOM_WALLET_B64 your-agent
```

Credentials are stored in `~/.agentdom/wallet.json` (mode `0600`) or your OS Keychain. Never logged. Never sent to AgentDOM servers.

## Deploy to AWS

```bash
./deploy-aws.sh sk-or-v1-YOUR_OPENROUTER_KEY
```

Deploys: ECS Fargate + ALB + CloudFront + S3 + Secrets Manager + CloudWatch in one command.

See [AWS-DEPLOY.md](./AWS-DEPLOY.md) for the full architecture.

## Agent Token Protocol

Publishers declare an `agent_tokens` endpoint. Agents provision scoped, short-lived tokens automatically — no human browser redirect after initial setup.

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

Like AWS IAM roles, but for any software on the internet.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The fastest contribution is adding a polyfill manifest for a new provider:

```bash
node tools/gen-manifest.js --openapi=https://api.example.com/openapi.json --host=api.example.com
```

## License

MIT © [Ragavendhra Machikatla](https://github.com/RagavRida)
