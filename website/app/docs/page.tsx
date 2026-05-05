'use client';

import { useState } from 'react';
import { Shield, Key, Terminal, Globe, Zap, BookOpen, Layers, ArrowRight, Brain, Lock } from 'lucide-react';
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
  { id: 'quickstart',  label: 'Quick Start',      icon: Zap },
  { id: 'dispatch',    label: 'dispatch_intent',   icon: ArrowRight },
  { id: 'mcp',         label: 'MCP Setup',         icon: Terminal },
  { id: 'wallet',      label: 'Auth Wallet',       icon: Key },
  { id: 'policy',      label: 'Policy Engine',     icon: Shield },
  { id: 'memory',      label: 'Memory & Planning', icon: Brain },
  { id: 'publishers',  label: 'For Publishers',    icon: Globe },
  { id: 'manifest',    label: 'Manifest Spec',     icon: BookOpen },
  { id: 'providers',   label: 'Providers',         icon: Layers },
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

          {/* Auth Wallet */}
          <section id="wallet" style={{ marginBottom: 72 }}>
            <div className="section-label">04 · Auth Wallet</div>
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
              <div style={{ marginBottom: 8, color: '#6b7280' }}># Auth commands</div>
              <div><span style={{ color: 'var(--accent)' }}>agentdom auth</span> linear.app &nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#6b7280' }}># OAuth PKCE</span></div>
              <div><span style={{ color: 'var(--accent)' }}>agentdom auth</span> github.com &nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#6b7280' }}># Device flow</span></div>
              <div><span style={{ color: 'var(--accent)' }}>agentdom auth</span> stripe.com &nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#6b7280' }}># API key prompt</span></div>
              <div><span style={{ color: 'var(--accent)' }}>agentdom wallet list</span> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={{ color: '#6b7280' }}># show all tokens</span></div>
            </div>
          </section>

          {/* Policy */}
          <section id="policy" style={{ marginBottom: 72 }}>
            <div className="section-label">05 · Policy Engine</div>
            <h2>Human-in-the-loop when it matters</h2>
            <p style={{ color: '#9ca3af', marginBottom: 24, lineHeight: 1.7 }}>
              Every intent is classified by <strong>side effect</strong> before execution. You control which effects need approval, which are auto-allowed, and which are always denied.
            </p>
            <CodeBlock code={policyCode} label="~/.agentdom/policy.json" />
          </section>

          {/* Memory & Planning */}
          <section id="memory" style={{ marginBottom: 72 }}>
            <div className="section-label">06 · Memory & Planning</div>
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
