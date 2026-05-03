---
app: Finder
platform: desktop
framework: appkit
version: 1
notes:
  - Finder's main desktop/folder view is the system desktop; AX exposes it as a window but child file rows are deeply nested. Most reliable surface is the menubar.
  - For file-system operations agents should usually shell out (fs/path) rather than driving Finder; this manifest exists for "show this folder to the user" / GUI-driven flows.
tools:
  - name: new_window
    description: Open a fresh Finder window.
    click: New Finder Window

  - name: new_folder
    description: Create a new folder in the frontmost Finder window.
    click: New Folder

  - name: show_path
    description: Show the path bar in the current Finder window (toggle).
    click: Show Path Bar

  - name: go_home
    description: Navigate to the user's home folder.
    click: Home

  - name: go_applications
    description: Navigate to /Applications.
    click: Applications

  - name: empty_trash
    description: Empty the Trash. Triggers a confirmation sheet.
    click: Empty Trash…
---

# AgentDOM Manifest — Finder

macOS's built-in file manager. AppKit, but the file-row content is deeply
nested and not reliably accessible via the standard scan depth. This manifest
focuses on the menubar — which IS reliably accessible — for the most common
agent intents: open a window, create a folder, jump to a known location.

## Why this manifest

The auto-scanner sees Finder's menubar items but no useful tools come out of
the document area. By manifest-declaring the high-leverage menu intents, an
agent can drive Finder for navigation and folder ops without needing to
descend into AX tree quirks.

## What's NOT covered

- Selecting a specific file in the current view (would need column/list view AX walk).
- Reading the current path / selection state.
- Drag-and-drop.

For most file ops, agents should use Node `fs` / shell commands directly
rather than driving Finder. This manifest is for "make Finder show X to the
user" intents.
