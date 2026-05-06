'use client';

import { useState } from 'react';
import { Shield, Key, Terminal, Globe, Zap, BookOpen, Layers, ArrowRight, Brain, Lock, UserCheck, Package, RefreshCw } from 'lucide-react';
import AnimatedGrid from '@/components/AnimatedGrid';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import CodeBlock from '@/components/CodeBlock';

// ── Code snippets ─────────────────────────────────────────────────────────────

const installCode = `<span class="syn-comment"># Install globally</span>
npm install -g agentdom

<span class="syn-comment"># Authenticate once (opens browser for OAuth)</span>
agentdom auth linear.app
agentdom auth resend.com      <span class="syn-comment"># prompts for API key</span>
agentdom auth github.com      <span class="syn-comment"># device flow</span>

<span class="syn-comment"># Run a goal</span>
agentdom goal <span class="syn-str">"Create a Linear ticket for the login crash"</span>`;

const dispatchCode = `<span class="syn-comment">// Dispatch a single intent directly</span>
<span class="syn-fn">dispatch_intent</span>(<span class="syn-str">"issues.create"</span>, {
  title:    <span class="syn-str">"Login crash on iOS 17"</span>,
  priority: <span class="syn-num">1</span>,
  teamId:   <span class="syn-str">"ENG"</span>
}, <span class="syn-str">"linear.app"</span>)

<span class="syn-comment">// → wallet fetches Keychain token</span>
<span class="syn-comment">// → POST https://api.linear.app/graphql</span>
<span class="syn-comment">// → { success: true, issue: { id: "ENG-42" } }</span>`;

const mcpCode = `<span class="syn-comment"># Claude Code — add in one command</span>
claude mcp add agentdom-desktop -- node \\
  $(npm root -g)/agentdom/desktop-mcp-server.js

<span class="syn-comment"># claude_desktop_config.json</span>
{
  <span class="syn-str">"mcpServers"</span>: {
    <span class="syn-str">"agentdom"</span>: {
      <span class="syn-str">"command"</span>: <span class="syn-str">"node"</span>,
      <span class="syn-str">"args"</span>: [<span class="syn-str">"$(npm root -g)/agentdom/desktop-mcp-server.js"</span>]
    }
  }
}`;

const policyCode = `<span class="syn-comment">// ~/.agentdom/policy.json</span>
{
  <span class="syn-str">"per_class"</span>: {
    <span class="syn-str">"read"</span>:     <span class="syn-str">"allow"</span>,
    <span class="syn-str">"external"</span>: <span class="syn-str">"prompt"</span>,   <span class="syn-comment">// API writes need approval</span>
    <span class="syn-str">"send"</span>:     <span class="syn-str">"prompt"</span>,   <span class="syn-comment">// emails need approval</span>
    <span class="syn-str">"delete"</span>:   <span class="syn-str">"deny"</span>,    <span class="syn-comment">// never auto-delete</span>
    <span class="syn-str">"payment"</span>:  <span class="syn-str">"deny"</span>     <span class="syn-comment">// never auto-charge</span>
  }
}

<span class="syn-comment">// Approve / deny from CLI</span>
agentdom policy show
agentdom approve abc123
agentdom deny   abc123`;

const setupCode = `<span class="syn-comment"># One-time setup — run this once per provider, then agents run forever</span>
agentdom setup linear.app         <span class="syn-comment"># opens browser → OAuth PKCE → refresh token stored</span>
agentdom setup github.com         <span class="syn-comment"># device flow → enter code at github.com/login/device</span>
agentdom setup resend.com         <span class="syn-comment"># prompts for API key → stored in Keychain</span>
agentdom setup openrouter.ai <span class="syn-kw">--key</span>=sk-or-v1-xxx  <span class="syn-comment"># non-interactive</span>

<span class="syn-comment"># Check what's set up</span>
agentdom setup --list

<span class="syn-comment"># After setup — package credentials for your agent</span>
agentdom wallet export <span class="syn-kw">--base64</span> <span class="syn-kw">--providers</span>=linear.app,resend.com
<span class="syn-comment"># → AGENTDOM_WALLET_B64=eyJ3YWxsZXQi...  (single env var)</span>`;

const walletProvisionCode = `<span class="syn-comment"># 3 ways to give an agent its wallet — no human at runtime</span>

<span class="syn-comment"># Option 1: Base64 (Docker / serverless / CI)</span>
export AGENTDOM_WALLET_B64=$(agentdom wallet export --base64 --providers=resend.com)
docker run -e AGENTDOM_WALLET_B64=$AGENTDOM_WALLET_B64 your-agent

<span class="syn-comment"># Option 2: File path (server / multi-agent)</span>
agentdom wallet create <span class="syn-kw">--agent</span>=email-bot <span class="syn-kw">--providers</span>=resend.com
AGENTDOM_WALLET_PATH=~/.agentdom/email-bot.wallet.json agentdom goal <span class="syn-str">"..."</span>

<span class="syn-comment"># Option 3: Env vars (GitHub Actions / Doppler / Vercel)</span>
agentdom wallet env  <span class="syn-comment"># prints these:</span>
export AGENTDOM_RESEND_COM_KEY=re_xxx
export AGENTDOM_LINEAR_APP_KEY=lin_xxx`;

const agentTokenCode = `<span class="syn-comment"># Publisher declares in .well-known/agentdom.json:</span>
{
  <span class="syn-str">"auth"</span>: {
    <span class="syn-str">"method"</span>: <span class="syn-str">"api_key"</span>,
    <span class="syn-str">"agent_tokens"</span>: {
      <span class="syn-str">"issue"</span>:  <span class="syn-str">"POST https://api.yourapp.com/agent-tokens"</span>,
      <span class="syn-str">"revoke"</span>: <span class="syn-str">"DELETE https://api.yourapp.com/agent-tokens/{id}"</span>,
      <span class="syn-str">"rotate"</span>: <span class="syn-str">"POST https://api.yourapp.com/agent-tokens/{id}/rotate"</span>,
      <span class="syn-str">"scopes"</span>: [<span class="syn-str">"emails:send"</span>, <span class="syn-str">"domains:read"</span>],
      <span class="syn-str">"max_ttl_seconds"</span>: <span class="syn-num">86400</span>
    }
  }
}

<span class="syn-comment"># Agent provisions its own scoped token — no human needed:</span>
agentdom agent-token resend.com <span class="syn-kw">--scopes</span>=emails:send <span class="syn-kw">--ttl</span>=3600
<span class="syn-comment"># → POST /agent-tokens with master key → scoped token stored → auto-rotates</span>

<span class="syn-comment"># dispatch_intent uses it automatically:</span>
<span class="syn-fn">dispatch_intent</span>(<span class="syn-str">"emails.send"</span>, { to, subject, html }, <span class="syn-str">"resend.com"</span>)
<span class="syn-comment"># → secrets.resolve() tries agent_tokens protocol first</span>
<span class="syn-comment"># → master key never exposed to agent runtime</span>`;

const publisherCode = `<span class="syn-comment"># Step 1: Generate manifest from your OpenAPI spec</span>
npx agentdom-publisher init \\
  --openapi=./openapi.json \\
  --host=api.yourapp.com

<span class="syn-comment"># Step 2: Validate locally</span>
npx agentdom-publisher validate

<span class="syn-comment"># Step 3: Deploy .well-known/agentdom.json to your server</span>
<span class="syn-comment"># Step 4: Verify live</span>
npx agentdom-publisher verify --host=api.yourapp.com

<span class="syn-comment"># Step 5: Test a real dispatch</span>
npx agentdom-publisher test \\
  --host=api.yourapp.com --token=sk-... --intent=contacts.list

<span class="syn-comment"># Step 6: Submit to public registry</span>
npx agentdom-publisher submit --host=api.yourapp.com`;

const manifestCode = `{
  <span class="syn-str">"version"</span>: <span class="syn-str">"1.0"</span>,
  <span class="syn-str">"host"</span>:    <span class="syn-str">"api.yourapp.com"</span>,
  <span class="syn-str">"auth"</span>: {
    <span class="syn-str">"method"</span>:    <span class="syn-str">"api_key"</span>,
    <span class="syn-str">"key_header"</span>: <span class="syn-str">"Authorization"</span>,
    <span class="syn-str">"key_format"</span>: <span class="syn-str">"Bearer {token}"</span>
  },
  <span class="syn-str">"capabilities"</span>: [{
    <span class="syn-str">"intent"</span>:      <span class="syn-str">"contacts.create"</span>,
    <span class="syn-str">"transport"</span>:   <span class="syn-str">"api"</span>,
    <span class="syn-str">"method"</span>:      <span class="syn-str">"POST"</span>,
    <span class="syn-str">"endpoint"</span>:    <span class="syn-str">"https://api.yourapp.com/contacts"</span>,
    <span class="syn-str">"side_effects"</span>: [<span class="syn-str">"external"</span>]
  }]
}`;

// ── Nav sections ──────────────────────────────────────────────────────────────
const sections = [
  { id: 'quickstart',    label: 'Quick Start',        icon: Zap },
  { id: 'dispatch',      label: 'dispatch_intent',     icon: ArrowRight },
  { id: 'mcp',           label: 'MCP Setup',           icon: Terminal },
  { id: 'setup',         label: 'Setup (Human Step)',  icon: UserCheck },
  { id: 'wallet',        label: 'Auth Wallet',         icon: Key },
  { id: 'walletprovision', label: 'Wallet → Agent',   icon: Package },
  { id: 'agent-tokens',  label: 'Agent Token Protocol', icon: RefreshCw },
  { id: 'policy',        label: 'Policy Engine',       icon: Shield },
  { id: 'memory',        label: 'Memory & Planning',   icon: Brain },
  { id: 'publishers',    label: 'For Publishers',      icon: Globe },
  { id: 'manifest',      label: 'Manifest Spec',       icon: BookOpen },
  { id: 'providers',     label: 'Providers',           icon: Layers },
];

const providers = [
  { name: 'linear.app',    auth: 'OAuth2',    intents: 8,   intentsLabel: 'issues, teams, comments' },
  { name: 'hubspot.com',   auth: 'OAuth2',    intents: 8,   intentsLabel: 'contacts, deals, companies' },
  { name: 'vercel.com',    auth: 'API Key',   intents: 8,   intentsLabel: 'deployments, projects, env vars' },
  { name: 'slack.com',     auth: 'OAuth2',    intents: 6,   intentsLabel: 'messages, channels, reactions' },
  { name: 'notion.so',     auth: 'OAuth2',    intents: 6,   intentsLabel: 'pages, databases, blocks' },
  { name: 'supabase.com',  auth: 'API Key',   intents: 7,   intentsLabel: 'projects, secrets, SQL' },
  { name: 'resend.com',    auth: 'API Key',   intents: 5,   intentsLabel: 'emails, domains' },
  { name: 'cal.com',       auth: 'OAuth2',    intents: 6,   intentsLabel: 'bookings, availability' },
  { name: 'github.com',    auth: 'Device',    intents: 811, intentsLabel: 'repos, issues, PRs, and more' },
  { name: 'stripe.com',    auth: 'API Key',   intents: 442, intentsLabel: 'payments, customers, subscriptions' },
  { name: 'openai.com',    auth: 'API Key',   intents: 5,   intentsLabel: 'chat, embeddings, images' },
  { name: 'anthropic.com', auth: 'API Key',   intents: 2,   intentsLabel: 'messages, models' },
];

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DocsPage() {
  const [activeSection, setActiveSection] = useState('quickstart');

  return (
    <>
      <AnimatedGrid />
      <Navbar />

      {/* Hero */}
      <section className="hero" style={{ minHeight: 'auto', paddingBottom: 60 }}>
        <div className="hero-container">
          <div className="badge"><BookOpen size={12} /> Documentation · v3.2</div>
          <h1>Build with <span className="gradient">AgentDOM</span></h1>
          <p className="hero-sub">
            The complete reference for agents, developers, and publishers.
          </p>
        </div>
      </section>

      {/* Docs layout */}
      <div style={{ display: 'flex', maxWidth: 1100, margin: '0 auto', padding: '0 32px 120px', gap: 48 }}>

        {/* Sidebar */}
        <nav style={{ width: 200, flexShrink: 0, position: 'sticky', top: 100, alignSelf: 'flex-start' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: 12 }}>On This Page</div>
          {sections.map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              onClick={() => setActiveSection(s.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', borderRadius: 8, marginBottom: 2,
                fontSize: 13, color: activeSection === s.id ? 'var(--accent)' : '#9ca3af',
                background: activeSection === s.id ? 'rgba(249,115,22,.08)' : 'transparent',
                textDecoration: 'none', transition: 'all 0.2s',
              }}
            >
              <s.icon size={14} />
              {s.label}
            </a>
          ))}
        </nav>

        {/* Content */}
        <main style={{ flex: 1, minWidth: 0 }}>

          {/* Quick Start */}
          <section id="quickstart" style={{ marginBottom: 72 }}>
            <div className="section-label">01 · Quick Start</div>
            <h2>Up and running in 2 minutes</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              Install the CLI, authenticate with any SaaS provider once, and start dispatching intents immediately.
            </p>
            <CodeBlock code={installCode} label="terminal" />
          </section>

          {/* dispatch_intent */}
          <section id="dispatch" style={{ marginBottom: 72 }}>
            <div className="section-label">02 · Core Protocol</div>
            <h2>dispatch_intent</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              The single function that makes AgentDOM work. Agents declare <em>what</em> they want — AgentDOM picks the fastest available transport (API › CLI › Browser › Desktop).
            </p>
            <CodeBlock code={dispatchCode} label="agent code" />
            <div style={{ marginTop: 24 }}>
              <table className="doc-table">
                <thead><tr><th>Transport</th><th>Used when</th><th>Latency</th></tr></thead>
                <tbody>
                  <tr><td><code>api</code></td><td>Provider has REST/GraphQL manifest</td><td>~120ms</td></tr>
                  <tr><td><code>cli</code></td><td>CLI tool available locally</td><td>~200ms</td></tr>
                  <tr><td><code>browser</code></td><td>No API, falls back to CDP web automation</td><td>~300ms</td></tr>
                  <tr><td><code>desktop</code></td><td>Native macOS app via Accessibility API</td><td>~100ms</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* MCP Setup */}
          <section id="mcp" style={{ marginBottom: 72 }}>
            <div className="section-label">03 · MCP Integration</div>
            <h2>Connect to Claude, Cursor, or any MCP client</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              AgentDOM runs as an MCP server (stdio). Any agent framework that speaks MCP gets 50+ tools automatically.
            </p>
            <CodeBlock code={mcpCode} label="setup" />
            <div style={{ marginTop: 24 }}>
              <table className="doc-table">
                <thead><tr><th>Tool exposed via MCP</th><th>What it does</th></tr></thead>
                <tbody>
                  <tr><td><code>dispatch_intent</code></td><td>Execute any intent on any connected provider</td></tr>
                  <tr><td><code>wallet_auth</code></td><td>Authenticate a new provider</td></tr>
                  <tr><td><code>wallet_list</code></td><td>List all authenticated providers</td></tr>
                  <tr><td><code>policy_list</code></td><td>Show current policy rules</td></tr>
                  <tr><td><code>memory_recall</code></td><td>Search past agent runs</td></tr>
                  <tr><td><code>clickElement</code></td><td>Click by label — no selectors needed</td></tr>
                  <tr><td><code>typeText</code></td><td>Type into any input field</td></tr>
                  <tr><td><code>observe</code></td><td>Read desktop state, clipboard, running apps</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Setup — one-time human step */}
          <section id="setup" style={{ marginBottom: 72 }}>
            <div className="section-label">04 · Setup</div>
            <h2>The only step that needs a human</h2>
            <p style={{ color: '#9ca3af', marginBottom: 16, lineHeight: 1.7 }}>
              Run <code>agentdom setup</code> once per provider. It handles OAuth, device flow, or API key prompts automatically — then stores the token in your OS Keychain. After this, agents run forever without any human involvement.
            </p>
            <div style={{ marginBottom: 20, padding: '12px 20px', background: 'rgba(249,115,22,0.08)', borderRadius: 8, borderLeft: '3px solid var(--accent)', fontSize: 13, color: '#d1d5db' }}>
              <strong style={{ color: 'var(--accent)' }}>Design principle:</strong> Human consent is required exactly once per provider. Everything after that — token refresh, dispatch, rotation — is fully headless.
            </div>
            <CodeBlock code={setupCode} label="terminal" />
            <div style={{ marginTop: 20, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              {[
                { icon: Globe,   title: 'OAuth PKCE',   desc: 'Browser opens once. Approve. Refresh token stored forever.' },
                { icon: Terminal, title: 'Device Flow', desc: 'Enter code at URL. No redirect. Works in any terminal.' },
                { icon: Key,     title: 'API Key',      desc: 'Paste once. Encrypted in Keychain. Never asked again.' },
              ].map(c => (
                <div key={c.title} className="feature" style={{ padding: '16px 20px' }}>
                  <div className="feature-icon"><c.icon size={16} /></div>
                  <h3 style={{ fontSize: 14 }}>{c.title}</h3>
                  <p style={{ fontSize: 12 }}>{c.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Auth Wallet */}
          <section id="wallet" style={{ marginBottom: 72 }}>
            <div className="section-label">05 · Auth Wallet</div>
            <h2>Tokens that never leave your machine</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              One consent per provider. Tokens stored in your OS Keychain (macOS Keychain Access, Windows Credential Manager, Linux libsecret). Auto-refreshed 5 minutes before expiry.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {[
                { icon: Key,      title: 'OAuth 2.0 PKCE',  desc: 'Opens browser for user consent. No client secret needed. PKCE secured.' },
                { icon: Lock,     title: 'Device Flow',      desc: 'For GitHub and headless environments. No browser required.' },
                { icon: Shield,   title: 'API Key',          desc: 'Prompts once, stores securely in Keychain. Never in plaintext.' },
                { icon: Zap,      title: 'Auto-refresh',     desc: 'Background scheduler refreshes tokens 5 min before expiry silently.' },
              ].map(c => (
                <div key={c.title} className="feature" style={{ padding: '20px 24px' }}>
                  <div className="feature-icon"><c.icon size={18} /></div>
                  <h3>{c.title}</h3>
                  <p>{c.desc}</p>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 20, padding: '16px 20px', background: 'var(--code-bg)', borderRadius: 8, fontFamily: 'monospace', fontSize: 13 }}>
              <div style={{ marginBottom: 8, color: '#6b7280' }}># Credential resolution order (automatic)</div>
              <div><span style={{ color: '#6b7280' }}>0.</span> <span style={{ color: 'var(--accent)' }}>Agent Token Protocol</span> <span style={{ color: '#6b7280' }}># publisher-issued scoped tokens (best)</span></div>
              <div><span style={{ color: '#6b7280' }}>1.</span> <span style={{ color: 'var(--accent)' }}>AGENTDOM_&lt;HOST&gt;_KEY</span> <span style={{ color: '#6b7280' }}># env var</span></div>
              <div><span style={{ color: '#6b7280' }}>2.</span> <span style={{ color: 'var(--accent)' }}>~/.agentdom/wallet.json</span> <span style={{ color: '#6b7280' }}># local wallet</span></div>
              <div><span style={{ color: '#6b7280' }}>3.</span> <span style={{ color: 'var(--accent)' }}>OS Keychain</span> <span style={{ color: '#6b7280' }}># macOS / Windows / Linux</span></div>
              <div><span style={{ color: '#6b7280' }}>4.</span> <span style={{ color: 'var(--accent)' }}>AWS SSM</span> <span style={{ color: '#6b7280' }}># /agentdom/&lt;host&gt;/token</span></div>
              <div><span style={{ color: '#6b7280' }}>5.</span> <span style={{ color: 'var(--accent)' }}>HashiCorp Vault</span> <span style={{ color: '#6b7280' }}># secret/agentdom/&lt;host&gt;</span></div>
              <div><span style={{ color: '#6b7280' }}>6.</span> <span style={{ color: 'var(--accent)' }}>1Password</span> <span style={{ color: '#6b7280' }}># op://AgentDOM/&lt;host&gt;/token</span></div>
            </div>
          </section>

          {/* Wallet Provisioning */}
          <section id="walletprovision" style={{ marginBottom: 72 }}>
            <div className="section-label">06 · Wallet → Agent</div>
            <h2>Give credentials to your agent</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              After <code>agentdom setup</code>, export your wallet and inject it into any agent — Docker container, serverless function, CI job, or remote server. Three delivery methods, zero human interaction at runtime.
            </p>
            <CodeBlock code={walletProvisionCode} label="terminal" />
            <div style={{ marginTop: 20 }}>
              <table className="doc-table">
                <thead><tr><th>Command</th><th>Purpose</th></tr></thead>
                <tbody>
                  <tr><td><code>agentdom wallet list</code></td><td>Show all stored credentials</td></tr>
                  <tr><td><code>agentdom wallet export --base64</code></td><td>Single env var for Docker/CI</td></tr>
                  <tr><td><code>agentdom wallet create --agent=id</code></td><td>Scoped wallet per agent identity</td></tr>
                  <tr><td><code>agentdom wallet import &lt;file|b64&gt;</code></td><td>Load wallet from file or string</td></tr>
                  <tr><td><code>agentdom wallet env</code></td><td>Print shell export lines</td></tr>
                  <tr><td><code>agentdom wallet token &lt;host&gt;</code></td><td>Print raw token for a provider</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Agent Token Protocol */}
          <section id="agent-tokens" style={{ marginBottom: 72 }}>
            <div className="section-label">07 · Agent Token Protocol</div>
            <h2>Publishers issue tokens directly to agents</h2>
            <p style={{ color: '#9ca3af', marginBottom: 16, lineHeight: 1.7 }}>
              A new M2M auth standard built on top of <code>.well-known/agentdom.json</code>. Publishers declare an <code>agent_tokens</code> endpoint. Agents call it with their master credential and receive a short-lived, scoped token — no browser redirect, no human approval.
            </p>
            <div style={{ marginBottom: 20, padding: '12px 20px', background: 'rgba(249,115,22,0.08)', borderRadius: 8, borderLeft: '3px solid var(--accent)', fontSize: 13, color: '#d1d5db' }}>
              <strong style={{ color: 'var(--accent)' }}>Analogy:</strong> Like AWS IAM roles for EC2 — the machine provisions its own short-lived credentials using a trust relationship. The master key never reaches the agent runtime.
            </div>
            <CodeBlock code={agentTokenCode} label="agent_tokens protocol" />
            <div style={{ marginTop: 24, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              {[
                { icon: RefreshCw, title: 'Auto-rotation',    desc: 'Tokens rotated 5 min before expiry. Agent never handles stale credentials.' },
                { icon: Shield,    title: 'Scoped access',    desc: 'Agent gets only the permissions it needs. Master key stays in vault.' },
                { icon: Zap,       title: 'Zero human steps', desc: 'After one-time setup, agents provision and rotate their own tokens forever.' },
                { icon: Globe,     title: 'Publisher-native', desc: 'Publishers add 5 lines to their manifest. Works with any existing token issuance system.' },
              ].map(c => (
                <div key={c.title} className="feature" style={{ padding: '20px 24px' }}>
                  <div className="feature-icon"><c.icon size={18} /></div>
                  <h3>{c.title}</h3>
                  <p>{c.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Policy */}
          <section id="policy" style={{ marginBottom: 72 }}>
            <div className="section-label">08 · Policy Engine</div>
            <h2>Human-in-the-loop when it matters</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              Every intent is classified by <strong>side effect</strong> before execution. You control which effects need approval, which are auto-allowed, and which are always denied.
            </p>
            <CodeBlock code={policyCode} label="~/.agentdom/policy.json" />
          </section>

          {/* Memory & Planning */}
          <section id="memory" style={{ marginBottom: 72 }}>
            <div className="section-label">09 · Memory & Planning</div>
            <h2>Agents that learn and plan</h2>
            <p style={{ color: '#9ca3af', marginBottom: 20, lineHeight: 1.7 }}>
              AgentDOM includes two runtime layers that make agents reliable across sessions.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div className="feature" style={{ padding: '20px 24px' }}>
                <div className="feature-icon"><Brain size={18} /></div>
                <h3>Episodic Memory</h3>
                <p>Cross-session JSONL store. Agents recall what worked and what failed per provider. Query with <code>agentdom memory recall</code>.</p>
              </div>
              <div className="feature" style={{ padding: '20px 24px' }}>
                <div className="feature-icon"><Layers size={18} /></div>
                <h3>Plan-Execute-Verify</h3>
                <p>Goals are broken into explicit JSON plans. Each step is policy-checked, executed, and verified. Failures trigger automatic replanning.</p>
              </div>
            </div>
          </section>

          {/* For Publishers */}
          <section id="publishers" style={{ marginBottom: 72 }}>
            <div className="section-label">07 · For Publishers</div>
            <h2>Make your API agent-native in 6 steps</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              Publish a <code>.well-known/agentdom.json</code> manifest and every AgentDOM agent can instantly discover and use your product — no per-framework integration needed.
            </p>
            <CodeBlock code={publisherCode} label="terminal" />
            <div style={{ marginTop: 20, padding: '14px 20px', background: 'rgba(249,115,22,.06)', border: '1px solid rgba(249,115,22,.2)', borderRadius: 8, fontSize: 13, color: '#9ca3af', lineHeight: 1.7 }}>
              ⚡ <strong style={{ color: 'var(--text)' }}>No OpenAPI spec?</strong> Hand-craft the manifest — the format is minimal. See the example below.
            </div>
          </section>

          {/* Manifest spec */}
          <section id="manifest" style={{ marginBottom: 72 }}>
            <div className="section-label">08 · Manifest Spec</div>
            <h2><code>.well-known/agentdom.json</code></h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              The open standard. Agents fetch this once, cache it, and call your API directly.
            </p>
            <CodeBlock code={manifestCode} label=".well-known/agentdom.json" />
            <div style={{ marginTop: 24 }}>
              <table className="doc-table">
                <thead><tr><th>side_effect value</th><th>Meaning</th><th>Default policy</th></tr></thead>
                <tbody>
                  <tr><td><code>read</code></td><td>GET data, no mutation</td><td>auto-allow</td></tr>
                  <tr><td><code>external</code></td><td>Write to external service</td><td>prompt</td></tr>
                  <tr><td><code>send</code></td><td>Send email / notification</td><td>prompt</td></tr>
                  <tr><td><code>delete</code></td><td>Delete a record</td><td>deny</td></tr>
                  <tr><td><code>payment</code></td><td>Charge a card</td><td>deny</td></tr>
                  <tr><td><code>write_local</code></td><td>Write to local filesystem</td><td>allow</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Providers */}
          <section id="providers" style={{ marginBottom: 72 }}>
            <div className="section-label">09 · Provider Registry</div>
            <h2>12 built-in polyfill providers</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              These manifests are bundled with AgentDOM and also served from <code>agentdom.dev/manifests/</code>. Agents work with all of them on day one — no vendor action required.
            </p>
            <table className="doc-table">
              <thead><tr><th>Provider</th><th>Auth</th><th>Intents</th><th>Covers</th></tr></thead>
              <tbody>
                {providers.map(p => (
                  <tr key={p.name}>
                    <td><code>{p.name}</code></td>
                    <td>{p.auth}</td>
                    <td>{p.intents}</td>
                    <td style={{ color: '#6b7280', fontSize: 12 }}>{p.intentsLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

        </main>
      </div>

      <Footer />
    </>
  );
}
