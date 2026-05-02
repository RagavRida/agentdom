@echo off
REM AgentDOM — Windows Installer
REM Usage: Download and run, or:
REM   powershell -c "irm https://getagentdom.com/install.ps1 | iex"

echo.
echo   AgentDOM Installer
echo   ────────────────────
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   X Node.js not found.
    echo   ^> Install Node.js 18+: https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo   √ Node.js detected
echo   ^> Installing agentdom globally...

npm install -g agentdom

echo.
echo   √ AgentDOM installed!
echo.
echo   Usage:
echo     agentdom                          # Interactive mode
echo     agentdom https://example.com      # Open a site
echo.
pause
