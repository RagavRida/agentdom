# AGENTDOM.md — App Manifest Spec

A single markdown file an app ships so any MCP-connected LLM can interact with
it through typed tools, with semantic intent names instead of raw UI labels.

Same shape as `llms.txt` for sites or OpenAPI for HTTP APIs — but for app UIs.

---

## Why ship a manifest

The AgentDOM scanner can already read the accessibility tree of any running app
and auto-generate typed tools (`click_save`, `navigate({target})`, etc.). That
covers ~80% of the surface. The manifest covers the gap:

- **Semantic intent names.** The auto-emitted tool for Calculator's add button
  is `click_add`. An LLM reasoning in math notation thinks `+`. The manifest
  maps `+` → `Add`.
- **Workflow notes the scanner can't see.** "The Save sheet appears only for
  unsaved docs", "Square Root in Scientific mode inserts √() — supply the
  argument inside", "Display value lives in AXValue, not AXTitle".
- **Top-level intents that bundle multi-step flows.** A `clear` intent on
  Calculator that the manifest defines as `click: All Clear` instead of the
  agent guessing among 51 button labels.
- **Versioning and provenance.** App owners stamp the manifest with their app
  version; agents can warn if they're talking to an older release than the
  manifest was written for.

## File location

The desktop MCP server looks for a manifest by app name in this order:

1. `~/.agentdom/manifests/<AppName>.md` — user override.
2. `<package>/manifests/<AppName>.md` — bundled with AgentDOM.
3. *(future)* inside the app bundle at `Contents/Resources/AGENTDOM.md`.

The first match wins. App name matching is bidi-mark-tolerant, so `‎WhatsApp`
and `WhatsApp` both find a `WhatsApp.md` manifest.

## File format

Markdown with YAML-ish frontmatter between `---` lines. The frontmatter is the
machine-readable spec; the body below is free-form documentation that an agent
can include in its prompt as context.

### Frontmatter fields

| Field       | Type                  | Required | Purpose                                        |
| ----------- | --------------------- | -------- | ---------------------------------------------- |
| `app`       | string                | yes      | App name as it appears in macOS Dock / Finder. |
| `platform`  | `desktop`/`web`/`cli`/`api` | yes | Surface this manifest targets.                  |
| `framework` | `appkit`/`swiftui`/`catalyst`/`electron`/`java`/`native` | no | Helps agents set expectations. |
| `version`   | integer               | no       | Manifest revision number; bump on changes.    |
| `aliases`   | map of string→string  | no       | Label aliases used by manifest tools.          |
| `notes`     | list of strings       | no       | Limitations / non-obvious behavior.            |
| `tools`     | list of tool entries  | no       | Top-level intents the agent can call.          |

### Tool entry

Each entry in `tools:` describes one intent the agent can invoke. v1 supports
single-click intents:

```yaml
tools:
  - name: clear
    description: Reset the display to 0.
    click: All Clear
```

`name` is what the agent calls (`clear()`); `description` is its docstring;
`click` is the AX label the dispatcher invokes — alias-resolved.

Future versions will support multi-step intents (`steps:`), parameterized
tools (`params:`), and verification (`verify:`).

## Worked example

`manifests/Calculator.md`:

```markdown
---
app: Calculator
platform: desktop
framework: swiftui
version: 1
aliases:
  "+": Add
  "-": Subtract
  "*": Multiply
  "=": Equals
notes:
  - Display value is in AXValue, not AXTitle.
  - Run All Clear before any new computation.
tools:
  - name: clear
    description: Reset the display to 0.
    click: All Clear
  - name: copy_result
    description: Copy the displayed result to the clipboard.
    click: Copy
---

# Calculator AgentDOM Manifest

The macOS Calculator. SwiftUI on macOS 26+. Three modes: Basic / Scientific / Programmer.
... free-form context for the agent ...
```

## What the agent sees

When the MCP client calls `scan_app({ app: "Calculator" })`, the response now
includes:

```jsonc
{
  "app": "Calculator",
  "framework": "native",
  "counts": { "forms": 0, "actions": 55, "navigation": 6 },
  "manifest": {
    "source": "/.../manifests/Calculator.md",
    "tools": 3,
    "aliases": 11,
    "notes": [
      "Display value is in AXValue, not AXTitle.",
      ...
    ]
  },
  "tools": [
    { "name": "clear",        "description": "Reset the display to 0.", "inputSchema": {...} },
    { "name": "copy_result",  "description": "Copy the displayed result.", "inputSchema": {...} },
    { "name": "click_add",    "description": "Click \"Add\" on Calculator.", ... },
    { "name": "click_2",      ... },
    ...
  ]
}
```

Manifest-declared tools come first; auto-discovered tools fill in the rest.
The agent can invoke `clear()` (manifest) or `click_2()` (auto) interchangeably.

## What this is not

- **Not a replacement for the auto-scanner.** The manifest *augments*; an app
  with no manifest still gets the full auto-emitted tool set.
- **Not a programmable DSL.** v1 supports declarative click-intents only.
  Programmable workflows belong in the agent's reasoning, not in the manifest.
- **Not bundled in the app binary (yet).** For now the manifest ships in
  `<package>/manifests/` or `~/.agentdom/manifests/`. Future versions will read
  `Contents/Resources/AGENTDOM.md` from the app bundle so app owners can ship
  it with their release.

## How to ship a manifest as an app owner

1. Open your app while it's running on macOS.
2. `npm install -g agentdom && agentdom-mcp-desktop` *or* run `node desktop-mcp-server.js` from this repo.
3. From an MCP client, call `scan_app({ app: "<your app name>" })` and copy the auto-emitted tools list.
4. Trim it to the intents that matter most for agents (typically: 5–15 tools).
5. Add aliases for any non-obvious label mappings (icons, internationalization).
6. Add `notes:` describing quirks the scanner can't see.
7. Drop the file at `<app>/manifests/<AppName>.md` in this package, or
   `~/.agentdom/manifests/<AppName>.md` for personal use.
8. Re-run `scan_app`; the response's `manifest:` block confirms it loaded.

## Versioning

Bump `version:` on breaking changes (renamed tools, removed aliases). Agents
can pin to a manifest version and detect drift.

---

This spec is v0.1. Feedback: open an issue against the agentdom repo with the
label `manifest-spec`.
