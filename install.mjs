#!/usr/bin/env node
// Installs or updates the Shopify Implementation Kit in a theme repo.
//   node install.mjs <path-to-theme-repo> [--dry-run] [--force]
//   node install.mjs <path-to-app-repo> --app [--dry-run] [--force]   hands over to the app kit's installer (app/)
//   node install.mjs --all <folder> [--yes]   lists the theme and app repos under it; --yes installs into those without a kit
// Copies the kit's .claude/ files and leaves the repo's own files alone: shopify-kit.json, .env.local,
// settings.local.json, cli-check.json and logs/. The steps both kits share are installKit in shared/installer-core.mjs.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAll, installKit, MANIFEST } from './shared/installer-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

// The app kit is a separate product in app/ with its own installer. Without --app, everything below runs as before.
{
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('--'));
  if (argv.includes('--all')) process.exit(installAll(ROOT, target, { yes: argv.includes('--yes') }));
  if (argv.includes('--app')) {
    if (argv.includes('--theme')) {
      console.error('Pass --theme or --app, not both.');
      process.exit(1);
    }
    await import('./app/install.mjs');
    process.exit();
  }
}

process.exit(installKit({
  kitDir: join(ROOT, '.claude'),
  cloneRoot: ROOT,
  kind: 'theme',
  label: 'kit',
  // Files each theme repo owns: never copied over, never removed. The installer writes the last two itself.
  perRepo: new Set(['shopify-kit.json', '.env.local', 'settings.local.json', 'cli-check.json', MANIFEST, '.gitignore']),
  gitignore: '# The kit stays out of git for now. When the team commits it, replace this with:\n#   logs/\n#   .env.local\n#   settings.local.json\n#   cli-check.json\n*\n',
  usage: 'Usage: node install.mjs <path-to-theme-repo> [--dry-run] [--force]',
  looksLike: (repo) => (!existsSync(join(repo, 'config', 'settings_schema.json')) && !existsSync(join(repo, 'sections'))
    ? 'doesn\'t look like a Shopify theme (no config/settings_schema.json or sections/)' : null),
  ownRepos: [ROOT, join(ROOT, 'app')],
  kept: 'shopify-kit.json, .env.local, settings.local.json, cli-check.json, logs/',
  next: {
    first: 'Next: open Claude Code in the repo, trust the folder, and run /shopify-setup.',
    update: 'Next: open Claude Code in the repo; /shopify-implement runs the CLI check on its own.',
  },
  args: process.argv.slice(2),
}));
