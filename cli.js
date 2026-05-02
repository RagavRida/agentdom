#!/usr/bin/env node
/**
 * AgentDOM v3 CLI — AI-powered agent control of any website
 * Fixes: stealth mode, AI intent, SPA handling, timeouts, quote parsing
 */

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// FIX: Stealth plugin to evade bot detection
puppeteerExtra.use(StealthPlugin());

// ── Colors ──
const C = {
  r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m',
  green: '\x1b[38;2;0;212;170m', purple: '\x1b[38;2;167;139;250m',
  orange: '\x1b[38;2;251;146;60m', blue: '\x1b[38;2;96;165;250m',
  red: '\x1b[38;2;239;68;68m', gray: '\x1b[38;2;136;136;160m',
  white: '\x1b[37m', pink: '\x1b[38;2;244;114;182m',
};
const log = (m, c = C.white) => console.log(`${c}${m}${C.r}`);
const logI = m => log(`  ${m}`, C.blue);
const logS = m => log(`  ✓ ${m}`, C.green);
const logE = m => log(`  ✗ ${m}`, C.red);
const logD = m => log(`  ${m}`, C.gray);

const AGENTDOM_SCRIPT = fs.readFileSync(path.join(__dirname, 'agentdom.js'), 'utf-8');

// ── AI Intent Engine (OpenRouter) ──
let aiKey = null;
let aiModel = null;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function initAI() {
  aiKey = process.env.OPENROUTER_API_KEY || null;
  if (!aiKey) return false;
  aiModel = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001';
  return true;
}

async function aiChat(prompt) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${aiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agentdom.dev',
      'X-Title': 'AgentDOM CLI',
    },
    body: JSON.stringify({
      model: aiModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Autonomous Agent Loop ──
async function executeGoal(page, goal, handleCommand, maxSteps = 15) {
  log('', C.green);
  log(`  ╔═══ AUTONOMOUS MODE ═══════════════════════╗`, C.green);
  log(`  ║ Goal: ${goal.slice(0, 44)}`, C.green);
  log(`  ╚═══════════════════════════════════════════╝`, C.green);
  console.log('');

  const history = [];

  for (let step = 1; step <= maxSteps; step++) {
    // 1. Scan current page
    const schema = await evalWithTimeout(page, () => AgentDOM.scan());
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000));

    // 2. Ask AI for next action
    const prompt = `You are an autonomous AI agent operating a web browser. You must complete a goal by issuing CLI commands.

GOAL: ${goal}

CURRENT PAGE:
- Title: ${schema.page.meta.title}
- URL: ${schema.page.meta.url}
- Forms: ${JSON.stringify(schema.page.forms)}
- Actions: ${JSON.stringify(schema.page.actions.slice(0, 20))}
- Visible text (first 2000 chars): ${pageText}

PREVIOUS STEPS:
${history.map((h, i) => `${i + 1}. ${h.command} → ${h.result}`).join('\n') || 'None yet'}

AVAILABLE COMMANDS:
- goto <url>          Navigate to URL
- click <selector>    Click an element
- type <sel> "text"   Type text into input
- fill <form> {json}  Fill form fields
- submit <form>       Submit a form
- scroll <px>         Scroll down
- press <Key>         Press keyboard key
- select <sel> "val"  Select dropdown option
- wait <ms>           Wait milliseconds
- screenshot <name>   Take screenshot

Rules:
1. Issue EXACTLY ONE command per response — no explanations, no markdown
2. If the goal is COMPLETE or the answer is found in the visible text, respond with: DONE: <answer/explanation>
3. If the goal is IMPOSSIBLE, respond with: FAILED: <reason>
4. The visible text above already contains the page content — do NOT scroll repeatedly to read it
5. Use the exact selectors from the schema. Do NOT wrap selectors in extra quotes
6. If a command failed, try an alternative approach — do NOT repeat the same command
7. For navigation, you can use: goto <url> to go directly to a known URL

Your next command:`;

    let aiResponse;
    try {
      aiResponse = (await aiChat(prompt)).trim();
    } catch (e) {
      logE(`AI error: ${e.message}`);
      break;
    }

    // 3. Check if done
    if (aiResponse.startsWith('DONE:')) {
      log(`  ──────────────────────────────────────────`, C.green);
      log(`  ✓ GOAL COMPLETE (${step} steps)`, C.green);
      log(`    ${aiResponse.slice(5).trim()}`, C.green);
      log(`  ──────────────────────────────────────────`, C.green);
      return { success: true, steps: step, history };
    }

    if (aiResponse.startsWith('FAILED:')) {
      logE(`GOAL FAILED: ${aiResponse.slice(7).trim()}`);
      return { success: false, steps: step, reason: aiResponse, history };
    }

    // 4. Execute the command
    // Clean: markdown backticks, wrapping quotes on selectors, multiline (take first line)
    let command = aiResponse
      .replace(/^```[a-z]*\n?|\n?```$/g, '')
      .replace(/^`|`$/g, '')
      .split('\n')[0]  // Take only the first line
      .trim();
    // Fix: AI sometimes wraps selectors in extra quotes: click "#foo" → click #foo
    command = command.replace(/^(click|hover|scrollto|dblclick|rightclick)\s+"([^"]+)"$/, '$1 $2');
    log(`  ${C.purple}[Step ${step}/${maxSteps}]${C.r} ${C.orange}${command}${C.r}`);

    let result = 'OK';
    try {
      await handleCommand(command);
      result = 'Success';
      // Wait for page to settle after action
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      result = `Error: ${e.message}`;
      logE(result);
    }

    history.push({ command, result });
  }

  logE(`Max steps (${maxSteps}) reached without completing goal.`);
  return { success: false, steps: maxSteps, reason: 'max steps', history };
}

async function aiInferIntent(elements, pageContext) {
  if (!aiKey) return elements;
  const prompt = `You are analyzing a webpage to infer the semantic intent of interactive UI elements.

Page: "${pageContext.title}" (${pageContext.url})
Description: ${pageContext.description || 'none'}

For each element below, respond with a JSON array of objects with "index" and "intent" fields.
Intent must be one of: authenticate, register, search, filter, sort, create, update, delete, save, navigate-forward, navigate-back, dismiss, download, upload, purchase, add-to-cart, subscribe, share, copy, toggle, expand-collapse, play-media, or null if unclear.

Elements:
${elements.map((e, i) => `${i}. <${e.tag}> label="${e.label}" selector="${e.selector}" href="${e.href || ''}"`).join('\n')}

Respond ONLY with a valid JSON array. No markdown, no explanation.`;

  try {
    const text = (await aiChat(prompt)).replace(/```json\n?|\n?```/g, '').trim();
    const intents = JSON.parse(text);
    intents.forEach(({ index, intent }) => {
      if (index >= 0 && index < elements.length && intent) {
        elements[index].intent = intent;
        elements[index].intentSource = 'ai';
      }
    });
  } catch (e) {
    // AI failed, keep regex intents
  }
  return elements;
}

async function aiAnalyzePage(page) {
  if (!aiKey) return null;
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText.slice(0, 3000),
    forms: AgentDOM.scan().page.forms.length,
    actions: AgentDOM.scan().page.actions.length,
  }));

  const prompt = `Analyze this webpage and describe what an AI agent can do here.

Title: ${snapshot.title}
URL: ${snapshot.url}
Forms: ${snapshot.forms}, Actions: ${snapshot.actions}
Page text (first 3000 chars):
${snapshot.text}

Respond with a brief JSON object:
{
  "purpose": "one-line description of what this page is for",
  "capabilities": ["list of things an agent can do here"],
  "suggestedFlow": ["step 1", "step 2", ...],
  "warnings": ["any blockers like captcha, login required, etc"]
}`;

  try {
    const text = (await aiChat(prompt)).replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    return { error: e.message };
  }
}

// FIX: Timeout wrapper for page.evaluate
async function evalWithTimeout(page, fn, args = [], timeoutMs = 15000) {
  return Promise.race([
    page.evaluate(fn, ...args),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => a.startsWith('http'));
  const headless = args.includes('--headless');
  const noAI = args.includes('--no-ai');
  const vp = (args.find(a => a.startsWith('--viewport='))?.split('=')[1] || '1280x800').split('x').map(Number);

  console.log('');
  log('  ╔═══════════════════════════════════════════╗', C.green);
  log('  ║   AgentDOM v3.0 — AI-Powered Agent CLI    ║', C.green);
  log('  ╚═══════════════════════════════════════════╝', C.green);
  console.log('');

  // Init AI
  const hasAI = !noAI && initAI();
  if (hasAI) logS(`AI engine ready (OpenRouter → ${aiModel})`);
  else logD('AI disabled (set OPENROUTER_API_KEY to enable)');

  // Launch browser with stealth
  logI('Launching stealth browser...');
  const browser = await puppeteerExtra.launch({
    headless, defaultViewport: { width: vp[0], height: vp[1] },
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${vp[0]},${vp[1] + 100}`],
  });
  const page = await browser.newPage();

  // Inject AgentDOM on every navigation
  await page.evaluateOnNewDocument(AGENTDOM_SCRIPT);

  // FIX: SPA navigation detection
  let lastUrl = '';
  page.on('framenavigated', async () => {
    const cur = page.url();
    if (cur !== lastUrl) {
      lastUrl = cur;
      logD(`[SPA] Navigation detected → ${cur}`);
    }
  });

  logS(`Browser ready (stealth mode, ${vp[0]}x${vp[1]})`);

  if (url) {
    logI(`Navigating to ${url}...`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      lastUrl = page.url();
      logS(`Loaded: ${await page.title()}`);
    } catch (e) { logE(`Navigation failed: ${e.message}`); }
  } else {
    logD('No URL. Use "goto <url>" to navigate.');
  }

  console.log('');
  logD('Type "help" for commands. Ctrl+C to exit.');
  console.log('');

  // ── Command Handler ──
  async function handleCommand(cmd) {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const verb = parts[0].toLowerCase();
    const rest = parts.slice(1).join(' ');

    try {
      switch (verb) {

        // Navigation
        case 'goto': case 'navigate': case 'open': {
          const t = rest.startsWith('http') ? rest : `https://${rest}`;
          logI(`Navigating to ${t}...`);
          await page.goto(t, { waitUntil: 'networkidle2', timeout: 30000 });
          lastUrl = page.url();
          logS(`Loaded: ${await page.title()}`);
          break;
        }
        case 'back': { await page.goBack({ waitUntil: 'networkidle2' }); logS(`Back → ${await page.title()}`); break; }
        case 'forward': { await page.goForward({ waitUntil: 'networkidle2' }); logS(`Forward → ${await page.title()}`); break; }
        case 'reload': { await page.reload({ waitUntil: 'networkidle2' }); logS(`Reloaded`); break; }
        case 'url': { log(`  ${page.url()}`, C.green); break; }
        case 'title': { log(`  ${await page.title()}`, C.green); break; }

        // Schema / Read
        case 'scan': {
          let schema = await evalWithTimeout(page, () => AgentDOM.scan());
          // AI-enhance intents if available
          if (hasAI && schema.page.actions.length > 0) {
            logI('AI analyzing intents...');
            schema.page.actions = await aiInferIntent(schema.page.actions, schema.page.meta);
          }
          console.log(JSON.stringify(schema, null, 2));
          break;
        }
        case 'snapshot': {
          const s = await evalWithTimeout(page, () => AgentDOM.snapshot());
          console.log(JSON.stringify(s, null, 2));
          break;
        }
        case 'text': {
          const sel = rest || 'body';
          const t = await page.evaluate(s => document.querySelector(s)?.innerText?.slice(0, 3000) || 'Not found', sel);
          log(t, C.white);
          break;
        }
        case 'html': {
          const sel = rest || 'body';
          const h = await page.evaluate(s => document.querySelector(s)?.outerHTML?.slice(0, 5000) || 'Not found', sel);
          log(h, C.gray);
          break;
        }
        case 'forms': {
          const forms = await evalWithTimeout(page, () => AgentDOM.scan().page.forms);
          if (!forms.length) { logD('No forms found.'); break; }
          forms.forEach((f, i) => {
            log(`  Form ${i + 1}: ${f.id || '(no id)'}  intent: ${f.intent || '?'}  method: ${f.method}`, C.purple);
            f.fields.forEach(fd => {
              log(`    → ${fd.label || fd.name || '?'} (${fd.type}) ${fd.required ? '[REQ]' : ''} → ${fd.selector}`, C.gray);
            });
            if (f.submitButton) log(`    ⏎ "${f.submitButton.label}" → ${f.submitButton.selector}`, C.orange);
          });
          break;
        }
        case 'actions': {
          let acts = await evalWithTimeout(page, () => AgentDOM.scan().page.actions);
          if (hasAI && acts.length > 0) {
            logI('AI analyzing intents...');
            const meta = await page.evaluate(() => ({ title: document.title, url: location.href, description: document.querySelector('meta[name="description"]')?.content }));
            acts = await aiInferIntent(acts, meta);
          }
          acts.forEach(a => {
            const src = a.intentSource === 'ai' ? '🤖' : '⚡';
            const cov = a.covered ? ' ⚠️ COVERED' : '';
            log(`  ${src} [${a.intent || '—'}] "${a.label || '?'}" (${a.tag}) → ${a.selector}${cov}`, C.orange);
          });
          break;
        }
        case 'links': {
          const links = await page.evaluate(() =>
            [...document.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim().slice(0, 80), href: a.href, ext: a.hostname !== location.hostname }))
          );
          links.forEach(l => log(`  ${l.ext ? '↗' : '→'} ${l.text || '(no text)'} — ${l.href}`, l.ext ? C.orange : C.blue));
          log(`  ${links.length} links total`, C.gray);
          break;
        }

        // AI-powered commands
        case 'analyze': {
          if (!hasAI) { logE('AI not available. Set OPENROUTER_API_KEY.'); break; }
          logI('AI analyzing page...');
          const analysis = await aiAnalyzePage(page);
          console.log(JSON.stringify(analysis, null, 2));
          break;
        }

        case 'ask': {
          if (!hasAI) { logE('AI not available. Set OPENROUTER_API_KEY.'); break; }
          const pageText = await page.evaluate(() => document.body.innerText.slice(0, 4000));
          const prompt = `Page: ${await page.title()} (${page.url()})\nContent: ${pageText}\n\nQuestion: ${rest}\n\nAnswer concisely:`;
          try {
            const resp = await aiChat(prompt);
            log(`  ${resp}`, C.green);
          } catch (e) { logE(e.message); }
          break;
        }

        case 'goal': {
          if (!hasAI) { logE('AI not available. Set OPENROUTER_API_KEY.'); break; }
          if (!rest) { logE('Usage: goal "Sign up on example.com with email test@test.com"'); break; }
          await executeGoal(page, rest, handleCommand);
          break;
        }

        // Actions (with timeouts)
        case 'click': {
          logI(`Clicking ${rest}...`);
          await evalWithTimeout(page, async sel => await AgentDOM.click(sel), [rest]);
          logS(`Clicked ${rest}`);
          await page.waitForNetworkIdle({ timeout: 2000 }).catch(() => {});
          break;
        }
        case 'dblclick': {
          await evalWithTimeout(page, async sel => await AgentDOM.dblClick(sel), [rest]);
          logS(`Double-clicked ${rest}`);
          break;
        }
        case 'hover': {
          await evalWithTimeout(page, async sel => await AgentDOM.hover(sel, 800), [rest]);
          logS(`Hovered ${rest}`);
          break;
        }
        case 'type': {
          // FIX: Support both single and double quotes, and escaped quotes
          const match = rest.match(/^(\S+)\s+(?:"(.+)"|'(.+)')$/);
          if (!match) { logE('Usage: type <selector> "text" or \'text\''); break; }
          const [, sel, dq, sq] = match;
          const text = dq || sq;
          logI(`Typing into ${sel}...`);
          await evalWithTimeout(page, async (s, t) => await AgentDOM.type(s, t), [sel, text]);
          logS(`Typed "${text}" into ${sel}`);
          break;
        }
        case 'clear': {
          await page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          }, rest);
          logS(`Cleared ${rest}`);
          break;
        }
        case 'press': { await page.keyboard.press(rest); logS(`Pressed ${rest}`); break; }
        case 'select': {
          const m = rest.match(/^(\S+)\s+(?:"(.+)"|'(.+)')$/);
          if (!m) { logE('Usage: select <sel> "value"'); break; }
          await evalWithTimeout(page, async (s, v) => await AgentDOM.select(s, v), [m[1], m[2] || m[3]]);
          logS(`Selected "${m[2] || m[3]}" in ${m[1]}`);
          break;
        }
        case 'check': { await evalWithTimeout(page, async s => await AgentDOM.check(s, true), [rest]); logS(`Checked ${rest}`); break; }
        case 'uncheck': { await evalWithTimeout(page, async s => await AgentDOM.check(s, false), [rest]); logS(`Unchecked ${rest}`); break; }
        case 'fill': {
          const m = rest.match(/^(\S+)\s+(.+)$/);
          if (!m) { logE('Usage: fill <form> {"field":"value"}'); break; }
          const data = JSON.parse(m[2]);
          // Auto-fix: bare ID without # prefix
          let fsel = m[1];
          if (/^[a-zA-Z_][\w-]*$/.test(fsel) && !fsel.startsWith('#')) fsel = '#' + fsel;
          logI(`Filling form ${fsel}...`);
          await evalWithTimeout(page, async (s, d) => await AgentDOM.fillForm(s, d), [fsel, data]);
          logS(`Filled ${Object.keys(data).length} field(s)`);
          break;
        }
        case 'submit': {
          let ssel = rest;
          if (/^[a-zA-Z_][\w-]*$/.test(ssel) && !ssel.startsWith('#')) ssel = '#' + ssel;
          logI(`Submitting ${ssel}...`);
          await evalWithTimeout(page, async s => await AgentDOM.submitForm(s), [rest]);
          logS(`Submitted ${rest}`);
          await page.waitForNetworkIdle({ timeout: 3000 }).catch(() => {});
          break;
        }

        // Scroll
        case 'scroll': { await evalWithTimeout(page, async n => await AgentDOM.scroll({ by: n }), [parseInt(rest) || 500]); logS(`Scrolled ${rest || 500}px`); break; }
        case 'scrollto': { await evalWithTimeout(page, async s => await AgentDOM.scrollTo(s), [rest]); logS(`Scrolled to ${rest}`); break; }
        case 'top': { await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); logS('Top'); break; }
        case 'bottom': { await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); logS('Bottom'); break; }

        // Wait
        case 'wait': {
          const ms = parseInt(rest);
          if (ms) { await new Promise(r => setTimeout(r, ms)); logS(`Waited ${ms}ms`); }
          else { logI(`Waiting for ${rest}...`); await page.waitForSelector(rest, { visible: true, timeout: 10000 }); logS(`Found ${rest}`); }
          break;
        }
        case 'waittext': {
          logI(`Waiting for "${rest}"...`);
          await page.waitForFunction(t => document.body.textContent.includes(t), { timeout: 10000 }, rest);
          logS(`Found "${rest}"`);
          break;
        }
        case 'waitnav': {
          logI('Waiting for navigation...');
          // FIX: Also handle SPA navigations
          const currentUrl = page.url();
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
            new Promise(resolve => {
              const check = setInterval(async () => {
                if (page.url() !== currentUrl) { clearInterval(check); resolve(); }
              }, 300);
              setTimeout(() => { clearInterval(check); resolve(); }, 15000);
            }),
          ]);
          logS(`Now at: ${await page.title()}`);
          break;
        }

        // Utility
        case 'screenshot': {
          const fp = path.resolve(rest || `screenshot_${Date.now()}.png`);
          await page.screenshot({ path: fp }); logS(`Saved: ${fp}`); break;
        }
        case 'fullshot': {
          const fp = path.resolve(rest || `fullpage_${Date.now()}.png`);
          await page.screenshot({ path: fp, fullPage: true }); logS(`Saved: ${fp}`); break;
        }
        case 'eval': case 'js': {
          const r = await page.evaluate(rest);
          if (r !== undefined) { typeof r === 'object' ? console.log(JSON.stringify(r, null, 2)) : log(`  ${r}`, C.green); }
          break;
        }
        case 'run': {
          const sp = path.resolve(rest);
          if (!fs.existsSync(sp)) { logE(`File not found: ${sp}`); break; }
          const lines = fs.readFileSync(sp, 'utf-8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
          logI(`Running ${rest} (${lines.length} commands)`);
          for (const line of lines) { log(`  ${C.purple}❯${C.r} ${line}`); await handleCommand(line); }
          logS('Script done');
          break;
        }
        case 'cookies': {
          const c = await page.cookies(); console.log(JSON.stringify(c, null, 2)); break;
        }

        // Help
        case 'help': {
          console.log('');
          log('  ╭─── Navigation ───────────────────────────╮', C.green);
          logD('  goto <url> | back | forward | reload | url | title');
          log('  ╭─── Read ─────────────────────────────────╮', C.purple);
          logD('  scan | snapshot | forms | actions | links | text [sel] | html [sel]');
          log('  ╭─── AI ──────────────────────────────────╮', C.pink);
          logD('  analyze         AI analysis of the page');
          logD('  ask "question"  Ask AI about page content');
          logD('  goal "task"     Autonomous — AI completes the task');
          log('  ╭─── Act ──────────────────────────────────╮', C.orange);
          logD('  click | dblclick | hover | type <sel> "text"');
          logD('  clear | press <Key> | select <sel> "val"');
          logD('  check | uncheck | fill <form> {json} | submit');
          log('  ╭─── Scroll ──────────────────────────────╮', C.blue);
          logD('  scroll <px> | scrollto <sel> | top | bottom');
          log('  ╭─── Wait ────────────────────────────────╮', C.pink);
          logD('  wait <sel|ms> | waittext "text" | waitnav');
          log('  ╭─── Utility ─────────────────────────────╮', C.gray);
          logD('  screenshot | fullshot | eval <js> | run <file> | cookies | exit');
          console.log('');
          break;
        }

        case 'exit': case 'quit': case 'q': {
          logI('Shutting down...');
          await browser.close();
          process.exit(0);
        }

        default: logE(`Unknown: "${verb}". Type "help".`);
      }
    } catch (e) { logE(e.message); }
  }

  // ── REPL ──
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin, output: process.stdout,
      prompt: `${C.purple}❯${C.r} `, historySize: 200,
    });
    rl.prompt();
    rl.on('line', async line => { await handleCommand(line); console.log(''); rl.prompt(); });
    rl.on('close', async () => { await browser.close(); process.exit(0); });
  } else {
    const rl = readline.createInterface({ input: process.stdin });
    const cmds = [];
    rl.on('line', l => cmds.push(l.trim()));
    rl.on('close', async () => {
      for (const c of cmds) { if (c && !c.startsWith('#')) { log(`${C.purple}❯${C.r} ${c}`); await handleCommand(c); } }
      await browser.close(); process.exit(0);
    });
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
