#!/usr/bin/env node
// Compares app/.claude/kit/toml.mjs with the Shopify CLI's own parse of a real app (shopify app info -j).
// Needs the CLI and a login, so it isn't part of the offline e2e. Read-only: it never prints values, only differing paths.
//   node test/app-toml-parity.mjs <app-repo> [<app-repo> ...]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { parseToml } = await import(new URL('../.claude/kit/toml.mjs', import.meta.url));
const { parseCliJson } = await import(new URL('../.claude/kit/core.mjs', import.meta.url));

function diffPaths(a, b, path = '', out = []) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], `${path}.${k}`, out);
  } else out.push(path || '(root)');
  return out;
}

let failed = 0;
let compared = 0;
// No repos would compare nothing and look like a pass.
if (!process.argv.slice(2).length) {
  console.error('Usage: node test/app-toml-parity.mjs <app-repo> [<app-repo> ...]   (needs the Shopify CLI and a login)');
  process.exit(1);
}
for (const repo of process.argv.slice(2)) {
  const r = spawnSync('shopify', ['app', 'info', '-j', '--no-input', '--path', repo], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
  const info = parseCliJson(r.stdout);
  if (!info?.project) { console.log(`SKIP  ${repo}: app info gave no project (${r.stderr.trim().split('\n').pop()})`); continue; }
  const files = [...info.project.appConfigFiles, ...info.project.extensionConfigFiles];
  for (const f of files) {
    const mine = parseToml(readFileSync(f.path, 'utf8'));
    const d = diffPaths(mine, f.content);
    compared++;
    if (d.length) failed++;
    console.log(`${d.length ? 'FAIL' : 'ok  '}  ${f.path.replace(/\\/g, '/').split('/').slice(-3).join('/')}${d.length ? `  differs at ${d.slice(0, 5).join(', ')}` : ''}`);
  }
}
// Every repo skipped compared nothing: that's no pass either.
if (!compared) console.log('FAIL  no file was compared: every repo was skipped');
process.exit(failed || !compared ? 1 : 0);
