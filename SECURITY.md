# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 3.2.x | ✅ Active |
| 3.1.x | ⚠️ Security fixes only |
| < 3.1  | ❌ No support |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **security@getagentdom.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

You will receive a response within 48 hours. We follow responsible disclosure — we'll coordinate a fix and public disclosure timeline with you.

## Credential security

AgentDOM stores credentials in:

| Store | Location | Mode |
|---|---|---|
| Wallet file | `~/.agentdom/wallet.json` | `0600` (user-only) |
| OS Keychain | macOS Keychain, libsecret | System-managed |
| Env vars | Process environment | Transient |

**Tokens are never:**
- Logged to stdout/stderr in production mode
- Sent to any AgentDOM-controlled server
- Included in telemetry

## Agent Token Protocol security

The `agent_tokens` protocol (M2M auth) has these security properties:
- Master credentials are never sent to the agent runtime
- Agent tokens are scoped to minimum required permissions
- Tokens have configurable TTLs (`max_ttl_seconds`)
- Revocation is supported via `revoke` endpoint
- Rotation is automatic (5 min before expiry)

## Policy engine

Before any external action, AgentDOM's policy engine classifies the intent's side effects and checks against `~/.agentdom/policy.json`. Destructive operations (`delete`, `payment`) are denied by default.

## Known limitations

- Device flow tokens for GitHub may not support granular scope selection
- OAuth PKCE `client_id` values in `lib/oauth-pkce.js` are placeholder values for development — replace with production app credentials before deployment
- `AGENTDOM_WALLET_B64` is base64, not encrypted — treat it like a password
