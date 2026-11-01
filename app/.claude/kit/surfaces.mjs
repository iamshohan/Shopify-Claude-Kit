// Surfaces: what an app exposes to Shopify, merchants and its own database, read from its config files.
// Scopes, webhooks, app proxy, custom data definitions, extensions (targets, capabilities), Prisma models, dependencies.
// Each surface is one item "kind:name" with a value, so two readings (a base commit and the working tree) diff cleanly.
// The proposal declares every surface a change adds, removes or changes; verify compares that with this diff.
//   node .claude/kit/surfaces.mjs [--selftest]       prints the working tree's items
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToml } from './toml.mjs';
import { run } from './core.mjs';

// ── Readers ──
// A reader answers read(path) → text|null and list(dir) → names, for the working tree or a commit.

export function treeReader(root) {
  return {
    read: (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } },
    list: (dir) => { try { return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } },
    files: (dir) => { try { return readdirSync(join(root, dir), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; } },
  };
}

export function gitReader(root, rev) {
  return {
    read: (p) => { const r = run('git', ['show', `${rev}:${p}`], { cwd: root }); return r.code === 0 ? r.stdout : null; },
    list: (dir) => {
      const r = run('git', ['ls-tree', '--name-only', '-d', `${rev}:${dir}`], { cwd: root });
      return r.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
    },
    files: (dir) => {
      const r = run('git', ['ls-tree', `${rev}:${dir}`], { cwd: root });
      return r.code === 0 ? r.stdout.split(/\r?\n/).filter((l) => /\sblob\s/.test(l)).map((l) => l.split('\t')[1]) : [];
    },
  };
}

// ── Reading the surfaces ──

// Scopes that reach protected customer data: a public app needs Shopify's approval, and every merchant sees them.
export const PCD_SCOPE = /(^|_)(customers?|orders|all_orders|customer_[a-z_]+|draft_orders|checkouts)$/;
// App config keys whose change matters beyond the code: which app this is, where it runs, how it authenticates.
const CONFIG_KEYS = ['client_id', 'embedded', 'application_url', 'auth.redirect_urls', 'access', 'pos.embedded', 'app_preferences'];

/** JSON with object keys sorted: two values equal regardless of key order compare equal as text. */
export const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const at = (obj, path) => path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/** Extension folders: the app config's extension_directories (folder/* patterns), default extensions/*. */
function extensionDirs(cfg, reader) {
  const patterns = Array.isArray(cfg?.extension_directories) ? cfg.extension_directories : ['extensions/*'];
  const out = [];
  for (const p of patterns) {
    const m = String(p).replace(/\\/g, '/').match(/^(.*?)\/?\*+$/);
    if (!m) continue;
    for (const name of reader.list(m[1])) out.push(`${m[1]}/${name}`);
  }
  return [...new Set(out)].sort();
}

/** Models and enums from a Prisma schema: one item each, valued by its normalised body. */
export function prismaItems(text) {
  const items = {};
  if (!text) return items;
  const provider = text.match(/datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/);
  if (provider) items['db:provider'] = provider[1];
  for (const m of text.matchAll(/^\s*(model|enum|view|type)\s+(\w+)\s*\{([\s\S]*?)^\s*\}/gm)) {
    // A // inside a string (@default("https://…")) is part of the value, not a comment.
    const body = m[3].split(/\r?\n/).map((l) => l.replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/g, (x, str) => str || '').trim().replace(/\s+/g, ' ')).filter(Boolean).join('; ');
    items[`${m[1] === 'model' ? 'model' : m[1]}:${m[2]}`] = body;
  }
  return items;
}

/**
 * The Prisma schema as one text: package.json "prisma.schema" (a file or a folder), else prisma/schema.prisma, else the
 * multi-file prisma/schema/*.prisma. A model in a file the kit doesn't read would be invisible to propose, verify and drift.
 */
function prismaSchema(reader) {
  let configured = null;
  try { configured = JSON.parse(reader.read('package.json') || '{}')?.prisma?.schema || null; } catch { /* reported with the dependencies */ }
  const folder = (dir) => (reader.files?.(dir) || []).filter((f) => f.endsWith('.prisma')).sort().map((f) => reader.read(`${dir}/${f}`) || '').join('\n') || null;
  const at = (p) => { const clean = String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''); return /\.prisma$/.test(clean) ? reader.read(clean) : folder(clean); };
  return (configured && at(configured)) || reader.read('prisma/schema.prisma') || folder('prisma/schema');
}

/** Every surface item of the app at one reading. configName: the app config file (shopify.app.toml or shopify.app.<name>.toml). */
export function readItems(reader, { configName = 'shopify.app.toml' } = {}) {
  const items = {};
  const problems = [];
  const parse = (p) => {
    const text = reader.read(p);
    if (text === null) return null;
    try { return parseToml(text); } catch (e) { problems.push(`${p}: ${e.message}`); return null; }
  };
  const cfg = parse(configName);
  if (!cfg) problems.push(`${configName} is missing or unreadable`);
  else {
    for (const s of splitList(cfg.access_scopes?.scopes)) items[`scope:${s}`] = '';
    for (const s of splitList(cfg.access_scopes?.optional_scopes)) items[`optional-scope:${s}`] = '';
    if (cfg.access_scopes?.use_legacy_install_flow !== undefined) items['config:access_scopes.use_legacy_install_flow'] = String(cfg.access_scopes.use_legacy_install_flow);
    if (cfg.webhooks?.api_version) items['webhooks:api_version'] = cfg.webhooks.api_version;
    // A topic can have several subscriptions (another uri, a filter): a second one is a change, not a no-op.
    const subs = {};
    for (const sub of cfg.webhooks?.subscriptions || []) {
      const detail = stable({ uri: sub.uri, filter: sub.filter, include_fields: sub.include_fields });
      for (const t of sub.topics || []) (subs[`webhook:${t}`] ||= []).push(detail);
      for (const t of sub.compliance_topics || []) (subs[`compliance-webhook:${t}`] ||= []).push(detail);
    }
    // One subscription keeps the value onboarded repos already recorded.
    for (const [k, list] of Object.entries(subs)) items[k] = list.length === 1 ? list[0] : stable([...new Set(list)].sort());
    if (cfg.app_proxy) items['app-proxy'] = `${cfg.app_proxy.prefix}/${cfg.app_proxy.subpath} -> ${cfg.app_proxy.url}`;
    for (const k of CONFIG_KEYS) if (at(cfg, k) !== undefined) items[`config:${k}`] = stable(at(cfg, k));
    // Custom data declared in the config: [metaobjects.app.<type>] and [<owner>.metafields.<ns>.<key>].
    for (const [ns, types] of Object.entries(cfg.metaobjects || {})) for (const [type, def] of Object.entries(types || {})) items[`metaobject:${ns}.${type}`] = stable(def);
    for (const [owner, v] of Object.entries(cfg)) {
      if (!v || typeof v !== 'object' || !v.metafields || owner === 'metaobjects') continue;
      for (const [ns, keys] of Object.entries(v.metafields)) for (const [key, def] of Object.entries(keys || {})) items[`metafield:${owner}.${ns}.${key}`] = stable(def);
    }
  }
  for (const dir of extensionDirs(cfg, reader)) {
    const ext = parse(`${dir}/shopify.extension.toml`);
    if (!ext) continue;
    // Older configs describe one extension at the top level; current ones list them under [[extensions]].
    const list = Array.isArray(ext.extensions) ? ext.extensions : [ext];
    for (const e of list) {
      const h = e.handle || dir.split('/').pop();
      items[`extension:${h}`] = `${e.type || ext.type || '?'} in ${dir}`;
      if (e.api_version || ext.api_version) items[`extension-api:${h}`] = e.api_version || ext.api_version;
      for (const t of e.targeting || []) items[`target:${h}/${t.target}`] = t.module || t.export || '';
      for (const [k, v] of Object.entries(e.capabilities || ext.capabilities || {})) items[`capability:${h}/${k}`] = stable(v);
      for (const m of e.metafields || ext.metafields || []) items[`extension-metafield:${h}/${m.namespace}.${m.key}`] = '';
      for (const t of e.targeting || []) for (const m of t.metafields || []) items[`extension-metafield:${h}/${m.namespace}.${m.key}`] = '';
    }
  }
  Object.assign(items, prismaItems(prismaSchema(reader)));
  for (const dir of ['', ...extensionDirs(cfg, reader)]) {
    const text = reader.read(dir ? `${dir}/package.json` : 'package.json');
    if (!text) continue;
    try {
      const pkg = JSON.parse(text);
      for (const [n, v] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) items[`dependency:${dir ? `${dir}:` : ''}${n}`] = String(v);
    } catch { problems.push(`${dir || '.'}/package.json isn't valid JSON`); }
  }
  return { items: Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b))), problems };
}

// ── Diff and attention ──

/** What changed from a to b: [{ op: '+'|'-'|'~', key, from, to }], sorted by key. */
export function diffItems(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push({ op: '+', key: k, to: b[k] });
    else if (!(k in b)) out.push({ op: '-', key: k, from: a[k] });
    else if (a[k] !== b[k]) out.push({ op: '~', key: k, from: a[k], to: b[k] });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

const kindOf = (key) => key.split(':')[0];
const nameOf = (key) => key.slice(key.indexOf(':') + 1);

/**
 * Why a surface change needs the dev's attention at Gate 1, or null. Dependency version bumps return null:
 * maintenance changes those often, and the lockfile review covers them.
 */
export function attentionFor({ op, key, to }) {
  const k = kindOf(key);
  const n = nameOf(key);
  if (k === 'scope') {
    const pcd = PCD_SCOPE.test(n) ? ' This scope reaches protected customer data: request access in the Partner Dashboard, and the data-protection rules apply.' : '';
    return op === '+' ? `new access scope ${n}: each installed store approves it when a merchant next opens the app; until then the app runs with its old scopes.${pcd}` : `scope ${n} removed: code that still needs it will fail.`;
  }
  if (k === 'optional-scope') return `optional scope ${n} ${op === '+' ? 'added' : op === '-' ? 'removed' : 'changed'}`;
  if (k === 'webhook' || k === 'compliance-webhook') return `webhook ${n} ${op === '+' ? 'added: the app receives this data from every store' : op === '-' ? 'removed' : 'changed (address or filter)'}`;
  if (k === 'webhooks') return `webhook API version ${op === '~' ? 'changed' : op === '+' ? 'set' : 'removed'}: payload shapes can change`;
  if (k === 'app-proxy') return `app proxy ${op === '+' ? 'added: the app answers requests on the storefront' : op === '-' ? 'removed' : 'changed'}`;
  if (k === 'config') return `app config ${n} changed${n === 'client_id' ? ': the repo now points at a different app' : ''}`;
  if (k === 'metaobject' || k === 'metafield') return `${k} definition ${n} ${op === '+' ? 'added' : op === '-' ? 'removed (merchant data on it can be lost)' : 'changed'}: merchant-facing data changes on deploy`;
  if (k === 'extension') return `extension ${n} ${op === '+' ? 'added' : op === '-' ? 'removed: merchants lose it on the next release' : 'changed type or folder'}`;
  if (k === 'extension-api') return `extension ${n} ${op === '-' ? 'no longer pins an API version' : `moves to API version ${to || '(new)'}`}: check the changelog for breaking changes`;
  if (k === 'target') return `extension target ${n} ${op === '+' ? 'added' : op === '-' ? 'removed (placed blocks on it disappear)' : 'changed module'}`;
  if (k === 'capability') {
    const cap = n.split('/').pop();
    const why = { network_access: 'the extension may call external servers (needs approval in the Partner Dashboard)', block_progress: 'the extension may block checkout progress', api_access: 'the extension may query the Storefront API', collect_buyer_consent: 'the extension collects buyer consent' }[cap];
    return `capability ${n} ${op === '-' ? 'removed' : `${op === '+' ? 'added' : 'changed'}${why ? `: ${why}` : ''}`}`;
  }
  if (k === 'extension-metafield') return null;
  if (['model', 'enum', 'view', 'type', 'db'].includes(k)) return `database ${k} ${n} ${op === '+' ? 'added' : op === '-' ? 'removed (its data goes with it)' : 'changed'}: needs a migration, and the deploy order matters`;
  if (k === 'dependency') return op === '+' ? `new dependency ${n}: check its licence, maintenance and what it can reach` : null;
  return `${key} ${op}`;
}

// ── The committed snapshot ──
// appspec/surfaces.json: the items as of the last archive, plus why each one exists when a change said so.

export function readSnapshot(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * surfaces.json's text: one item per line, sorted, so two changes archiving in parallel touch different lines where
 * they can. items: { key: { value, why?, scenario?, since? } }.
 */
export function snapshotText(items) {
  const keys = Object.keys(items).sort();
  return ['{', '  "note": "Written by the app kit at onboard and archive. Edit through a change.",', '  "items": {',
    ...keys.map((k, i) => `    ${JSON.stringify(k)}: ${JSON.stringify(items[k])}${i < keys.length - 1 ? ',' : ''}`), '  }', '}', ''].join('\n');
}

/** The extensions among the items: [{ handle, type, dir }], dir relative to the repo root with forward slashes. */
export const extensionList = (items) => Object.entries(items).filter(([k]) => k.startsWith('extension:'))
  .map(([k, v]) => ({ handle: k.slice('extension:'.length), type: String(v).split(' in ')[0], dir: String(v).split(' in ')[1] || '' }));

// ── Self-test ──

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), got, want]);
  const files = {
    'shopify.app.toml': 'client_id = "abc"\nembedded = true\n[access_scopes]\nscopes = "read_products, write_orders"\n[webhooks]\napi_version = "2026-07"\n  [[webhooks.subscriptions]]\n  uri = "/webhooks/app/uninstalled"\n  topics = [ "app/uninstalled" ]\n  [[webhooks.subscriptions]]\n  compliance_topics = ["customers/redact"]\n  uri = "/webhooks/gdpr"\n[app_proxy]\nurl = "/proxy"\nprefix = "apps"\nsubpath = "x"\n[metaobjects.app.faq]\nname = "FAQ"\n[product.metafields.app.faq]\ntype = "json"\n',
    'extensions/gift/shopify.extension.toml': 'api_version = "2026-07"\n[[extensions]]\nhandle = "gift"\ntype = "function"\n  [[extensions.targeting]]\n  target = "cart.transform.run"\n  export = "run"\n',
    'extensions/banner/shopify.extension.toml': 'api_version = "2026-07"\n[[extensions]]\nhandle = "banner"\ntype = "ui_extension"\n[[extensions.targeting]]\nmodule = "./src/Checkout.jsx"\ntarget = "purchase.checkout.block.render"\n[extensions.capabilities]\nnetwork_access = true\n',
    'prisma/schema.prisma': 'datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}\nmodel Session {\n  id String @id // the session id\n  shop   String\n}\n',
    'package.json': '{"dependencies":{"react":"^18.0.0"}}',
  };
  const reader = { read: (p) => files[p] ?? null, list: (d) => (d === 'extensions' ? ['banner', 'gift'] : []) };
  const { items, problems } = readItems(reader);
  eq('no problems', problems, []);
  eq('item keys', Object.keys(items), [
    'app-proxy', 'capability:banner/network_access', 'compliance-webhook:customers/redact', 'config:client_id', 'config:embedded', 'db:provider', 'dependency:react',
    'extension-api:banner', 'extension-api:gift', 'extension:banner', 'extension:gift', 'metafield:product.app.faq', 'metaobject:app.faq', 'model:Session',
    'scope:read_products', 'scope:write_orders', 'target:banner/purchase.checkout.block.render', 'target:gift/cart.transform.run', 'webhook:app/uninstalled', 'webhooks:api_version',
  ]);
  eq('model body ignores comments and spacing', items['model:Session'], 'id String @id; shop String');
  const changed = { ...items, 'scope:read_customers': '', 'model:Session': 'id String @id; shop String; email String?' };
  delete changed['webhook:app/uninstalled'];
  eq('diff', diffItems(items, changed).map((d) => `${d.op}${d.key}`), ['~model:Session', '+scope:read_customers', '-webhook:app/uninstalled']);
  eq('PCD scope flagged', /protected customer data/.test(attentionFor({ op: '+', key: 'scope:read_customers' })), true);
  eq('ordinary scope not flagged as PCD', /protected customer data/.test(attentionFor({ op: '+', key: 'scope:read_products' })), false);
  eq('dependency bump needs no attention', attentionFor({ op: '~', key: 'dependency:react' }), null);
  eq('network access explained', /external servers/.test(attentionFor({ op: '+', key: 'capability:banner/network_access' })), true);
  eq('the snapshot is valid JSON with one item per line', [JSON.parse(snapshotText({ b: { value: '1' }, a: { value: '', why: 'x' } })).items, snapshotText({ b: { value: '1' }, a: { value: '' } }).split('\n').filter((l) => /^ {4}"/.test(l)).length],
    [{ a: { value: '', why: 'x' }, b: { value: '1' } }, 2]);
  eq('extensions with their folders', extensionList(items).map((e) => `${e.handle} ${e.type} ${e.dir}`), ['banner ui_extension extensions/banner', 'gift function extensions/gift']);
  const custom = readItems({ read: (p) => ({ 'shopify.app.toml': 'client_id = "a"\nextension_directories = ["functions/*"]', 'functions/fee/shopify.extension.toml': '[[extensions]]\nhandle = "fee"\ntype = "function"' })[p] ?? null, list: (d) => (d === 'functions' ? ['fee'] : []) });
  eq('extension_directories are read', extensionList(custom.items).map((e) => e.dir), ['functions/fee']);
  const twoSubs = readItems({ read: (p) => (p === 'shopify.app.toml' ? ['client_id = "a"', '[webhooks]', 'api_version = "2026-07"', '[[webhooks.subscriptions]]', 'uri = "/w"', 'topics = ["orders/create"]', '[[webhooks.subscriptions]]', 'uri = "https://elsewhere.example/c"', 'topics = ["orders/create"]'].join('\n') : null), list: () => [] });
  eq('a second subscription to a topic changes the item', diffItems({ 'webhook:orders/create': stable({ uri: '/w' }) }, { 'webhook:orders/create': twoSubs.items['webhook:orders/create'] }).map((d) => d.op + d.key), ['~webhook:orders/create']);
  eq('// inside a Prisma string is part of the value', prismaItems(['model Shop {', '  url String @default("https://a.example") // note', '}'].join('\n'))['model:Shop'], 'url String @default("https://a.example")');
  const multi = { 'shopify.app.toml': 'client_id = "a"', 'prisma/schema/base.prisma': ['model A {', '  id Int @id', '}'].join('\n'), 'prisma/schema/more.prisma': ['model B {', '  id Int @id', '}'].join('\n') };
  eq('a multi-file Prisma schema is read whole', Object.keys(readItems({ read: (p) => multi[p] ?? null, list: () => [], files: (d) => (d === 'prisma/schema' ? ['base.prisma', 'more.prisma'] : []) }).items).filter((k) => k.startsWith('model:')), ['model:A', 'model:B']);
  eq('missing config is a problem', readItems({ read: () => null, list: () => [] }).problems.length, 1);
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain && process.argv.includes('--selftest')) selftest();
else if (isMain) {
  const root = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
  console.log(JSON.stringify(readItems(treeReader(root)), null, 2));
}
