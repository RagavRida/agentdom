import { 
  Sparkles, 
  ShieldCheck, 
  Zap, 
  FileCode2, 
  Terminal, 
  Globe, 
  Laptop, 
  Monitor,
  X, 
  Check, 
  ArrowRight,
  Star,
  KeyRound,
  Brain,
  Route,
  Layers,
  Lock,
  Cpu,
  Database,
} from 'lucide-react';
import { OpenAIIcon, GoogleIcon, AnthropicIcon, LangChainIcon } from '@/components/BrandIcons';
import AnimatedGrid from '@/components/AnimatedGrid';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import CodeBlock from '@/components/CodeBlock';
import HeroOrb from '@/components/HeroOrb';
import ScrollReveal from '@/components/ScrollReveal';
import MagneticButton from '@/components/MagneticButton';

// ── Code snippets ─────────────────────────────────────────────────────────────

const heroCode = `<span class="syn-comment">// One command. Any software.</span>
$ agentdom auth linear.app         <span class="syn-comment"># one-time OAuth consent</span>
$ agentdom auth resend.com          <span class="syn-comment"># API key, stored in Keychain</span>

<span class="syn-comment">// Then let the agent do the work</span>
$ agentdom goal <span class="syn-str">"Create a Linear ticket for the login crash
  and send a Slack summary to #engineering"</span>`;

const dispatchCode = `<span class="syn-comment">// Agent says what it wants — AgentDOM figures out how</span>
<span class="syn-fn">dispatch_intent</span>(<span class="syn-str">"issues.create"</span>, {
  title:    <span class="syn-str">"Login crash on iOS 17"</span>,
  priority: <span class="syn-num">1</span>,
  teamId:   <span class="syn-str">"ENG"</span>
}, <span class="syn-str">"linear.app"</span>)

<span class="syn-comment">// → looks up wallet token → POST https://api.linear.app/graphql</span>
<span class="syn-comment">// → { success: true, issue: { id: "ENG-42", url: "..." } }</span>
<span class="syn-comment">// Total latency: ~120ms. No browser. No screenshot.</span>`;

const manifestCode = `<span class="syn-comment">// .well-known/agentdom.json (any vendor publishes this)</span>
{
  <span class="syn-str">"version"</span>: <span class="syn-str">"1.0"</span>,
  <span class="syn-str">"host"</span>: <span class="syn-str">"yourapp.com"</span>,
  <span class="syn-str">"auth"</span>: { <span class="syn-str">"method"</span>: <span class="syn-str">"oauth2"</span>, ... },
  <span class="syn-str">"capabilities"</span>: [{
    <span class="syn-str">"intent"</span>:      <span class="syn-str">"contacts.create"</span>,
    <span class="syn-str">"transport"</span>:   <span class="syn-str">"api"</span>,
    <span class="syn-str">"endpoint"</span>:    <span class="syn-str">"https://api.yourapp.com/contacts"</span>,
    <span class="syn-str">"side_effects"</span>: [<span class="syn-str">"external"</span>]
  }]
}`;

const walletCode = `<span class="syn-comment">// First time: browser opens, human approves OAuth once</span>
$ agentdom auth hubspot.com
<span class="syn-comment">  → Stored in macOS Keychain. Never leaves your machine.</span>

<span class="syn-comment">// All future calls: silent, auto-refreshed, zero prompts</span>
<span class="syn-fn">dispatch_intent</span>(<span class="syn-str">"contacts.create"</span>, { email: <span class="syn-str">"alice@acme.com"</span> })
<span class="syn-comment">// → token fetched from Keychain → 1 API hop → done</span>`;

// ── Data ──────────────────────────────────────────────────────────────────────

const todayProblems = [
  { icon: X, text: 'Agents click buttons in a browser designed for humans' },
  { icon: X, text: 'Screenshots cost $$$, break on any UI change' },
  { icon: X, text: '5+ seconds per action through a vision model' },
  { icon: X, text: 'Auth requires a human to log in each time' },
];

const agentdomBenefits = [
  { icon: Check, text: 'Machine-readable interface: dispatch_intent("contacts.create")' },
  { icon: Check, text: 'Polyfill registry covers 50+ SaaS with zero vendor cooperation' },
  { icon: Zap,   text: '~120ms per API action, no LLM vision call needed' },
  { icon: Check, text: 'One-time OAuth consent stored in OS Keychain forever' },
];

const features = [
  { icon: Route,     title: 'Dispatch Router',    desc: 'Intent → cheapest available transport. API < CLI < CDP/browser < AX/desktop < coordinate. Agents always get the fastest path.' },
  { icon: KeyRound,  title: 'Auth Wallet',         desc: 'OS Keychain (macOS/Windows/Linux) stores OAuth tokens. One consent, then silent forever. Auto-refreshes before expiry.' },
  { icon: Layers,    title: 'Polyfill Registry',   desc: '50+ SaaS manifests hosted at agentdom.dev/manifests/. Agents work with HubSpot, Stripe, Linear, Slack — before vendors do anything.' },
  { icon: Brain,     title: 'Episodic Memory',     desc: 'Cross-session memory stores what worked and what failed per provider. Agents learn and improve over time.' },
  { icon: ShieldCheck, title: 'Policy Engine',     desc: 'Per-effect allow/prompt/deny. read=allow, send=prompt, delete=deny by default. Human approves sensitive actions.' },
  { icon: Cpu,       title: 'Plan-Execute-Verify', desc: 'Explicit JSON plan → policy check → execute → verify result → replan on failure. Not greedy one-shot calls.' },
  { icon: Monitor,   title: 'Universal Surfaces',  desc: 'REST/GraphQL, Web CDP (Shadow DOM, iframes, React), Electron, macOS AX, CLI — all behind the same intent interface.' },
  { icon: FileCode2, title: '.well-known Standard', desc: 'Open spec. Vendors publish agentdom.json to declare capabilities. Agents discover and use new tools without any code changes.' },
];

const providers = [
  { name: 'Linear',     category: 'Issues',    intents: 8,  auth: 'OAuth2' },
  { name: 'HubSpot',    category: 'CRM',       intents: 8,  auth: 'OAuth2' },
  { name: 'Vercel',     category: 'Deploy',    intents: 8,  auth: 'API Key' },
  { name: 'Slack',      category: 'Messaging', intents: 6,  auth: 'OAuth2' },
  { name: 'Notion',     category: 'Docs',      intents: 6,  auth: 'OAuth2' },
  { name: 'Supabase',   category: 'DB',        intents: 7,  auth: 'API Key' },
  { name: 'Resend',     category: 'Email',     intents: 5,  auth: 'API Key' },
  { name: 'Cal.com',    category: 'Calendar',  intents: 6,  auth: 'OAuth2' },
  { name: 'GitHub',     category: 'Code',      intents: 811, auth: 'Device' },
  { name: 'Stripe',     category: 'Payments',  intents: 442, auth: 'API Key' },
  { name: 'OpenAI',     category: 'AI',        intents: 5,  auth: 'API Key' },
  { name: 'Anthropic',  category: 'AI',        intents: 2,  auth: 'API Key' },
];

const integrations: { icon: React.ReactNode; label: string }[] = [
  { icon: <OpenAIIcon size={18} />, label: 'OpenAI' },
  { icon: <GoogleIcon size={18} />, label: 'Gemini' },
  { icon: <AnthropicIcon size={18} />, label: 'Claude MCP' },
  { icon: <LangChainIcon size={18} />, label: 'LangChain' },
  { icon: <Cpu size={16} />, label: 'CrewAI' },
  { icon: <Globe size={16} />, label: 'LangGraph' },
  { icon: <Terminal size={16} />, label: 'Any MCP client' },
];

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <>
      <AnimatedGrid />
      <Navbar />

      {/* ── Hero ── */}
      <section className="hero">
        <HeroOrb />
        <div className="hero-container">
          <ScrollReveal delay={0}>
            <div className="badge"><Star size={12} /> Open Standard · MIT License · v3.1</div>
          </ScrollReveal>

          <ScrollReveal delay={100}>
            <h1>Software built for<br /><span className="gradient">AI agents</span></h1>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <p className="hero-sub">
              The next billion users aren't humans — they're AI agents. AgentDOM gives them machine-readable access to any software: APIs, desktops, CLIs. No screenshots. No scraping. One protocol.
            </p>
          </ScrollReveal>

          <ScrollReveal delay={300}>
            <CodeBlock code={heroCode} label="terminal" />
          </ScrollReveal>

          <ScrollReveal delay={400}>
            <div className="hero-actions">
              <MagneticButton href="/docs" className="btn btn-primary">
                Get Started <ArrowRight size={16} />
              </MagneticButton>
              <MagneticButton href="https://github.com/RagavRida/agentdom" external className="btn btn-outline">
                <Star size={16} /> Star on GitHub
              </MagneticButton>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Section 01 — The Problem ── */}
      <section className="section section-alt" id="comparison">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 01 / 05 ] · The Problem</div>
            <h2>Agents deserve better than clicking buttons</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Agents are running on software designed for human eyes. They need a completely different foundation.
            </p>
          </ScrollReveal>
          <div className="comparison-grid">
            <ScrollReveal delay={150} direction="left">
              <div className="comparison-card comparison-bad">
                <div className="comparison-header">
                  <X size={20} />
                  <span>Today — designed for humans</span>
                </div>
                <p className="comparison-method">Agent sees a form → takes screenshot → sends to vision model → guesses coordinates → clicks → waits → repeats</p>
                <ul className="comparison-list">
                  {todayProblems.map((item, i) => (
                    <li key={i}>
                      <item.icon size={16} />
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={250} direction="right">
              <div className="comparison-card comparison-good">
                <div className="comparison-header">
                  <Check size={20} />
                  <span>AgentDOM — built for agents</span>
                </div>
                <p className="comparison-method">Agent declares intent → wallet provides token → one HTTP call → structured result</p>
                <ul className="comparison-list">
                  {agentdomBenefits.map((item, i) => (
                    <li key={i}>
                      <item.icon size={16} />
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Section 02 — How dispatch works ── */}
      <section className="section" id="how">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 02 / 05 ] · The Protocol</div>
            <h2>One intent. Any software.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Agents express <em>what</em> they want. AgentDOM figures out <em>how</em> — picking the fastest available transport automatically.
            </p>
          </ScrollReveal>
          <div className="example-grid">
            <ScrollReveal delay={150} direction="left">
              <div className="example-card">
                <div className="card-label">Agent calls this</div>
                <CodeBlock code={dispatchCode} />
              </div>
            </ScrollReveal>
            <ScrollReveal delay={250} direction="right">
              <div className="example-card highlight">
                <div className="card-label">Transport priority</div>
                <div style={{ padding: '20px', fontFamily: 'monospace', fontSize: 13, lineHeight: 2, whiteSpace: 'nowrap', overflowX: 'auto' }}>
                  <div style={{ color: '#10b981' }}>① REST/GraphQL API  &nbsp;&nbsp;~120ms ✓ cheapest</div>
                  <div style={{ color: '#60a5fa' }}>② CLI bridge        &nbsp;&nbsp;~200ms</div>
                  <div style={{ color: '#a78bfa' }}>③ Browser CDP       &nbsp;&nbsp;~300ms</div>
                  <div style={{ color: '#f59e0b' }}>④ Desktop AX (macOS) ~100ms</div>
                  <div style={{ color: '#6b7280' }}>⑤ Coordinate click  &nbsp;&nbsp;last resort</div>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Section 03 — Auth Wallet ── */}
      <section className="section section-alt" id="auth">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 03 / 05 ] · Auth Wallet</div>
            <h2>Tokens that never leave your machine</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Unlike Composio or Zapier, AgentDOM is local-first. OAuth tokens live in your OS Keychain. No cloud proxy. One fewer network hop.
            </p>
          </ScrollReveal>
          <div className="example-grid">
            <ScrollReveal delay={150} direction="left">
              <div className="example-card highlight">
                <div className="card-label">How it works</div>
                <CodeBlock code={walletCode} />
              </div>
            </ScrollReveal>
            <ScrollReveal delay={250} direction="right">
              <div className="example-card">
                <div className="card-label">Storage backend</div>
                <div style={{ padding: '20px', fontFamily: 'monospace', fontSize: 13, lineHeight: 2, whiteSpace: 'nowrap', overflowX: 'auto' }}>
                  <div style={{ color: '#10b981' }}>macOS  → Keychain Access</div>
                  <div style={{ color: '#60a5fa' }}>Windows → Credential Manager</div>
                  <div style={{ color: '#a78bfa' }}>Linux   → libsecret / KWallet</div>
                  <div style={{ color: '#f59e0b', marginTop: 12 }}>Auto-refresh: 5min before expiry</div>
                  <div style={{ color: '#f59e0b' }}>Offline: bundled manifests + cached tokens</div>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ── Section 04 — Polyfill Registry ── */}
      <section className="section" id="providers">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 04 / 05 ] · Polyfill Registry</div>
            <h2>50+ providers. Zero vendor cooperation.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              We generate <code>.well-known/agentdom.json</code> from public OpenAPI specs and host them at <strong>agentdom.dev/manifests/</strong>. 
              Agents work with any of these on day one — no vendor action required.
            </p>
          </ScrollReveal>

          <ScrollReveal delay={150}>
            <div className="example-card" style={{ marginBottom: 32 }}>
              <div className="card-label">The standard any vendor can publish</div>
              <CodeBlock code={manifestCode} />
            </div>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <div className="features" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              {providers.map((p) => (
                <div key={p.name} className="feature" style={{ padding: '16px 20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <h3 style={{ fontSize: 15, margin: 0 }}>{p.name}</h3>
                    <span style={{ fontSize: 11, color: '#6b7280', background: '#111', padding: '2px 7px', borderRadius: 4 }}>{p.category}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#4b5563' }}>
                    {p.intents} intents · {p.auth}
                  </div>
                </div>
              ))}
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Section 05 — Features ── */}
      <section className="section section-alt" id="features">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 05 / 05 ] · Runtime</div>
            <h2>Everything agents need to act autonomously</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">The runtime layer that makes agents reliable, safe, and self-improving.</p>
          </ScrollReveal>
          <div className="features">
            {features.map((f, i) => (
              <ScrollReveal key={f.title} delay={150 + i * 60}>
                <div className="feature">
                  <div className="feature-icon"><f.icon size={20} /></div>
                  <h3>{f.title}</h3>
                  <p>{f.desc}</p>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Integrations ── */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <div className="section-label">Integrations</div>
            <h2>Works with every agent framework</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 40px' }}>
              AgentDOM is an MCP server. Any agent that speaks MCP connects instantly.
            </p>
          </ScrollReveal>
          <ScrollReveal delay={200}>
            <div className="integrations">
              {integrations.map((i) => (
                <div className="int-badge" key={i.label}>
                  {i.icon} {i.label}
                </div>
              ))}
            </div>
          </ScrollReveal>
          <ScrollReveal delay={300}>
            <div style={{ marginTop: 40 }}>
              <div className="example-card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'left' }}>
                <div className="card-label">Claude Code — add in one command</div>
                <CodeBlock code={`claude mcp add agentdom-desktop -- node \\
  $(npm root -g)/agentdom/desktop-mcp-server.js`} small />
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── For Publishers ── */}
      <section className="section section-alt" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <div className="section-label">For Publishers</div>
            <h2>Make your product agent-native</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 40px' }}>
              Publish <code>.well-known/agentdom.json</code> and every AI agent that uses AgentDOM can instantly discover and use your product — with no extra integration work.
            </p>
          </ScrollReveal>
          <ScrollReveal delay={200}>
            <div className="steps-scroll-wrapper">
              <div className="steps">
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Terminal size={20} /></div>
                  <h3>Generate from OpenAPI</h3>
                  <CodeBlock code={`npx agentdom-publisher init \\
  --openapi=./openapi.json \\
  --host=api.yourapp.com`} small />
                </div>
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Globe size={20} /></div>
                  <h3>Publish to your domain</h3>
                  <CodeBlock code={`# Deploy to:
https://yourapp.com/.well-known/agentdom.json`} small />
                </div>
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Zap size={20} /></div>
                  <h3>Agents discover you instantly</h3>
                  <CodeBlock code={`dispatch_intent("contacts.create", {...},
  "yourapp.com")
# → works immediately, no code changes`} small />
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="cta section-alt">
        <ScrollReveal>
          <h2>Build for agents. Start today.</h2>
        </ScrollReveal>
        <ScrollReveal delay={100}>
          <p>The next billion users aren't human. Give them the interface they need.</p>
        </ScrollReveal>
        <ScrollReveal delay={200}>
          <div className="cta-code">npm install -g agentdom</div>
        </ScrollReveal>
        <ScrollReveal delay={300}>
          <div className="hero-actions" style={{ marginTop: 32 }}>
            <MagneticButton href="/docs" className="btn btn-primary">
              Read the Docs <ArrowRight size={16} />
            </MagneticButton>
            <MagneticButton href="https://github.com/RagavRida/agentdom" external className="btn btn-outline">
              <Star size={16} /> Star on GitHub
            </MagneticButton>
          </div>
        </ScrollReveal>
      </section>

      <Footer />
    </>
  );
}
