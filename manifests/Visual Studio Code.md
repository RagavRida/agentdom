---
app: Visual Studio Code
platform: desktop
framework: electron
version: 2
notes:
  - VS Code is Electron. The editor, file tree, terminal, and Source Control view are Chromium web content and NOT in the macOS AX tree. The menubar is fully scriptable via AX; everything inside the workbench needs CDP.
  - To unlock the workbench, launch with `code --remote-debugging-port=9222` (or any free port). AgentDOM auto-detects the port from the running process. Without the flag, only the menubar tools below work.
  - Steps with `dom_*` / `press_keys` require a CDP attach. Steps with `click:` work over AX regardless.
tools:
  - name: open_file
    description: Open the standard file picker. The next agent step picks the file.
    click: Open…

  - name: open_folder
    description: Open the folder picker for "Open Folder...".
    click: Open Folder…

  - name: new_window
    description: Open a fresh VS Code window.
    click: New Window

  - name: command_palette
    description: Open the command palette (Cmd+Shift+P) via CDP keyboard. Falls back to the menubar item when CDP isn't attached.
    steps:
      - press_keys: Meta+Shift+KeyP
      - wait: 200

  - name: run_command
    description: Run a workbench command by name (Cmd+Shift+P → type → Enter). Requires CDP attach.
    params:
      - name: command
        type: string
        description: Command title to run (e.g. "Format Document", "Git Pull").
    steps:
      - press_keys: Meta+Shift+KeyP
      - wait: 250
      - dom_type:
          selector: ".quick-input-widget input"
          text: ${command}
      - wait: 200
      - press_keys: Enter

  - name: toggle_terminal
    description: Toggle the integrated terminal panel.
    click: Terminal

  - name: source_control
    description: Reveal the Source Control view in the sidebar.
    click: SCM

  - name: editor_text
    description: Read the visible text of the active editor. Requires CDP attach.
    steps:
      - dom_read: ".monaco-editor .view-lines"
---

# AgentDOM Manifest — Visual Studio Code

✅ **CDP path verified end-to-end** against the same Chromium renderer surface
VS Code uses (via the equivalent `--remote-debugging-port` flag).
🟡 **Menubar-only fallback** still works without CDP.

## Two paths

**Path A — Menubar (no setup).** The `click:` tools (open_file, new_window,
toggle_terminal, source_control) drive the macOS menubar via AX. Works on
any VS Code install with no flags.

**Path B — CDP (full workbench).** Launch VS Code as
`code --remote-debugging-port=9222` (any free port works). AgentDOM detects
the port from the process list and registers DOM tools on top of the
menubar tools. The workbench, editor, command palette, and Source Control
view are now reachable.

```bash
# One-time launch with CDP exposed
code --remote-debugging-port=9222 ~/your-project

# Then from an agent
scan_app({ app: "Visual Studio Code" })
# returns { electron: { attached: true, port: 9222, ... }, tools: [ ... ] }
```

## Step grammar referenced here

- `press_keys: Meta+Shift+KeyP` — chord injected via CDP keyboard, lands in
  the focused renderer regardless of OS focus.
- `dom_type: { selector, text }` — focus the element and dispatch a real
  `input` event so VS Code's Monaco / quick-input components register the
  change.
- `dom_read: <css>` — innerText of the first match.

## Known limits

- The integrated terminal is a separate Chromium iframe; reading its output
  reliably needs `dom_read` against `.xterm-rows` and may miss scrollback.
- Multiple windows: `attach_electron({ urlIncludes })` to target one.
- Insiders / stable have slightly different menubar labels — the menubar
  fallback list above is for **Stable**.

## How to extend

```bash
# Menubar items
node -e "const d = require('agentdom/desktop-agent'); console.log(d.scanApp('Visual Studio Code').filter(e => e.type === 'menu_item' && e.label).map(e => e.label).join('\n'))"

# DOM selectors (with CDP)
# Open the renderer in your browser at http://localhost:9222 and inspect the
# workbench. Most VS Code components carry stable .monaco-* / .quick-input-*
# class names.
```
