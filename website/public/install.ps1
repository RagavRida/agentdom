# AgentDOM installer — irm https://agentdom.dev/install.ps1 | iex
$ErrorActionPreference = 'Stop'

Write-Host "🔧 Installing AgentDOM..."

# Check for Node.js
try {
    $nodeVersionRaw = (node -v) 2>$null
} catch {
    Write-Host "❌ Node.js not found. Install it first: https://nodejs.org" -ForegroundColor Red
    exit 1
}
if (-not $nodeVersionRaw) {
    Write-Host "❌ Node.js not found. Install it first: https://nodejs.org" -ForegroundColor Red
    exit 1
}

$nodeVersion = $nodeVersionRaw -replace 'v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 18) {
    Write-Host "❌ Node.js 18+ required (found v$nodeVersion)" -ForegroundColor Red
    exit 1
}

# Install agentdom globally
npm install -g agentdom@latest

# Run doctor to verify (don't fail install if doctor reports something)
try { agentdom doctor } catch {}

Write-Host ""
Write-Host "✅ AgentDOM installed! Get started:" -ForegroundColor Green
Write-Host "   agentdom auth github.com    # authenticate"
Write-Host "   agentdom serve              # start MCP server"
