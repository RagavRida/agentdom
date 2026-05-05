# Publisher Integration Guide — AgentDOM

Become **agent-native** in under 10 minutes. This guide shows you how to publish a machine-readable manifest so AI agents can autonomously discover, authenticate to, and use your product.

---

## Why Do This?

> "Agents are already browsing the web, researching products, and managing software. But they're doing it on top of interfaces designed for humans — clicking buttons, guessing selectors, parsing screenshots. If your product publishes an AgentDOM manifest, agents can use it directly — no scraping, no screenshots, no friction."

**Your benefit:** Every agent that uses AgentDOM (Claude, GPT, Gemini, LangChain, CrewAI…) can instantly discover and use your product when they need it. Zero additional integration work per agent framework.

---

## The Standard: `.well-known/agentdom.json`

Like `robots.txt` for crawlers, you host a machine-readable capability manifest at:

```
https://api.yourapp.com/.well-known/agentdom.json
```

Agents fetch this once, cache it, and then call your API directly — using the auth method you specify.

---

## Step 1: Generate from Your OpenAPI Spec

```bash
npx agentdom-publisher init --openapi=./openapi.json --host=api.yourapp.com
```

This compiles your OpenAPI 3.x spec into a `.well-known/agentdom.json` manifest automatically.

**What gets generated:**

```json
{
  "version": "1.0",
  "host": "api.yourapp.com",
  "name": "Your App",
  "auth": {
    "method": "oauth2",
    "auth_url": "https://yourapp.com/oauth/authorize",
    "token_url": "https://yourapp.com/oauth/token",
    "scopes": ["read", "write"]
  },
  "capabilities": [
    {
      "intent": "contacts.create",
      "description": "Create a new contact",
      "transport": "api",
      "method": "POST",
      "endpoint": "https://api.yourapp.com/v1/contacts",
      "args": {
        "email":     { "type": "string", "required": true },
        "firstname": { "type": "string", "required": false }
      },
      "side_effects": ["external"],
      "cost": 1
    }
  ]
}
```

**No OpenAPI spec?** Hand-craft the manifest instead — the format is minimal and self-explanatory. See the [example manifest](../docs/agentdom.example.json).

---

## Step 2: Review & Customize

Key things to check after generation:

### Auth method
```json
// API Key (most common)
"auth": {
  "method": "api_key",
  "key_header": "Authorization",
  "key_format": "Bearer {token}",
  "key_env": "YOURAPP_API_KEY"
}

// OAuth 2.0 PKCE (for user-delegated access)
"auth": {
  "method": "oauth2_pkce",
  "auth_url": "https://yourapp.com/oauth/authorize",
  "token_url": "https://yourapp.com/oauth/token",
  "scopes": ["contacts:read", "contacts:write"]
}
```

### Side effects (critical for agent policy)
Agents use `side_effects` to determine whether to prompt the user for approval. Be accurate:

| Effect | When to use |
|--------|-------------|
| `read` | GET endpoints that return data only |
| `external` | POSTing, PATCHing, sending to external systems |
| `send` | Sending emails, notifications, messages |
| `delete` | Deleting records |
| `payment` | Anything involving billing or charges |
| `write_local` | Writing to the local filesystem |

### Intent naming
Use `noun.verb` format: `contacts.create`, `issues.list`, `emails.send`. Agents use these to search your capabilities.

---

## Step 3: Validate Locally

```bash
npx agentdom-publisher validate --manifest=./.well-known/agentdom.json
```

**Output:**
```
🤖 AgentDOM Publisher SDK v1.0

Validating: /yourapp/.well-known/agentdom.json
  Host:         api.yourapp.com
  Version:      1.0
  Capabilities: 24
  Auth:         api_key

✓ Manifest is valid (24 capabilities, 0 errors)
```

Common errors it catches:
- Duplicate intent IDs
- Endpoint template vars (`{contactId}`) with no matching arg
- Unknown `transport` or `side_effect` values
- OAuth missing `auth_url` or `token_url`

---

## Step 4: Deploy to Your Server

The manifest must be accessible at:
```
https://api.yourapp.com/.well-known/agentdom.json
```

**nginx:**
```nginx
location /.well-known/agentdom.json {
    alias /var/www/.well-known/agentdom.json;
    add_header Content-Type application/json;
    add_header Access-Control-Allow-Origin *;
    add_header Cache-Control "public, max-age=3600";
}
```

**Express / Node.js:**
```js
import manifest from './.well-known/agentdom.json' assert { type: 'json' };

app.get('/.well-known/agentdom.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json(manifest);
});
```

**Vercel / Netlify / Static hosting:**
```bash
# Just copy .well-known/agentdom.json into your public directory
cp .well-known/agentdom.json public/.well-known/agentdom.json
```

> ⚠️ **Required:** The manifest must be served with `Access-Control-Allow-Origin: *` so agents can fetch it from any environment.

---

## Step 5: Verify Live Deployment

```bash
npx agentdom-publisher verify --host=api.yourapp.com
```

**Output:**
```
🤖 AgentDOM Publisher SDK v1.0

Fetching https://api.yourapp.com/.well-known/agentdom.json...
✓ Manifest found at https://api.yourapp.com/.well-known/agentdom.json
✓ 24 capabilities declared
✓ Auth method: api_key
✓ Manifest is valid and ready for AgentDOM agents!

→ Test a live dispatch:
  npx agentdom intent contacts.list --provider=api.yourapp.com

→ Submit to registry:
  npx agentdom-publisher submit --host=api.yourapp.com
```

---

## Step 6: Test a Real API Call

```bash
npx agentdom-publisher test \
  --host=api.yourapp.com \
  --token=sk-your-api-key \
  --intent=contacts.list \
  --args='{"limit": 5}'
```

This performs a live dispatch against your API using the manifest's endpoint and auth config. Verifies the full path works end-to-end.

---

## Step 7: Submit to the Public Registry

```bash
npx agentdom-publisher submit --host=api.yourapp.com
```

Once submitted, your manifest is served from the AgentDOM CDN:
```
https://agentdom.dev/manifests/api.yourapp.com.json
```

Any agent using AgentDOM can then call your API — even before they have an API key (they'll be prompted to authenticate on first use).

---

## Full Command Reference

```bash
# Generate manifest from OpenAPI spec
npx agentdom-publisher init \
  --openapi=./openapi.json \
  --host=api.yourapp.com \
  --out=./           # optional output dir (default: cwd)

# Validate manifest locally
npx agentdom-publisher validate \
  --manifest=./.well-known/agentdom.json

# Verify live deployment
npx agentdom-publisher verify --host=api.yourapp.com

# Test a real dispatch
npx agentdom-publisher test \
  --host=api.yourapp.com \
  --token=sk-...       \
  --intent=contacts.list \
  --args='{"limit": 5}'

# Submit to public registry
npx agentdom-publisher submit --host=api.yourapp.com
```

---

## Checklist

- [ ] `npx agentdom-publisher init` — manifest generated
- [ ] `npx agentdom-publisher validate` — 0 errors
- [ ] Manifest deployed to `https://yourhost/.well-known/agentdom.json`
- [ ] CORS header `Access-Control-Allow-Origin: *` set
- [ ] `npx agentdom-publisher verify` — live check passes
- [ ] `npx agentdom-publisher test` — end-to-end dispatch works
- [ ] `npx agentdom-publisher submit` — listed in public registry

---

## Support

- **Docs:** [agentdom.dev/docs](https://agentdom.dev/docs)
- **Spec:** [github.com/RagavRida/agentdom](https://github.com/RagavRida/agentdom)
- **Registry:** [agentdom.dev/manifests](https://agentdom.dev/manifests)
- **npm:** [npmjs.com/package/agentdom](https://www.npmjs.com/package/agentdom)

---

*AgentDOM is an open standard. No publisher lock-in. Self-hostable. MIT licensed.*
