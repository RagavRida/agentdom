# AgentDOM — Tools & Capabilities

Single source of truth for what the agent gets, what the host needs to provide,
and what's still to build. Last updated 2026-05-03.

---

## 1. Capability surface — what tools the agent receives

`compile(scan, { from, to })` returns `{ ir, tools }`. The shape of `tools`
depends on `to`. The set of tools depends on `from` and the scan content.

### 1.1 Per-source: what each adapter extracts

| Source     | Adapter      | Extracts                                                                     |
| ---------- | ------------ | ---------------------------------------------------------------------------- |
| `desktop`  | `from-desktop` | buttons, text fields, checkboxes, menus, links, framework metadata           |
| `web`      | `from-web`     | `<form>`s with typed fields, buttons, links (→ navigation), POST forms tag side-effects |
| `cli`      | `from-cli`     | subcommands + flags from `--help` text (Cobra/Click/argparse styles)         |
| `api`      | `from-openapi` | every operation across paths (GET/POST/PUT/PATCH/DELETE), parameters, JSON request body, `$ref` resolution |

### 1.2 Per-target: tool list shape

| Target     | Shape                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------- |
| `openai`   | `{ type: 'function', function: { name, description, parameters: {type, properties, required} } }` |
| `mcp`      | `{ name, description, inputSchema: {type, properties, required} }`                           |

Both targets carry an `_internal` field with the source selector + intent +
sideEffects so an executor can route the call back to the underlying surface.

### 1.3 Tool kinds emitted

| Kind          | Emitted from                                            | Example name     |
| ------------- | ------------------------------------------------------- | ---------------- |
| Form tool     | `ir.forms[]` — group of related inputs + submit         | `authenticate`, `create_pet` |
| Action tool   | `ir.actions[]` — standalone clickable                   | `click_save`, `click_cancel` |
| Navigation    | `ir.navigation[]` — collapsed into one tool with enum   | `navigate({ target })` |

State (checkbox toggles, radio selections) is exposed in `ir.state[]` for
agents to inspect; it isn't surfaced as a callable tool by default.

### 1.4 Optimizer passes

Every IR goes through these before codegen:

1. **Dead-element elimination** — disabled, covered, hidden, empty-label dropped.
2. **Deduplication** — same `(type, label, selector)` collapses.
3. **Name normalization** — labels become `snake_case` slugs for tool names.
4. **Side-effect tagging** — intent → `['create' | 'delete' | 'update' | …]`.
5. **Priority ranking** — auth/create/delete = 1, search/update = 2, nav = 3, dismiss = 4.

---

## 2. Runtime requirements — what the host needs

### 2.1 Permissions

| Platform   | Required                                                                                  | How to grant                                                          |
| ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| macOS      | Accessibility (mandatory). Screen Recording (only for `screenshotApp`).                   | System Settings → Privacy & Security → Accessibility → add Terminal/Node binary. |
| Windows    | Run elevated *only if the target app is elevated*. Otherwise no special perms.            | Right-click → Run as administrator (when needed).                     |
| Linux      | Not yet supported.                                                                        | —                                                                     |

`desktop.checkPermissions()` probes and returns `{ ok, hint }` with concrete remediation.

### 2.2 Required binaries

| Binary       | When needed                                            | Notes                            |
| ------------ | ------------------------------------------------------ | -------------------------------- |
| `osascript`  | macOS desktop ops                                      | Ships with macOS.                |
| `python3`    | macOS scrolling + display enumeration                  | Quartz bindings via PyObjC.       |
| `powershell` | Windows desktop ops                                    | Ships with Windows.              |
| Node ≥ 18    | All paths                                              | —                                |

### 2.3 Optional binaries

| Binary       | When used                                                                          | Fallback                                  |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| `cliclick`   | macOS `clickAt` / `humanClick` / `drag` — multi-display safe via CGEvent.          | AppleScript "click at" — primary display only. |
| `pbcopy` / `pbpaste` | macOS Unicode text input via clipboard paste.                              | Plain `keystroke` (corrupts non-ASCII).   |

### 2.4 Network

None of the compiler stages require network. Scanners and codegen are pure local
operations. The optional `agent-platform.js` and `mcp-server.js` open local
sockets but no outbound calls except to user-configured LLM endpoints.

---

## 3. Public API surface

### 3.1 `desktop-agent/index.js`

| Function | Purpose | Notes |
| --- | --- | --- |
| `checkPermissions()` | Probe permission state | macOS / Windows |
| `isRunning(app)` | Is the app running? | Fast (~100ms) |
| `getDisplays()` | Enumerate monitors | `[{id, x, y, width, height, primary}]` |
| `detectFramework(app)` | `'electron' \| 'java' \| 'native' \| 'unknown'` | macOS only |
| `listApps()` | Apps with windows | |
| `openApp(app)` / `activate(app)` | Launch / foreground | |
| `scanApp(app)` | UI-tree dump | Adds `_meta` for Electron, sheets recursed |
| `clickElement(app, label)` | Click via AXPress / InvokePattern | Accepts `"Label (n)"` for duplicates |
| `clickAt(x, y)` | Click at screen coords | Uses cliclick where available |
| `typeText(app, text)` | Type into focused field | Auto-clipboard for Unicode |
| `typeIntoField(app, field, text)` | Set value via AXSetValue / ValuePattern | |
| `pressKeys(app, "cmd+s")` | Keyboard shortcut | Whitelisted modifiers/keys |
| `clickMenu(app, "File > Save")` | Menu navigation | macOS + Windows |
| `screenshotApp(app, path)` | Window-region capture | |
| `scroll(app, dir, n)` / `scrollTo(app, pos)` | Scroll | CGEvent on macOS, SendKeys on Windows |
| `drag(fromX, fromY, toX, toY)` | Drag | |
| `runAppleScript(script)` | Escape hatch | macOS only |
| `withRetry(fn, {retries, delay})` | Retry primitive | |

### 3.2 `compiler/index.js`

| Function | Returns |
| --- | --- |
| `compile(scan, { from, to, appName?, command? })` | `{ ir, tools }` |
| `fromDesktop(scan, opts)` | IR |
| `fromWeb(scan)` | IR |
| `fromCLI(helpText, { command })` | IR |
| `fromOpenAPI(spec)` | IR |
| `optimize(ir)` | IR |
| `toOpenAI(ir)` / `toMCP(ir)` | tool list |

### 3.3 CLI subcommands

| Command | Effect |
| --- | --- |
| `agentdom <url>` | Web automation REPL |
| `agentdom --desktop` | Desktop automation REPL |
| `agentdom init [dir] [--force]` | Scaffold a starter project |

---

## 4. Roadmap — tools still to ship

### Near-term (each ≤ 1 day)

- **Web headless `activate()` for Windows** — UIA doesn't expose a native focus pattern; current `SetForegroundWindow` is the workaround. Investigate whether `clickElement` + `typeIntoField` callers genuinely need foregrounding (most don't). Drop the call where unnecessary; keep it only for SendKeys-based ops.
- **Field-name slugging in OpenAI codegen** — current params are raw labels (`Email`, `Password`). Slug to `email` / `password` for cleaner agent-side ergonomics.
- **Catalyst detection** via `Info.plist` parsing — distinguish AppKit from Catalyst (currently both report `'native'`).
- **Web adapter for `agentdom init` template** — show a 3-line web example alongside the desktop one so adopters see both surfaces.

### Medium-term (each ≤ 1 week)

- **Linux platform port** — `xdotool` + AT-SPI for X11, `ydotool` for Wayland. Same API surface as macOS/Windows.
- **Form-grouping heuristic v2** — proximity-based grouping (rect intersection) so a real desktop app with multiple distinct forms doesn't collapse into one synthetic form.
- **Electron CDP injection** — when `detectFramework === 'electron'`, attach to the renderer's DevTools port and inject `agentdom.js` directly. Recovers the full DOM that the AX tree masks.
- **`agentdom record`** — capture user actions, serialize as a script, replay deterministically. Visual way to author automations.
- **Chrome extension** — zero-install demo path: inject `agentdom.js` into any page from the toolbar, expose tools to a connected agent.
- **Interactive docs** at `getagentdom.com/docs` — live playground.

### Long-term (each ≥ 1 week)

- **Auth-flow automation** — OAuth, MFA, CAPTCHA handlers. Biggest blocker for real-world deployments.
- **Mobile scanners** — iOS via XCUITest, Android via UIAutomator. Same IR target.
- **Session management** — parallel agents, isolated browser pools.
- **Observability** — structured logging, replay, audit trail for compliance.

### Already shipped this branch (reference)

- ✅ Shell-injection hardening across `desktop-agent`
- ✅ Permission detector (`checkPermissions`)
- ✅ Retry primitive (`withRetry`)
- ✅ Windows clickElement / typeIntoField / clickMenu (UI Automation)
- ✅ Unicode → clipboard paste fallback (both platforms)
- ✅ App-running probe (`isRunning`)
- ✅ Duplicate-label disambiguation (`"OK (2)"`)
- ✅ Multi-display enumeration (`getDisplays`)
- ✅ macOS framework detection + sheet/modal recursion
- ✅ Unified IR + adapters (desktop / web / cli / api)
- ✅ Optimizer (5 passes)
- ✅ Codegen targets (OpenAI, MCP)
- ✅ Compiler smoke suite (15 passing)
- ✅ Error messages with remediation hints across every failure path
- ✅ `agentdom init` scaffolder
