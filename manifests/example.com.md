---
app: example.com
platform: web
version: 1
notes:
  - example.com is IANA-reserved and renders a single <h1>, paragraph, and link. Stable for demos.
  - The manifest is keyed by hostname (with leading "www." stripped). Drop a manifest at manifests/<hostname>.md to ship it.
tools:
  - name: get_headline
    description: Read the H1 text from example.com.
    steps:
      - navigate: https://example.com/
      - read: h1

  - name: open_more_info
    description: Follow the "More information..." link and report the destination page title.
    steps:
      - navigate: https://example.com/
      - click: a
      - wait: 800
      - read: title
---

# AgentDOM Manifest — example.com

Reference web manifest. Demonstrates the four web step primitives: `navigate`,
`click`, `wait`, `read`. Web manifests live alongside desktop / CLI / API
manifests in `manifests/<key>.md`; for web the key is the page's hostname
(stripped of `www.`).

## Step grammar (web)

- `navigate: <url-or-${param}>` — `page.goto(url, { waitUntil: 'networkidle2' })`.
- `click: <css-selector>` — clicks via injected `AgentDOM.click(sel)`. Selectors
  are CSS, same as the auto-emitted `click` primitive.
- `type: { selector, text }` — types via `AgentDOM.type(sel, text)`.
- `read: <"title"|"url"|"body"|css-selector>` — captures page state.
  Returns `innerText` for selector targets, capped at 4000 chars.
- `wait: <ms>` — small delay between steps (e.g. after a navigation that
  triggers JS-driven content updates).

## Why ship a web manifest

The web MCP server already auto-emits typed tools per page (`login`,
`search`, `submit_<form-id>`) via the legacy synthesizer. Manifests add
*site-level intents* on top — workflows that span multiple page loads,
or canonical lookups an agent should always know about regardless of
which page the user is currently on.
