# `.well-known/agentdom` — Universal Agent Discovery Protocol

**Status:** Draft v0.1 (2026-05-05)
**Repo:** `~/strollr-site/strollr-clone/artifacts/strollr/n/agent-schema/`

A single endpoint every web app, CLI tool, or desktop bundle exposes so an
agent learns in one fetch:

1. **What it can do** — capabilities, named by intent
2. **How to do each one** — API > CLI > UI, ranked by cost
3. **How to authenticate** — OAuth2, API key, session cookie, or none
4. **How to fall back** — UI manifest when API can't reach an intent

Combines the pieces that exist in fragments today (OAuth, OpenAPI, MCP,
agents.json, App Intents) into one self-describing surface.

---

## Discovery

### Web apps

```
GET https://<host>/.well-known/agentdom.json
```

Returns the manifest. CORS-permissive (`Access-Control-Allow-Origin: *`)
so agent clients can fetch from any origin.

### Desktop apps

Bundle ships the file inside the `.app` bundle:

```
/Applications/MyApp.app/Contents/Resources/.well-known/agentdom.json
```

The desktop MCP server reads it during `scan_app` and merges its capabilities
into the auto-discovered tool list.

### CLI tools

The binary writes the manifest to one of:

```
/usr/local/share/agentdom/<bin>.json
$HOME/.agentdom/cli/<bin>.json
```

Or supports the convention `<bin> --agentdom` which prints the JSON to stdout.

---

## Manifest schema

```json
{
  "agentdom": "0.1",
  "name": "HubSpot",
  "homepage": "https://www.hubspot.com",
  "icon": "https://www.hubspot.com/favicon.ico",
  "description": "CRM platform — contacts, deals, marketing, sales hub.",

  "auth": {
    "method": "oauth2",
    "authorize_url": "https://app.hubspot.com/oauth/authorize",
    "token_url": "https://api.hubapi.com/oauth/v1/token",
    "client_id_required": true,
    "scopes_for": {
      "contacts.read":  ["crm.objects.contacts.read"],
      "contacts.write": ["crm.objects.contacts.write"],
      "deals.write":    ["crm.objects.deals.write"]
    }
  },

  "capabilities": [
    {
      "intent": "contacts.create",
      "transport": "api",
      "method": "POST",
      "endpoint": "https://api.hubapi.com/crm/v3/contacts",
      "schema_ref": "#/components/schemas/SimplePublicObjectInput",
      "scopes": ["crm.objects.contacts.write"],
      "cost": 1
    },
    {
      "intent": "contacts.search",
      "transport": "api",
      "method": "POST",
      "endpoint": "https://api.hubapi.com/crm/v3/objects/contacts/search",
      "scopes": ["crm.objects.contacts.read"],
      "cost": 1
    },
    {
      "intent": "deal.move_stage",
      "transport": "api",
      "method": "PATCH",
      "endpoint": "https://api.hubapi.com/crm/v3/objects/deals/{dealId}",
      "scopes": ["crm.objects.deals.write"],
      "cost": 1
    },
    {
      "intent": "report.view",
      "transport": "ui",
      "url": "https://app.hubspot.com/reports/{reportId}",
      "auth_via": "session_cookie",
      "cost": 30
    }
  ],

  "openapi": "https://api.hubapi.com/api-catalog-public/v1/apis/openapi.json",

  "fallback": {
    "transport": "ui",
    "manifest": "https://app.hubspot.com/.well-known/agentdom.md",
    "host": "app.hubspot.com"
  },

  "policy": {
    "rate_limit": "100/min",
    "side_effects_disclosed": ["contacts.create", "contacts.delete", "deal.move_stage", "messaging.send"],
    "data_residency": "US"
  }
}
```

### Required fields

| Field          | Type     | Notes                                                  |
| -------------- | -------- | ------------------------------------------------------ |
| `agentdom`     | string   | Spec version (semver). `"0.1"` for this draft.         |
| `name`         | string   | Display name.                                          |
| `capabilities` | array    | At least one capability or `fallback` must be present. |

### Optional fields

| Field         | Type   | Notes                                                                |
| ------------- | ------ | -------------------------------------------------------------------- |
| `homepage`    | URL    | Marketing page.                                                      |
| `icon`        | URL    | 32×32+ icon for agent UIs.                                           |
| `description` | string | Short prose, < 280 chars.                                            |
| `auth`        | object | Required if any capability needs authentication.                     |
| `openapi`     | URL    | Direct OpenAPI spec — agent can compile typed tools from it.         |
| `fallback`    | object | Pointer to a UI-driving manifest when API can't reach all intents.   |
| `policy`      | object | Rate limits, declared side-effects, data residency.                  |

### Auth methods

```json
{ "method": "none" }
{ "method": "api_key", "header": "Authorization", "format": "Bearer {token}", "obtain_url": "https://app.example.com/settings/api" }
{ "method": "oauth2", "authorize_url": "...", "token_url": "...", "scopes_for": { "<intent>": ["scope1", "scope2"] } }
{ "method": "session_cookie", "domain": "app.example.com", "obtain_via": "user_login" }
```

### Capability shape

```json
{
  "intent": "<dotted.id>",
  "transport": "api" | "cli" | "ui",
  "cost": <number — latency+reliability proxy, lower is better>,
  "scopes": ["<scope>", ...],

  // transport=api:
  "method": "POST" | "GET" | ...,
  "endpoint": "https://...",
  "schema_ref": "#/components/...",        // optional, points into openapi

  // transport=cli:
  "binary": "gh",
  "args_template": ["issue", "create", "--title", "{title}", "--body", "{body}"],

  // transport=ui:
  "url": "https://...",                    // entry URL
  "manifest": "https://.../agentdom.md",   // optional UI manifest with steps
  "auth_via": "session_cookie" | "oauth2"
}
```

### Cost convention

Lower = preferred. Rough scale:

| Cost | Transport                                           |
| ---- | --------------------------------------------------- |
| 1    | Single API call                                     |
| 3    | API call with prerequisite lookups (e.g. resolve ID) |
| 5    | CLI invocation (process spawn overhead)             |
| 30   | UI driving — single click                           |
| 50   | UI driving — multi-step manifest                    |
| 100  | UI driving — requires re-scan after navigation      |

Agent picks the lowest-cost provider it can authenticate to. Ties broken
by user preference (configured in the wallet) or alphabetical.

---

## Routing semantics

Agent calls `dispatch_intent({ intent, args })`. The runtime:

1. Looks up `intent` in the fused index across all known providers
   (well-known + bundled manifests + scanned UIs).
2. Filters providers the user has valid auth for (or `auth.method == "none"`).
3. Sorts by `cost` ascending.
4. Tries the cheapest. On 4xx/5xx that isn't a hard auth failure, falls
   back to the next provider.
5. Returns `{ provider, transport, result, fallbacks_attempted: [...] }`.

A provider returning HTTP 401/403 triggers re-auth via the wallet (or
prompts the user) before falling back.

---

## Auth wallet

A single client component manages tokens for every provider. Storage:

- macOS: file at `~/.agentdom/wallet.json` (0600), with optional Keychain
  upgrade in v0.2.
- Linux: same path, 0600.
- Windows: `%USERPROFILE%\.agentdom\wallet.json` (DPAPI in v0.2).

Format:

```json
{
  "wallet": "0.1",
  "providers": {
    "hubspot.com": {
      "method": "oauth2",
      "access_token": "...",
      "refresh_token": "...",
      "expires_at": "2026-05-05T11:00:00Z",
      "scopes": ["crm.objects.contacts.write", ...],
      "obtained_at": "2026-05-05T10:00:00Z",
      "client_id": "..."
    },
    "linear.app": {
      "method": "api_key",
      "key": "lin_api_..."
    }
  }
}
```

OAuth flow (browser-mediated):

```
1. agent.auth({ provider: "hubspot.com" })
2. Wallet fetches /.well-known/agentdom.json → reads auth block.
3. Wallet picks a free localhost port (e.g. 53291).
4. Wallet spawns http server at http://127.0.0.1:53291/callback.
5. Wallet opens browser to:
     <authorize_url>?client_id=<id>&redirect_uri=http://127.0.0.1:53291/callback
       &response_type=code&scope=<concat>&state=<csrf>
6. User clicks "Approve" in browser.
7. Browser hits /callback?code=<auth_code>&state=<csrf>.
8. Wallet exchanges code at token_url for access_token + refresh_token.
9. Stores in wallet.json with scopes + expiry.
10. agent.dispatch_intent uses the token transparently.
```

For `api_key` providers, `auth({ provider })` opens the `obtain_url` in
the browser, prompts the user to paste the key, and stores it.

---

## Adopting the spec

### As a SaaS vendor (HubSpot, Notion, Linear...)

1. Publish `https://<your-domain>/.well-known/agentdom.json` (10 minutes).
2. List your existing OAuth app + scopes; capabilities match your existing
   API endpoints. No code changes.
3. Add CORS header `Access-Control-Allow-Origin: *` on that one endpoint.
4. Optionally add a `fallback.manifest` pointing at a UI manifest for the
   handful of features your API doesn't expose.

### As a desktop app vendor

Ship `Contents/Resources/.well-known/agentdom.json` inside the `.app`
bundle. Capabilities map to AppIntents on macOS or your IPC surface.

### As a CLI tool

Either ship `/usr/local/share/agentdom/<bin>.json` or support
`<bin> --agentdom`. Capabilities list your commands, mapped to flag
templates.

### As an agent

Two reads in your runtime:

```
GET https://<host>/.well-known/agentdom.json    # per domain
node -e "require('agentdom').discover()"        # for local apps
```

Then `dispatch_intent` everywhere. Don't write per-vendor integration code.

---

## Relationship to existing standards

| Standard               | Subsumed by `.well-known/agentdom`?                 |
| ---------------------- | --------------------------------------------------- |
| OpenAPI                | No — referenced via `openapi:`. Compose, don't replace. |
| OAuth 2.0              | No — referenced via `auth.method: oauth2`.          |
| MCP                    | Complementary. MCP is the agent ↔ runtime wire format; this spec is the vendor ↔ agent discovery format. An MCP server can serve `.well-known/agentdom.json` as a resource. |
| `.well-known/openid-configuration` | Inspired this spec's structure.        |
| llms.txt / agents.json | Subsumed — those describe content; this describes capabilities + auth + transport. |
| Apple App Intents      | Native equivalent on iOS/macOS. Bridge layer can translate AppIntents → agentdom capabilities. |
| Google A2A             | Different layer — A2A is agent-to-agent; this is vendor-to-agent. |

---

## Versioning

`agentdom` field is semver. Agents must:
- Accept all `0.x` minor versions, ignoring unknown fields.
- Reject majors they don't understand with a clear error.

Breaking changes bump the major. Field additions are minor bumps and
backward compatible.

---

## Open questions (v0.2 scope)

- Per-intent rate limit declarations vs. global.
- Cost units — should they be wall-clock ms estimates or ordinal classes?
- Streaming intents (long-running operations) — distinct field or embed in capability?
- Multi-tenant providers (Slack workspaces, Notion workspaces) — workspace selection in auth flow.
- Permission UI — agent-side standard for showing scopes before user approves.
- Discovery cache TTL — vendor controls via `Cache-Control` or spec-defined?
