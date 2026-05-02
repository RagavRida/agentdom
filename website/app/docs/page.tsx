'use client';

import { useState } from 'react';
import { Shield, Key, Ticket, Lock } from 'lucide-react';
import AnimatedGrid from '@/components/AnimatedGrid';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import CodeBlock from '@/components/CodeBlock';

const tabs = ['cdn', 'npm', 'meta'] as const;
type Tab = typeof tabs[number];

const tabContent: Record<Tab, { title: string; desc?: string; code: string; after?: string }> = {
  cdn: {
    title: 'Option 1: CDN Script Tag',
    desc: 'Add this before <code>&lt;/body&gt;</code> in your HTML:',
    code: `<span class="syn-comment">&lt;!-- AgentDOM v3 — makes your site agent-ready --&gt;</span>
<span class="syn-tag">&lt;script</span> <span class="syn-attr">src</span>=<span class="syn-str">"https://cdn.jsdelivr.net/npm/agentdom@3/agentdom.js"</span><span class="syn-tag">&gt;&lt;/script&gt;</span>`,
    after: "That's it. Any agent using AgentDOM can now scan and interact with your page.",
  },
  npm: {
    title: 'Option 2: NPM Package',
    code: `npm install agentdom

<span class="syn-comment">// Then in your app:</span>
<span class="syn-tag">import</span> <span class="syn-str">'agentdom'</span>;`,
  },
  meta: {
    title: 'Option 3: Meta Tag',
    desc: 'Declare your site as agent-ready without loading the full runtime:',
    code: `<span class="syn-tag">&lt;meta</span> <span class="syn-attr">name</span>=<span class="syn-str">"agentdom"</span> <span class="syn-attr">content</span>=<span class="syn-str">"enabled"</span><span class="syn-tag">&gt;</span>
<span class="syn-tag">&lt;meta</span> <span class="syn-attr">name</span>=<span class="syn-str">"agentdom:auth"</span> <span class="syn-attr">content</span>=<span class="syn-str">"oauth2,form"</span><span class="syn-tag">&gt;</span>
<span class="syn-tag">&lt;link</span> <span class="syn-attr">rel</span>=<span class="syn-str">"agentdom-manifest"</span> <span class="syn-attr">href</span>=<span class="syn-str">"/agentdom.json"</span><span class="syn-tag">&gt;</span>`,
  },
};

const manifestCode = `{
  <span class="syn-str">"agentdom"</span>: <span class="syn-str">"3.0.0"</span>,
  <span class="syn-str">"name"</span>: <span class="syn-str">"Your App"</span>,
  <span class="syn-str">"description"</span>: <span class="syn-str">"What your app does"</span>,
  <span class="syn-str">"auth"</span>: {
    <span class="syn-str">"methods"</span>: [<span class="syn-str">"form"</span>, <span class="syn-str">"oauth2"</span>],
    <span class="syn-str">"login_url"</span>: <span class="syn-str">"/login"</span>
  },
  <span class="syn-str">"capabilities"</span>: [
    { <span class="syn-str">"name"</span>: <span class="syn-str">"search"</span>, <span class="syn-str">"url"</span>: <span class="syn-str">"/search"</span> }
  ]
}`;

const formCode = `<span class="syn-tag">&lt;form</span> <span class="syn-attr">data-agentdom-intent</span>=<span class="syn-str">"authenticate"</span><span class="syn-tag">&gt;</span>
  <span class="syn-tag">&lt;input</span> <span class="syn-attr">name</span>=<span class="syn-str">"email"</span> <span class="syn-attr">type</span>=<span class="syn-str">"email"</span>
         <span class="syn-attr">data-agentdom-field</span>=<span class="syn-str">"email"</span><span class="syn-tag">&gt;</span>
  <span class="syn-tag">&lt;input</span> <span class="syn-attr">name</span>=<span class="syn-str">"password"</span> <span class="syn-attr">type</span>=<span class="syn-str">"password"</span>
         <span class="syn-attr">data-agentdom-field</span>=<span class="syn-str">"password"</span><span class="syn-tag">&gt;</span>
  <span class="syn-tag">&lt;button</span> <span class="syn-attr">type</span>=<span class="syn-str">"submit"</span><span class="syn-tag">&gt;</span>Log In<span class="syn-tag">&lt;/button&gt;</span>
<span class="syn-tag">&lt;/form&gt;</span>

<span class="syn-comment">&lt;!-- Agent auto-generates: login(email, password) --&gt;</span>`;

const authCards = [
  { icon: Lock, title: 'Form-Based Auth', desc: 'Agent fills your login form directly. No API changes needed.', code: `<span class="syn-fn">login</span>(email: <span class="syn-str">"user@co.com"</span>,\n      password: <span class="syn-str">"agent-token"</span>)\n\n<span class="syn-comment">// AgentDOM fills + submits</span>` },
  { icon: Key, title: 'OAuth2 for Agents', desc: 'Standard OAuth2 flow with agent-specific scopes.', code: `<span class="syn-str">"auth"</span>: {\n  <span class="syn-str">"methods"</span>: [<span class="syn-str">"oauth2"</span>],\n  <span class="syn-str">"oauth2"</span>: {\n    <span class="syn-str">"authorize_url"</span>: <span class="syn-str">"/oauth/authorize"</span>\n  }\n}` },
  { icon: Shield, title: 'API Key Auth', desc: 'Issue agent-specific API keys with limited scopes.', code: `<span class="syn-tag">&lt;input</span> <span class="syn-attr">name</span>=<span class="syn-str">"api_key"</span>\n       <span class="syn-attr">data-agentdom-field</span>=<span class="syn-str">"api_key"</span><span class="syn-tag">&gt;</span>` },
  { icon: Ticket, title: 'Agent Tokens', desc: 'Short-lived tokens for agent sessions.', code: `POST /auth/agent-token\n{ <span class="syn-str">"agent_id"</span>: <span class="syn-str">"agentdom-v3"</span>,\n  <span class="syn-str">"scopes"</span>: [<span class="syn-str">"read"</span>], <span class="syn-str">"ttl"</span>: 3600 }` },
];

const apiMethods = [
  { group: 'Schema & Discovery', items: [
    { name: 'AgentDOM.scan()', desc: 'Returns structured JSON schema of all forms, buttons, and links.' },
    { name: 'AgentDOM.scanWithTools()', desc: 'Scan + auto-generate tools. Returns schema with tools array.' },
    { name: 'AgentDOM.synthesizeTools(schema?)', desc: 'Generate tools from a schema. Returns { tools, page_type, summary }.' },
  ]},
  { group: 'Actions', items: [
    { name: 'AgentDOM.click(selector)', desc: 'Human-like click with bezier mouse path.' },
    { name: 'AgentDOM.type(selector, text)', desc: 'Type with realistic keystroke timing. React-compatible.' },
    { name: 'AgentDOM.fillForm(selector, data)', desc: 'Fill entire form from { fieldName: value } object.' },
    { name: 'AgentDOM.submitForm(selector)', desc: 'Find and click the submit button.' },
    { name: 'AgentDOM.hover(selector, duration?)', desc: 'Hover with pointer events. Triggers tooltips and dropdowns.' },
  ]},
];

export default function DocsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('cdn');
  const content = tabContent[activeTab];

  return (
    <>
      <AnimatedGrid />
      <Navbar />

      {/* Hero */}
      <section className="hero">
        <div className="hero-container">
          <div className="badge">Developer Documentation</div>
          <h1>Make your app <span className="gradient">agent-ready</span></h1>
          <p className="hero-sub">One script tag. Any AI agent can now discover, authenticate, and use your app programmatically.</p>
          <CodeBlock code={`<span class="syn-tag">&lt;script</span> <span class="syn-attr">src</span>=<span class="syn-str">"https://cdn.jsdelivr.net/npm/agentdom@3/agentdom.js"</span><span class="syn-tag">&gt;&lt;/script&gt;</span>`} label="Add to your site" />
        </div>
      </section>

      {/* Quick Start */}
      <section className="section section-alt" id="quickstart">
        <div className="container">
          <h2>Quick Start</h2>
          <p className="section-sub">Three ways to add AgentDOM to your app.</p>
          <div className="tabs">
            {tabs.map(t => (
              <button key={t} className={`tab ${activeTab === t ? 'active' : ''}`} onClick={() => setActiveTab(t)}>
                {t.toUpperCase()}
              </button>
            ))}
          </div>
          <h3>{content.title}</h3>
          {content.desc && <p dangerouslySetInnerHTML={{ __html: content.desc }} style={{ margin: '8px 0 16px', fontSize: 14, color: '#6b7280' }} />}
          <CodeBlock code={content.code} />
          {content.after && <p style={{ marginTop: 12, fontSize: 14, color: '#6b7280' }}>{content.after}</p>}
        </div>
      </section>

      {/* Embed */}
      <section className="section" id="embed">
        <div className="container">
          <h2>Embed & Configure</h2>
          <p className="section-sub">Customize AgentDOM for your specific app.</p>
          <h3>Agent Manifest (<code>/agentdom.json</code>)</h3>
          <p style={{ fontSize: 14, color: '#6b7280', margin: '8px 0 16px' }}>Place this at your site root to tell agents what your app offers:</p>
          <CodeBlock code={manifestCode} label="agentdom.json" />

          <h3 style={{ marginTop: 40 }}>Annotate Your Forms</h3>
          <p style={{ fontSize: 14, color: '#6b7280', margin: '8px 0 16px' }}>Add <code>data-agentdom-*</code> attributes so agents understand your forms:</p>
          <CodeBlock code={formCode} />
        </div>
      </section>

      {/* Auth */}
      <section className="section section-alt" id="auth">
        <div className="container">
          <h2>Agent Authentication</h2>
          <p className="section-sub">Let agents authenticate with your service securely.</p>
          <div className="auth-grid">
            {authCards.map(c => (
              <div className="auth-card" key={c.title}>
                <h3><c.icon size={16} /> {c.title}</h3>
                <p>{c.desc}</p>
                <CodeBlock code={c.code} small />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Dynamic Tools */}
      <section className="section" id="tools">
        <div className="container">
          <h2>Dynamic Tool Generation</h2>
          <p className="section-sub">Your page&apos;s forms and buttons automatically become callable tools.</p>
          <table className="doc-table">
            <thead><tr><th>Your Page Has</th><th>Agent Gets</th><th>Example</th></tr></thead>
            <tbody>
              <tr><td>Login form</td><td><code>login(email, password)</code></td><td>Gmail, Stripe</td></tr>
              <tr><td>Search bar</td><td><code>search(query)</code></td><td>Google, Amazon</td></tr>
              <tr><td>Signup form</td><td><code>create_account(name, email, pwd)</code></td><td>Any registration</td></tr>
              <tr><td>Checkout form</td><td><code>checkout(card, exp, cvc)</code></td><td>Stripe, Shopify</td></tr>
              <tr><td>Nav links</td><td><code>navigate_to(destination)</code></td><td>Dashboard</td></tr>
              <tr><td>Buttons</td><td><code>subscribe()</code>, <code>download()</code></td><td>SaaS apps</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* API Reference */}
      <section className="section section-alt" id="api">
        <div className="container">
          <h2>API Reference</h2>
          <p className="section-sub">JavaScript API available on any page with AgentDOM.</p>
          {apiMethods.map(g => (
            <div className="api-group" key={g.group}>
              <h3>{g.group}</h3>
              {g.items.map(item => (
                <div className="api-item" key={item.name}>
                  <code>{item.name}</code>
                  <p>{item.desc}</p>
                </div>
              ))}
            </div>
          ))}

          <div className="api-group">
            <h3>Server-Side Integration</h3>
            <table className="doc-table">
              <thead><tr><th>Protocol</th><th>Endpoint</th><th>Use Case</th></tr></thead>
              <tbody>
                <tr><td>HTTP API</td><td><code>POST /tools/discover</code></td><td>Scan URL → get tools</td></tr>
                <tr><td>HTTP API</td><td><code>POST /tools/execute</code></td><td>Execute a tool</td></tr>
                <tr><td>MCP</td><td><code>tools/list</code></td><td>Claude / Cursor</td></tr>
                <tr><td>OpenAI</td><td>Function Calling</td><td>Tools per turn</td></tr>
                <tr><td>Gemini</td><td>Function Calling</td><td>Tools per turn</td></tr>
                <tr><td>A2A</td><td><code>/.well-known/agent.json</code></td><td>Agent Card</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <Footer />
    </>
  );
}
