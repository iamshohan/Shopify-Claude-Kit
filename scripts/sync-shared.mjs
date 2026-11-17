#!/usr/bin/env node
// Copies the code both kits share from shared/ into each kit's .claude/kit/, which installers ship and guards import.
// The kits install separately (a repo holds one kit), so each needs its own copy; this keeps the copies equal.
//   node scripts/sync-shared.mjs           write the copies
//   node scripts/sync-shared.mjs --check   exit 1 if a copy differs from its source (both kits' e2e run this)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['guard-core.mjs', 'jira.mjs', 'update-check.mjs'];
const KITS = ['.claude/kit', 'app/.claude/kit'];
const header = (f) => `// Generated from shared/${f} by scripts/sync-shared.mjs: edit that file, then run node scripts/sync-shared.mjs.\n`;

const check = process.argv.includes('--check');
const stale = [];
for (const f of SHARED) {
  const src = readFileSync(join(REPO, 'shared', f), 'utf8');
  // A #! line must stay first, or node refuses the file.
  const text = src.startsWith('#!') ? src.replace(/^.*\n/, (l) => l + header(f)) : header(f) + src;
  for (const kit of KITS) {
    const to = join(REPO, kit, f);
    const now = existsSync(to) ? readFileSync(to, 'utf8') : null;
    if (now === text) continue;
    if (check) stale.push(`${kit}/${f}`);
    else { writeFileSync(to, text); console.log(`wrote ${kit}/${f}`); }
  }
}
if (check && stale.length) {
  console.error(`Out of step with shared/: ${stale.join(', ')}. Edit shared/, then run node scripts/sync-shared.mjs.`);
  process.exit(1);
}
if (check) console.log(`shared code in step (${SHARED.length} files × ${KITS.length} kits)`);
