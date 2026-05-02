#!/bin/bash
# AgentDOM — macOS/Linux Installer
# Usage: curl -fsSL https://getagentdom.com/install.sh | bash

set -e

echo ""
echo "  ⚡ AgentDOM Installer"
echo "  ─────────────────────"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "  ✗ Node.js not found."
    echo "  → Install Node.js 18+: https://nodejs.org"
    echo ""
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "  ✗ Node.js $NODE_VERSION found, but 18+ required."
    echo "  → Update: https://nodejs.org"
    exit 1
fi

echo "  ✓ Node.js $(node -v) detected"

# Install globally via npm
echo "  → Installing agentdom globally..."
npm install -g agentdom 2>&1 | tail -1

echo ""
echo "  ✓ AgentDOM installed successfully!"
echo ""
echo "  Usage:"
echo "    agentdom                          # Interactive mode"
echo "    agentdom https://example.com      # Open a site"
echo "    agentdom --help                   # See all options"
echo ""
echo "  AI Mode (optional):"
echo "    export OPENROUTER_API_KEY=sk-or-..."
echo "    agentdom https://example.com"
echo "    > goal \"sign up for newsletter\""
echo ""
