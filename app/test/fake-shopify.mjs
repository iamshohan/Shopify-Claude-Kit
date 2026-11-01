#!/usr/bin/env node
// A stand-in for the Shopify CLI, for test/e2e.mjs. It logs every call (with any SHOPIFY_FLAG_* it was given) to
// $FAKE_SHOPIFY_DIR/calls.jsonl and mimics only the output shapes the app kit's wrapper reads.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.env.FAKE_SHOPIFY_DIR;
if (!DIR) { process.stderr.write('FAKE_SHOPIFY_DIR is not set\n'); process.exit(1); }
const VALUE_FLAGS = new Set(['path', 'config', 'store', 'query-file', 'variable-file', 'input', 'export', 'client-id']);
const words = [];
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { words.push(a); continue; }
  const name = a.slice(2);
  if (VALUE_FLAGS.has(name)) flags[name] = argv[++i]; else flags[name] = true;
}
const cmd = words.join(' ');
const leaked = Object.keys(process.env).filter((k) => k.startsWith('SHOPIFY_FLAG_'));
appendFileSync(join(DIR, 'calls.jsonl'), `${JSON.stringify({ cmd, flags, leaked, noAnalytics: process.env.SHOPIFY_CLI_NO_ANALYTICS === '1' })}\n`);
const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

if (cmd === 'version') { process.stdout.write('4.9.4\n'); process.exit(0); }
// Like the real CLI: --config <name> means shopify.app.<name>.toml in the app folder (found upward from --path).
if (flags.config) {
  let dir = flags.path;
  while (dir && !existsSync(join(dir, 'shopify.app.toml')) && join(dir, '..') !== dir) dir = join(dir, '..');
  if (!existsSync(join(dir, `shopify.app.${flags.config}.toml`))) { process.stderr.write(`Couldn't find shopify.app.${flags.config}.toml\n`); process.exit(1); }
}
if (flags.help) {
  // Every flag the wrapper's contract looks for, so cli-check passes.
  process.stdout.write('FLAGS\n  --json\n  --no-input\n  --path=<value>\n  --input=<value>\n  --export=<value>\n  --store=<value>\n  --query-file=<value>\n  --variable-file=<value>\n  --skip-instructions\n  --skip-dependencies-installation\n');
  process.exit(0);
}
switch (cmd) {
  case 'app config validate': out({ valid: true, issues: [] }); break;
  case 'app build': process.stdout.write('Build complete\n'); break;
  case 'app function build': process.stdout.write('Function built\n'); break;
  case 'app function run': {
    const input = JSON.parse(readFileSync(flags.input, 'utf8'));
    // A crashing Function, as CLI 4.9.4 prints it: the result with the Function's log, then an error line.
    if (input.crash) {
      out({ name: 'function.wasm', size: 2, memory_usage: 1280, instructions: 99, logs: 'Error: boom in run\n    at run (function.mjs:3:1)', input, output: {}, success: false });
      process.stdout.write('{"error":{"type":"external","message":"Command failed with exit code 1"}}\n');
      process.exit(1);
    }
    // FAKE_SHAPE_CHANGED: a CLI whose JSON no longer has the fields the kit reads.
    if (process.env.FAKE_SHAPE_CHANGED) { out({ result: { operations: [] }, stats: { fuel: 1 } }); break; }
    // A cart over 50 gets the gift; the fixtures' expected output follows the same rule, with its keys in another order.
    const total = Number(input?.cart?.cost?.subtotalAmount?.amount || 0);
    out({ name: 'function.wasm', size: 2, memory_usage: 1280, instructions: 123456, logs: '', input, output: { operations: total >= 50 ? [{ add: 'gift', quantity: 1 }] : [] }, success: true });
    break;
  }
  case 'app security check': {
    // FAKE_SECURITY_BROKEN: the check fails before writing results (no login, a CLI error).
    if (process.env.FAKE_SECURITY_BROKEN) { process.stderr.write('Error: security check could not start\n'); process.exit(1); }
    const d = join(flags.path, '.shopify', 'app-security', 'shopify.app');
    mkdirSync(d, { recursive: true });
    // The real shape (CLI 4.9.4): findings nested per check, severities in agent-checks.json.
    const planted = process.env.FAKE_SECURITY_FINDING ? [{ location: { file: 'app/routes/api.open.jsx' }, message: 'Endpoint without authentication', fix: { description: 'authenticate it' } }] : [];
    writeFileSync(join(d, 'deterministic-findings.json'), JSON.stringify({ schema_version: 1, engine: { name: 'fake', version: '1' }, checks: [
      { id: 'MISSING_COMPLIANCE_WEBHOOKS', status: 'executed', findings: [{ location: { file: 'shopify.app.toml' }, message: 'Missing mandatory compliance webhooks.', fix: { description: 'add them' } }] },
      { id: 'UNAUTHENTICATED_ENDPOINT', status: 'executed', findings: planted },
      { id: 'UNSAFE_INNERHTML', status: 'unresolved', reason: { code: 'unsupported_framework' }, findings: [] },
    ] }));
    writeFileSync(join(d, 'agent-checks.json'), JSON.stringify({ checks: [{ id: 'MISSING_COMPLIANCE_WEBHOOKS', severity: 'medium' }, { id: 'UNAUTHENTICATED_ENDPOINT', severity: 'high' }] }));
    process.stdout.write('Security check complete\n');
    break;
  }
  case 'app info': {
    // The real shape (CLI 4.9.4), with a planted .env and web env: the wrapper must never print either.
    out({
      remoteApp: process.env.FAKE_SHAPE_CHANGED ? { title: 'E2E Gift', apiKey: 'e2e', scopes: 'read_products' } : { title: 'E2E Gift', apiKey: 'e2e', grantedScopes: ['read_products'] }, account: { email: 'dev@example.invalid' },
      project: { directory: flags.path, appConfigFiles: [{ path: 'shopify.app.toml', content: { name: 'E2E Gift', client_id: 'e2e', embedded: true, access_scopes: { scopes: 'read_products,write_cart_transforms' } } }],
        extensionConfigFiles: [{ path: 'extensions/gift/shopify.extension.toml', content: { api_version: '2026-07', extensions: [{ handle: 'gift', type: 'function' }] } }],
        dotenvFiles: [{ path: '.env', content: 'SHOPIFY_API_SECRET=PLANTED-SECRET-123' }] },
      _hiddenConfig: { dev_store_url: 'kit-dev.myshopify.com' }, webEnv: 'SHOPIFY_API_SECRET=PLANTED-SECRET-123',
    });
    break;
  }
  case 'app execute': {
    const q = readFileSync(flags['query-file'], 'utf8');
    out({ data: /mutation/.test(q) ? { cartTransformCreate: { cartTransform: { id: 'gid://shopify/CartTransform/1' }, userErrors: [] } } : { shop: { name: 'Dev' } } });
    break;
  }
  default:
    process.stderr.write(`fake shopify: unsupported "${cmd}"\n`);
    process.exit(1);
}

