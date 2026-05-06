# CLAUDE.md — AgentDOM × Claude Code

This file is read automatically by Claude Code when working in this repository.

## Project summary

AgentDOM is a universal AI agent protocol (npm: `agentdom`, v3.2.0).
Core: `dispatch_intent(intent, args, provider)` — single function to interact with any software.

Website: https://getagentdom.com · npm: https://www.npmjs.com/package/agentdom

## Always run tests before committing

```bash
npm test   # must show: # pass 33  # fail 0
```

## Important rules

- **Never add `"type": "module"` to package.json** — tests use CJS require()
- **Use `.mjs` extension** for any new ESM utilities
- **Never hardcode API keys** — use `~/.agentdom/wallet.json` or env vars
- **`AGENTDOM_<HOST>_KEY` convention** for env-based credentials
- **All `dispatch_intent` paths** must go through `lib/secrets.js` (the 7-source resolver)

## Auth flow (important — do not break)

```
Human (once):    agentdom setup <provider>   → stores token
Agent (forever): dispatch_intent(...)        → secrets.resolve() → token → HTTP
```

The `secrets.resolve()` waterfall in `lib/secrets.js`:
0. Agent Token Protocol (`lib/agent-tokens.js`)
1. `AGENTDOM_<HOST>_KEY` env var
2. `~/.agentdom/wallet.json` (or `AGENTDOM_WALLET_B64` / `AGENTDOM_WALLET_PATH`)
3. OS Keychain
4. AWS SSM (`/agentdom/<host>/token`)
5. HashiCorp Vault (`secret/agentdom/<host>`)
6. 1Password (`op://AgentDOM/<host>/token`)

## Key files to understand before editing

| File | Role |
|---|---|
| `agentdom.js` | Main dispatch_intent runtime |
| `lib/secrets.js` | Headless credential resolver |
| `lib/agent-tokens.js` | Agent Token Protocol (M2M) |
| `commands/auth.js` | Wallet read/write, discover() |
| `desktop-mcp-server.js` | MCP server (50+ tools) |
| `manifests/*.json` | Provider polyfill manifests |

## Adding capabilities — checklist

- [ ] Add intent to the provider manifest in `manifests/<host>.json`
- [ ] Add auth type if new (`lib/secrets.js` handles resolution)
- [ ] Add test case in `test/core.test.js`
- [ ] Run `npm test` — all 33 must pass

## Commit style

```
feat(scope): short description

Longer explanation if needed.
```

Scopes: `auth`, `wallet`, `dispatch`, `protocol`, `mcp`, `cli`, `docs`, `manifest`, `test`
