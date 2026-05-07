# Changelog

All notable changes to AgentDOM are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [3.6.0] — 2026-05-07

### Added

**Embedding SDKs** — any app can expose itself to AI agents in ~10 lines
- `agentdom/express` (`lib/express-middleware.js`) — Express.js middleware: serves `/.well-known/agentdom.json` + routes `POST /api/agentdom/<intent>` to handlers
- `agentdom/nextjs` (`lib/nextjs.js`) — Next.js SDK: App Router (`GET`/`POST` handlers), Pages Router handler, Edge Middleware for `/.well-known/agentdom.json`
- `tools/agentdom.py` — Python SDK with `@agent.capability()` decorator; `agent.register(app)` auto-detects Flask or FastAPI
- `package.json` exports map: `agentdom/express`, `agentdom/nextjs`, `agentdom/mcp`, `agentdom/publisher`

**mcp-use Bridge** (`compiler/to-mcpuse.js` + `agentdom-publisher mcpuse`)
- `npx agentdom-publisher mcpuse --host=<host>` — fetches live manifest and generates a fully working mcp-use server scaffold
- `--lang=python` — generates Python variant with `mcp_use` + `httpx`
- `--out=<dir>` — output directory; `--port=3000`
- Generated server includes mcp-use Inspector at `/inspector` out of the box
- `slugify()` with `operation_id` fallback handles malformed intent names

**AWS CDK Stack** (`aws/cdk-stack.js` + `cdk.json` + `deploy-aws.sh`)
- `./deploy-aws.sh sk-or-v1-...` — one command deploys full production stack
- ECS Fargate 2 GB / 1 vCPU + Puppeteer/Chromium container
- Application Load Balancer → `api.getagentdom.com`
- CloudFront CDN for `agentdom.js` + docs (S3)
- Secrets Manager auto-injects `OPENROUTER_API_KEY`
- Auto-scaling 1→5 tasks on CPU/request load
- CloudWatch dashboard + 14-day log retention
- Route 53 DNS (optional via `HOSTED_ZONE_ID`)

**PyPI Package** (`python/`)
- `pip install agentdom` — first-party Python SDK on PyPI
- Optional extras: `agentdom[flask]`, `agentdom[fastapi]`, `agentdom[dispatch]`, `agentdom[all]`
- `dispatch_intent()` async + `dispatch_intent_sync()` sync consumer-side function
- `python/pyproject.toml` with hatchling build system
- `.github/workflows/publish-pypi.yml` — auto-publishes on every `v*` tag via OIDC trusted publishing

**CLI Onboarding Wizard** (`commands/onboard.js`)
- Full-width ASCII "scanning eye" logo in brand orange
- Guided TUI: LLM provider → API key → integration setup → browser detection → smoke test → CI wallet export
- `agentdom doctor` health-check command
- Fixed terminal freeze after secret input (ephemeral `readline` instances)

**README** — full rewrite in mcp-use style: badges, 3-tab quickstart (JS/Python/CLI), routing diagram, transport table, integrations table, embedding SDK examples

### Fixed
- `agentdom.py` flake8 F401/F811: removed unused `json`, `functools`, `Dict`, `Any`, `Optional`, top-level `asyncio` imports
- `browser.fill` multi-strategy selector — no more `Input not found` on GitHub forms

### Chore
- Removed from repo: `yc-coding-session.md`, `website/Users:.fileloc`, `website/dns-change.json`, debug screenshots, `python/dist/` build artifacts
- `.gitignore` hardened: blocks `*.fileloc`, `*-session.md`, `python/dist/`, root `*.png`, `cdk.out/`

---

## [3.2.0] — 2026-05-06

### Added

**Agent Token Protocol** (`lib/agent-tokens.js`)
- Publishers declare `auth.agent_tokens` in `.well-known/agentdom.json`
- Agents call `issueAgentToken()` with master credential → receive scoped, short-lived tokens
- `ensureAgentToken()` — main agent entry point: issues or auto-rotates as needed
- `agentdom agent-token <provider> [issue|rotate|revoke]` CLI command
- OpenRouter manifest updated with `agent_tokens` spec as first adopter

**Headless Secrets Resolver** (`lib/secrets.js`)
- 7-source credential waterfall: Agent Token Protocol → env var → wallet → OS Keychain → AWS SSM → HashiCorp Vault → 1Password
- `AGENTDOM_WALLET_B64` — portable base64 wallet for Docker/serverless/CI injection
- `AGENTDOM_WALLET_PATH` — explicit wallet file path
- OAuth access tokens auto-refreshed silently using stored refresh tokens
- `secrets.resolveOrThrow()` — fails with actionable error message (which env var to set)

**Wallet Provisioning** (`commands/wallet.js`)
- `agentdom wallet list` — show all stored credentials
- `agentdom wallet export [--base64] [--providers=a,b]` — scoped portable export
- `agentdom wallet import <file|base64>` — load wallet from file or base64 string
- `agentdom wallet create --agent=id [--providers=a,b]` — scoped wallet per agent identity
- `agentdom wallet env` — print shell export lines for CI/CD

**Setup Command** (`commands/setup.js`)
- `agentdom setup <provider>` — single human-facing command for one-time credential setup
- Auto-detects auth method (OAuth PKCE / device flow / API key) from manifest
- Non-interactive mode: `--key=<value>` for scripts and CI
- Multi-provider: `agentdom setup linear.app resend.com github.com`
- Status: `agentdom setup --list`
- After-setup guidance: prints exact wallet export command for agent delivery

**dispatch_intent auth upgrade**
- `secrets.resolve()` called first (7 sources) before `authWallet.token()`
- Error messages tell agent exactly which env var to set

**Docs site** (`website/`)
- New sections: Setup (Human Step), Auth Wallet resolution waterfall, Wallet→Agent provisioning, Agent Token Protocol
- Sidebar expanded to 12 sections with new icons

**Repository hygiene**
- `AGENTS.md` — machine-readable instructions for AI coding agents
- `CLAUDE.md` — Claude Code specific instructions
- `VISION.md` — protocol vision and roadmap
- `CONTRIBUTING.md` — contributor guide with manifest creation walkthrough
- `SECURITY.md` — security policy and responsible disclosure
- `.github/ISSUE_TEMPLATE/` — bug report + manifest request templates
- `.github/workflows/ci.yml` — CI on Node 20/22/24
- `.github/workflows/publish.yml` — npm publish on version tag

### Fixed
- `discover()` in `commands/auth.js` now uses CJS `fs.readFileSync` instead of ESM dynamic `import()` — fixes `ReferenceError` in CJS context
- Wallet format migrated from flat object to `{ wallet: '0.1', providers: {} }` structure
- `commands/setup.js` `--list` flag correctly handled (argv remapping)

---

## [3.1.0] — 2026-05-04

### Added
- MCP server (`desktop-mcp-server.js`) with 50+ tools
- Policy engine (`lib/policy.js`) — per-effect allow/prompt/deny
- Episodic memory (`lib/memory.js`) — cross-session recall
- Planner (`lib/planner.js`) — plan-execute-verify runtime
- Publisher SDK (`npx agentdom-publisher`)
- 13 polyfill manifests: linear.app, hubspot.com, vercel.com, slack.com, notion.so, supabase.com, resend.com, cal.com, github.com, stripe.com, openai.com, anthropic.com, openrouter.ai

### Fixed
- Removed `"type": "module"` from `package.json` — test suite now runs correctly
- Renamed `tools/publisher.js` → `tools/publisher.mjs` to preserve ESM entry

---

## [3.0.0] — 2026-05-01

### Added
- Core protocol: `dispatch_intent(intent, args, provider)`
- Transport hierarchy: api > cli > browser > desktop
- OAuth PKCE + device flow auth (`lib/oauth-pkce.js`)
- OS Keychain integration (`lib/keychain.js`)
- Browser engine via Puppeteer (`integrations/browser-engine.js`)
- Desktop agent via macOS Accessibility API (`desktop-agent/`)
- AgentDOM browser runtime (`agentdom.js`)
- Resilience layer: retry, timeout, circuit-breaker (`lib/resilience.js`)
