# AgentDOM — Vision

> The web was built for humans. AI agents deserve their own interface.

## The problem

Every AI agent today is essentially blind. To use software, it either:
- Takes screenshots and "looks" at pixels (fragile, slow, expensive)
- Scrapes HTML and guesses at semantics (breaks on every deploy)
- Calls raw REST APIs with hand-written integration code (unmaintainable at scale)

The result: agents are brittle, slow, and require constant human maintenance.

## The insight

Software already has machine-readable interfaces — APIs, CLI tools, accessibility trees. The problem isn't that the interfaces don't exist. The problem is **there's no standard protocol for agents to discover, authenticate to, and call them**.

AgentDOM is that protocol.

## The protocol

```
Publisher declares:    .well-known/agentdom.json
Agent discovers:       dispatch_intent("contacts.create", {...}, "hubspot.com")
AgentDOM routes:       api > cli > browser > desktop (fastest available)
```

One function. Any software. Any transport.

## The auth layer

OAuth was built for humans clicking "Allow" in browsers. AI agents don't have browsers.

AgentDOM introduces the **Agent Token Protocol**: publishers declare an `agent_tokens` endpoint in their manifest. Agents call it with a master credential and receive short-lived, scoped tokens — without any human browser redirect.

Like AWS IAM roles for EC2, but for any software on the internet.

## The polyfill registry

Most publishers won't implement this immediately. So AgentDOM ships a polyfill registry — handcrafted manifests for the 100 most important APIs. This means agents can use Linear, Slack, Stripe, GitHub, Notion, Resend, and 90+ others today, even before those publishers publish their own manifests.

## The MCP bridge

AgentDOM exposes everything as an MCP server. Any agent framework that speaks MCP — Claude Code, Cursor, Continue — gets 50+ tools automatically: `dispatch_intent`, `wallet_auth`, `scan_app`, `observe`, and more.

## The roadmap

**Now (v3.2)**
- Core protocol: dispatch_intent with 4 transports
- 13 polyfill manifests
- MCP server
- Auth wallet (OS Keychain, OAuth PKCE, device flow)
- Agent Token Protocol
- Policy engine
- Episodic memory
- Publisher SDK (npx agentdom-publisher)

**Next (v4)**
- Agent Token Protocol adoption by publishers
- Polyfill registry at 100+ providers
- Real-time intent streaming
- Multi-agent orchestration primitives
- Publisher dashboard at getagentdom.com

**Future**
- Agents negotiate capabilities directly with publishers
- Cross-agent credential delegation
- Intent marketplace

## The bet

The next wave of software won't be designed for humans to click — it'll be designed for agents to call. AgentDOM is the foundation layer for that future: a universal semantic interface that works with any software, any agent, any LLM.

If every SaaS ships `.well-known/agentdom.json`, agents become first-class users of the entire internet.
