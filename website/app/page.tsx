import { 
  Sparkles, 
  ShieldCheck, 
  MousePointerClick, 
  Zap, 
  Puzzle, 
  FileCode2, 
  Terminal, 
  Globe, 
  Laptop, 
  MessageSquareCode, 
  Monitor, 
  X, 
  Check, 
  Clock, 
  Coins, 
  Crosshair,
  Blocks,
  Fingerprint,
  Bot,
  Workflow,
  ArrowRight,
  Star
} from 'lucide-react';
import { OpenAIIcon, GoogleIcon, AnthropicIcon, LangChainIcon } from '@/components/BrandIcons';
import AnimatedGrid from '@/components/AnimatedGrid';
import Navbar from '@/components/Navbar';
import Footer from '@/components/Footer';
import CodeBlock from '@/components/CodeBlock';
import HeroOrb from '@/components/HeroOrb';
import ScrollReveal from '@/components/ScrollReveal';
import MagneticButton from '@/components/MagneticButton';

const heroCode = `<span class="syn-comment">// Web: One script tag</span>
<span class="syn-tag">&lt;script</span> <span class="syn-attr">src</span>=<span class="syn-str">"https://cdn.jsdelivr.net/npm/agentdom@3/agentdom.js"</span><span class="syn-tag">&gt;&lt;/script&gt;</span>

<span class="syn-comment">// Desktop: Native agent</span>
$ agentdom desktop --observe

<span class="syn-comment">// CLI: Terminal automation</span>
$ agentdom scan --interface cli`;

const htmlExample = `&lt;form data-agentdom-intent="authenticate"&gt;
  &lt;input name="email" type="email"
         aria-label="Email address"&gt;
  &lt;input name="password" type="password"
         aria-label="Password"&gt;
  &lt;button type="submit"&gt;Log In&lt;/button&gt;
&lt;/form&gt;`;

const toolExample = `<span class="syn-fn">login</span>(
  email: <span class="syn-str">"user@company.com"</span>,
  password: <span class="syn-str">"agent-token-xyz"</span>
)

<span class="syn-comment">// AgentDOM fills form + clicks submit</span>
<span class="syn-comment">// Agent gets authenticated session</span>`;

const features = [
  { icon: Monitor, title: 'Desktop Agent', desc: 'Control any desktop app. Click buttons, type text, manage windows. Native macOS support, Windows coming soon.' },
  { icon: Crosshair, title: 'No Screenshots', desc: 'Structured schema, not pixel parsing. Faster, cheaper, and deterministic every single time.' },
  { icon: Sparkles, title: 'Auto Tool Synthesis', desc: 'Forms become functions. Buttons become actions. Links become navigation. All auto-generated.' },
  { icon: ShieldCheck, title: 'Agent Auth', desc: 'Form-based auth, OAuth2, API keys, and the new Agent Token standard for secure sessions.' },
  { icon: MousePointerClick, title: 'Human-Like Actions', desc: 'Bezier mouse curves, realistic keystroke timing, hover events. Bypasses bot detection.' },
  { icon: Zap, title: 'MCP Server', desc: 'Built-in Model Context Protocol server. Works with Claude, Cursor, and any MCP client.' },
  { icon: Puzzle, title: 'Multi-Platform', desc: 'Web, Desktop, CLI, Mobile, API. One protocol that works everywhere software runs.' },
  { icon: FileCode2, title: 'Agent Manifest', desc: 'Declare capabilities in agentdom.json. Agents discover what your app can do before visiting.' },
];

const integrations: { icon: React.ReactNode; label: string }[] = [
  { icon: <OpenAIIcon size={18} />, label: 'OpenAI' },
  { icon: <GoogleIcon size={18} />, label: 'Google Gemini' },
  { icon: <AnthropicIcon size={18} />, label: 'Claude MCP' },
  { icon: <LangChainIcon size={18} />, label: 'LangChain' },
  { icon: <Blocks size={16} />, label: 'A2A Protocol' },
  { icon: <Globe size={16} />, label: 'HTTP API' },
  { icon: <Terminal size={16} />, label: 'CLI' },
];

const screenshotProblems = [
  { icon: Coins, text: 'Every action costs a vision API call ($$$)' },
  { icon: X, text: 'UI changes by 1px? Agent breaks' },
  { icon: Clock, text: 'Slow: 2-5 seconds per action' },
  { icon: X, text: 'Non-deterministic results' },
];

const agentdomBenefits = [
  { icon: Check, text: 'Scan once, reusable tools (free)' },
  { icon: Check, text: 'Schema adapts automatically' },
  { icon: Zap, text: 'Fast: milliseconds per action' },
  { icon: Check, text: 'Deterministic every time' },
];

export default function Home() {
  return (
    <>
      <AnimatedGrid />
      <Navbar />

      {/* Hero */}
      <section className="hero">
        <HeroOrb />
        <div className="hero-container">
          <ScrollReveal delay={0}>
            <div className="badge"><Star size={12} /> Open Source · MIT License</div>
          </ScrollReveal>
          
          <ScrollReveal delay={100}>
            <h1>Power AI agents with<br /><span className="gradient">structured software access</span></h1>
          </ScrollReveal>
          
          <ScrollReveal delay={200}>
            <p className="hero-sub">
              The protocol to give AI agents typed, reliable access to any software interface. Web, desktop, CLI — no screenshots required.
            </p>
          </ScrollReveal>
          
          <ScrollReveal delay={300}>
            <CodeBlock code={heroCode} label="agentdom" />
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

      {/* Section 01 - Why not screenshots? */}
      <section className="section section-alt" id="comparison">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 01 / 05 ] · Core</div>
            <h2>Why not screenshots?</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">Software should describe itself to machines, not be photographed by them.</p>
          </ScrollReveal>
          <div className="comparison-grid">
            <ScrollReveal delay={150} direction="left">
              <div className="comparison-card comparison-bad">
                <div className="comparison-header">
                  <X size={20} />
                  <span>Screenshot Agents</span>
                </div>
                <p className="comparison-method">Take screenshot → send to vision model → guess coordinates → click → repeat</p>
                <ul className="comparison-list">
                  {screenshotProblems.map((item, i) => (
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
                  <span>AgentDOM</span>
                </div>
                <p className="comparison-method">Scan once → get structured schema → call typed functions</p>
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

      {/* Section 02 - Works everywhere */}
      <section className="section" id="how">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 02 / 05 ] · Platforms</div>
            <h2>Works everywhere</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">One protocol for every interface. Web, desktop, CLI, or API — AgentDOM creates a machine-readable schema that agents use to generate tools.</p>
          </ScrollReveal>
          <div className="platform-grid">
            <ScrollReveal delay={150}>
              <div className="platform-card">
                <div className="step-num">01</div>
                <div className="platform-icon"><Globe size={24} /></div>
                <h3>Web</h3>
                <p>One script tag. Auto-generates tools from your HTML. Any page becomes agent-ready instantly.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={250}>
              <div className="platform-card">
                <div className="step-num">02</div>
                <div className="platform-icon"><Laptop size={24} /></div>
                <h3>Desktop</h3>
                <p>Native agent observes and controls desktop apps via accessibility APIs. macOS today, Windows coming soon.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={350}>
              <div className="platform-card">
                <div className="step-num">03</div>
                <div className="platform-icon"><Terminal size={24} /></div>
                <h3>CLI</h3>
                <p>Full terminal automation. Scan any command-line interface and generate typed tools.</p>
              </div>
            </ScrollReveal>
            <ScrollReveal delay={450}>
              <div className="platform-card">
                <div className="step-num">04</div>
                <div className="platform-icon"><Workflow size={24} /></div>
                <h3>API</h3>
                <p>Universal HTTP gateway for any agent framework. Connect any system to any agent.</p>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Section 03 - Your Page → Agent Tools */}
      <section className="section section-alt" id="tools">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 03 / 05 ] · Zero Config</div>
            <h2>Your page → Agent tools</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">Any form or action on your page becomes a callable function for AI agents. Zero configuration required.</p>
          </ScrollReveal>
          <div className="example-grid">
            <ScrollReveal delay={150} direction="left">
              <div className="example-card">
                <div className="card-label">Your HTML</div>
                <CodeBlock code={htmlExample} />
              </div>
            </ScrollReveal>
            <div className="example-arrow">
              <ArrowRight size={24} />
            </div>
            <ScrollReveal delay={250} direction="right">
              <div className="example-card highlight">
                <div className="card-label">Agent gets this tool</div>
                <CodeBlock code={toolExample} />
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* Section 04 - Features */}
      <section className="section" id="features">
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 04 / 05 ] · Features</div>
            <h2>Everything agents need</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub">Built for the agent era. Every feature designed to make AI-software interaction reliable and fast.</p>
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

      {/* Integrations */}
      <section className="section section-alt" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <div className="section-label">[ 05 / 05 ] · Integrations</div>
            <h2>Connect with any AI agent</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 40px' }}>Works with every major agent platform out of the box.</p>
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
        </div>
      </section>

      {/* Download */}
      <section className="section" id="download" style={{ textAlign: 'center' }}>
        <div className="container">
          <ScrollReveal>
            <h2>Install on any platform</h2>
          </ScrollReveal>
          <ScrollReveal delay={100}>
            <p className="section-sub" style={{ margin: '0 auto 48px' }}>One CLI for web, desktop, and terminal automation. Works on macOS and Linux. Windows CLI support included.</p>
          </ScrollReveal>
          <div className="steps-scroll-wrapper">
            <div className="steps">
              <ScrollReveal delay={150}>
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Laptop size={20} /></div>
                  <h3>macOS / Linux</h3>
                  <CodeBlock code={`curl -fsSL https://getagentdom.com/install.sh | bash`} small />
                  <p style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>Installs CLI for web + desktop agent</p>
                </div>
              </ScrollReveal>
              <ScrollReveal delay={250}>
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Terminal size={20} /></div>
                  <h3>Windows</h3>
                  <CodeBlock code={`irm https://getagentdom.com/install.ps1 | iex`} small />
                  <p style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>Installs CLI for web automation</p>
                </div>
              </ScrollReveal>
              <ScrollReveal delay={350}>
                <div className="step">
                  <div className="feature-icon" style={{ margin: '0 0 20px' }}><Globe size={20} /></div>
                  <h3>Browser CDN</h3>
                  <CodeBlock code={`<span class="syn-tag">&lt;script</span> <span class="syn-attr">src</span>=<span class="syn-str">"https://cdn.jsdelivr.net/npm/agentdom@3/agentdom.js"</span><span class="syn-tag">&gt;&lt;/script&gt;</span>`} small />
                  <p style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>Web-only, no install needed</p>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta section-alt">
        <ScrollReveal>
          <h2>Start building in seconds</h2>
        </ScrollReveal>
        <ScrollReveal delay={100}>
          <p>One protocol for every machine. No screenshots required.</p>
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
