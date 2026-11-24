#!/usr/bin/env node
// Copies what both kits share from shared/ into each kit's .claude/ (code into kit/, run rules into rules/), which
// installers ship and guards import. The kits install separately (a repo holds one kit), so each needs its own copy;
// this keeps the copies equal.
//   node scripts/sync-shared.mjs           write the copies
//   node scripts/sync-shared.mjs --check   exit 1 if a copy differs from its source (both kits' e2e run this)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// Paths under shared/, copied to the same path under each kit's .claude/ (kit/x.mjs → .claude/kit/x.mjs).
const SHARED = ['kit/core.mjs', 'kit/guard-core.mjs', 'kit/jira.mjs', 'kit/update-check.mjs', 'rules/runs.md'];
const SOURCE = (f) => join(REPO, 'shared', f.startsWith('kit/') ? f.slice(4) : f);
const KITS = ['.claude', 'app/.claude'];
const note = (f) => `Generated from shared/${f.replace(/^kit\//, '')} by scripts/sync-shared.mjs: edit that file, then run node scripts/sync-shared.mjs.`;

/** The copy's text: the note goes after what must stay first (a #! line, a rules file's frontmatter). */
function copyText(f, src) {
  if (f.endsWith('.md')) return src.replace(/^(---\n[\s\S]*?\n---\n)?/, (fm) => `${fm}<!-- ${note(f)} -->\n`);
  return src.startsWith('#!') ? src.replace(/^.*\n/, (l) => `${l}// ${note(f)}\n`) : `// ${note(f)}\n${src}`;
}

const check = process.argv.includes('--check');
const stale = [];
for (const f of SHARED) {
  const text = copyText(f, readFileSync(SOURCE(f), 'utf8'));
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
