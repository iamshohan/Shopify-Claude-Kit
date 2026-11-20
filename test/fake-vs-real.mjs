#!/usr/bin/env node
// Is test/fake-shopify.mjs still printing what the real Shopify CLI prints? The e2e suite only proves the kit agrees
// with the fake; this compares the fake with the real CLI's output structure, which cli-check records (keys and
// types, no values) in each theme repo's .claude/cli-check.json. It reads the theme repos update.mjs knows about.
//   node test/fake-vs-real.mjs    (fails when the fake prints something the newest recorded CLI doesn't)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliJson, shapeOf } from '../.claude/kit/lib.mjs';
import { readRegistry } from '../shared/installer-core.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The exact calls the kit makes (cli() adds --no-input).
const CALLS = {
  'theme list': ['theme', 'list', '--store', 'fake-store.myshopify.com', '--json', '--no-input'],
  'theme info': ['theme', 'info', '--json', '--no-input'],
};

/** Paths in the fake's shape that the real one lacks or types differently; the real CLI may print more. */
function differences(fake, real, path = '') {
  const at = path || '(top level)';
  const kind = (s) => (Array.isArray(s) ? 'an array' : s && typeof s === 'object' ? 'an object' : `a ${s}`);
  if (real === 'null' || real === 'mixed' || fake === 'null' || fake === 'mixed') return [];
  if (Array.isArray(fake) || Array.isArray(real)) {
    if (!Array.isArray(fake) || !Array.isArray(real)) return [`${at}: the fake prints ${kind(fake)}, the CLI ${kind(real)}`];
    return fake.length && real.length ? differences(fake[0], real[0], `${path}[]`) : [];
  }
  if (typeof fake === 'object' || typeof real === 'object') {
    if (typeof fake !== 'object' || typeof real !== 'object') return [`${at}: the fake prints ${kind(fake)}, the CLI ${kind(real)}`];
    return Object.keys(fake).flatMap((k) => (k in real
      ? differences(fake[k], real[k], path ? `${path}.${k}` : k)
      : [`${path ? `${path}.` : ''}${k}: the fake prints it, the CLI doesn't`]));
  }
  return fake === real ? [] : [`${at}: the fake prints ${kind(fake)}, the CLI ${kind(real)}`];
}

const version = (v) => (String(v).match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1); return false; };

function selftest() {
  const cases = [
    [{ themes: [{ id: 'number' }] }, { themes: [{ id: 'number', admin_url: 'string' }] }, 0],
    [[{ id: 'number' }], { themes: [{ id: 'number' }] }, 1],
    [{ themes: [{ id: 'number', processing: 'boolean' }] }, { themes: [{ id: 'number' }] }, 1],
    [{ themes: [{ id: 'number' }] }, { themes: [] }, 0],
    [{ store: 'string' }, { store: 'null' }, 0],
    [{ id: 'string' }, { id: 'number' }, 1],
  ];
  const bad = cases.filter(([f, r, n]) => differences(f, r).length !== n);
  const merged = shapeOf([{ id: 1, role: null }, { id: 2, role: 'live', processing: true }, { id: 3, name: 'x' }]);
  const mergedOk = JSON.stringify(merged) === JSON.stringify([{ id: 'number', name: 'string', processing: 'boolean', role: 'string' }]);
  if (bad.length || !mergedOk) {
    console.log(`FAIL selftest: ${bad.map((c) => JSON.stringify(c)).join(' ')}${mergedOk ? '' : ` shapeOf merge gave ${JSON.stringify(merged)}`}`);
    process.exit(1);
  }
}

function fakeShapes() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-vs-real-'));
  try {
    writeFileSync(join(dir, 'themes.json'), JSON.stringify([{ id: 1, name: 'Live', role: 'live' }, { id: 2, name: 'Draft', role: 'unpublished' }]));
    // Without the test switches (FAKE_LEGACY_LIST, ...), so this is the fake's default output.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FAKE_')));
    return Object.fromEntries(Object.entries(CALLS).map(([name, args]) => {
      const r = spawnSync(process.execPath, [join(REPO, 'test', 'fake-shopify.mjs'), ...args], { env: { ...env, FAKE_SHOPIFY_DIR: dir }, encoding: 'utf8' });
      const data = parseCliJson(r.stdout);
      if (r.status !== 0 || !data) { console.log(`FAIL the fake failed on ${name}: ${r.stderr.trim()}`); process.exit(1); }
      return [name, shapeOf(data)];
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Per command: the shapes recorded by the newest CLI version any theme repo has run cli-check with. */
function newestRecordings() {
  const found = {};
  for (const [repo, kind] of Object.entries(readRegistry(REPO))) {
    if (kind !== 'theme') continue;
    let check;
    try { check = JSON.parse(readFileSync(join(repo, '.claude', 'cli-check.json'), 'utf8')); } catch { continue; }
    const v = version(check.cliVersion);
    if (v.length !== 3) continue;
    for (const [name, shape] of Object.entries(check.shapes || {})) {
      const best = found[name];
      if (!best || newer(v, best.v)) found[name] = { v, cliVersion: check.cliVersion, shapes: [shape], repos: [repo] };
      else if (!newer(best.v, v)) { best.shapes.push(shape); best.repos.push(repo); }
    }
  }
  return found;
}

selftest();
const fake = fakeShapes();
const real = newestRecordings();
const lines = [];
let failed = false;
for (const [name, shape] of Object.entries(fake)) {
  const rec = real[name];
  if (!rec) { lines.push(`--    ${name}: no real CLI output recorded yet (cli-check records it in each theme repo)`); continue; }
  const diffs = [...new Set(rec.shapes.flatMap((s) => differences(shape, s)))];
  if (diffs.length) failed = true;
  lines.push(diffs.length
    ? `FAIL  ${name}: test/fake-shopify.mjs differs from CLI ${rec.cliVersion} (${rec.repos.join(', ')}):\n${diffs.map((d) => `        ${d}`).join('\n')}`
    : `ok    ${name}: matches CLI ${rec.cliVersion} (${rec.repos.length} repo${rec.repos.length === 1 ? '' : 's'})`);
}
console.log(lines.join('\n'));
console.log(failed ? 'the fake CLI is out of date: update test/fake-shopify.mjs (and the kit, if it reads the old shape)' : 'the fake CLI matches every recorded output');
process.exit(failed ? 1 : 0);
