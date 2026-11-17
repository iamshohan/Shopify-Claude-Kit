#!/usr/bin/env node
// Updates the kit everywhere on this machine: pulls this clone, then re-runs the installer in every repo it was installed into.
//   node update.mjs                  pull, then update every repo
//   node update.mjs --no-pull        update every repo from this checkout as it is
//   node update.mjs --scan <folder>  also find repos installed before the installer kept a list (one-time), then update
//   node update.mjs --list           show the repos, change nothing
// The installers keep the list (.installs.json here, git-ignored). A repo whose kit is gone drops off it.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry, writeRegistry } from './shared/installer-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const version = () => readFileSync(join(ROOT, '.claude', 'VERSION'), 'utf8').trim();
const appVersion = () => readFileSync(join(ROOT, 'app', '.claude', 'VERSION'), 'utf8').trim();
const manifestOf = (repo) => { try { return JSON.parse(readFileSync(join(repo, '.claude', '.kit-manifest.json'), 'utf8')); } catch { return null; } };

const registry = readRegistry(ROOT);

// Repos installed before 1.2.0 aren't on the list; a manifest marks a kit install, its `kit` field says which kit.
const scanAt = args.indexOf('--scan');
if (scanAt !== -1) {
  const top = args[scanAt + 1];
  if (!top || !existsSync(top)) { console.error('Usage: node update.mjs --scan <folder that holds your theme and app repos>'); process.exit(1); }
  const skip = new Set(['node_modules', '.git', '.claude', 'logs']);
  const walk = (dir, depth) => {
    const manifest = manifestOf(dir);
    if (manifest && resolve(dir) !== resolve(ROOT)) { registry[resolve(dir)] = manifest.kit === 'app' ? 'app' : 'theme'; return; }
    if (depth === 0) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !skip.has(e.name)) walk(join(dir, e.name), depth - 1);
  };
  walk(resolve(top), 4);
  writeRegistry(ROOT, registry);
}

const repos = Object.entries(registry);
if (flag('--list')) {
  console.log(repos.length ? repos.map(([r, k]) => `${k.padEnd(5)}  ${r}${manifestOf(r) ? `  (kit ${manifestOf(r).version})` : '  (no kit there now)'}`).join('\n') : 'No repos yet. Install into one, or: node update.mjs --scan <folder>');
  process.exit(0);
}

if (!flag('--no-pull')) {
  const before = version();
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: ROOT, encoding: 'utf8' });
  // A pull that didn't apply leaves this checkout as it was; installing from it would only repeat the last update.
  if (pull.status !== 0) {
    console.error(`git pull failed, so nothing was updated:\n${(pull.stderr || pull.stdout).trim()}\nFix the clone (local changes or a diverged branch), or run with --no-pull to install this checkout as it is.`);
    process.exit(1);
  }
  console.log(before === version() ? `Kit ${version()}: no newer version on the remote.` : `Pulled kit ${before} → ${version()}.`);
}

if (!repos.length) {
  writeRegistry(ROOT, registry);
  console.log('No repos to update yet. Repos installed from now on are added automatically; for earlier ones: node update.mjs --scan <folder>');
  process.exit(0);
}

console.log(`Updating the kit in ${repos.length} repo${repos.length === 1 ? '' : 's'} on this machine (theme kit ${version()}, app kit ${appVersion()}):`);
let failed = 0;
for (const [repo, kit] of repos) {
  if (!manifestOf(repo)) {
    delete registry[repo];
    console.log(`  -  ${repo}: no kit there any more, dropped from the list`);
    continue;
  }
  const run = spawnSync(process.execPath, [join(ROOT, 'install.mjs'), repo, ...(kit === 'app' ? ['--app'] : [])], { cwd: ROOT, encoding: 'utf8' });
  const headline = (run.stdout || '').split(/\r?\n/).find((l) => /^(Updating|Installing)/.test(l)) || '';
  if (run.status === 0) console.log(`  ok ${repo}: ${headline.replace(/ in .*$/, '') || 'updated'}`);
  else { failed++; console.log(`  !! ${repo}: ${(run.stderr || run.stdout).trim().split(/\r?\n/)[0]}`); }
}
writeRegistry(ROOT, registry);
console.log(failed
  ? `${failed} repo${failed === 1 ? '' : 's'} not updated; run node install.mjs <repo> there to see why.`
  : 'Done. A Claude Code session already open in one of these repos picks up new hooks and settings when it restarts.');
process.exit(failed ? 1 : 0);
