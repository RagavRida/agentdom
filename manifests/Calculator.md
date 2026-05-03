---
app: Calculator
platform: desktop
framework: swiftui
version: 1
aliases:
  "+": Add
  "-": Subtract
  "*": Multiply
  "x": Multiply
  "/": Divide
  "÷": Divide
  "×": Multiply
  "=": Equals
  "AC": All Clear
  "C": All Clear
  ".": Point
notes:
  - The display value is in AXValue of an AXStaticText element, not AXTitle.
  - Run the All Clear typed action before any new computation.
  - In Scientific mode, Square Root inserts √(...) — supply the argument inside the parens, then Equals.
  - Switching modes via the typed Scientific / Basic / Programmer actions registers a different tool set; always re-scan after a mode switch.
tools:
  - name: clear
    description: Reset the Calculator display to 0.
    click: All Clear
  - name: copy_result
    description: Copy the displayed result to the system clipboard.
    click: Copy
  - name: paste_value
    description: Paste the clipboard value into the display.
    click: Paste
  - name: compute
    description: Compute an arithmetic expression in Basic mode (e.g. "12*7+3"). Returns the displayed result.
    params:
      expression:
        type: string
        required: true
        description: An expression using digits 0-9 and operators + - * / =
    steps:
      - click: All Clear
      - expression_chars: ${expression}
      - click: Equals
      - read: display
---

# AgentDOM Manifest — Calculator (macOS)

The macOS built-in Calculator. SwiftUI on macOS 26+. Three modes: Basic, Scientific, Programmer.

## What this manifest provides

- **Aliases** so an agent that thinks in math notation (`+`, `-`, `*`) can dispatch through the Calculator's accessibility labels (`Add`, `Subtract`, `Multiply`).
- **Notes** capturing non-obvious things the auto-scanner can't tell you: where the display value lives, how Square Root behaves in Scientific mode, the need to re-scan after mode switches.
- **Top-level shortcut tools** (`clear`, `copy_result`, `paste_value`) so the agent doesn't have to know the underlying labels for the most common operations.

## Why an app owner would ship this

The auto-scanner sees 51 buttons including `Add`, `Subtract`, `Equals`. An agent reasoning in arithmetic notation (`+`, `-`, `=`) needs the alias map to bridge the gap. Without the manifest, the agent has to guess that `+` maps to `Add`. With the manifest, the LLM follows a documented contract.

## How to extend this manifest

To add new tools, append to the `tools:` list in the frontmatter. To add new aliases, extend the `aliases:` map. The body below the frontmatter is free-form documentation — the agent's prompt can include it as context.
