// Install-time rules both installers share (install.mjs for the theme kit, app/install.mjs for the app kit). Installers run
// from the kit repo itself, so both import this file directly; it is never copied into a theme or app repo.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

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

// ── Installed repos (update.mjs) ──
// Every repo this clone installed into, so `node update.mjs` can refresh them all. It lives in the clone, git-ignored:
// paths are per machine. SHOPIFY_KIT_REGISTRY moves it (the e2e suites point it at a temp file).

export const registryPath = (cloneRoot) => process.env.SHOPIFY_KIT_REGISTRY || join(cloneRoot, '.installs.json');

/** { "<absolute repo path>": "theme" | "app" }; empty when missing or unreadable. */
export function readRegistry(cloneRoot) {
  try {
    const r = JSON.parse(readFileSync(registryPath(cloneRoot), 'utf8'));
    return r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  } catch { return {}; }
}

export function writeRegistry(cloneRoot, registry) {
  writeFileSync(registryPath(cloneRoot), JSON.stringify(registry, null, 2) + '\n');
}

/** Records a repo after an install. A failed write only costs update.mjs that repo, so it never fails the install. */
export function register(cloneRoot, repo, kit) {
  try { writeRegistry(cloneRoot, { ...readRegistry(cloneRoot), [resolve(repo)]: kit }); } catch { /* read-only clone */ }
}

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
