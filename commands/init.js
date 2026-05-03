/**
 * `agentdom init [dir]` — scaffold a starter project.
 *
 * Lays down package.json + index.js + README.md + .gitignore in `dir` (default
 * cwd). Refuses to overwrite existing files unless `--force` is passed.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const C = {
  green: '\x1b[32m', red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m', r: '\x1b[0m',
};
const ok   = m => process.stdout.write(`  ${C.green}✓${C.r} ${m}\n`);
const fail = m => process.stderr.write(`  ${C.red}✗${C.r} ${m}\n`);
const info = m => process.stdout.write(`  ${C.cyan}→${C.r} ${m}\n`);
const dim  = m => process.stdout.write(`  ${C.gray}${m}${C.r}\n`);

const PKG_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

const TEMPLATES = {
  'package.json': ({ name }) => JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'commonjs',
    scripts: {
      start: 'node index.js',
    },
    dependencies: {
      agentdom: `^${PKG_VERSION}`,
    },
  }, null, 2) + '\n',

  'index.js': () => `// AgentDOM starter — scans a desktop app and prints typed agent tools.
//
// Run:
//   1. Open the target app (e.g. Finder, Calculator).
//   2. Grant Accessibility permission to your terminal:
//      System Settings > Privacy & Security > Accessibility
//   3. node index.js [AppName]   (default: Finder)

const desktop = require('agentdom/desktop-agent');
const { compile } = require('agentdom/compiler');

const APP = process.argv[2] || 'Finder';

const perm = desktop.checkPermissions();
if (!perm.ok) {
  console.error('Permission needed:', perm.hint);
  process.exit(1);
}
if (!desktop.isRunning(APP)) {
  console.error(\`"\${APP}" is not running. Open it first or pass another app name.\`);
  process.exit(1);
}

const elements = desktop.scanApp(APP);
if (elements.error) {
  console.error('Scan failed:', elements.error, elements.hint || '');
  process.exit(1);
}

const { ir, tools } = compile(elements, { from: 'desktop', to: 'openai', appName: APP });

console.log(\`\\nScanned \${APP}: \${ir.actions.length} actions, \${ir.forms.length} forms, \${ir.navigation.length} navigation items.\\n\`);
console.log(\`Generated \${tools.length} agent tools:\`);
for (const t of tools) {
  const params = Object.keys(t.function.parameters.properties || {});
  console.log(\`  - \${t.function.name}\${params.length ? '(' + params.join(', ') + ')' : '()'}\`);
}
console.log(\`\\nFeed \\\`tools\\\` directly to an OpenAI / Anthropic / Claude function-calling request.\`);
`,

  'README.md': ({ name }) => `# ${name}

Scaffolded by \`agentdom init\`. Compiles a running desktop app into typed agent tools.

## Quickstart

\`\`\`bash
npm install
node index.js [AppName]    # default: Finder
\`\`\`

## What this shows

\`scanApp\` walks the macOS Accessibility tree (or Windows UI Automation tree)
and \`compile\` turns it into an OpenAI-compatible tool list — no API keys, no
selectors, no integration code per app.

## Next steps

- Swap \`to: 'openai'\` for \`to: 'mcp'\` to emit MCP tools for Claude Desktop / Cursor.
- Try \`{ from: 'cli' }\` with the output of \`<binary> --help\`.
- Try \`{ from: 'api' }\` with a parsed OpenAPI spec.
- See https://getagentdom.com for full docs.
`,

  '.gitignore': () => `node_modules/
.env
*.log
.DS_Store
`,
};

function isEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  const entries = fs.readdirSync(dir).filter(n => n !== '.git' && n !== '.DS_Store');
  return entries.length === 0;
}

function parseArgs(argv) {
  const flags = { force: argv.includes('--force') };
  const positional = argv.filter(a => !a.startsWith('--'));
  return { dir: positional[0] || '.', flags };
}

function run(argv = []) {
  const { dir, flags } = parseArgs(argv);
  const target = path.resolve(dir);
  const projectName = path.basename(target).replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'agentdom-project';

  info(`Scaffolding "${projectName}" in ${target}`);

  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
    ok(`Created ${dir}/`);
  } else if (!isEmpty(target) && !flags.force) {
    fail(`Target ${dir} is not empty. Pass --force to overwrite.`);
    process.exit(1);
  }

  let written = 0;
  for (const [filename, render] of Object.entries(TEMPLATES)) {
    const filePath = path.join(target, filename);
    if (fs.existsSync(filePath) && !flags.force) {
      dim(`skip   ${filename} (exists)`);
      continue;
    }
    fs.writeFileSync(filePath, render({ name: projectName }), 'utf-8');
    ok(`wrote  ${filename}`);
    written++;
  }

  if (written === 0) {
    dim('Nothing to do.');
    return;
  }

  process.stdout.write('\n');
  info('Next steps:');
  if (dir !== '.') process.stdout.write(`    cd ${dir}\n`);
  process.stdout.write('    npm install\n');
  process.stdout.write('    node index.js\n\n');
}

module.exports = { run, TEMPLATES };
