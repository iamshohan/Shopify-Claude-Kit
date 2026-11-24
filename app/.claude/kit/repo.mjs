// Repo paths, settings, stages and change state for the app kit. Shared by app.mjs, shopify.mjs and the guard.
// A change lives in git: appspec/changes/<id>/ holds its proposal.md and change.json (kit-only).
// Per person and never committed: .claude/app-kit.json (settings), .claude/logs/ (guard log, seals, kit notes).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { fail, now, parseArgsWith, run as runIn, writeJsonAtomic } from './core.mjs';

// ── Paths ──
// Located from this file, not from cwd: commands may run from a subfolder.
export const KIT_DIR = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_DIR = resolve(KIT_DIR, '..');
export const ROOT = resolve(CLAUDE_DIR, '..');
export const LOGS = join(CLAUDE_DIR, 'logs');
export const CONFIG_REL = '.claude/app-kit.json';
export const CONFIG_PATH = join(ROOT, CONFIG_REL);
// The build: VERSION stays put between releases, so the installed commit tells two builds apart (the CLI check's cache,
// status notes, feedback). Not installed (the kit repo itself): VERSION alone.
export const KIT_VERSION = (() => {
  let v = 'dev';
  try { v = readFileSync(join(CLAUDE_DIR, 'VERSION'), 'utf8').trim(); } catch { /* no VERSION */ }
  try {
    const m = JSON.parse(readFileSync(join(CLAUDE_DIR, '.kit-manifest.json'), 'utf8'));
    if (m.commit) v += `+${String(m.commit).slice(0, 7)}${m.uncommitted ? '-dirty' : ''}`;
  } catch { /* not installed */ }
  return v;
})();

export const DEFAULTS = { appConfig: 'shopify.app.toml', baseBranch: 'main', branchPattern: '{ID}' };

const SPEC = {
  dir: 'appspec',
  changes: 'appspec/changes',
  archive: 'appspec/archive',
  surfaces: 'appspec/surfaces.json',
  // Security findings that predate the change: verify fails only on new ones. Written at onboard and handoff.
  securityBaseline: 'appspec/security-baseline.json',
  project: 'appspec/project.md',
};
/** Where the kit's records live, relative to the repo root: always appspec/. */
export const specPaths = () => SPEC;

// App code (the guard's pattern) and lockfiles, which pin what runs; not build output, CI or the kit's records. Results
// are recorded against it, so committing docs or .gitignore doesn't make them stale, and dist/ needn't be committed.
const APP_CODE = /^(app|extensions|prisma|web|src|server|lib|shared|public)\/|\.(m?[jt]sx?|cjs|liquid|graphql|gql|prisma|toml|json|ya?ml|html|css|scss)$|(^|\/)(yarn\.lock|bun\.lockb?)$/i;
// <any folder>/<extension>/dist/: extensions may live in any extension_directories folder, not only extensions/.
const BUILD_OUTPUT = /^(\.shopify\/|\.react-router\/|build\/|dist\/|node_modules\/|\.playwright-mcp\/|[^/]+\/[^/]+\/(dist|generated|node_modules)\/|extensions\/[^/]+\/schema\.graphql$)|\.generated\.[jt]sx?$|\.d\.ts$/;
export const isAppCode = (p) => APP_CODE.test(p) && !BUILD_OUTPUT.test(p) && !/^(appspec|\.claude|\.github)\//.test(p);

// ── Arguments and settings ──

// Flags that never take a value (see parseArgsWith in core.mjs); a new boolean flag must be listed here.
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'help', 'force', 'selftest', 'test', 'none', 'all', 'write', 'skip-tests', 'regression']);
export const parseArgs = parseArgsWith(BOOLEAN_FLAGS);

export function readConfig({ required = true } = {}) {
  if (!existsSync(CONFIG_PATH)) {
    if (!required) return null;
    fail(`No ${CONFIG_REL} in this repo yet. Run /app-setup first.`);
  }
  return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) };
}

/** The dev store as a myshopify domain; the kit acts on no other store. */
export function devStore(cfg) {
  const s = String(cfg?.devStore || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!s) return '';
  return s.endsWith('.myshopify.com') ? s : `${s}.myshopify.com`;
}


// ── Git ──

export const run = (cmd, args = [], opts = {}) => runIn(cmd, args, { ...opts, cwd: opts.cwd ?? ROOT });

export function git(args, { allowFail = false } = {}) {
  const r = run('git', args);
  if (r.code !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.code === 0 ? r.stdout.trim() : '';
}

export const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
export const head = () => git(['rev-parse', 'HEAD'], { allowFail: true });

// Branches the kit never pushes or merges into. The guard enforces the same list.
export function protectedBranches(cfg) {
  // "release" as a string, not a list, would spread into single letters and protect nothing.
  const extra = [].concat(cfg?.protectedBranches || []).flatMap((b) => String(b).split(','));
  return [...new Set(['main', 'master', cfg?.baseBranch, ...extra].map((b) => String(b || '').trim()).filter(Boolean))];
}

// A test run (app.mjs start <id> --test) names its branch with this suffix, and the guard never lets it be pushed.
export const TEST_SUFFIX = '-kit-test';

export function branchFor(cfg, id, st) {
  if (st?.test) return `${id}${TEST_SUFFIX}`;
  return (cfg?.branchPattern || DEFAULTS.branchPattern).replace('{ID}', id).replace('{id}', id.toLowerCase());
}

/** The branch onboarding commits appspec/ on; a first change may stack on it before it's merged. */
export const ONBOARD_BRANCH = 'kit-onboard';

/**
 * The commit a change is measured from: where HEAD meets origin/<base> (as a PR diff is), else where the branch started.
 * A change stacked on the unmerged onboarding branch is measured from it, until that branch is in the base.
 */
export function effectiveBase(st, cfg) {
  const base = `origin/${cfg?.baseBranch || 'main'}`;
  const stacked = st?.stackedOn && git(['rev-parse', '--verify', '--quiet', `origin/${st.stackedOn}`], { allowFail: true })
    && run('git', ['merge-base', '--is-ancestor', `origin/${st.stackedOn}`, base]).code !== 0;
  return git(['merge-base', 'HEAD', stacked ? `origin/${st.stackedOn}` : base], { allowFail: true }) || st?.base;
}

export function owner() {
  return {
    name: git(['config', 'user.name'], { allowFail: true }) || process.env.USERNAME || process.env.USER || 'dev',
    email: git(['config', 'user.email'], { allowFail: true }) || null,
    host: hostname(),
  };
}

// ── Stages ──
// One graph for every type of change. Human-readable copies: the commands and README.md.

export const STAGES = [
  { name: 'propose', skill: 'app-propose', gate: 'Gate 1: the dev approves the scenarios, the surfaces and how each scenario is checked' },
  { name: 'build', skill: 'app-build' },
  { name: 'verify', skill: 'app-verify' },
  { name: 'accept', skill: 'app-verify', gate: 'Gate 2: the dev accepts the measured result' },
  { name: 'handoff', skill: 'app-handoff' },
];
// change: add or adjust behaviour. fix: a bug, reproduced by a failing test. maintain: no behaviour change (API version,
// dependencies, refactor). ab: an A/B-gated extension with a gate and its completion (how the test ends).
export const TYPES = ['change', 'fix', 'maintain', 'ab'];

export const stageIndex = (name) => STAGES.findIndex((s) => s.name === name);
export const finished = (st) => ['done', 'abandoned'].includes(st?.stage);

// ── Change state ──

/** A change id: a Jira key (ABC-123) or a short kebab-case name. */
export function normId(raw) {
  const s = String(raw || '').trim();
  if (/^[A-Za-z][A-Za-z0-9]+-\d+$/.test(s)) return s.toUpperCase();
  if (/^[a-z0-9][a-z0-9-]{1,59}$/.test(s) && !s.endsWith('-')) return s;
  fail(`"${raw}" isn't a change id. Use a Jira key (ABC-123) or a short kebab-case name (add-gift-label).`);
}

export const changeDir = (cfg, id) => `${specPaths(cfg).changes}/${id}`;
export const statePath = (cfg, id) => join(ROOT, changeDir(cfg, id), 'change.json');

export function readChange(cfg, id, { required = true } = {}) {
  const p = statePath(cfg, id);
  if (!existsSync(p)) {
    if (!required) return null;
    fail(`No change "${id}". Start one with node .claude/kit/app.mjs start ${id} --type change|fix|maintain|ab`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeChange(cfg, id, st) {
  st.updatedAt = now();
  writeJsonAtomic(statePath(cfg, id), st);
}

/** Every open change in the working tree: [{ id, st }]. Archived changes live under appspec/archive and aren't listed. */
export function listChanges(cfg) {
  const dir = join(ROOT, specPaths(cfg).changes);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'change.json')))
    .map((e) => { try { return { id: e.name, st: JSON.parse(readFileSync(join(dir, e.name, 'change.json'), 'utf8')) }; } catch { return null; } })
    .filter(Boolean);
}
