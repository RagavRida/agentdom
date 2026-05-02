# AgentDOM — Windows PowerShell Installer
# Usage: irm https://getagentdom.com/install.ps1 | iex

Write-Host ""
Write-Host "  ⚡ AgentDOM Installer" -ForegroundColor Yellow
Write-Host "  ─────────────────────"
Write-Host ""

# Check for Node.js
try {
    $nodeVersion = (node -v) -replace 'v', ''
    $major = [int]($nodeVersion.Split('.')[0])
    if ($major -lt 18) {
        Write-Host "  ✗ Node.js $nodeVersion found, but 18+ required." -ForegroundColor Red
        Write-Host "  → Update: https://nodejs.org"
        exit 1
    }
    Write-Host "  ✓ Node.js v$nodeVersion detected" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Node.js not found." -ForegroundColor Red
    Write-Host "  → Install Node.js 18+: https://nodejs.org"
    exit 1
}

# Install
Write-Host "  → Installing agentdom globally..."
npm install -g agentdom

Write-Host ""
Write-Host "  ✓ AgentDOM installed!" -ForegroundColor Green
Write-Host ""
Write-Host "  Usage:"
Write-Host "    agentdom                          # Interactive mode"
Write-Host "    agentdom https://example.com      # Open a site"
Write-Host ""
Write-Host "  AI Mode (optional):"
Write-Host '    $env:OPENROUTER_API_KEY="sk-or-..."'
Write-Host "    agentdom https://example.com"
Write-Host '    > goal "sign up for newsletter"'
Write-Host ""
