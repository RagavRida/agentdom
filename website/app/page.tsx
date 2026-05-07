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
import AgentLogo from '@/components/AgentLogo';

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

// Intent schema fields shown in the manifest reference grid
const schemaFields = [
  { field: 'intent',       type: 'string',    example: '"contacts.create"',        desc: 'Semantic action ID — provider-scoped, versioned' },
  { field: 'args',         type: 'object',    example: '{ email, name, ... }',      desc: 'Typed parameters — validated against manifest schema' },
  { field: 'provider',     type: 'string?',   example: '"api.hubspot.com"',         desc: 'Optional — auto-resolved from intent registry if omitted' },
  { field: 'transport',    type: 'enum',      example: '"api" | "cli" | "browser"', desc: 'Override dispatch priority — default: auto' },
  { field: 'side_effects', type: 'string[]',  example: '["external", "send"]',      desc: 'Effect classes — gates policy engine before execution' },
  { field: 'verify',       type: 'string?',   example: '"result.data.id != null"', desc: 'JS expression evaluated post-execution for correctness' },
  { field: 'timeout_ms',   type: 'number?',   example: '15000',                     desc: 'Per-step timeout — default 15s, overridable per intent' },
  { field: 'dry_run',      type: 'boolean?',  example: 'true',                      desc: 'Plan-only mode — validate + cost-estimate, no execution' },
];

// Auth methods shown in the transport reference grid
const authMethods = [
  { method: 'oauth2_pkce',     flow: 'Browser redirect',  secret: false, note: 'S256 code_challenge — no client_secret required' },
  { method: 'oauth2_device',   flow: 'Device code poll',  secret: false, note: 'RFC 8628 — no browser redirect, works headless' },
  { method: 'api_key',         flow: 'Header injection',  secret: true,  note: 'Authorization / x-api-key — stored in OS Keychain' },
  { method: 'agent_tokens',    flow: 'M2M provisioning',  secret: false, note: 'Agent self-provisions scoped token — no human needed' },
  { method: 'oauth2_cc',       flow: 'Client credentials', secret: true, note: 'Machine-to-machine — no user context' },
];

// Protocol compatibility badges
const protocols: { icon: React.ReactNode; label: string }[] = [
  { icon: <Terminal size={16} />, label: 'MCP (stdio)' },
  { icon: <Globe size={16} />,    label: 'MCP (SSE)' },
  { icon: <FileCode2 size={16} />, label: 'OpenAI Function Calling' },
  { icon: <Cpu size={16} />,      label: 'Anthropic Tool Use' },
  { icon: <Database size={16} />, label: 'JSON Schema v7' },
  { icon: <Layers size={16} />,   label: 'OpenAPI 3.x' },
  { icon: <Lock size={16} />,     label: 'OAuth 2.0 + PKCE' },
  { icon: <Zap size={16} />,      label: 'RFC 8628 Device Flow' },
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
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              <div style={{
                background: 'rgba(249,115,22,0.06)',
                border: '1px solid rgba(249,115,22,0.2)',
                borderRadius: '50%',
                padding: 18,
                boxShadow: '0 0 40px rgba(249,115,22,0.12)',
              }}>
                <AgentLogo size={56} />
              </div>
            </div>
          </ScrollReveal>

          <ScrollReveal delay={60}>
            <div className="badge"><Star size={12} /> Open Standard · MIT License · v3.2</div>
          </ScrollReveal>

          <ScrollReveal delay={100}>
            <h1>The machine-readable<br />interface for <span className="gradient">AI agents</span></h1>
          </ScrollReveal>

          <ScrollReveal delay={200}>
            <p className="hero-sub">
              Agents shouldn't click buttons. <code>dispatch_intent()</code> gives them a typed, transport-agnostic primitive over any API, CLI, browser, or desktop — with OAuth resolved automatically and zero human interaction at runtime.
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
            <h2>Browser automation is the wrong abstraction</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Vision model + CDP screenshot loop = 3–8 s/action, brittle on every deploy, and no structured result to verify. Agents need a stable API contract — not pixel coordinates.
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
            <div className="section-label">[ 02 / 05 ] · dispatch_intent()</div>
            <h2>One function. Any transport.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Agents pass <code>intent + args + provider</code>. AgentDOM selects the lowest-latency transport — REST API, CLI bridge, Browser CDP, or Desktop AX — and injects the resolved credential automatically.
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
            <div className="section-label">[ 03 / 05 ] · secrets.resolve()</div>
            <h2>7-source credential waterfall</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Agent Token Protocol → env var → base64 wallet → wallet file → OS Keychain → AWS SSM → HashiCorp Vault. Local-first: no cloud token proxy, no escrow service, tokens never leave your infrastructure.
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
            <div className="section-label">[ 04 / 05 ] · Manifest Registry</div>
            <h2>50+ providers. Zero vendor buy-in.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">
              Polyfill manifests auto-generated from public OpenAPI specs. Each maps semantic intent IDs to REST endpoints, auth headers, side-effect classes, and optional Agent Token Protocol endpoints for M2M token issuance.
            </p>
          </ScrollReveal>

          <ScrollReveal delay={150}>
            <div className="example-card" style={{ marginBottom: 32 }}>
              <div className="card-label">Manifest schema — serve at <code style={{fontSize:11}}>GET /.well-known/agentdom.json</code></div>
              <CodeBlock code={manifestCode} />
            </div>
          </ScrollReveal>

          <ScrollReveal delay={180}>
            <div className="card-label" style={{ marginBottom: 12 }}>Auth methods supported by the protocol</div>
            <div className="features" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10, marginBottom: 32 }}>
              {authMethods.map((a) => (
                <div key={a.method} className="feature" style={{ padding: '14px 18px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <code style={{ fontSize: 12, color: '#f97316' }}>{a.method}</code>
                    <span style={{ fontSize: 10, color: '#6b7280', background: '#111', padding: '2px 7px', borderRadius: 4 }}>{a.flow}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#4b5563', lineHeight: 1.5 }}>{a.note}</div>
                </div>
              ))}
            </div>
          </ScrollReveal>

          <ScrollReveal delay={220}>
            <div className="card-label" style={{ marginBottom: 12 }}>dispatch_intent() — full parameter reference</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #1f2937' }}>
                    {['field', 'type', 'example', 'description'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: '#6b7280', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {schemaFields.map((s, i) => (
                    <tr key={s.field} style={{ borderBottom: '1px solid #111', background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                      <td style={{ padding: '8px 12px', color: '#f97316' }}>{s.field}</td>
                      <td style={{ padding: '8px 12px', color: '#60a5fa' }}>{s.type}</td>
                      <td style={{ padding: '8px 12px', color: '#10b981' }}>{s.example}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{s.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── Section 05 — Features ── */}
      <section className="section section-alt" id="features">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 05 / 05 ] · Agent Runtime</div>
            <h2>Plan → execute → verify → replan</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">LLM emits a structured JSON plan. Each step runs through policy check → dispatch_intent → result verification. Failed steps trigger LLM replanning. Session state checkpointed to disk.</p>
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

      {/* ── Protocol Compatibility ── */}
      <section className="section" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <div className="section-label">Protocol Compatibility</div>
            <h2>Implements open standards. No lock-in.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 40px' }}>
              AgentDOM exposes a native MCP server (<code>stdio</code> + <code>SSE</code>) and implements OpenAI function-calling and Anthropic tool-use schemas out of the box. Any framework that speaks these protocols connects with zero glue code.
            </p>
          </ScrollReveal>
          <ScrollReveal delay={200}>
            <div className="integrations">
              {protocols.map((p) => (
                <div className="int-badge" key={p.label}>
                  {p.icon} {p.label}
                </div>
              ))}
            </div>
          </ScrollReveal>
          <ScrollReveal delay={300}>
            <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, textAlign: 'left' }}>
              <div className="example-card">
                <div className="card-label">MCP stdio server (Claude Code / Cursor)</div>
                <CodeBlock code={`claude mcp add agentdom -- node \\
  $(npm root -g)/agentdom/desktop-mcp-server.js`} small />
              </div>
              <div className="example-card">
                <div className="card-label">OpenAI function-calling schema</div>
                <CodeBlock code={`const tools = await agentdom.toOpenAI('contacts.create');
// → { type: "function", function: { name, parameters } }`} small />
              </div>
              <div className="example-card">
                <div className="card-label">HTTP SSE server (any MCP client)</div>
                <CodeBlock code={`node $(npm root -g)/agentdom/mcp-api-server.js
# Listens on http://localhost:3001/mcp`} small />
              </div>
            </div>
          </ScrollReveal>
        </div>
      </section>

      {/* ── For Publishers ── */}
      <section className="section section-alt" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <div className="section-label">For API Publishers</div>
            <h2>Serve one JSON file. Every agent finds you.</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 40px' }}>
              Serve <code>GET /.well-known/agentdom.json</code> — declare intents, auth method, and an Agent Token Protocol endpoint for M2M credential issuance. Zero SDK required. Works with every AgentDOM client immediately.
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
          <h2>Zero-install. Running in 30 seconds.</h2>
        </ScrollReveal>
        <ScrollReveal delay={100}>
          <p>One-time credential setup. Headless forever. Zero humans in the agent runtime loop.</p>
        </ScrollReveal>
        <ScrollReveal delay={200}>
          <div className="cta-code">npx agentdom@latest setup linear.app &amp;&amp; agentdom run "file a ticket for the crash"</div>
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
