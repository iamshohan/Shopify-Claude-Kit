#!/usr/bin/env node
// Installs or updates the Shopify Implementation Kit in a theme repo.
//   node install.mjs <path-to-theme-repo> [--dry-run] [--force]
//   node install.mjs <path-to-app-repo> --app [--dry-run] [--force]   hands over to the app kit's installer (app/)
// Copies the kit's .claude/ files and leaves the repo's own files alone: shopify-kit.json,
// .env.local, settings.local.json, cli-check.json and logs/. Files a newer kit no longer ships
// are removed (tracked in .claude/.kit-manifest.json).
// settings.json is the kit's and is replaced every time; the repo's own permissions, hooks and env
// live in settings.local.json, which Claude Code merges with it.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitFiles, kitCommit, compareVersions, staleFiles, olderBuild } from './shared/installer-core.mjs';

// The app kit is a separate product in app/ with its own installer. Without --app, everything below runs as before.
{
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  if (argv.includes('--app')) {
    if (argv.includes('--theme')) {
      console.error('Pass --theme or --app, not both.');
      process.exit(1);
    }
    await import('./app/install.mjs');
    process.exit();
  }
  // Only the app kit's manifest names its kit; a theme kit's has no `kit` field.
  let kit;
  try {
    kit = target && JSON.parse(readFileSync(join(resolve(target), '.claude', '.kit-manifest.json'), 'utf8')).kit;
  } catch {}
  if (kit === 'app') {
    console.error(`${resolve(target)} holds the app kit. Update it with: node install.mjs <path> --app`);
    process.exit(1);
  }
}

const KIT = join(dirname(fileURLToPath(import.meta.url)), '.claude');
// Files each theme repo owns: never copied over, never removed. The installer writes the last two itself.
const PER_REPO = new Set(['shopify-kit.json', '.env.local', 'settings.local.json', 'cli-check.json', '.kit-manifest.json', '.gitignore']);
const GITIGNORE = '# The kit stays out of git for now. When the team commits it, replace this with:\n#   logs/\n#   .env.local\n#   settings.local.json\n#   cli-check.json\n*\n';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const force = args.includes('--force');
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.log('Usage: node install.mjs <path-to-theme-repo> [--dry-run] [--force]');
  process.exit(1);
}
const repo = resolve(target);
if (!force && !existsSync(join(repo, 'config', 'settings_schema.json')) && !existsSync(join(repo, 'sections'))) {
  console.error(`${repo} doesn't look like a Shopify theme (no config/settings_schema.json or sections/). Use --force if it is one.`);
  process.exit(1);
}
// Installing over the kit repo would replace the kit with itself and write a manifest that ends maintainer mode.
if ([resolve(KIT, '..'), resolve(KIT, '..', 'app')].includes(repo)) {
  console.error('That is the kit\'s own repo.');
  process.exit(1);
}
const dest = join(repo, '.claude');

// returns an array off all the files inside a folder (except the a folder named logs).
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    // Only .claude/logs/ is task history; a deeper folder named logs is kit content.
    if (statSync(p).isDirectory()) { if (p !== join(KIT, 'logs')) walk(p, out); } else out.push(relative(KIT, p).replaceAll('\\', '/'));
  }
  return out;
}
// The kit's files as git has them (a file never added isn't released), without the PER_REPO files.
const source = kitFiles(KIT, () => walk(KIT));
const files = source.files.filter((f) => !PER_REPO.has(f));

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const manifestPath = join(dest, '.kit-manifest.json');
const firstInstall = !existsSync(manifestPath);
let manifest = {};
try {
  if (!firstInstall) manifest = readJson(manifestPath);
} catch {
  console.warn('Warning: .claude/.kit-manifest.json is unreadable, so files an older kit dropped stay this time.');
}
// Files an older kit shipped that this one doesn't; only paths inside the kit's own folders (see staleFiles).
const stale = staleFiles(dest, manifest.files, files, PER_REPO);
const version = readFileSync(join(KIT, 'VERSION'), 'utf8').trim();
const installed = existsSync(join(dest, 'VERSION')) ? readFileSync(join(dest, 'VERSION'), 'utf8').trim() : null;
// Going back a version would delete the newer kit's files as "stale".
if (installed && compareVersions(installed, version) > 0 && !force) {
  console.error(`${dest} has kit ${installed}, newer than this checkout's ${version}. Update this kit repo (git pull), or pass --force to go back.`);
  process.exit(1);
}
const behind = installed && compareVersions(installed, version) === 0 && olderBuild(KIT, manifest.commit);
if (behind && !force) {
  console.error(`${dest} has a newer build of kit ${version}: ${behind}. Or pass --force to go back.`);
  process.exit(1);
}

// ── settings.json ──
// The kit's file replaces the repo's on every install, so a new hook or deny rule always lands.
// Whatever the repo's file has beyond the kit's moves to settings.local.json first. Claude Code merges
// list keys across the two files, and an allow there doesn't outrank the kit's ask or deny rules.

const destSettings = join(dest, 'settings.json');
const kitSettings = join(KIT, 'settings.json');
const localSettings = join(dest, 'settings.local.json');

// What `a` has that `b` doesn't: list items `b` lacks, and keys whose values differ, recursively.
function extras(a, b) {
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

// Adds `add` into `into`: lists gain the items they lack, and a value `into` already sets stays.
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

// The kit's settings.json runs the guard; a copy merged in by hand (as older installers asked) would run it twice.
function withoutGuard(s) {
  for (const [event, groups] of Object.entries(s.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    s.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !/hooks[\\/]+guard\.mjs/.test(JSON.stringify(h))) }))
      .filter((g) => g.hooks.length);
  }
  return s;
}

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
  for (const f of files.filter((f) => f !== 'settings.json' && existsSync(join(dest, f)) && sha(join(dest, f)) !== sha(join(KIT, f)))) {
    actions.push([`keep the repo's ${f} as ${f}.pre-kit (the kit's replaces it)`, () => copyFileSync(join(dest, f), join(dest, `${f}.pre-kit`))]);
  }
}
for (const f of files) {
  actions.push([`copy ${f}`, () => {
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(join(KIT, f), join(dest, f));
  }]);
}
for (const f of stale) actions.push([`remove ${f} (no longer in the kit)`, () => rmSync(join(dest, f), { force: true })]);
if (!existsSync(join(dest, '.gitignore'))) actions.push(['write .gitignore (keeps the kit out of git)', () => writeFileSync(join(dest, '.gitignore'), GITIGNORE)]);
actions.push(['write .kit-manifest.json', () => writeFileSync(manifestPath, JSON.stringify({ version, commit: kitCommit(KIT), uncommitted: source.dirty.length > 0, installedAt: new Date().toISOString(), files, settingsSha: sha(kitSettings) }, null, 2))]);

console.log(`${installed ? `Updating kit ${installed} → ${version}` : `Installing kit ${version}`} in ${dest}`);
if (source.dirty.length) console.warn(`Warning: this kit checkout has uncommitted changes (${source.dirty.slice(0, 5).join(', ')}${source.dirty.length > 5 ? ' …' : ''}); they ship as they are, not as a release.${source.untracked.length ? ` Not shipped because git doesn't have them: ${source.untracked.slice(0, 5).join(', ')}.` : ''}`);
for (const [what, act] of actions) {
  if (!dry) { mkdirSync(dest, { recursive: true }); act(); }
  if (!what.startsWith('copy ') || dry) console.log(`${dry ? '[dry run] ' : ''}${what}`);
}
console.log(`${dry ? '[dry run] would copy' : 'Copied'} ${files.length} kit files. Kept: shopify-kit.json, .env.local, settings.local.json, cli-check.json, logs/.`);
if (moved && !unreadable) console.log('Your own permissions, hooks and env are in .claude/settings.local.json now. Add new ones there: settings.json is replaced on every update.');
if (unreadable) console.log('Move your own entries from .claude/settings.pre-kit.json into .claude/settings.local.json by hand.');
console.log(installed ? 'Next: open Claude Code in the repo; /shopify-implement runs the CLI check on its own.' : 'Next: open Claude Code in the repo, trust the folder, and run /shopify-setup.');
