# Contributing to AgentDOM

Thank you for your interest in contributing! AgentDOM is a protocol for AI agents — contributions that expand the polyfill registry, improve reliability, or sharpen the developer experience are most welcome.

## Ways to contribute

| Type | Examples |
|---|---|
| **Polyfill manifests** | Add `.well-known/agentdom.json` for a new provider |
| **Bug fixes** | Fix dispatch failures, auth edge cases |
| **Protocol improvements** | Extend `agent_tokens`, improve transport selection |
| **Documentation** | Improve docs at getagentdom.com |
| **Tests** | Add test coverage for new providers or flows |

## Getting started

```bash
git clone https://github.com/RagavRida/agentdom
cd agentdom
npm install
npm test
```

## Running tests locally

The full suite runs via `npm test`. The Phase 7 CI pipeline runs a specific
test list — to mirror CI exactly:

```bash
node --test \
  test/core.test.js \
  test/wallet-auth.test.js \
  test/transport-perf.test.js \
  test/platform-bridge.test.js \
  test/runtime-gaps.test.js \
  test/cli-packaging.test.js \
  test/distribution.test.js
```

Validate the bundled manifests:

```bash
node tools/validate-manifest.js --all
```

## Adding a new CLI command

CLI subcommands live in `commands/` and are wired up in `bin/agentdom.js`
via `registerCommands(program)`. To add a command:

1. Create `commands/<name>.js` exporting a `run(argv)` (or `run(target)`)
   function. Use `'use strict'`, JSDoc, and CJS — no ESM imports.
2. Register it inside `registerCommands` in `bin/agentdom.js`:

   ```js
   program
     .command('<name> [arg]')
     .description('...')
     .action(async (arg, opts) => {
       const cmd = require(path.join(ROOT, 'commands/<name>.js'));
       await cmd.run(arg);
     });
   ```

3. Add a registration assertion in `test/cli-packaging.test.js`.

## Branch naming

| Prefix | Purpose                             |
| ------ | ----------------------------------- |
| `feat/` | New feature                        |
| `fix/`  | Bug fix                            |
| `docs/` | Documentation only                 |
| `test/` | Tests only                         |
| `chore/`| Build / tooling                    |

Example: `feat/mcp-config-generator`, `fix/keytar-postinstall`.

## Adding a polyfill manifest

The fastest way to contribute is adding a provider to the polyfill registry.

1. **Generate from OpenAPI spec:**
   ```bash
   node tools/gen-manifest.js \
     --openapi=https://api.example.com/openapi.json \
     --host=api.example.com
   ```

2. **Or create manually** in `manifests/api.example.com.json`:
   ```json
   {
     "version": "1.0",
     "host": "api.example.com",
     "auth": { "method": "api_key", "key_header": "Authorization" },
     "capabilities": [{
       "intent": "contacts.create",
       "transport": "api",
       "method": "POST",
       "endpoint": "https://api.example.com/contacts",
       "side_effects": ["external"]
     }]
   }
   ```

3. **Add the Agent Token Protocol** if the provider supports token issuance:
   ```json
   "agent_tokens": {
     "issue": "POST https://api.example.com/agent-tokens",
     "scopes": ["read", "write"]
   }
   ```

4. **Test it:**
   ```bash
   node -e "const m = require('./manifests/api.example.com.json'); console.log(m.capabilities.length)"
   ```

## Code style

- **CJS only** — use `require`/`module.exports`, not `import`/`export`
- Use `.mjs` extension for ESM-only utilities
- No external runtime dependencies in `lib/` or `commands/`
- All errors must include an actionable `hint` for the agent

## Pull request checklist

- [ ] All tests pass (`npm test`)
- [ ] Manifests validate (`node tools/validate-manifest.js --all`)
- [ ] No stray `console.log` left in `lib/`, `commands/`, or `compiler/`
- [ ] Commit message follows convention: `feat(manifest): add example.com polyfill`
- [ ] Added provider to README.md providers table if applicable
- [ ] Branch is named with a `feat/`, `fix/`, `docs/`, `test/`, or `chore/` prefix

## Commit convention

```
feat(scope): description
fix(scope): description
docs(scope): description
test(scope): description
```

Scopes: `auth`, `wallet`, `dispatch`, `protocol`, `mcp`, `cli`, `docs`, `manifest`, `test`

## Reporting issues

Use [GitHub Issues](https://github.com/RagavRida/agentdom/issues).

For security vulnerabilities, see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
