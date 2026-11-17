#!/usr/bin/env node
// Collects the kit's task logs from every repo on this machine into kit-logs/<date>/, so whoever improves the kit
// (a person or an agent) can read real runs: the plans, reports, kit notes and guard blocks.
//   node export-logs.mjs          tasks changed since the last export
//   node export-logs.mjs --all    every task again
// Repos come from the installers' list (.installs.json; node update.mjs --scan adds older ones). Text files only:
// no screenshots, theme pulls or A/B code. Exports older than 90 days are deleted. kit-logs/ is git-ignored.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegistry } from './shared/installer-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.SHOPIFY_KIT_EXPORT || join(ROOT, 'kit-logs'); // the e2e suite points it at a temp folder
const KEEP_DAYS = 90;
const TEXT = /\.(md|json|jsonl|txt)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const lastPath = join(OUT, 'last-export.json');
let since = 0;
if (!process.argv.includes('--all')) try { since = Date.parse(JSON.parse(readFileSync(lastPath, 'utf8')).at) || 0; } catch { /* first export */ }
const startedAt = new Date();
const day = startedAt.toISOString().slice(0, 10);
const dest = join(OUT, day);

// Two repos with one folder name (two clones of "theme") get a short tag from their full path.
const repos = Object.entries(readRegistry(ROOT));
const names = repos.map(([r]) => basename(r));
const label = (repo) => (names.filter((n) => n === basename(repo)).length > 1 ? `${basename(repo)}-${createHash('sha1').update(repo).digest('hex').slice(0, 6)}` : basename(repo));

const textFiles = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && TEXT.test(e.name)).map((e) => join(dir, e.name)); } catch { return []; } };
const changed = (files) => files.some((f) => statSync(f).mtimeMs > since);
/** Copies the text files at the top of each task folder under `from` that changed since the last export. */
function copyTasks(from, to) {
  const done = [];
  let dirs = [];
  try { dirs = readdirSync(from, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return done; }
  for (const d of dirs) {
    const files = textFiles(join(from, d.name)).filter((f) => statSync(f).size <= MAX_BYTES);
    if (!files.length || !changed(files)) continue;
    mkdirSync(join(to, d.name), { recursive: true });
    for (const f of files) copyFileSync(f, join(to, d.name, basename(f)));
    done.push(d.name);
  }
  return done;
}

const index = [];
for (const [repo, kit] of repos) {
  if (!existsSync(repo)) continue;
  const to = join(dest, label(repo));
  const tasks = copyTasks(join(repo, '.claude', 'logs'), join(to, 'logs'));
  // The app kit's changes live in appspec/ (committed), its notes in .claude/logs/.
  if (kit === 'app') tasks.push(...copyTasks(join(repo, 'appspec', 'changes'), join(to, 'changes')), ...copyTasks(join(repo, 'appspec', 'archive'), join(to, 'archive')));
  // The guard log and kit-feedback.md sit at the top of .claude/logs/.
  const top = textFiles(join(repo, '.claude', 'logs')).filter((x) => statSync(x).mtimeMs > since && statSync(x).size <= MAX_BYTES);
  for (const f of top) {
    mkdirSync(join(to, 'logs'), { recursive: true });
    copyFileSync(f, join(to, 'logs', basename(f)));
  }
  if (tasks.length || top.length) index.push(`- **${label(repo)}** (${kit} kit, ${repo}): ${tasks.length ? tasks.join(', ') : 'guard log only'}`);
}

// Old exports go, so the folder never grows past about three months.
const cutoff = startedAt.getTime() - KEEP_DAYS * 86400000;
let removed = 0;
for (const d of existsSync(OUT) ? readdirSync(OUT) : []) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Date.parse(d) < cutoff) { rmSync(join(OUT, d), { recursive: true, force: true }); removed++; }
}

if (index.length) {
  mkdirSync(dest, { recursive: true });
  const indexPath = join(dest, 'index.md');
  const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').trimEnd() : `# Kit logs · ${day}\n\nTask logs from every kit repo on this machine. Read them for what went wrong and what the kit could do better.`;
  writeFileSync(indexPath, `${before}\n\n## Export at ${startedAt.toISOString().slice(11, 16)} UTC${since ? `, changes since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')}` : ''}\n\n${index.join('\n')}\n`);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(lastPath, JSON.stringify({ at: startedAt.toISOString() }, null, 2) + '\n');
console.log(index.length ? `Exported ${index.length} repo${index.length === 1 ? '' : 's'} to kit-logs/${day}/` : `Nothing changed since the last export (${repos.length} repos checked).`);
if (!repos.length) console.log('No repos listed yet: they join when the kit is installed or updated, or with node update.mjs --scan <folder>.');
if (removed) console.log(`Removed ${removed} export${removed === 1 ? '' : 's'} older than ${KEEP_DAYS} days.`);
