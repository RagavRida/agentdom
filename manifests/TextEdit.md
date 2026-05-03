---
app: TextEdit
platform: desktop
framework: appkit
version: 1
aliases:
  "save_doc": Save
  "save_as": Save As…
  "new_doc": New
  "open_doc": Open…
  "close_doc": Close
notes:
  - The document body is a single AXTextArea labelled "text entry area" — type into it via typeIntoField.
  - Untitled docs do not prompt to save when closed (no save sheet).
  - macOS Tahoe auto-closes idle documents after a while; if scan returns no text_area, dispatch click_new first.
tools:
  - name: new_document
    description: Open a fresh untitled document.
    click: New
  - name: save_document
    description: Save the current document. Triggers the Save sheet for unsaved docs.
    click: Save
  - name: copy_selection
    description: Copy the current text selection.
    click: Copy
  - name: paste_clipboard
    description: Paste clipboard contents at the caret.
    click: Paste
  - name: select_all
    description: Select all text in the current document.
    click: Select All
  - name: write_note
    description: Replace the current document body with the given text. Returns the document body for verification.
    params:
      text:
        type: string
        required: true
        description: Text to write into the document.
    steps:
      - click: Select All
      - type:
          field: text entry area
          text: ${text}
      - read: text entry area
---

# AgentDOM Manifest — TextEdit (macOS)

The macOS built-in plain-text and rich-text editor. AppKit-based.

## What this manifest provides

- **Top-level intents** mapped to Edit/File menu items: `save_document`, `paste_clipboard`, `copy_selection`, etc.
- **Notes** about the text-area's accessibility shape so the agent knows to use `typeIntoField("TextEdit", "text entry area", text)` rather than guessing.
- **Lifecycle quirks** documented: macOS Tahoe auto-closes idle docs, so an agent should always check whether a `text_area` is in scope before dispatching `paste_clipboard`.

## Recommended workflow for "write to a TextEdit doc"

1. `scan_app("TextEdit")` — register the typed-tool list.
2. If the scan has no `text_area`: `new_document` (opens an Untitled doc), then re-scan.
3. `typeIntoField("TextEdit", "text entry area", "Hello AgentDOM")`, OR use the clipboard hop: `pbcopy <text>` then dispatch `paste_clipboard`.
4. `scan_app` again to confirm the doc body contains the expected text.

## Limitations to be aware of

- Rich-text formatting is not exposed as a dedicated typed surface — the formatting toolbar's buttons (Bold, Italic, Underline) appear as `click_bold` / `click_italic` action tools, but reading the *current* formatting state is not exposed via accessibility.
- The find panel (`click_find`) opens a modal sheet with its own typed tools — sheet recursion in scan_app picks them up but they only register while the panel is visible.
