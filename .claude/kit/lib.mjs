// Shared helpers for the kit scripts. Zero dependencies, so the kit runs in any theme repo.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';

// Located from this file, not from cwd: commands may run from a subfolder.
export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_DIR = resolve(KIT_DIR, '..');
export const ROOT = resolve(CLAUDE_DIR, '..');
export const LOGS = join(CLAUDE_DIR, 'logs');
export const CONFIG_PATH = join(CLAUDE_DIR, 'shopify-kit.json');
export const KIT_VERSION = readFileSync(join(CLAUDE_DIR, 'VERSION'), 'utf8').trim();
export const WIN = process.platform === 'win32';

export const THEME_DIRS = ['assets', 'blocks', 'config', 'layout', 'locales', 'sections', 'snippets', 'templates'];
/** The CLI's --only takes the next argument even when it starts with -, so only theme paths reach it. */
export const isThemePath = (p) => new RegExp(`^(${THEME_DIRS.join('|')})/.`).test(p) && !p.split('/').includes('..');
// Files Shopify rewrites when someone saves in the admin (and syncs into git on GitHub-connected themes).
export const MERCHANT_JSON = /^(templates\/.+\.json|sections\/[^/]+\.json|config\/settings_data\.json)$/;

// Source of truth for the pipeline. Human-readable copies: commands/implement.md and README.md.
export const STAGES = [
  { name: 'intake', skill: 'shopify-intake' },
  { name: 'analyze', skill: 'shopify-intake' },
  { name: 'clarify', skill: 'shopify-plan', gate: 'Gate 1: the dev answers the open questions' },
  { name: 'plan', skill: 'shopify-plan' },
  { name: 'approve', skill: 'shopify-plan', gate: 'Gate 2: the dev approves the plan' },
  { name: 'build', skill: 'shopify-build' },
  { name: 'draft', skill: 'shopify-build' },
  { name: 'qa', skill: 'shopify-qa' },
  { name: 'accept', skill: 'shopify-qa', gate: 'Gate 3: the dev accepts the QA result' },
  { name: 'handoff', skill: 'shopify-handoff' },
];

// /shopify-investigate: read-only, ends in an answer instead of a draft theme.
export const INVESTIGATION_STAGES = [
  { name: 'frame', skill: 'shopify-investigate' },
  { name: 'gather', skill: 'shopify-investigate' },
  { name: 'conclude', skill: 'shopify-investigate', gate: 'the dev accepts the answer or asks for more' },
];

export const stagesFor = (st) => (st?.kind === 'investigation' ? INVESTIGATION_STAGES : STAGES);

export const now = () => new Date().toISOString();

export function print(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

export function fail(message, code = 1) {
  process.stderr.write(String(message).trimEnd() + '\n');
  process.exit(code);
}

const BOOLEAN_FLAGS = new Set(['dry-run', 'baseline', 'json', 'help', 'force', 'no-comments', 'selftest', 'investigate', 'live', 'github', 'none', 'all', 'adopt', 'test']);

export function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (!BOOLEAN_FLAGS.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[a.slice(2)] = argv[++i];
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

export function slug(text, max = 20) {
  return String(text || 'dev').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'dev';
}

/**
 * Runs a program. Real executables are spawned directly. The Shopify CLI is a .cmd shim
 * on Windows, which Node can only start through a shell, so those arguments are quoted
 * here and characters cmd.exe would interpret are refused.
 */
export function run(cmd, args = [], { cwd = ROOT, env = {}, input, timeout = 600000, shell = false } = {}) {
  const opts = { cwd, env: { ...process.env, ...env }, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 };
  let res;
  if (shell && WIN) {
    for (const a of args) if (/["%^&|<>!\r\n]/.test(a)) throw new Error(`Refusing to pass ${JSON.stringify(a)} through cmd.exe.`);
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

/** Where each secret comes from (they can come from different places), or null if any is missing. */
export function secretSource(names) {
  const local = join(CLAUDE_DIR, '.env.local');
  const global = join(homedir(), '.claude', '.env');
  const from = names.map((n) => (process.env[n] ? 'process environment' : readEnvFile(local)[n] ? local : readEnvFile(global)[n] ? global : null));
  if (from.some((f) => !f)) return null;
  return [...new Set(from)].join(' + ');
}

export function readConfig({ required = true } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (!required) return null;
    fail('No .claude/shopify-kit.json in this repo yet. Run /shopify-setup first.');
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function protectedBranches(cfg) {
  return [...new Set(['main', 'master', cfg?.baseBranch, ...(cfg?.protectedBranches || [])].filter(Boolean))];
}

// A test run (kit.mjs start <KEY> --test) names its branch and draft with this suffix, and the guard never lets that branch be pushed.
export const TEST_SUFFIX = '-kit-test';

export function branchFor(cfg, key, st) {
  if (st?.test) return `${key}${TEST_SUFFIX}`;
  const pattern = cfg?.branchPattern || '{KEY}';
  return pattern.replace('{KEY}', key).replace('{key}', key.toLowerCase());
}

/** The draft theme's name: the key, so a teammate sees whose ticket it is; a test run's is set apart. */
export const draftNameFor = (key, st) => (st?.test ? `${key}${TEST_SUFFIX}` : key);

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
  return JSON.parse(readFileSync(p, 'utf8'));
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

/**
 * A storefront path like /cart. Git Bash on Windows rewrites arguments that start with "/"
 * into "C:/Program Files/Git/cart" before the script sees them, so undo that, and accept
 * paths written without the leading slash.
 */
export function storefrontPath(p) {
  let s = String(p || '').trim();
  const msys = s.match(/^[A-Za-z]:[\\/](?:.*[\\/])?Git[\\/](.*)$/i);
  if (msys) s = msys[1].replaceAll('\\', '/');
  else if (/^[A-Za-z]:[\\/]/.test(s)) fail(`"${p}" looks like a file path, not a storefront path. Git Bash may have rewritten it: pass it without the leading slash, e.g. cart or products/x.`);
  if (s === 'home') s = '';
  return '/' + s.replace(/^\/+/, '');
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

// The mutations the kit runs: definitions and QA values at the draft stage, their cleanup at handoff.
const KIT_MUTATIONS = ['metafieldDefinitionCreate', 'metaobjectDefinitionCreate', 'metafieldsSet', 'metaobjectCreate', 'metaobjectUpsert',
  'metafieldsDelete', 'metafieldDefinitionDelete', 'metaobjectDefinitionDelete', 'metaobjectDelete'];
// These delete by id, and the id must be one this task created.
const DELETES_BY_ID = ['metafieldDefinitionDelete', 'metaobjectDefinitionDelete', 'metaobjectDelete'];

/** Tokens with comments dropped and strings blanked, so neither can hide a field; code keeps strings (they hold ids). */
function gqlScan(text) {
  const tokens = [];
  let code = '';
  const word = /[A-Za-z_]\w*|-?\d[\w.+-]*/y;
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('"""', i)) {
      i += 3;
      while (i < text.length && !text.startsWith('"""', i)) i += text.startsWith('\\"""', i) ? 4 : 1;
      i += 3;
      tokens.push('""');
    } else if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
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
  if (fields.some((f) => DELETES_BY_ID.includes(f))) {
    const ids = [...`${code}\n${varsText}`.matchAll(/gid:\/\/shopify\/(?:MetafieldDefinition|MetaobjectDefinition|Metaobject)\/\d+/g)].map((m) => m[0]);
    if (!ids.length) problems.push('A delete names the id it deletes (an identifier isn\'t enough), in the file or its variables.');
    for (const id of new Set(ids)) if (!createdIds.includes(id)) problems.push(`${id} wasn't created by this task, so the kit won't delete it.`);
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
