// Shared helpers for the kit scripts. Zero dependencies, so the kit runs in any theme repo.
import { spawnSync } from 'node:child_process';
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

const BOOLEAN_FLAGS = new Set(['dry-run', 'baseline', 'json', 'help', 'force', 'no-comments', 'selftest', 'investigate']);

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
    res = spawnSync(line, { ...opts, shell: true });
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

export function branchFor(cfg, key) {
  const pattern = cfg?.branchPattern || '{KEY}';
  return pattern.replace('{KEY}', key).replace('{key}', key.toLowerCase());
}

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

/** Absolute path, and true only if it sits inside this task's log folder. */
export function inTaskFolder(key, file) {
  const abs = resolve(ROOT, file);
  const folder = resolve(LOGS, key) + (WIN ? '\\' : '/');
  return { abs, ok: abs.toLowerCase().startsWith(folder.toLowerCase()) };
}
