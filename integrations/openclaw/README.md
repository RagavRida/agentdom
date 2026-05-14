# @agentdom/openclaw-bridge

> **OpenClaw + AgentDOM = 1,300 integrations, zero glue code.**

Register [AgentDOM](https://github.com/RagavRida/agentdom) as an OpenClaw skill.
Your agents inherit 1,300+ intents across 13 SaaS providers, plus any desktop
app, CLI tool, or web UI you point them at — without writing per-provider
integration code.

## Why this exists

OpenClaw is great at the **inbound and presentation** half of the agent loop:
22+ messaging channels, voice wake words, Live Canvas, Lobster workflows.

Its **outbound execution** is hand-coded per service (browser, canvas, nodes,
cron, Discord/Slack actions). The minute a user wants the 14th SaaS integration,
someone has to ship code.

AgentDOM is the protocol that solves outbound. One function — `dispatch_intent` —
routes any intent to the cheapest available transport (API → CLI → browser →
desktop), across any provider that publishes `.well-known/agentdom.json`.

This bridge wires them together.

## Install

```bash
npm install -g agentdom @agentdom/openclaw-bridge
agentdom-openclaw install
```

That's it. Restart OpenClaw and the `dispatch_intent`, `wallet_auth`,
`discover_surfaces`, `scan_app`, and `policy_list` tools are available to every
agent.

Verify:

```bash
agentdom-openclaw doctor
```

## Use it from a Lobster workflow

```js
// task: triage_ios_crash
await dispatch_intent("issues.create", {
  title: "Login crash on iOS 17.5",
  description: "See attached stack trace.",
  assignee: "alice",
  labels: ["bug", "ios", "P1"],
}, "linear.app");

await dispatch_intent("messaging.send", {
  channel: "#ios-eng",
  text: "Filed LIN-1284 for the login crash. cc <@alice>",
}, "slack.com");

await dispatch_intent("email.send", {
  to: "support@company.com",
  subject: "Tracking: iOS login crash",
  body: "We're on it. Ticket: LIN-1284.",
}, "resend.com");
```

No SDK imports. No OAuth wrangling. No per-provider glue.

## What you get out of the box

| Provider | Auth | Intents |
|---|---|---|
| github.com | Device Flow | **811** |
| stripe.com | API Key | **442** |
| linear.app | OAuth 2.0 | 8 |
| hubspot.com | OAuth 2.0 | 8 |
| vercel.com | API Key | 8 |
| slack.com | OAuth 2.0 | 6 |
| notion.so | OAuth 2.0 | 6 |
| supabase.com | API Key | 7 |
| resend.com | API Key | 5 |
| cal.com | OAuth 2.0 | 6 |
| openai.com | API Key | 5 |
| anthropic.com | API Key | 2 |
| openrouter.ai | API Key | 3 |

Plus any host that publishes `.well-known/agentdom.json` is discoverable at
call time. No manifest update required on this side.

## One-time auth per provider

```
wallet_auth({ provider: "linear.app" })       # browser opens once
wallet_auth({ provider: "github.com" })       # device flow code
wallet_auth({ provider: "resend.com",
              key: "re_..." })                # paste once
```

Subsequent agent runs are fully headless. Tokens persist in
`~/.agentdom/wallet.json` (mode 0600) or your OS keychain.

For CI / Docker / serverless:

```bash
agentdom wallet export --base64
# pass AGENTDOM_WALLET_B64 to the container
```

## Approval gates (Lobster integration)

Side-effecting intents (send / delete / write) trigger AgentDOM's policy
engine. Configure it once:

```bash
agentdom policy set external=allow      # API calls
agentdom policy set send=prompt         # email/Slack: ask first
agentdom policy set delete=prompt       # destructive: ask first
```

When `prompt` fires, AgentDOM emits a pending action. Route it into
Lobster's approval-gate queue:

```js
const pending = await policy_list();
for (const action of pending.requests) {
  await lobster.gate({
    id: action.id,
    summary: action.intent,
    args: action.args,
    onApprove: () => policy_approve({ id: action.id }),
    onDeny:    () => policy_deny({ id: action.id }),
  });
}
```

Lobster's resume tokens + AgentDOM's headless wallet give you durable,
auditable, cross-channel automation.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ OpenClaw                                                 │
│   inbound:  WhatsApp / Telegram / Slack / voice / ...    │
│   brain:    LLM picks intent + args                      │
│   Lobster:  workflow, approval gates, resume tokens      │
│   Canvas:   A2UI live workspace                          │
└──────────────────┬───────────────────────────────────────┘
                   │  MCP (stdio) — dispatch_intent
                   ▼
┌──────────────────────────────────────────────────────────┐
│ AgentDOM                                                 │
│   routing:  api > cli > browser > desktop                │
│   wallet:   OAuth2 / API key / device flow / session     │
│   compiler: any surface → typed tools                    │
│   policy:   per-effect allow/prompt/deny                 │
└──────────────────┬───────────────────────────────────────┘
                   ▼
   Linear · GitHub · Slack · Notion · Stripe · HubSpot ·
   Vercel · Supabase · Resend · Cal · OpenAI · Anthropic ·
   OpenRouter · + any .well-known/agentdom.json publisher
```

## What this bridge is *not*

- **Not a fork.** It runs the official `agentdom serve` binary as a subprocess.
- **Not a re-implementation.** OAuth, transport routing, the compiler, the
  policy engine all live in AgentDOM upstream.
- **Not a replacement for OpenClaw's built-in tools.** Browser, canvas, nodes,
  cron, and the channel-specific actions stay where they are. This bridge
  fills the gap *between* those tools — the long tail of SaaS integrations.

## Status

v0.1. Skill API tracks OpenClaw's published skill spec. If the OpenClaw skill
format changes, file an issue against
[RagavRida/agentdom](https://github.com/RagavRida/agentdom) with the label
`openclaw-bridge`.

## License

MIT
