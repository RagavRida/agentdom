---
app: Visual Studio Code
platform: desktop
framework: electron
version: 1
notes:
  - VS Code is Electron. The editor, file tree, and terminal are Chromium web content and NOT in the AX tree. Manifest tools are menubar-driven.
  - VS Code exposes its full command palette via Cmd+Shift+P. The "command_palette" tool below opens it; the agent then types the desired command. Sending the actual command text requires CDP or keyboard automation (deferred to a future commit).
tools:
  - name: open_file
    description: Open the standard file picker. The user / next agent step picks the file.
    click: Open…

  - name: open_folder
    description: Open the folder picker for "Open Folder...".
    click: Open Folder…

  - name: new_window
    description: Open a fresh VS Code window.
    click: New Window

  - name: command_palette
    description: Open the command palette (Cmd+Shift+P). Agent should type the command name next.
    click: Command Palette…

  - name: toggle_terminal
    description: Toggle the integrated terminal panel.
    click: Terminal

  - name: source_control
    description: Reveal the Source Control view in the sidebar.
    click: SCM
---

# AgentDOM Manifest — Visual Studio Code (template)

⚠️ **🟡 template — not yet verified.** Same Electron-content limitation as
Slack: editor, file tree, terminal pane, and Source Control view are
Chromium web content and not exposed via macOS Accessibility.

## What's actually possible today

VS Code's macOS menubar is rich (File, Edit, Selection, View, Go, Run,
Terminal, Window, Help). The manifest exposes the most common navigation
and panel-toggle intents an agent would reach for.

For *any* command, `command_palette` opens the palette and the agent
types the command name. With CDP injection (deferred), the agent could
also drive the editor directly: open files by path, jump to symbol, run
debug configs.

## What's NOT covered

- Opening a specific file by path — Open dialog is a sheet, but selecting
  inside it via accessibility is unreliable. Use the OS-level `code <path>`
  CLI instead (which IS scriptable — see `manifests/code.md` if shipped).
- Reading editor contents — Chromium-rendered, not in AX.
- Running tasks — pipe the workspace's `.vscode/tasks.json` to a CLI agent
  flow instead.

## How to extend

VS Code's menubar items differ between Stable and Insiders, and between
versions. Run:

```bash
node -e "const d = require('agentdom/desktop-agent'); console.log(d.scanApp('Visual Studio Code').filter(e => e.type === 'menu_item' && e.label).map(e => e.label).join('\n'))"
```

PR additions to this manifest based on your installed build.
