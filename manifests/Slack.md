---
app: Slack
platform: desktop
framework: electron
version: 1
notes:
  - Slack is an Electron app — the message list, channel sidebar, and message input are Chromium web content and NOT exposed via macOS Accessibility. The scanner sees Slack's chrome (menubar + window controls) only.
  - Until web content is wired through Chrome DevTools Protocol, manifest tools here are limited to menu-driven intents (preferences, search, navigate-back, set-status). Sending messages requires CDP injection or keyboard automation; not in v1.
  - Slack's keyboard shortcuts are extensive and reliable — agents should prefer those over menu navigation when the desired action has a shortcut (Cmd+K for quick switcher, Cmd+/ for shortcut help).
tools:
  - name: open_preferences
    description: Open Slack's preferences window.
    click: Preferences…

  - name: hide_slack
    description: Hide the Slack app (without quitting).
    click: Hide Slack

  - name: workspace_directory
    description: Open the workspace's member directory.
    click: Workspace Directory

  - name: jump_to_quick_switcher
    description: Open Slack's quick-switcher (jump to channel/DM).
    click: Jump to…

  - name: search_workspace
    description: Open the workspace search.
    click: Search…

  - name: set_status
    description: Open the status/profile editor.
    click: Set Yourself as…
---

# AgentDOM Manifest — Slack (template)

⚠️ **This is a 🟡 template, not yet verified end-to-end.** Slack's labels may
shift between versions; test against your installed Slack and adjust.

## What's actually possible today

Slack runs on Electron. The scanner sees:

- The full macOS menubar (File, Edit, View, Window, Help, etc. — accessible)
- Window chrome (close/minimize/zoom buttons)
- Slack's *web* content (channel list, message input, threads): **invisible**

So this manifest's tools are all menubar-driven. They open dialogs, jump to
the quick switcher, or trigger keyboard shortcuts via the menu's bound
accelerator.

## What's NOT covered

- Sending a message to a channel or DM — message input is web content.
- Reading the unread count or recent messages — same reason.
- Channel-list navigation — same reason.

For those flows, the right answer is **Chrome DevTools Protocol injection** —
attach to Slack's Electron renderer process and inject `agentdom.js`, the
same way the web MCP server handles real browser pages. That's deferred
for a future commit.

## How to extend

Slack adds menu items in updates; verify these labels still exist in your
installed version:

```bash
node -e "const d = require('agentdom/desktop-agent'); console.log(d.scanApp('Slack').filter(e => e.type === 'menu_item' && e.label).map(e => e.label).join('\n'))"
```

Append the labels you care about under `tools:`. PR this manifest's update
back to the registry if you find a missing intent.
