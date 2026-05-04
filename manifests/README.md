# AgentDOM Manifest Registry

Curated `AGENTDOM.md` manifests for popular apps. Drop one in here and any
MCP-connected LLM can drive that app with typed semantic tools.

## What's in the box

| File                          | Surface  | Status     | Notes                                        |
| ----------------------------- | -------- | ---------- | -------------------------------------------- |
| `Calculator.md`               | desktop  | ✅ verified | SwiftUI; full `compute(expression)` + 11 aliases |
| `TextEdit.md`                 | desktop  | ✅ verified | AppKit; `write_note(text)` round-trips       |
| `Finder.md`                   | desktop  | ✅ verified | File-ops menu intents — `new_window()` round-trips |
| `git.md`                      | cli      | ✅ verified | 5 query tools, real `git` invocations        |
| `docker.md`                   | cli      | 🟡 template | Cobra-style; verifiable if Docker installed  |
| `Stub API.md`                 | api      | ✅ verified | Backed by the test harness's local httpd     |
| `example.com.md`              | web      | ✅ verified | IANA test domain                             |
| `Slack.md`                    | desktop  | 🟡 template | Electron — menubar verified; CDP `dom_*` steps need a live workspace |
| `Visual Studio Code.md`       | desktop  | ✅ verified | Electron — menubar AX + CDP workbench; relaunch with `--remote-debugging-port=N` |
| `Cursor.md`                   | desktop  | 🟡 template | VS Code fork — same selectors plus AI-specific `ai_chat` / `ai_compose` |

**Status legend:** ✅ verified end-to-end on the maintainer's machine; 🟡 template
written from public docs / app menus, awaiting first-run verification on a real
host.  Templates are still useful — they encode the intended shape and let
contributors refine vs starting from a blank file.

## Discovery order

The desktop / CLI / API / web MCP servers all consult these locations in order
on every `scan_*` call:

1. `~/.agentdom/manifests/<key>.md`  — user override
2. `<package>/manifests/<key>.md`     — bundled (this directory)

The first match wins.  `<key>` is the app/binary/site name:

- **desktop:**  app's `localizedName` (e.g. `Calculator`, `‎WhatsApp` — bidi marks ignored)
- **cli:**       binary name (e.g. `git`, `docker`)
- **api:**       OpenAPI spec's `info.title` (e.g. `Stub API`)
- **web:**       page's hostname, leading `www.` stripped (e.g. `example.com`)

## How to contribute a manifest

1. Run the relevant MCP server against your target app:
   ```
   npm run mcp:desktop      # for desktop apps
   npm run mcp:cli          # for CLI binaries
   npm run mcp:api          # for HTTP APIs
   npm run mcp               # for web pages (Puppeteer)
   ```
2. From an MCP client (Claude Desktop, the harness in `test/mcp-servers.test.js`,
   or the demos in `test/*.demo.js`), call the surface's `scan_*` meta tool and
   inspect the auto-emitted tool list.
3. Identify the 5–15 highest-leverage intents an agent will actually need.
4. Write `manifests/<key>.md` with frontmatter + tool steps. See `MANIFEST-SPEC.md`
   for the full grammar.
5. Test by re-running `scan_*`.  The response's `manifest:` block should report
   your tool count and notes.
6. Open a PR.  If you've verified each tool returns the expected result on a
   real host, mark it ✅ in this README; otherwise mark it 🟡.

## What goes in a manifest vs the auto-scanner

The auto-scanner reads the live AX tree / DOM / `--help` / OpenAPI spec and
emits **mechanical** tools by label: `click_save`, `click_send`, `submit_form`.

The manifest adds **semantic** tools the scanner can't infer:

- **Aliases.** `+` → `Add`, `cmd+s` → `Save`, `←` → `Previous`. Maps the way an
  LLM thinks to the labels the app exposes.
- **Multi-step intents.** `compute(expression)` instead of 7 separate clicks.
  `write_note(text)` instead of select-all + type + read.
- **Lifecycle notes.** "Run All Clear before any computation", "macOS Tahoe
  auto-closes idle docs", "this Electron app's web content is not in the AX
  tree".
- **Versioning.** Bump `version:` when intents change so agents can detect drift.

## When a manifest is the wrong tool

- **One-off interactions** the agent can synthesize from auto-emitted tools.
  Don't manifest `click_save` — the auto-scanner already exposes it.
- **Apps with rich, well-behaved AX trees.**  Calculator and TextEdit don't
  *need* manifests for basic interaction; the manifests we ship for them add
  intent shortcuts and aliases on top.
- **Apps where intent depends on per-user state.** A "post to my favourite
  channel" intent in Slack belongs in the agent's preferences, not a shared
  manifest.

## What's still missing in the registry

If you ship an app and want it manifested here, the highest-impact additions
right now are:

- **Notion** (Electron — agents constantly hit the search & nav surface)
- **Discord** (Electron — same shape as Slack)
- **Cursor**  (Electron, fork of VS Code — could share most of the VS Code template)
- **Mail** (native AppKit — clean AX tree, easy to manifest)
- **Linear** (web — typed shortcut menu would cover ~80% of agent intents)
- **kubectl** (CLI — Kubernetes operators want this)
- **gh** (the GitHub CLI)

Open issues on the agentdom repo with the label `manifest-request` for any of
these and the registry will grow.
