#!/usr/bin/env node
// Installs or updates the Shopify App Kit in an app repo.
//   node install.mjs <path-to-app-repo> --app [--dry-run] [--force]   from the kit repo's root, which hands over to this file
// Copies the kit's .claude/ files and leaves the repo's own files alone: app-kit.json, .env.local, settings.local.json,
// cli-check.json and logs/. The app's records (appspec/) are the repo's own and committed; this installer never touches them.
// The steps both kits share are installKit in ../shared/installer-core.mjs.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installKit, MANIFEST } from '../shared/installer-core.mjs';

const APP = dirname(fileURLToPath(import.meta.url));

process.exitCode = installKit({
  kitDir: join(APP, '.claude'),
  cloneRoot: join(APP, '..'),
  kind: 'app',
  label: 'app kit',
  // Files each app repo owns: never copied over, never removed. The installer writes the last two itself.
  perRepo: new Set(['app-kit.json', '.env.local', 'settings.local.json', 'cli-check.json', MANIFEST, '.gitignore']),
  gitignore: '# The kit stays out of git for now (appspec/ at the repo root is committed). When the team commits the kit, replace this with:\n#   logs/\n#   .env.local\n#   settings.local.json\n#   cli-check.json\n#   app-kit.json\n*\n',
  usage: 'Usage: node install.mjs <path-to-app-repo> --app [--dry-run] [--force]',
  looksLike: (repo) => (!readdirSync(repo).some((f) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(f)) ? 'doesn\'t look like a Shopify app (no shopify.app.toml)' : null),
  // app/ itself, or the kit repo's root: devs reach this file through the root installer, so `.` there is the theme kit's repo.
  ownRepos: [APP, join(APP, '..')],
  kept: 'app-kit.json, .env.local, settings.local.json, cli-check.json, logs/',
  next: {
    first: 'Next: open Claude Code in the repo, trust the folder, and run /app-setup.',
    update: 'Next: open Claude Code in the repo; the kit runs its CLI check on its own.',
  },
  args: process.argv.slice(2),
});
