// Install-time rules both installers share (install.mjs for the theme kit, app/install.mjs for the app kit). Installers run
// from the kit repo itself, so both import this file directly; it is never copied into a theme or app repo.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MANIFEST = '.kit-' + 'manifest.json';

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

// ── One install (install.mjs, app/install.mjs) ──
// settings.json is the kit's and is replaced every time, so a new hook or deny rule always lands. Whatever the repo's file
// has beyond the kit's moves to settings.local.json first: Claude Code merges list keys across the two files, and an allow
// there doesn't outrank the kit's ask or deny rules.

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** What `a` has that `b` doesn't: list items `b` lacks, and keys whose values differ, recursively. */
export function extras(a, b) {
  if (Array.isArray(a)) {
    const have = new Set((Array.isArray(b) ? b : []).map((v) => JSON.stringify(v)));
    const out = a.filter((v) => !have.has(JSON.stringify(v)));
    return out.length ? out : undefined;
  }
  if (a && typeof a === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(a)) {
      const e = extras(v, b && typeof b === 'object' && !Array.isArray(b) ? b[k] : undefined);
      if (e !== undefined) out[k] = e;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? undefined : a;
}

/** Adds `add` into `into`: lists gain the items they lack, and a value `into` already sets stays. */
function merge(into, add) {
  for (const [k, v] of Object.entries(add)) {
    if (Array.isArray(v)) {
      const list = Array.isArray(into[k]) ? into[k] : [];
      into[k] = [...list, ...(extras(v, list) || [])];
    } else if (v && typeof v === 'object') into[k] = merge(into[k] && typeof into[k] === 'object' ? into[k] : {}, v);
    else if (!(k in into)) into[k] = v;
  }
  return into;
}

/** A guard hook merged in by hand (as older installers asked) would run twice next to the kit's own. */
function withoutGuard(s) {
  for (const [event, groups] of Object.entries(s.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    s.hooks[event] = groups.map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !/hooks[\\/]+guard\.mjs/.test(JSON.stringify(h))) })).filter((g) => g.hooks.length);
  }
  return s;
}

/** Every file under kitDir, except task history in its own logs/ (a deeper folder named logs is kit content). */
function walkKit(kitDir, dir = kitDir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (p !== join(kitDir, 'logs')) walkKit(kitDir, p, out); } else out.push(relative(kitDir, p).replaceAll('\\', '/'));
  }
  return out;
}

/**
 * Installs or updates one kit's .claude/ in one repo and returns the exit code. The repo's own files (perRepo) are never
 * copied over or removed; files an older kit shipped and this one doesn't are (tracked in the manifest).
 *   kind      'theme' | 'app', written to the manifest and update.mjs's list; label names it in messages ('kit', 'app kit')
 *   looksLike (repo) => why it isn't this kind of repo, or null; skipped on an update and with --force
 *   ownRepos  paths that are the kit repo itself: installing there would end maintainer mode
 */
export function installKit({ kitDir, cloneRoot, kind, label, perRepo, gitignore, usage, looksLike, ownRepos, kept, next, args }) {
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--'));
  const stop = (msg) => { console.error(msg); return 1; };
  if (!target) { console.log(usage); return 1; }
  const repo = resolve(target);
  const dest = join(repo, '.claude');
  const manifestPath = join(dest, MANIFEST);
  const firstInstall = !existsSync(manifestPath);
  if (ownRepos.map((p) => resolve(p)).includes(repo)) return stop('That is the kit\'s own repo.');
  // An update skips this: the repo was accepted at its first install (perhaps with --force), and update.mjs passes no flags.
  const notThis = !force && firstInstall && looksLike(repo);
  if (notThis) return stop(`${repo} ${notThis}. Use --force if it is one.`);

  const source = kitFiles(kitDir, () => walkKit(kitDir));
  const files = source.files.filter((f) => !perRepo.has(f));
  let manifest = {};
  try {
    if (!firstInstall) manifest = readJson(manifestPath);
  } catch {
    console.warn(`Warning: .claude/${MANIFEST} is unreadable, so files an older kit dropped stay this time.`);
  }
  // Theme manifests from before 1.16.1 have no `kit` field.
  const other = Object.keys(manifest).length && (manifest.kit === 'app' ? 'app' : 'theme');
  if (other && other !== kind) return stop(`${dest} holds the ${other} kit. A repo gets one kit.${other === 'app' ? ' Update it with: node install.mjs <path> --app' : ''}`);
  const stale = staleFiles(dest, manifest.files, files, perRepo);
  const version = readFileSync(join(kitDir, 'VERSION'), 'utf8').trim();
  const installed = existsSync(join(dest, 'VERSION')) ? readFileSync(join(dest, 'VERSION'), 'utf8').trim() : null;
  // Going back a version would delete the newer kit's files as "stale".
  if (installed && compareVersions(installed, version) > 0 && !force) {
    return stop(`${dest} has ${label} ${installed}, newer than this checkout's ${version}. Update this kit repo (git pull), or pass --force to go back.`);
  }
  const behind = installed && compareVersions(installed, version) === 0 && olderBuild(kitDir, manifest.commit);
  if (behind && !force) return stop(`${dest} has a newer build of ${label} ${version}: ${behind}. Or pass --force to go back.`);

  const destSettings = join(dest, 'settings.json');
  const kitSettings = join(kitDir, 'settings.json');
  const localSettings = join(dest, 'settings.local.json');
  // A file identical to what the installer wrote last time has nothing of the repo's in it.
  const ownSettings = existsSync(destSettings) && sha(destSettings) !== sha(kitSettings) && sha(destSettings) !== manifest.settingsSha;
  let moved;
  let unreadable = false;
  if (ownSettings) {
    try {
      moved = extras(withoutGuard(readJson(destSettings)), readJson(kitSettings));
      // Carried over as is, disableAllHooks would switch the kit's guard off from settings.local.json.
      if (moved && 'disableAllHooks' in moved) {
        delete moved.disableAllHooks;
        console.warn('Warning: the repo\'s settings.json had disableAllHooks; it is not carried over, so the guard stays on.');
        if (!Object.keys(moved).length) moved = undefined;
      }
      if (moved && existsSync(localSettings)) readJson(localSettings);
    } catch {
      unreadable = true;
    }
  }

  // Plan every step first, so --dry-run prints the same list without touching the repo.
  const actions = [];
  if (unreadable) {
    actions.push(['save the repo\'s settings.json as settings.pre-kit.json (it or settings.local.json isn\'t valid JSON)', () => copyFileSync(destSettings, join(dest, 'settings.pre-kit.json'))]);
  } else if (moved) {
    actions.push([`move the repo's own settings to settings.local.json: ${JSON.stringify(moved)}`, () => {
      writeFileSync(localSettings, JSON.stringify(merge(existsSync(localSettings) ? readJson(localSettings) : {}, moved), null, 2) + '\n');
    }]);
  }
  // A first install would silently replace a .claude/CLAUDE.md or README.md the repo already has.
  if (firstInstall) {
    for (const f of files.filter((x) => x !== 'settings.json' && existsSync(join(dest, x)) && sha(join(dest, x)) !== sha(join(kitDir, x)))) {
      actions.push([`keep the repo's ${f} as ${f}.pre-kit (the kit's replaces it)`, () => copyFileSync(join(dest, f), join(dest, `${f}.pre-kit`))]);
    }
  }
  for (const f of files) {
    actions.push([`copy ${f}`, () => {
      mkdirSync(dirname(join(dest, f)), { recursive: true });
      copyFileSync(join(kitDir, f), join(dest, f));
    }]);
  }
  for (const f of stale) actions.push([`remove ${f} (no longer in the kit)`, () => rmSync(join(dest, f), { force: true })]);
  if (!existsSync(join(dest, '.gitignore'))) actions.push(['write .gitignore (keeps the kit out of git)', () => writeFileSync(join(dest, '.gitignore'), gitignore)]);
  const excludes = missingExcludes(repo);
  if (excludes) actions.push([`add ${excludes.add.join(', ')} to .git/info/exclude (Playwright's output stays out of git; this clone only)`, () => addExcludes(excludes)]);
  actions.push([`write ${MANIFEST}`, () => writeFileSync(manifestPath, JSON.stringify({ kit: kind, version, commit: kitCommit(kitDir), source: cloneRoot, uncommitted: source.dirty.length > 0, installedAt: new Date().toISOString(), files, settingsSha: sha(kitSettings) }, null, 2))]);

  console.log(`${installed === version ? `Reinstalling ${label} ${version}` : installed ? `Updating ${label} ${installed} → ${version}` : `Installing ${label} ${version}`} in ${dest}`);
  if (source.dirty.length) console.warn(`Warning: this kit checkout has uncommitted changes (${source.dirty.slice(0, 5).join(', ')}${source.dirty.length > 5 ? ' …' : ''}); they ship as they are, not as a release.${source.untracked.length ? ` Not shipped because git doesn't have them: ${source.untracked.slice(0, 5).join(', ')}.` : ''}`);
  for (const [what, act] of actions) {
    if (!dry) { mkdirSync(dest, { recursive: true }); act(); }
    if (!what.startsWith('copy ') || dry) console.log(`${dry ? '[dry run] ' : ''}${what}`);
  }
  // So node update.mjs reaches this repo next time.
  if (!dry) register(cloneRoot, repo, kind);
  console.log(`${dry ? '[dry run] would copy' : 'Copied'} ${files.length} kit files. Kept: ${kept}.`);
  if (moved && !unreadable) console.log('Your own permissions, hooks and env are in .claude/settings.local.json now. Add new ones there: settings.json is replaced on every update.');
  if (unreadable) console.log('Move your own entries from .claude/settings.pre-kit.json into .claude/settings.local.json by hand.');
  console.log(installed ? next.update : next.first);
  return 0;
}
