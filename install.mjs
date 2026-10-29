#!/usr/bin/env node
// Installs or updates the Shopify Implementation Kit in a theme repo.
//   node install.mjs <path-to-theme-repo> [--dry-run] [--force]
// Copies the kit's .claude/ files and leaves the repo's own files alone: shopify-kit.json,
// .env.local, settings.local.json, cli-check.json and logs/. Files a newer kit no longer ships
// are removed (tracked in .claude/.kit-manifest.json).
// settings.json is the kit's and is replaced every time; the repo's own permissions, hooks and env
// live in settings.local.json, which Claude Code merges with it.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// walks the .claude folder to get an array of all the files inside it using walk(). Then, filter out the PER_REPO files from that array.
const files = walk(KIT).filter((f) => !PER_REPO.has(f));

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
const previous = manifest.files || [];
// find out the files the exist in the theme's .claude but not in the new version
const stale = previous.filter((f) => !files.includes(f) && !PER_REPO.has(f));
const version = readFileSync(join(KIT, 'VERSION'), 'utf8').trim();
const installed = existsSync(join(dest, 'VERSION')) ? readFileSync(join(dest, 'VERSION'), 'utf8').trim() : null;

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
actions.push(['write .kit-manifest.json', () => writeFileSync(manifestPath, JSON.stringify({ version, installedAt: new Date().toISOString(), files, settingsSha: sha(kitSettings) }, null, 2))]);

console.log(`${installed ? `Updating kit ${installed} → ${version}` : `Installing kit ${version}`} in ${dest}`);
for (const [what, act] of actions) {
  if (!dry) { mkdirSync(dest, { recursive: true }); act(); }
  if (!what.startsWith('copy ') || dry) console.log(`${dry ? '[dry run] ' : ''}${what}`);
}
console.log(`${dry ? '[dry run] would copy' : 'Copied'} ${files.length} kit files. Kept: shopify-kit.json, .env.local, settings.local.json, cli-check.json, logs/.`);
if (moved && !unreadable) console.log('Your own permissions, hooks and env are in .claude/settings.local.json now. Add new ones there: settings.json is replaced on every update.');
if (unreadable) console.log('Move your own entries from .claude/settings.pre-kit.json into .claude/settings.local.json by hand.');
console.log(installed ? 'Next: open Claude Code in the repo; /shopify-implement runs the CLI check on its own.' : 'Next: open Claude Code in the repo, trust the folder, and run /shopify-setup.');
