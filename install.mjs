#!/usr/bin/env node
// Installs or updates the Shopify Implementation Kit in a theme repo.
//   node install.mjs <path-to-theme-repo> [--dry-run] [--force]
// Copies the kit's .claude/ files and leaves the repo's own files alone: shopify-kit.json,
// .env.local, settings.local.json, cli-check.json and logs/. Files a newer kit no longer ships
// are removed (tracked in .claude/.kit-manifest.json).
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

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'logs') walk(p, out); } else out.push(relative(KIT, p).replaceAll('\\', '/'));
  }
  return out;
}
const files = walk(KIT).filter((f) => !PER_REPO.has(f));

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const manifestPath = join(dest, '.kit-manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const previous = manifest.files || [];

// settings.json is the repo's own once it differs from what this installer wrote last time
// (for a manifest from an older installer, which recorded no hash: once it lacks the kit's guard).
// The kit's version goes beside it, to merge by hand.
const destSettings = join(dest, 'settings.json');
const kitSettings = join(KIT, 'settings.json');
const ownSettings = existsSync(destSettings) && sha(destSettings) !== sha(kitSettings)
  && (manifest.settingsSha ? sha(destSettings) !== manifest.settingsSha : !readFileSync(destSettings, 'utf8').includes('.claude/hooks/guard.mjs'));
const stale = previous.filter((f) => !files.includes(f) && !PER_REPO.has(f));
const version = readFileSync(join(KIT, 'VERSION'), 'utf8').trim();
const installed = existsSync(join(dest, 'VERSION')) ? readFileSync(join(dest, 'VERSION'), 'utf8').trim() : null;

// Plan every step first, so --dry-run prints the same list without touching the repo.
const actions = [];
for (const f of files) {
  const to = f === 'settings.json' && ownSettings ? 'settings.kit.json' : f;
  actions.push([`copy ${f}${to !== f ? ` → ${to} (the repo has its own settings.json)` : ''}`, () => {
    mkdirSync(dirname(join(dest, to)), { recursive: true });
    copyFileSync(join(KIT, f), join(dest, to));
  }]);
}
for (const f of stale) actions.push([`remove ${f} (no longer in the kit)`, () => rmSync(join(dest, f), { force: true })]);
if (!existsSync(join(dest, '.gitignore'))) actions.push(['write .gitignore (keeps the kit out of git)', () => writeFileSync(join(dest, '.gitignore'), GITIGNORE)]);
actions.push(['write .kit-manifest.json', () => writeFileSync(manifestPath, JSON.stringify({ version, installedAt: new Date().toISOString(), files, settingsSha: ownSettings ? manifest.settingsSha : sha(kitSettings) }, null, 2))]);

console.log(`${installed ? `Updating kit ${installed} → ${version}` : `Installing kit ${version}`} in ${dest}`);
for (const [what, act] of actions) {
  if (!dry) { mkdirSync(dest, { recursive: true }); act(); }
  if (!what.startsWith('copy ') || dry) console.log(`${dry ? '[dry run] ' : ''}${what}`);
}
console.log(`${dry ? '[dry run] would copy' : 'Copied'} ${files.length} kit files. Kept: shopify-kit.json, .env.local, settings.local.json, cli-check.json, logs/.`);
if (ownSettings) console.log('This repo has its own .claude/settings.json: merge the hooks, permissions and env from .claude/settings.kit.json into it.');
console.log(installed ? 'Next: open Claude Code in the repo; /shopify-implement runs the CLI check on its own.' : 'Next: open Claude Code in the repo, trust the folder, and run /shopify-setup.');
