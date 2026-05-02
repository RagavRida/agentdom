# AgentDOM

**The runtime that lets any AI agent operate any website like a human.**

[![npm](https://img.shields.io/npm/v/agentdom)](https://npmjs.com/package/agentdom) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

AgentDOM gives autonomous AI agents a machine-readable schema of any webpage and human-like interaction capabilities — no APIs needed.

## Quick Start

```bash
npm install -g agentdom
agentdom https://example.com
```

## What It Does

```
Any Website → AgentDOM → Machine-Readable Schema + Human-Like Actions
```

1. **Scans** any page → structured JSON schema (forms, buttons, links, intents)
2. **Acts** like a human → real mouse events, keystrokes, form fills
3. **Reasons** with AI → classifies element intents, plans multi-step workflows
4. **Autonomous** → give a goal, agent does the rest

## Integration with Every Major AI Platform

| Platform | Integration | Command |
|----------|-------------|---------|
| **Anthropic (Claude)** | MCP Server | `npm run mcp` |
| **OpenAI (GPT-4)** | Function Calling | `npm run openai "Sign up on example.com"` |
| **Google (Gemini)** | Function Calling | `npm run gemini "Find Stripe pricing"` |
| **Google A2A** | Agent-to-Agent Protocol | `npm run a2a` |
| **Any Platform** | REST API | `npm run server` |
| **Chrome** | Extension | Load `chrome-extension/` in `chrome://extensions` |
| **Cursor/Windsurf** | MCP | Auto-configured in `~/.cursor/mcp.json` |

## Usage

### CLI — Interactive Mode
```bash
agentdom https://stripe.com
❯ scan          # Get page schema
❯ forms         # List all forms
❯ actions       # List all actions
❯ click #btn    # Click an element
❯ goal "Find the pricing"  # Autonomous mode
```

### CLI — Autonomous Mode
```bash
agentdom https://strollr.app --headless
❯ goal Sign up with email test@ai.com
# Agent types email, clicks submit, verifies success — zero human steps
```

### HTTP API
```bash
npm run server
# Server starts at http://localhost:3700

curl -X POST http://localhost:3700/browse \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

curl -X POST http://localhost:3700/goal \
  -H 'Content-Type: application/json' \
  -d '{"objective": "Find the pricing", "url": "https://stripe.com"}'
```

### OpenAI Function Calling
```bash
OPENROUTER_API_KEY=sk-... node integrations/openai.js "Sign up on strollr.app with email test@ai.com"
```

### Google Gemini
```bash
OPENROUTER_API_KEY=sk-... node integrations/gemini.js "Find what Stripe charges per transaction"
```

### MCP (Claude Desktop / Cursor)
Add to `~/.cursor/mcp.json` or Claude Desktop config:
```json
{
  "mcpServers": {
    "agentdom": {
      "command": "node",
      "args": ["/path/to/agent-schema/mcp-server.js"],
      "env": { "OPENROUTER_API_KEY": "sk-..." }
    }
  }
}
```

### Google A2A Protocol
```bash
OPENROUTER_API_KEY=sk-... npm run a2a
# Agent Card: http://localhost:3800/.well-known/agent.json

# Other agents can send tasks:
curl -X POST http://localhost:3800/tasks/send \
  -H 'Content-Type: application/json' \
  -d '{"message": {"parts": [{"type": "text", "text": "Find Stripe pricing"}]}}'
```

### Chrome Extension
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `chrome-extension/` folder
4. Click the extension icon on any page to scan

## Architecture

```
┌─────────────────────────────────────────────────┐
│              AI Agent (any platform)             │
│  OpenAI / Gemini / Claude / Custom              │
└─────────┬────────┬────────┬────────┬────────────┘
          │        │        │        │
    ┌─────▼──┐ ┌──▼───┐ ┌──▼──┐ ┌──▼──────┐
    │OpenAI  │ │Gemini│ │ MCP │ │HTTP API │
    │Adapter │ │Adapt.│ │     │ │         │
    └────┬───┘ └──┬───┘ └──┬──┘ └──┬──────┘
         └────────┴────────┴───────┘
                       │
              ┌────────▼────────┐
              │  Browser Engine │ ← Session Pool + Stealth
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  agentdom.js    │ ← In-page runtime
              │  scan() + act() │
              └─────────────────┘
```

## AIDL Schema (v3.0)
Every page is converted to this machine-readable format:
```json
{
  "_aidl": "3.0.0",
  "page": {
    "meta": { "title": "...", "url": "...", "description": "..." },
    "forms": [{
      "id": "loginForm",
      "intent": "authenticate",
      "fields": [{ "name": "email", "type": "email", "selector": "#email" }],
      "submitButton": { "selector": "#submit", "label": "Log in" }
    }],
    "actions": [{
      "label": "Sign up", "selector": "#signup-btn",
      "intent": "register", "tag": "button"
    }]
  }
}
```

## Environment Variables
| Variable | Purpose | Required |
|----------|---------|----------|
| `OPENROUTER_API_KEY` | AI intent inference & autonomous mode | For AI features |
| `OPENROUTER_MODEL` | AI model (default: `google/gemini-2.0-flash-001`) | No |
| `AGENTDOM_API_KEY` | HTTP API authentication | No |
| `PORT` | HTTP server port (default: 3700) | No |
| `A2A_PORT` | A2A server port (default: 3800) | No |

## License
MIT
