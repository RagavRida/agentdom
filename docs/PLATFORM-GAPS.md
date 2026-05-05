# AgentDOM — Platform Gaps & Workarounds

Last updated: 2026-05-05

This document catalogs known platform-specific limitations and the
recommended workarounds for agents.

---

## 1. macOS Catalyst Apps (WhatsApp, Telegram, etc.)

### The Problem

Apple's **Mac Catalyst** framework ports iOS apps to macOS by wrapping them
in a thin AppKit shell around a WKWebView renderer. The accessibility tree
exposed to AX clients (our `ax-bridge.py`) contains only the **native
chrome** (title bar, toolbar buttons) — the web content inside the
WKWebView is invisible to the AX API.

This means:
- `scanApp("WhatsApp")` returns toolbar elements but **no chat UI**.
- `clickElement("WhatsApp", "Send")` cannot find the send button.
- `typeIntoField("WhatsApp", "Message", "Hello")` has no field to target.

### Why It Happens

WKWebView does not expose a CDP (Chrome DevTools Protocol) port, unlike
Electron's Chromium renderer. There's no `--remote-debugging-port` flag.
Apple's WebKit accessibility bridge _does_ forward some AX nodes from the
web content, but only for native Safari — Catalyst WKWebViews use a
stripped subset that drops most interactive elements.

### Affected Apps

| App | Framework | Content Visible? | Notes |
|-----|-----------|-------------------|-------|
| WhatsApp | Catalyst (WKWebView) | ❌ | Chat content invisible |
| Telegram | Catalyst (WKWebView) | ❌ | Same issue |
| Maps | Catalyst (MapKit) | Partial | Map tiles not in AX |
| News | Catalyst (WKWebView) | ❌ | Article content invisible |

### Workarounds

1. **Use the web version instead.** WhatsApp Web (`web.whatsapp.com`) runs
   in a real browser. AgentDOM's web engine (`agentdom https://web.whatsapp.com`)
   has full DOM access — scan, click, type all work.

   ```bash
   agentdom https://web.whatsapp.com --profile=whatsapp
   # Use --profile to persist the QR login across sessions
   ```

2. **Coordinate-based clicks via `clickInWindow`.** If you know the UI
   layout, you can click by window-relative position:

   ```js
   const desktop = require('agentdom/desktop-agent');
   // Click at 400px from left, 600px from top of WhatsApp window
   desktop.clickInWindow('WhatsApp', 400, 600);
   ```

   This is fragile (layout changes break it) but works for prototyping.

3. **Wait for Apple.** macOS 26 may improve WKWebView AX support. Track
   WebKit bugs at https://bugs.webkit.org.

---

## 2. Shadow DOM Components

### The Problem

Web components that use `shadowRoot` hide their internal DOM from
`document.querySelectorAll`. A page might show 3 buttons visually but
`scanPage()` returns 0 if they're all inside shadow roots.

### Status: ✅ Fixed

`agentdom.js` v3.1 walks shadow roots recursively via `deepQueryAll`.
Both `scanPage()` and all action methods (click, type, etc.) traverse
shadow DOM automatically.

---

## 3. Cross-Origin Iframes

### The Problem

Same-origin iframes are traversable from JavaScript. Cross-origin iframes
throw `SecurityError` when accessed via `contentDocument`.

### Status: ✅ Fixed (web + Electron)

- **Web (agentdom.js):** `deepQueryAll` tries `frame.contentDocument` and
  silently skips cross-origin frames.
- **Electron bridge:** Uses Puppeteer's `page.frames()` API which has
  native access to all frames regardless of origin. `clickByText`,
  `clickBySelector`, `typeIntoField`, and `readBySelector` all walk
  every frame.
- **Headless CLI:** Puppeteer has full cross-origin frame access.

---

## 4. React Controlled Inputs

### The Problem

React overrides the native `value` setter on `<input>` elements with its
own synthetic event system. Setting `el.value = "text"` directly is
silently dropped — React's internal state doesn't update, so the UI
doesn't reflect the change.

### Status: ✅ Fixed

`agentdom.js` uses `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`
to bypass React's wrapper, then dispatches `input` and `change` events
with `{ bubbles: true }`. This works for React, Vue, Svelte, Lit, and
Angular.

---

## 5. Coordinate-Based Clicks & Retina Displays

### The Problem

macOS uses "logical points" for screen coordinates, but Retina displays
render at 2x or 3x pixel density. `clickAt(x, y)` uses logical points
(matching `CGWindowList` coordinates), so no Retina conversion is needed.
However, window position changes between sessions make absolute
coordinates fragile.

### Status: ✅ Mitigated

- `clickInWindow(app, relX, relY)` resolves the app's window frame via
  `CGWindowListCopyWindowInfo` and adds the offset automatically. No
  Retina math needed — both coordinate spaces use logical points.
- `getWindowFrame(app)` returns `{ x, y, w, h }` for manual calculations.
- Prefer `clickElement(app, label)` via AX when possible — it's
  resolution-independent and doesn't break when the window moves.

---

## 6. Bot Protection / CAPTCHAs

### The Problem

Sites like HubSpot (Talon), Cloudflare (Turnstile), and Google (reCAPTCHA)
detect headless browsers and block automation.

### Status: 🟡 Partial

- **Stealth mode** (puppeteer-extra-plugin-stealth) evades most fingerprint
  checks.
- **Persistent profiles** (`--profile` flag) keep cookies so you only need
  to solve CAPTCHAs once.
- **No auto-solver yet.** CAPTCHA solving is on the roadmap (Month 4-6).

### Workaround

For sites with aggressive bot protection:
1. Launch in visible mode: `agentdom https://hubspot.com --profile=hubspot`
   (no `--headless`)
2. Solve the CAPTCHA manually once
3. Future sessions reuse the profile cookies

---

## 7. Linux Desktop

### Status: ❌ Not Yet Supported

Linux desktop automation (AT-SPI for X11, ydotool for Wayland) is on the
roadmap for Month 2-3. Web and CLI automation work fine on Linux today.

---

## 8. Multi-Page Workflow Recovery

### The Problem

Multi-step agent workflows (login → navigate → fill form → submit) fail
partway through with no way to resume.

### Status: ✅ Fixed

Checkpoint commands save and restore full workflow state:

```bash
agentdom https://example.com --profile=mysite
❯ goto https://example.com/login
❯ fill #loginForm {"email":"test@test.com","password":"pass123"}
❯ submit #loginForm
❯ checkpoint after-login    # saves URL, cookies, localStorage, scroll
# ... if the agent crashes later ...
❯ restore after-login       # resumes from the saved state
```

Checkpoints use atomic writes (`writeFileSync` to `.tmp` + `renameSync`)
to prevent corruption on crash.
