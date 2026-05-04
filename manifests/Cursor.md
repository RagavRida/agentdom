---
app: Cursor
platform: desktop
framework: electron
version: 1
notes:
  - Cursor is a VS Code fork. The menubar AX surface and the workbench DOM selectors are nearly identical to VS Code. Most VS Code DOM selectors (`.monaco-editor`, `.quick-input-widget`) work unchanged.
  - Launch with `cursor --remote-debugging-port=9222` to expose CDP. Without the flag, only the menubar tools below work.
tools:
  - name: open_file
    description: Open the file picker.
    click: Open…

  - name: open_folder
    description: Open the folder picker.
    click: Open Folder…

  - name: command_palette
    description: Open Cursor's command palette via CDP keyboard.
    steps:
      - press_keys: Meta+Shift+KeyP
      - wait: 200

  - name: ai_chat
    description: Open Cursor's AI chat sidebar (Cmd+L). Requires CDP attach.
    steps:
      - press_keys: Meta+KeyL
      - wait: 250

  - name: ai_compose
    description: Open Cursor's inline AI composer (Cmd+K) and send a prompt. Requires CDP attach.
    params:
      - name: prompt
        type: string
        description: Natural-language instruction for the inline edit.
    steps:
      - press_keys: Meta+KeyK
      - wait: 250
      - dom_type:
          selector: ".aislash-editor-input, .composer-input, .inline-composer-input"
          text: ${prompt}
      - wait: 150
      - press_keys: Enter

  - name: run_command
    description: Run any workbench command by name. Requires CDP attach.
    params:
      - name: command
        type: string
        description: Command title (e.g. "Format Document").
    steps:
      - press_keys: Meta+Shift+KeyP
      - wait: 250
      - dom_type:
          selector: ".quick-input-widget input"
          text: ${command}
      - wait: 200
      - press_keys: Enter

  - name: editor_text
    description: Read the active editor's visible text. Requires CDP attach.
    steps:
      - dom_read: ".monaco-editor .view-lines"
---

# AgentDOM Manifest — Cursor

🟡 **Template — derived from the verified VS Code path.** Cursor's
Chromium renderer is structurally identical to VS Code's, so the same
selectors and chord injection work. Selectors specific to Cursor's AI UI
(`.aislash-editor-input`, `.composer-input`) are best-effort and may shift
between Cursor releases.

## Setup

```bash
# One-time launch with CDP exposed
cursor --remote-debugging-port=9222 ~/your-project

# From an agent
attach_electron({ app: "Cursor" })
ai_compose({ prompt: "extract this into a function" })
```

## Why a separate manifest

VS Code's manifest covers the editor surface; Cursor's manifest adds the
AI-specific intents (`ai_chat`, `ai_compose`) that don't exist in stock
VS Code.
