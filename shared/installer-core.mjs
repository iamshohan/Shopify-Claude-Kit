// Install-time rules both installers share (install.mjs for the theme kit, app/install.mjs for the app kit). Installers run
// from the kit repo itself, so both import this file directly; it is never copied into a theme or app repo.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * The kit's files as git has them (committed or staged), relative to kitDir: a file the maintainer never added isn't part
 * of a release. dirty names the kit files with uncommitted changes, which ship as they are on disk. Outside a git checkout
 * (a downloaded copy), every file walk() finds ships.
 */
export function kitFiles(kitDir, walk) {
  try {
    const files = git(kitDir, ['ls-files', '-z', '--', '.']).split('\0').filter((f) => f && existsSync(resolve(kitDir, f)));
    const dirty = git(kitDir, ['status', '--porcelain', '--untracked-files=all', '--', '.']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
    return { files, dirty, untracked: dirty.length ? git(kitDir, ['ls-files', '--others', '--exclude-standard', '--', '.']).split(/\r?\n/).filter(Boolean) : [] };
  } catch {
    return { files: walk(), dirty: [], untracked: [] };
  }
}

/** The kit commit an install came from, so a repo's kitVersion can be told apart from another build of the same VERSION. */
export function kitCommit(kitDir) {
  try { return git(kitDir, ['rev-parse', 'HEAD']).trim(); } catch { return null; }
}

/**
 * Why installing this checkout over a repo's kit would go back in time, or null. VERSION stays put between releases, so
 * the build is the commit: the installed one must be an ancestor of HEAD here. A commit this clone doesn't have came from
 * a newer or another branch's checkout. No git, or no recorded commit (a download, an old manifest): nothing to compare.
 */
export function olderBuild(kitDir, installedCommit) {
  if (!installedCommit || !/^[0-9a-f]{7,40}$/i.test(installedCommit)) return null;
  const head = kitCommit(kitDir);
  if (!head || head.startsWith(installedCommit)) return null;
  try { git(kitDir, ['cat-file', '-e', `${installedCommit}^{commit}`]); } catch {
    return `it was installed from kit commit ${installedCommit.slice(0, 7)}, which this checkout doesn't have (git fetch, then check out the branch it came from)`;
  }
  try { git(kitDir, ['merge-base', '--is-ancestor', installedCommit, 'HEAD']); return null; } catch {
    return `it was installed from kit commit ${installedCommit.slice(0, 7)}, which this checkout's HEAD (${head.slice(0, 7)}) doesn't include (git pull, or check out that branch)`;
  }
}

// ── Tool output at the repo root ──
// Playwright MCP (kit-browser, or the dev's own server) writes .playwright-mcp/ into the folder Claude runs in: page text,
// console logs and draft preview URLs. .claude/.gitignore can't reach the root, and the repo's own .gitignore is the
// client's, so the line goes into .git/info/exclude: this clone only, never committed.
const TOOL_OUTPUT = ['.playwright-mcp/'];

/** The exclude file and the lines it still needs, or null (not a git repo, or git already ignores them). */
export function missingExcludes(repo) {
  const ignored = (p) => spawnSync('git', ['check-ignore', '-q', `${p}x`], { cwd: repo, stdio: 'ignore' }).status === 0;
  let file;
  try { file = resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']).trim()); } catch { return null; }
  const add = TOOL_OUTPUT.filter((p) => !ignored(p));
  return add.length ? { file, add } : null;
}

export function addExcludes({ file, add }) {
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Shopify-Claude-Kit: tool output\n${add.join('\n')}\n`);
}

// ── Installed repos (update.mjs) ──
// Every repo this clone installed into, so `node update.mjs` can refresh them all. It lives in the clone, git-ignored:
// paths are per machine. SHOPIFY_KIT_REGISTRY moves it (the e2e suites point it at a temp file).

export const registryPath = (cloneRoot) => process.env.SHOPIFY_KIT_REGISTRY || join(cloneRoot, '.installs.json');

/**
 * One spelling per folder: on Windows, C:\Users\ECHOLO~1\x, c:\users\echologyx\x and C:\Users\ECHOLOGYX\x are the same
 * repo, and as separate keys update.mjs installed into it once per spelling.
 */
export function repoKey(p) {
  try { return realpathSync.native(resolve(p)); } catch { return resolve(p); }
}

/** { "<absolute repo path>": "theme" | "app" }; empty when missing or unreadable. */
export function readRegistry(cloneRoot) {
  try {
    const r = JSON.parse(readFileSync(registryPath(cloneRoot), 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? Object.fromEntries(Object.entries(r).map(([k, v]) => [repoKey(k), v])) : {};
  } catch { return {}; }
}

export function writeRegistry(cloneRoot, registry) {
  writeFileSync(registryPath(cloneRoot), JSON.stringify(registry, null, 2) + '\n');
}

/** Records a repo after an install. A failed write only costs update.mjs that repo, so it never fails the install. */
export function register(cloneRoot, repo, kit) {
  try { writeRegistry(cloneRoot, { ...readRegistry(cloneRoot), [repoKey(repo)]: kit }); } catch { /* read-only clone */ }
}

/** The installer's lines about the repo's own files it moved or kept aside: the dev must act on these, the rest is routine. */
export const devNotes = (stdout) => (stdout || '').split(/\r?\n/)
  .filter((l) => /^(keep the repo's|move the repo's own settings|save the repo's settings|Your own permissions|Move your own entries)/.test(l));

/** -1, 0 or 1 for dotted version numbers (1.0.0 against 1.2.0); text parts compare as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

// The folders and top-level files a kit ships into .claude/. Anything else a manifest names is never removed.
const SHIPPED = /^(hooks|kit|commands|agents|skills|rules)\/|^(CLAUDE\.md|README\.md|VERSION|settings\.json)$/;

/**
 * Files an older kit shipped that this one doesn't, safe to remove: a plain relative path inside .claude/, in a folder the
 * kit owns. A manifest is a file in the repo anyone can edit, so "../package.json" in it must not delete the repo's file.
 */
export function staleFiles(dest, previous, files, perRepo) {
  const root = resolve(dest) + sep;
  return (Array.isArray(previous) ? previous : []).filter((f) => typeof f === 'string' && !files.includes(f) && !perRepo.has(f)
    && !isAbsolute(f) && !f.replaceAll('\\', '/').split('/').includes('..') && SHIPPED.test(f.replaceAll('\\', '/')) && resolve(dest, f).startsWith(root));
}

// ── Install into every Shopify repo under a folder (install.mjs --all) ──

const APP_TOML = /^shopify\.app(\.[\w-]+)?\.toml$/;
const NOT_REPOS = new Set(['node_modules', 'logs', 'dist', 'build', 'vendor']);

/** The installed kit's { kind, version }, or null. */
function installedKit(repo) {
  try {
    const m = JSON.parse(readFileSync(join(repo, '.claude', '.kit-manifest.json'), 'utf8'));
    return { kind: m.kit === 'app' ? 'app' : 'theme', version: m.version };
  } catch { return null; }
}

/**
 * Shopify theme and app repos under a folder: [{ repo, kind: 'theme' | 'app' | 'both', git, kit }]. A theme has
 * config/settings_schema.json and layout/; an app a shopify.app*.toml. The walk stops at each one found, so an app's
 * theme extension isn't listed on its own.
 */
export function findShopifyRepos(top, { depth = 4, exclude = [] } = {}) {
  const skip = new Set(exclude.map((p) => resolve(p)));
  const found = [];
  const walk = (dir, d) => {
    if (skip.has(resolve(dir))) return;
    let names;
    try { names = readdirSync(dir); } catch { return; }
    const app = names.some((n) => APP_TOML.test(n));
    const theme = existsSync(join(dir, 'config', 'settings_schema.json')) && existsSync(join(dir, 'layout'));
    if (app || theme) {
      found.push({ repo: resolve(dir), kind: app && theme ? 'both' : app ? 'app' : 'theme', git: names.includes('.git'), kit: installedKit(dir) });
      return;
    }
    if (!d) return;
    for (const n of names) {
      if (n.startsWith('.') || NOT_REPOS.has(n)) continue;
      try { if (statSync(join(dir, n)).isDirectory()) walk(join(dir, n), d - 1); } catch {}
    }
  };
  walk(resolve(top), depth);
  return found;
}

/**
 * install.mjs --all <folder> [--yes]: lists what it finds, and with --yes installs into the repos without a kit, one
 * installer run each. Repos that already have one are only added to update.mjs's list. Returns the exit code.
 */
export function installAll(cloneRoot, top, { yes = false } = {}) {
  if (!top || !existsSync(top)) {
    console.error('Usage: node install.mjs --all <folder that holds your theme and app repos> [--yes]');
    return 1;
  }
  const repos = findShopifyRepos(top, { exclude: [cloneRoot] });
  if (!repos.length) { console.log(`No Shopify theme or app repos under ${resolve(top)} (4 folders deep).`); return 0; }
  const registry = readRegistry(cloneRoot);
  const fresh = [];
  console.log(`Shopify repos under ${resolve(top)}:`);
  for (const r of repos) {
    const why = r.kit ? `has the ${r.kit.kind} kit ${r.kit.version}: node update.mjs keeps it current`
      : r.kind === 'both' ? 'looks like a theme and an app: install by hand, with or without --app'
        : !r.git ? 'not the root of a git repo, which the kit needs'
          : null;
    if (r.kit) registry[repoKey(r.repo)] = r.kit.kind;
    if (!why) fresh.push(r);
    console.log(`  ${!why ? 'new ' : r.kit ? 'has ' : 'skip'}  ${r.kind.padEnd(5)}  ${r.repo}${why ? `  (${why})` : ''}`);
  }
  try { writeRegistry(cloneRoot, registry); } catch { /* read-only clone: update.mjs --scan finds them later */ }
  if (!fresh.length) { console.log('Nothing to install.'); return 0; }
  const plural = fresh.length === 1 ? '' : 's';
  if (!yes) { console.log(`\nTo install the kit into the ${fresh.length} new repo${plural}: node install.mjs --all ${top} --yes`); return 0; }
  console.log(`\nInstalling into ${fresh.length} repo${plural}:`);
  let failed = 0;
  for (const r of fresh) {
    const run = spawnSync(process.execPath, [join(cloneRoot, 'install.mjs'), r.repo, ...(r.kind === 'app' ? ['--app'] : [])], { cwd: cloneRoot, encoding: 'utf8' });
    if (run.status === 0) {
      console.log(`  ok ${r.kind.padEnd(5)}  ${r.repo}`);
      for (const n of devNotes(run.stdout)) console.log(`       ${n}`);
    } else { failed++; console.log(`  !! ${r.kind.padEnd(5)}  ${r.repo}: ${(run.stderr || run.stdout).trim().split(/\r?\n/)[0]}`); }
  }
  if (failed < fresh.length) console.log('\nNext, in each new repo: open Claude Code there and run /shopify-setup (theme) or /app-setup (app). The kit needs its store before it can work.');
  if (failed) console.log(`${failed} not installed; run node install.mjs <repo> there to see why.`);
  return failed ? 1 : 0;
}
