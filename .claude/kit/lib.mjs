// Shared helpers for the kit scripts (kit.mjs, shopify.mjs, jira.mjs, ...) and hooks/guard.mjs.
// Zero dependencies, so the kit runs in any theme repo.
// Reads .claude/shopify-kit.json, .claude/VERSION and secrets; writes only .claude/logs/<KEY>/state.json.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, tmpdir } from 'node:os';

// ── Paths and theme files ──
// Located from this file, not from cwd: commands may run from a subfolder.
export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_DIR = resolve(KIT_DIR, '..');
export const ROOT = resolve(CLAUDE_DIR, '..');
export const LOGS = join(CLAUDE_DIR, 'logs');
export const CONFIG_PATH = join(CLAUDE_DIR, 'shopify-kit.json');
const VERSION = readFileSync(join(CLAUDE_DIR, 'VERSION'), 'utf8').trim();
/** The build: VERSION stays put between releases, so add the kit commit the installer recorded. The kit's own repo has no manifest. */
export const KIT_VERSION = (() => {
  try {
    const m = JSON.parse(readFileSync(join(CLAUDE_DIR, '.kit-manifest.json'), 'utf8'));
    return m.commit ? `${VERSION}+${String(m.commit).slice(0, 7)}${m.uncommitted ? '-dirty' : ''}` : VERSION;
  } catch { return VERSION; }
})();
export const WIN = process.platform === 'win32';

export const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
/** The CLI's --only takes the next argument even when it starts with -, so only theme paths reach it. */
export const isThemePath = (p) => new RegExp(`^(${THEME_DIRS.join('|')})/.`).test(p) && !p.split('/').includes('..');
/** Paths Shopify stores: one level deep, except templates/customers and templates/metaobject. assets/src/… (a build's source) isn't one. */
export const isStorable = (p) => /^(assets|blocks|config|layout|locales|sections|snippets|templates|templates\/customers|templates\/metaobject)\/[^/]+$/.test(p);
// Files Shopify rewrites when someone saves in the admin (and syncs into git on GitHub-connected themes).
export const MERCHANT_JSON = /^(templates\/.+\.json|sections\/[^/]+\.json|config\/settings_data\.json)$/i;

// ── Pipeline stages ──
// Source of truth for the pipeline. Human-readable copy: README.md.
export const STAGES = [
  { name: 'intake', skill: 'shopify-intake' },
  { name: 'analyze', skill: 'shopify-intake' },
  { name: 'plan', skill: 'shopify-plan' },
  { name: 'approve', skill: 'shopify-plan', gate: 'Gate 1: the dev approves the plan' },
  { name: 'build', skill: 'shopify-build' },
  { name: 'draft', skill: 'shopify-build' },
  { name: 'qa', skill: 'shopify-qa' },
  { name: 'accept', skill: 'shopify-qa', gate: 'Gate 2: the dev accepts the QA result' },
  { name: 'handoff', skill: 'shopify-handoff' },
];

// /shopify-investigate: read-only, ends in an answer instead of a draft theme.
// The guard knows the gate by its name, so it stays "conclude".
export const INVESTIGATION_STAGES = [
  { name: 'gather', skill: 'shopify-investigation' },
  { name: 'conclude', skill: 'shopify-investigation', gate: 'the dev accepts the answer or asks for more' },
];

export const stagesFor = (st) => (st?.kind === 'investigation' ? INVESTIGATION_STAGES : STAGES);

// Stages kit 1.1.0 dropped, and where a task that was in one resumes: teams have tasks in flight.
const RETIRED_STAGES = { clarify: 'plan', frame: 'gather' };

// ── Output and arguments ──

export const now = () => new Date().toISOString();

export function print(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

export function fail(message, code = 1) {
  process.stderr.write(String(message).trimEnd() + '\n');
  process.exit(code);
}

// Flags that never take a value. Any other --flag swallows the next argument unless it looks like a flag,
// so a new boolean flag must be listed here.
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'help', 'force', 'no-comments', 'selftest', 'investigate', 'live', 'github', 'none', 'all', 'adopt', 'test', 'check', 'skip-ignored']);
// A value can start with "--" too (QA measures CSS custom properties: --measured "--gap: 16px").
const looksLikeFlag = (a) => /^--[A-Za-z][\w-]*(=|$)/.test(a);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (!BOOLEAN_FLAGS.has(a.slice(2)) && i + 1 < argv.length && !looksLikeFlag(argv[i + 1])) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export function normKey(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) fail(`"${raw}" is not a Jira key (expected something like ABC-123).`);
  return key;
}

/** True if a theme name contains the key (or branch) as a whole word: ABC-12 matches "ABC-12 hero", not a teammate's "ABC-123". */
export function namesKey(name, key) {
  const esc = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${esc}(?![A-Z0-9])`, 'i').test(String(name || ''));
}

// ── Processes, git and CLI output ──

/**
 * Runs a program. Real executables are spawned directly. The Shopify CLI is a .cmd shim
 * on Windows, which Node can only start through a shell, so those arguments are quoted
 * here and characters cmd.exe would interpret are refused (as a failed run, so callers report it like any CLI error).
 */
export function run(cmd, args = [], { cwd = ROOT, env = {}, input, timeout = 600000, shell = false } = {}) {
  // The CLI reads SHOPIFY_FLAG_* as flags (SHOPIFY_FLAG_LIVE, _THEME, _STORE…): one left in the shell would retarget a call the wrapper built.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SHOPIFY_FLAG_/i.test(k)));
  const opts = { cwd, env: { ...inherited, ...env }, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 };
  let res;
  if (shell && WIN) {
    const bad = args.find((a) => /["%^&|<>!\r\n]/.test(a));
    if (bad !== undefined) return { code: 1, stdout: '', stderr: `Refusing to pass ${JSON.stringify(bad)} through cmd.exe, which reads " % ^ & | < > ! as its own syntax. Rename the file or folder without those characters, or ask the dev to run the command with the ! prefix.`, timedOut: false };
    const line = [cmd, ...args].map((a) => (a === '' || /[\s*?]/.test(a) ? `"${a}"` : a)).join(' ');
    // Otherwise cmd.exe runs a shopify.cmd from the repo root before the one on PATH.
    res = spawnSync(line, { ...opts, env: { ...opts.env, NoDefaultCurrentDirectoryInExePath: '1' }, shell: true });
  } else {
    res = spawnSync(cmd, args, opts);
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: (res.stderr || '') + (res.error ? `\n${res.error.message}` : ''),
    timedOut: res.error?.code === 'ETIMEDOUT',
  };
}

export function git(args, { allowFail = false } = {}) {
  const r = run('git', args);
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.code === 0 ? r.stdout.trim() : '';
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
}

/**
 * The commit this task's changes are measured from: where the branch (HEAD by default) meets origin/<baseBranch> now, as a
 * PR diff is. st.base is only where the branch started. Once the base branch is merged in, measuring from st.base
 * counts the merged-in work as this task's, and keeps flagging live edits the merge already brought in.
 * Once the branch itself is merged, they meet at its own tip, which leaves it no work. Then it is measured as its PR was:
 * from where the base branch stood just before the merge commit that took it in. A fast-forward merge has none: st.base.
 */
export function effectiveBase(st, cfg, head = 'HEAD') {
  const main = `origin/${cfg?.baseBranch || 'main'}`;
  const tip = git(['rev-parse', head], { allowFail: true });
  const met = git(['merge-base', head, main], { allowFail: true });
  if (met && met !== tip) return met;
  const lines = (args) => git(args, { allowFail: true }).split('\n').filter(Boolean);
  const holdsHead = new Set(lines(['rev-list', '--ancestry-path', `${head}..${main}`]));
  const merge = lines(['rev-list', '--first-parent', main, `^${head}`]).filter((c) => holdsHead.has(c)).pop();
  const before = merge && git(['merge-base', head, `${merge}^1`], { allowFail: true });
  return before && before !== tip ? before : st.base;
}

/**
 * A digest of the theme folders as the working tree has them, from git's tree ids: the same content gives the same value
 * whether it is committed or not. Built in a copy of the index (its stat cache spares re-hashing), so git's own is untouched.
 */
export function themeDigest() {
  const dirs = THEME_DIRS.filter((d) => existsSync(join(ROOT, d)));
  const tmp = mkdtempSync(join(tmpdir(), 'kit-index-'));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, 'index') };
    const index = resolve(ROOT, git(['rev-parse', '--git-path', 'index'], { allowFail: true }) || '.git/index');
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    if (run('git', ['add', '-A', '--', ...dirs], { env }).code !== 0) return null;
    const tree = run('git', ['write-tree'], { env }).stdout.trim();
    return tree ? createHash('sha256').update(run('git', ['ls-tree', tree, '--', ...dirs]).stdout).digest('hex').slice(0, 16) : null;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * The CLI can print hint lines and NDJSON progress events before the result,
 * so take the last top-level JSON value that isn't a progress event.
 */
export function parseCliJson(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      const value = JSON.parse(lines.slice(i).join('\n'));
      if (value && value.type === 'progress') continue;
      return value;
    } catch { /* not a complete value from here; keep scanning upward */ }
  }
  return null;
}

/**
 * A JSON value's structure without its values: sorted keys, and 'string', 'number', 'boolean' or 'null' for leaves.
 * An array is [item shape] with every item's keys merged, or [] when empty. cli-check records the real CLI's
 * shapes so test/fake-vs-real.mjs can compare the test fake with them, without copying store data.
 */
export function shapeOf(value, depth = 0) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return value.length && depth < 6 ? [value.map((v) => shapeOf(v, depth + 1)).reduce(mergeShapes)] : [];
  if (typeof value === 'object') return depth < 6 ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], depth + 1)])) : {};
  return typeof value;
}

// Two items of one array: null fits any type, keys are merged, and two different leaf types are 'mixed'.
function mergeShapes(a, b) {
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? [mergeShapes(a[0], b[0])] : (a.length ? a : b);
  const isObj = (s) => s && typeof s === 'object' && !Array.isArray(s);
  if (isObj(a) && isObj(b)) {
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map((k) => [k, Object.hasOwn(a, k) && Object.hasOwn(b, k) ? mergeShapes(a[k], b[k]) : (Object.hasOwn(a, k) ? a[k] : b[k])]));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? a : 'mixed';
}

/** The last diagnostic event whose message is a JSON object: where some CLI commands put their --json result. */
export function diagnosticJson(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event?.type !== 'diagnostic' || typeof event.message !== 'string') continue;
      const value = JSON.parse(event.message);
      if (value && typeof value === 'object') return value;
    } catch { /* not a JSON event */ }
  }
  return null;
}

// ── Secrets, config and names ──

// KEY=value lines, with an optional export prefix and matching quotes. No escapes or multi-line values.
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && /^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function readEnvFile(path) {
  try { return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {}; } catch { return {}; }
}

/** Per-person secrets: process env first, then .claude/.env.local, then ~/.claude/.env as a convenience fallback. */
export function secret(name) {
  return process.env[name] || readEnvFile(join(CLAUDE_DIR, '.env.local'))[name] || readEnvFile(join(homedir(), '.claude', '.env'))[name] || '';
}


export function readConfig({ required = true } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (!required) return null;
    fail('No .claude/shopify-kit.json in this repo yet. Run /shopify-setup first.');
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

// Branches the kit never pushes or merges into. hooks/guard.mjs enforces the same list.
export function protectedBranches(cfg) {
  // "release" as a string, not a list, would spread into single letters and protect nothing.
  const extra = [].concat(cfg?.protectedBranches || []).flatMap((b) => String(b).split(','));
  return [...new Set(['main', 'master', cfg?.baseBranch, ...extra].map((b) => String(b || '').trim()).filter(Boolean))];
}

// A test run (kit.mjs start <KEY> --test) names its branch and draft with this suffix,
// and the guard never lets that branch be pushed.
export const TEST_SUFFIX = '-kit-test';

export function branchFor(cfg, key, st) {
  if (st?.test) return `${key}${TEST_SUFFIX}`;
  const pattern = cfg?.branchPattern || '{KEY}';
  return pattern.replace('{KEY}', key).replace('{key}', key.toLowerCase());
}

/** The draft theme's name: the key, so a teammate sees whose ticket it is; a test run's is set apart. */
export const draftNameFor = (key, st) => (st?.test ? `${key}${TEST_SUFFIX}` : key);

// ── Task state ──
// One .claude/logs/<KEY>/state.json per task; kit.mjs owns the stage logic.

// Who started the task, stored in its state so a teammate can see whose it is.
export function owner() {
  return {
    name: git(['config', 'user.name'], { allowFail: true }) || process.env.USERNAME || process.env.USER || 'dev',
    email: git(['config', 'user.email'], { allowFail: true }) || null,
    host: hostname(),
  };
}

export const statePath = (key) => join(LOGS, key, 'state.json');

export function readState(key, { required = true } = {}) {
  const p = statePath(key);
  if (!existsSync(p)) {
    if (!required) return null;
    fail(`${key} hasn't been started. Run: node .claude/kit/kit.mjs start ${key}`);
  }
  const st = JSON.parse(readFileSync(p, 'utf8'));
  if (RETIRED_STAGES[st.stage]) { st.resumedFrom = st.stage; st.stage = RETIRED_STAGES[st.stage]; }
  return st;
}

/** Write to a temp file and rename, so a crash never leaves half a state file. */
export function writeState(key, state) {
  state.updatedAt = now();
  const p = statePath(key);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, p);
}

// ── Storefront paths and .shopifyignore ──

let msysRoot;
/** Where Git Bash's "/" is (cygpath -m /), asked once and only when a value looks rewritten. */
function gitBashRoot() {
  if (msysRoot === undefined) {
    const r = WIN && process.env.MSYSTEM ? run('cygpath', ['-m', '/'], { timeout: 5000 }) : null;
    msysRoot = r?.code === 0 ? r.stdout.trim().replace(/[\\/]+$/, '') : null;
  }
  return msysRoot;
}

/**
 * Git Bash on Windows rewrites an argument (or the value after "name=") that starts with "/" into
 * "<Git's root>/…" before the script sees it; this puts the "/" back. The root comes from cygpath, since a
 * Scoop install's root (…/scoop/apps/git/current) isn't a folder named Git. Without cygpath: lazy up to the
 * first Git folder, so a later "/Git/" in the text survives; [\s\S] because free text can span lines.
 */
export const unMsys = (s) => unMsysFrom(s, /^[A-Za-z]:[\\/]/.test(String(s)) ? gitBashRoot() : null);

export function unMsysFrom(s, root) {
  const text = String(s);
  if (root && text.slice(0, root.length + 1).replaceAll('\\', '/').toLowerCase() === `${root.toLowerCase()}/`) return text.slice(root.length).replace(/^\\/, '/');
  const m = text.match(/^[A-Za-z]:[\\/](?:[^\r\n]*?[\\/])?Git[\\/]([\s\S]*)$/i);
  return m ? `/${m[1]}` : s;
}

/**
 * A storefront path like /cart, with Git Bash's rewrite undone (unMsys). Paths written
 * without the leading slash are accepted too.
 */
export function storefrontPath(p) {
  let s = unMsys(String(p || '').trim());
  if (/^[A-Za-z]:[\\/]/.test(s)) fail(`"${p}" looks like a file path, not a storefront path. Git Bash may have rewritten it: pass it without the leading slash, e.g. cart or products/x.`);
  s = s.replaceAll('\\', '/');
  if (s === 'home') s = '';
  return '/' + s.replace(/^\/+/, '');
}

/** The repo's .shopifyignore as a matcher: the CLI skips those files without an error. */
export function shopifyIgnore() {
  const p = join(ROOT, '.shopifyignore');
  return existsSync(p) ? ignoreMatcher(readFileSync(p, 'utf8')) : () => false;
}

/** Matcher for .shopifyignore content: one plain glob or /regex/ per line. */
export function ignoreMatcher(text) {
  const tests = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((pat) => {
    if (/^\/.+\/$/.test(pat)) return new RegExp(pat.slice(1, -1));
    const re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    return new RegExp(pat.includes('/') ? `^${re}$` : `(^|/)${re}$`);
  });
  return (file) => tests.some((t) => t.test(file));
}

// ── Storefront fetch ──

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/**
 * GET a storefront page. ?preview_theme_id only sets a cookie and redirects; a client that drops
 * cookies on the redirect is served the live theme without any error, so redirects are followed by hand.
 */
export async function storefrontGet(url, jar = new Map()) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let current = url;
    let res;
    for (let hop = 0; hop < 8; hop++) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'en', ...(cookie ? { cookie } : {}) } });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      break;
    }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    return { status: res.status, url: current, html: await res.text() };
  }
  return { status: 429, url, html: '' };
}

/** The theme that rendered a page, from Shopify.theme in its HTML. */
export function renderedTheme(html) {
  const m = html.match(/Shopify\.theme\s*=\s*(\{[^;]*?\})\s*;/);
  if (!m) return null;
  try { const t = JSON.parse(m[1]); return { id: t.id, name: t.name, role: t.role }; } catch { return null; }
}

// ── Mutation checks ──
// Safety code: shopify.mjs and hooks/guard.mjs both run these before a store write.
// Every new rule or bypass gets a self-test or e2e case.

// The mutations the kit runs: definitions and QA values at the draft stage, their cleanup at handoff.
// No metaobjectUpsert: an upsert that hits a merchant's entry returns its id, which would then count as this task's.
const KIT_MUTATIONS = ['metafieldDefinitionCreate', 'metaobjectDefinitionCreate', 'metafieldsSet', 'metaobjectCreate',
  'metafieldsDelete', 'metafieldDefinitionDelete', 'metaobjectDefinitionDelete', 'metaobjectDelete'];
// These delete by id, and the id must be one this task created.
const DELETES_BY_ID = ['metafieldDefinitionDelete', 'metaobjectDefinitionDelete', 'metaobjectDelete'];

/**
 * The ids a mutation response says this call created or set: each payload's own object, never nested references
 * or owners, which belong to the merchant and must not become deletable as "created by this task".
 */
export function createdIds(response) {
  const payloads = Object.values(response?.data ?? response ?? {});
  return [...new Set(payloads.flatMap((p) => [p?.createdDefinition, p?.metaobjectDefinition, p?.metaobject, ...(Array.isArray(p?.metafields) ? p.metafields : [])])
    .map((o) => o?.id).filter((id) => typeof id === 'string' && id.startsWith('gid://shopify/')))];
}

// ── CLI output schemas (cli-check) ──

/**
 * A schema node with its "#/…" $ref followed. CLI 5 writes refs against the result schema's own definitions, and
 * --json-schema nests that schema under definitions.Result, so a ref may resolve from the document root or from
 * the nested schema (scope). Unresolvable → null, so a check reports the fields missing instead of passing.
 */
export function schemaNode(root, scope, node) {
  const ref = node?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  const at = (base) => ref.slice(2).split('/').reduce((o, k) => o?.[k], base);
  return at(root) ?? at(scope) ?? null;
}

/** The documented fields of one `store auth list --json` session (CLI 4: inline; CLI 5: behind a $ref). */
export function authSessionProps(schema) {
  const result = schema?.definitions?.Result;
  return schemaNode(schema, result, result?.properties?.sessions?.items)?.properties || {};
}

/** The documented fields of a `store execute` error. */
export function execErrorProps(schema) {
  const error = schema?.definitions?.Error;
  const field = schemaNode(schema, error, error?.properties?.error);
  return schemaNode(schema, error, field?.anyOf?.[0])?.properties || {};
}

/** The versions cli-check last verified: a failed run never becomes the version /shopify-update says to pin back to. */
export function lastVerified(last) {
  if (!last) return null;
  if (!last.ok) return last.previous ?? null;
  return { cliVersion: last.cliVersion, pluginVersion: last.pluginVersion, kitVersion: last.kitVersion ?? null, adminApiVersion: last.adminApiVersion ?? null };
}

/** Tokens with comments dropped and strings blanked, so neither can hide a field; code keeps strings (they hold ids). */
export function gqlScan(text) {
  const tokens = [];
  let code = '';
  const word = /[A-Za-z_]\w*|-?\d[\w.+-]*/y;
  let i = 0;
  while (i < text.length) {
    const start = i;
    // A lone CR ends a comment or a string too, as GraphQL servers read it; "#\rmutation" is a mutation.
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    if (text.startsWith('"""', i)) {
      i += 3;
      while (i < text.length && !text.startsWith('"""', i)) i += text.startsWith('\\"""', i) ? 4 : 1;
      i += 3;
      tokens.push('""');
    } else if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n' && text[i] !== '\r') i += text[i] === '\\' ? 2 : 1;
      i++;
      tokens.push('""');
    } else if (text.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else {
      word.lastIndex = i;
      const m = word.exec(text);
      if (m) { tokens.push(m[0]); i += m[0].length; } else { if (!/[\s,]/.test(text[i])) tokens.push(text[i]); i++; }
    }
    code += text.slice(start, i);
  }
  return { tokens, code };
}

/** Why the kit won't run this mutation file; empty if it may. The wrapper and the guard both check it. */
export function mutationProblems(text, varsText = '', createdIds = []) {
  const { tokens: t, code } = gqlScan(text);
  const isName = (x) => /^[A-Za-z_]\w*$/.test(x || '');
  let i = 0;
  const skip = (open, close) => { let depth = 0; do { if (t[i] === open) depth++; else if (t[i] === close) depth--; i++; } while (depth > 0 && i < t.length); };
  const skipDirectives = () => { while (t[i] === '@') { i += 2; if (t[i] === '(') skip('(', ')'); } };
  const unparsed = () => [`Couldn't parse the file near "${t[i] ?? 'the end'}", so the kit won't run it.`];
  const ops = [];
  while (i < t.length) {
    if (t[i] === 'fragment') return ['Fragments aren\'t allowed in a mutation file: write the fields out.'];
    let type = 'query';
    if (['query', 'mutation', 'subscription'].includes(t[i])) {
      type = t[i++];
      if (isName(t[i])) i++;
      if (t[i] === '(') skip('(', ')');
      skipDirectives();
    }
    if (t[i] !== '{') return unparsed();
    i++;
    const fields = [];
    while (i < t.length && t[i] !== '}') {
      if (t[i] === '...') return ['Fragment spreads aren\'t allowed at the top of a mutation.'];
      if (!isName(t[i])) return unparsed();
      let field = t[i++];
      // An alias names the result, not the mutation: check the real name.
      if (t[i] === ':') { field = t[++i]; if (!isName(field)) return unparsed(); i++; }
      fields.push(field);
      if (t[i] === '(') skip('(', ')');
      skipDirectives();
      if (t[i] === '{') skip('{', '}');
    }
    if (t[i] !== '}') return unparsed();
    i++;
    ops.push({ type, fields });
  }
  if (ops.length !== 1) return [`A mutation file holds exactly one operation; this one has ${ops.length}.`];
  const [{ type, fields }] = ops;
  if (type !== 'mutation' || !fields.length) return ['This file has no mutation.'];
  const problems = fields.filter((f) => !KIT_MUTATIONS.includes(f))
    .map((f) => `"${f}" isn't a mutation the kit runs. It runs ${KIT_MUTATIONS.join(', ')}; the dev does anything else in the admin.`);
  // Ids as Shopify reads them: string escapes decoded (gid:\/\/… and gid are a gid), and the variables parsed as JSON.
  const strings = [...code.matchAll(/"(?:[^"\\\r\n]|\\.)*"/g)].map((m) => { try { return JSON.parse(m[0]); } catch { return m[0]; } });
  let vars = null;
  try { vars = varsText.trim() ? JSON.parse(varsText) : null; } catch { if (varsText.trim()) problems.push('The variables file isn\'t valid JSON.'); }
  const varStrings = [];
  const walk = (v, key) => { if (typeof v === 'string') varStrings.push({ key, v }); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k); };
  walk(vars, null);
  const all = [code, ...strings, ...varStrings.map((s) => s.v)].join('\n');
  if (fields.some((f) => DELETES_BY_ID.includes(f))) {
    // An identifier (owner type, namespace, key) can name a merchant's definition while an owned id elsewhere passes the check.
    if (t.includes('identifier')) problems.push('A delete names the id it deletes, not an identifier.');
    const ids = [...all.matchAll(/gid:\/\/shopify\/(?:MetafieldDefinition|MetaobjectDefinition|Metaobject)\/\d+/g)].map((m) => m[0]);
    if (!ids.length) problems.push('A delete names the id it deletes (an identifier isn\'t enough), in the file or its variables.');
    for (const id of new Set(ids)) if (!createdIds.includes(id)) problems.push(`${id} wasn't created by this task, so the kit won't delete it.`);
  }
  // metafieldsDelete names owner, namespace and key, not a metafield id: only metafields on owners this task created.
  // Values under a definition the kit created go with deleteAllAssociatedMetafields; anything else is the dev's, in the admin.
  if (fields.includes('metafieldsDelete')) {
    // "ownerId: $o" takes its value from a variable or its default, which the owner list below can't see:
    // one owned literal elsewhere would let it through.
    if (t.some((x, j) => x === 'ownerId' && t[j + 1] === ':' && t[j + 2] === '$')) problems.push('metafieldsDelete: write each ownerId as a literal "gid://…", in the file or under an "ownerId" key in the variables, not as ownerId: $variable.');
    const owners = [...code.matchAll(/ownerId\s*:\s*"([^"]*)"/g)].map((m) => { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } })
      .concat(varStrings.filter((s) => s.key === 'ownerId').map((s) => s.v));
    if (!owners.length) problems.push('metafieldsDelete names the ownerId of each metafield it deletes, in the file or its variables.');
    for (const o of new Set(owners)) if (!createdIds.includes(o)) problems.push(`${o} wasn't created by this task, so the kit won't delete its metafields. Remove a merchant's values in the admin.`);
  }
  return problems;
}

// The guard records what it showed the dev in this file; the wrapper runs only that, once.
export const SEAL_FILE = 'guard-seal.json';
export const sealDigest = (text, varsText = '') => createHash('sha256').update(`${text}\0${varsText}`).digest('hex');

/** Absolute path, and true only if it sits inside this task's log folder. */
export function inTaskFolder(key, file) {
  const abs = resolve(ROOT, file);
  const folder = resolve(LOGS, key) + (WIN ? '\\' : '/');
  return { abs, ok: abs.toLowerCase().startsWith(folder.toLowerCase()) };
}
