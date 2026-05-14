#!/bin/bash
# AgentDOM installer — curl -fsSL agentdom.dev/install | sh
set -e

echo "🔧 Installing AgentDOM..."

# Check for Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install it first: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required (found $(node -v))"
  exit 1
fi

# Install agentdom globally
npm install -g agentdom@latest

# Run doctor to verify
agentdom doctor || true

echo ""
echo "✅ AgentDOM installed! Get started:"
echo "   agentdom auth github.com    # authenticate"
echo "   agentdom serve              # start MCP server"
