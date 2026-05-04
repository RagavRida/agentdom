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
    intent: messaging.switch_conversation
    click: Jump to…

  - name: search_workspace
    description: Open the workspace search.
    intent: messaging.search
    click: Search…

  - name: set_status
    description: Open the status/profile editor.
    click: Set Yourself as…

  - name: send_message
    description: Send a message in the currently-active conversation. Requires CDP attach (relaunch Slack with --remote-debugging-port=N).
    intent: messaging.send
    params:
      - name: text
        type: string
        description: Message body to send.
    steps:
      - dom_click: '[data-qa="message_input"] [contenteditable="true"]'
      - dom_type:
          selector: '[data-qa="message_input"] [contenteditable="true"]'
          text: ${text}
      - press_keys: Enter

  - name: read_latest
    description: Read the most recent visible message in the active conversation. Requires CDP attach.
    intent: messaging.read
    steps:
      - dom_read: '[data-qa="virtual-list-item"]:last-child'
---

# AgentDOM Manifest — Slack

🟡 **Template — labels verified against Slack 4.x menubar; CDP `dom_*` steps
unverified against a live workspace** (the structural pattern matches Slack's
documented `data-qa` attributes but workspaces vary).

## Two paths

**Path A — Menubar (no setup).** The `click:` tools (preferences, jump,
search, set status) drive the macOS menubar. Works on any Slack install.

**Path B — CDP (workbench).** Relaunch Slack with
`open -a Slack --args --remote-debugging-port=9222` (or set `SLACK_DEVELOPER_MENU=1`
and `--remote-debugging-port` via a wrapper). AgentDOM auto-detects the port
and the `send_message` / `read_latest` tools above register.

## What's NOT covered

- Channel-list navigation by free-text — selectors here target the *active*
  conversation. Use `jump_to_quick_switcher` + `dom_type` against
  `[data-qa="quick_switcher_input"]` to jump first.
- Threaded replies — the thread pane is a separate flex container; PR a
  `send_thread_reply` step that scopes to `[data-qa="thread_pane"]`.

## How to extend

Slack adds menu items in updates; verify these labels still exist in your
installed version:

```bash
node -e "const d = require('agentdom/desktop-agent'); console.log(d.scanApp('Slack').filter(e => e.type === 'menu_item' && e.label).map(e => e.label).join('\n'))"
```

Append the labels you care about under `tools:`. PR this manifest's update
back to the registry if you find a missing intent.
