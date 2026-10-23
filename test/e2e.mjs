#!/usr/bin/env node
// End-to-end test of the kit's scripts, offline: installs the kit into a temporary theme repo
// (with a bare "origin"), puts test/fake-shopify.mjs on PATH as `shopify`, and drives
// draft → push → live drift → merge → push → check → contract → mutate through the real scripts and guard.
//   node test/e2e.mjs [--keep]      --keep leaves the temp folder for inspection
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const KIT = resolveKit();
const KEY = 'ABC-1';
const tmp = mkdtempSync(join(tmpdir(), 'kit-e2e-'));
const repo = join(tmp, 'theme');
const store = join(tmp, 'store');
const bin = join(tmp, 'bin');
const results = [];

function resolveKit() { return join(dirname(fileURLToPath(import.meta.url)), '..'); }
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || !detail ? '' : `\n      ${String(detail).trim().split('\n').slice(0, 8).join('\n      ')}`}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
const live = (rel) => join(store, 'themes', '1', rel);
const setLive = (rel, text) => { mkdirSync(dirname(live(rel)), { recursive: true }); writeFileSync(live(rel), text); };
const commit = (msg) => { git('add', '-A'); git('commit', '-qm', msg); };
const calls = () => readFileSync(join(store, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const env = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey]}`, FAKE_SHOPIFY_DIR: store };
function kit(script, ...args) {
  const r = spawnSync(process.execPath, [join(repo, '.claude', 'kit', script), ...args], { cwd: repo, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
const json = (r) => { try { return JSON.parse(r.out); } catch { return {}; } };
const state = () => JSON.parse(readFileSync(join(repo, '.claude', 'logs', KEY, 'state.json'), 'utf8'));

// product.json: the branch edits "a", live edits "d"; the lines between keep the merge free of conflicts.
const product = (a, d) => `{\n  "sections": {\n    "main": { "type": "main-product" },\n    "a": { "type": "x", "settings": { "title": "${a}" } },\n    "b": { "type": "y" },\n    "c": { "type": "z" },\n    "d": { "type": "w", "settings": { "title": "${d}" } }\n  },\n  "order": ["main", "a", "b", "c", "d"]\n}\n`;

try {
  // The fake CLI, as `shopify` on PATH.
  mkdirSync(bin);
  const fake = join(KIT, 'test', 'fake-shopify.mjs');
  if (process.platform === 'win32') writeFileSync(join(bin, 'shopify.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  else { writeFileSync(join(bin, 'shopify'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(join(bin, 'shopify'), 0o755); }

  // A theme repo whose main equals the live theme, pushed to a bare origin.
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', join(tmp, 'origin.git')]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'e2e'); git('config', 'core.autocrlf', 'false');
  write('layout/theme.liquid', '{{ content_for_layout }}\n');
  write('sections/header.liquid', '<header></header>\n');
  write('config/settings_schema.json', '[{ "name": "theme_info", "theme_name": "E2E" }]\n');
  write('templates/product.json', product('A', 'D'));
  commit('base');
  git('remote', 'add', 'origin', join(tmp, 'origin.git'));
  git('push', '-q', '-u', 'origin', 'main');

  mkdirSync(join(store, 'themes'), { recursive: true });
  writeFileSync(join(store, 'themes.json'), JSON.stringify([{ id: 1, name: 'Live', role: 'live' }]));
  writeFileSync(join(store, 'calls.jsonl'), '');
  cpSync(repo, join(store, 'themes', '1'), { recursive: true, filter: (p) => !p.includes('.git') });

  const install = spawnSync(process.execPath, [join(KIT, 'install.mjs'), repo], { encoding: 'utf8' });
  ok('installer copies the kit', install.status === 0 && existsSync(join(repo, '.claude', 'kit', 'shopify.mjs')), install.stderr);
  writeFileSync(join(repo, '.claude', 'shopify-kit.json'), JSON.stringify({
    store: 'fake-store.myshopify.com', baseBranch: 'main', protectedBranches: ['main'], branchPattern: '{KEY}', adminApi: true, draftRoute: 'cli', adminApiVersion: '2026-07',
  }));

  // Task start, branch, baseline.
  ok('kit start', kit('kit.mjs', 'start', KEY).code === 0);
  git('switch', '-q', '--no-track', '-c', KEY, 'origin/main');
  const base = git('rev-parse', 'origin/main');
  kit('kit.mjs', 'set', KEY, `branch=${KEY}`, `base=${base}`);
  const baseline = kit('shopify.mjs', 'check', KEY, '--baseline');
  ok('theme-check baseline on a clean tree', baseline.code === 0, baseline.all);

  // The feature, a draft, a first push.
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  write('templates/product.json', product('A2', 'D'));
  commit('feature');
  const draft = kit('shopify.mjs', 'draft', KEY);
  ok('draft copies live into an unpublished theme named after the key', draft.code === 0 && state().draft.themeId === 2, draft.all);
  const push1 = kit('shopify.mjs', 'push', KEY);
  ok('push uploads and verifies', push1.code === 0 && existsSync(join(store, 'themes', '2', 'sections', 'feature.liquid')), push1.all);

  // Live changes: a merchant edit that Shopify syncs into main, and a teammate's merged section.
  git('switch', '-q', 'main');
  write('templates/product.json', product('A', 'D2'));
  commit('Update from Shopify for theme Live');
  write('sections/teammate.liquid', '<div>OFFENSE from a teammate</div>\n');
  commit('teammate feature');
  git('push', '-q', 'origin', 'main');
  setLive('templates/product.json', product('A', 'D2'));
  setLive('sections/teammate.liquid', '<div>OFFENSE from a teammate</div>\n');
  git('switch', '-q', KEY);

  const drift = kit('shopify.mjs', 'push', KEY);
  ok('push refuses when live changed a JSON file the branch changes', drift.code === 3 && /Live has changed templates\/product\.json/.test(drift.err), drift.all);

  // The documented fix: merge the base branch. Before kit 0.5 this push was refused forever.
  git('fetch', '-q', 'origin');
  git('merge', '-q', '--no-edit', 'origin/main');
  const before = calls().length;
  const push2 = kit('shopify.mjs', 'push', KEY);
  ok('after merging main, push goes through', push2.code === 0, push2.all);
  const sent = calls().slice(before).filter((c) => c.cmd === 'theme push').flatMap((c) => c.flags.only);
  ok('push sends only this task\'s files, not merged-in work', sent.includes('sections/feature.liquid') && !sent.includes('sections/teammate.liquid'), JSON.stringify(sent));

  const check1 = kit('shopify.mjs', 'check', KEY);
  ok('check doesn\'t count a merged-in offense as introduced', check1.code === 0 && json(check1).introducedErrors === 0, check1.all);
  write('sections/feature.liquid', '<div class="e2e-feature">OFFENSE</div>\n');
  commit('feature with an offense');
  ok('check counts an offense the branch adds', json(kit('shopify.mjs', 'check', KEY)).introducedErrors === 1);
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  commit('fix the offense');

  const contract = kit('contract.mjs', KEY);
  ok('contract covers this task\'s sections only', contract.code === 0 && /feature\.liquid/.test(contract.out) && !/teammate/.test(contract.out), contract.all);

  // A live edit that never reaches git: reconcile by hand, then --reconciled pins that live version.
  setLive('templates/product.json', product('A', 'D3'));
  write('templates/product.json', product('A2', 'D3'));
  commit('copy live\'s D3 edit into the branch');
  ok('an unsynced live edit is refused', kit('shopify.mjs', 'push', KEY).code === 3);
  const wrong = kit('shopify.mjs', 'push', KEY, '--reconciled', 'templates/index.json');
  ok('--reconciled refuses a file live didn\'t change', wrong.code === 1 && /hasn't changed since the base/.test(wrong.err), wrong.all);
  const rec = kit('shopify.mjs', 'push', KEY, '--reconciled', 'templates/product.json');
  ok('--reconciled lets the confirmed file through', rec.code === 0, rec.all);
  ok('the reconciliation holds for the next push', kit('shopify.mjs', 'push', KEY).code === 0);
  setLive('templates/product.json', product('A', 'D4'));
  ok('a later live edit to the same file is refused again', kit('shopify.mjs', 'push', KEY).code === 3);
  setLive('templates/product.json', product('A', 'D3'));

  ok('verify: the draft matches HEAD', kit('shopify.mjs', 'verify', KEY).code === 0);

  // The wrapper never writes to a theme that isn't an unpublished draft, even if the state points at live.
  kit('kit.mjs', 'set', KEY, 'draft.themeId=1');
  const toLive = kit('shopify.mjs', 'push', KEY);
  ok('push refuses a state that points at the live theme', toLive.code === 1 && /not unpublished/.test(toLive.err), toLive.all);
  kit('kit.mjs', 'set', KEY, 'draft.themeId=2');

  // Mutations run only after the guard showed them to the dev, and only once.
  const mfile = `.claude/logs/${KEY}/mutations/01-def.graphql`;
  write(mfile, 'mutation Def($d: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }\n');
  const unsealed = kit('shopify.mjs', 'mutate', KEY, mfile);
  ok('mutate refuses a call the guard never showed', unsealed.code === 1 && /wasn't shown/.test(unsealed.err), unsealed.all);
  const hook = spawnSync(process.execPath, [join(repo, '.claude', 'hooks', 'guard.mjs')], {
    cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node .claude/kit/shopify.mjs mutate ${KEY} ${mfile}` }, cwd: repo }),
  });
  ok('the guard asks the dev, showing the mutation', /"permissionDecision":"ask"/.test(hook.stdout) && /metafieldDefinitionCreate/.test(hook.stdout), hook.stdout + hook.stderr);
  const sealed = kit('shopify.mjs', 'mutate', KEY, mfile);
  ok('mutate runs once after the guard\'s prompt', sealed.code === 0 && state().mutations.at(-1)?.ids.includes('gid://shopify/MetafieldDefinition/901'), sealed.all);
  ok('the seal is single-use', kit('shopify.mjs', 'mutate', KEY, mfile).code === 1);

  // Lanes.
  ok('start --small', kit('kit.mjs', 'start', 'ABC-2', '--small').out.includes('Small lane'));
  ok('lane full switches back before approval', kit('kit.mjs', 'lane', 'ABC-2', 'full').code === 0 && !kit('kit.mjs', 'status', 'ABC-2').out.includes('Small lane'));

  const violations = join(store, 'violations.jsonl');
  ok('nothing wrote to the live theme', !existsSync(violations), existsSync(violations) ? readFileSync(violations, 'utf8') : '');
} catch (e) {
  ok('harness ran to the end', false, e.stack || e.message);
} finally {
  if (process.argv.includes('--keep')) console.log(`kept: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
