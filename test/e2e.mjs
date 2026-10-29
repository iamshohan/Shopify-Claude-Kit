#!/usr/bin/env node
// End-to-end test of the kit's scripts, offline: installs the kit into a temporary theme repo
// (with a bare "origin"), puts test/fake-shopify.mjs on PATH as `shopify`, and drives install → draft → push →
// live drift → merge → push → check → contract → reconcile → mutate → lanes through the real scripts and guard.
//   node test/e2e.mjs [--keep]      --keep leaves the temp folder for inspection
// Exits 1 if any check fails.
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Harness ──
// KIT is the kit repo root (install.mjs, test/), not its .claude/ as in install.mjs.

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

  // ── Fixtures: fake CLI, theme repo, store ──

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

  // ── Install and update ──

  const install = spawnSync(process.execPath, [join(KIT, 'install.mjs'), repo], { encoding: 'utf8' });
  ok('installer copies the kit, rules included', install.status === 0 && existsSync(join(repo, '.claude', 'kit', 'shopify.mjs')) && existsSync(join(repo, '.claude', 'rules', 'kit-runs.md')), install.stderr);
  // settings.json is always the kit's; the dev's own entries end up in settings.local.json, never lost.
  const reinstall = () => spawnSync(process.execPath, [join(KIT, 'install.mjs'), repo], { encoding: 'utf8' });
  const settingsPath = join(repo, '.claude', 'settings.json');
  const localPath = join(repo, '.claude', 'settings.local.json');
  const manifestPath = join(repo, '.claude', '.kit-manifest.json');
  const kitSettings = readFileSync(join(KIT, '.claude', 'settings.json'), 'utf8');
  const local = () => (existsSync(localPath) ? readFileSync(localPath, 'utf8') : '');
  const again = reinstall();
  ok('an update leaves no settings.local.json while settings.json is the kit\'s own', again.status === 0 && !existsSync(localPath), again.stdout);
  writeFileSync(settingsPath, kitSettings.replace('"allow": [', '"allow": [\n      "Bash(npm run dev:*)",'));
  const update = reinstall();
  ok('an update moves the dev\'s added permission to settings.local.json and restores the kit\'s settings.json',
    update.status === 0 && readFileSync(settingsPath, 'utf8') === kitSettings && JSON.parse(local()).permissions.allow.join() === 'Bash(npm run dev:*)', update.stdout);
  // A repo with its own settings.json before the first install, whose dev then merges the guard in by hand.
  // The 0.6.0 installer overwrote it on the second install: the manifest had no hash, and the guard string read as "kit's".
  rmSync(localPath);
  rmSync(manifestPath);
  writeFileSync(settingsPath, JSON.stringify({ env: { MY_FLAG: '1' }, permissions: { allow: ['Bash(npm run dev:*)'] } }));
  writeFileSync(join(repo, '.claude', 'CLAUDE.md'), 'The repo\'s own notes\n');
  const first = reinstall();
  const moved = local();
  ok('a first install moves a repo\'s own settings.json to settings.local.json',
    first.status === 0 && readFileSync(settingsPath, 'utf8') === kitSettings && /npm run dev/.test(moved) && /MY_FLAG/.test(moved), first.stdout);
  ok('a first install keeps a copy of the repo\'s own CLAUDE.md',
    readFileSync(join(repo, '.claude', 'CLAUDE.md.pre-kit'), 'utf8') === 'The repo\'s own notes\n', first.stdout);
  writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Bash(npm run dev:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }] }] },
  }));
  const merged = reinstall();
  ok('an update after the dev merged the guard in keeps their entries once and doesn\'t copy the guard',
    merged.status === 0 && local() === moved && readFileSync(settingsPath, 'utf8') === kitSettings, merged.stdout);
  writeFileSync(manifestPath, '{');
  const corrupt = reinstall();
  ok('an unreadable manifest warns instead of crashing', corrupt.status === 0 && /unreadable/.test(corrupt.stderr), corrupt.stderr);
  // Back to a clean install, then the config /shopify-setup would write.
  rmSync(localPath);
  rmSync(join(repo, '.claude', 'CLAUDE.md.pre-kit'));
  writeFileSync(join(repo, '.claude', 'shopify-kit.json'), JSON.stringify({
    store: 'fake-store.myshopify.com', baseBranch: 'main', protectedBranches: ['main'], branchPattern: '{KEY}', adminApi: true, draftRoute: 'cli', adminApiVersion: '2026-07',
  }));

  // ── Task start, branch, baseline ──
  ok('kit start', kit('kit.mjs', 'start', KEY).code === 0);
  // A Figma design makes analyze wait for design.md; "none" lifts that. The state is put back afterwards.
  const statePath = join(repo, '.claude', 'logs', KEY, 'state.json');
  const fresh = readFileSync(statePath, 'utf8');
  writeFileSync(statePath, JSON.stringify({ ...state(), stage: 'analyze' }));
  kit('kit.mjs', 'set', KEY, 'design.figma=https://www.figma.com/design/abc/Feature');
  const withDesign = kit('kit.mjs', 'done', KEY, 'analyze');
  kit('kit.mjs', 'set', KEY, 'design.figma=none');
  const noDesign = kit('kit.mjs', 'done', KEY, 'analyze');
  ok('analyze asks for design.md only while a Figma design is set',
    withDesign.code !== 0 && /design-extractor/.test(withDesign.all) && !/design-extractor/.test(noDesign.all), withDesign.all + noDesign.all);
  writeFileSync(statePath, fresh);
  git('switch', '-q', '--no-track', '-c', KEY, 'origin/main');
  const base = git('rev-parse', 'origin/main');
  kit('kit.mjs', 'set', KEY, `branch=${KEY}`, `base=${base}`);
  const baseline = kit('shopify.mjs', 'check', KEY, '--baseline');
  ok('theme-check baseline on a clean tree', baseline.code === 0, baseline.all);

  // ── The feature, a draft, a first push ──
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  write('templates/product.json', product('A2', 'D'));
  commit('feature');
  const draft = kit('shopify.mjs', 'draft', KEY);
  ok('draft copies live into an unpublished theme named after the key', draft.code === 0 && state().draft.themeId === 2, draft.all);
  const push1 = kit('shopify.mjs', 'push', KEY);
  ok('push uploads and verifies', push1.code === 0 && existsSync(join(store, 'themes', '2', 'sections', 'feature.liquid')), push1.all);

  // ── Live drift ──
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

  // ── Merge main, push again ──
  // The documented fix: merge the base branch. Before kit 0.5 this push was refused forever.
  git('fetch', '-q', 'origin');
  git('merge', '-q', '--no-edit', 'origin/main');
  const before = calls().length;
  const push2 = kit('shopify.mjs', 'push', KEY);
  ok('after merging main, push goes through', push2.code === 0, push2.all);
  const sent = calls().slice(before).filter((c) => c.cmd === 'theme push').flatMap((c) => c.flags.only);
  ok('push sends only this task\'s files, not merged-in work', sent.includes('sections/feature.liquid') && !sent.includes('sections/teammate.liquid'), JSON.stringify(sent));

  // ── Theme check and contract ──
  // Both count only what this branch changed, not what the merge brought in.

  const check1 = kit('shopify.mjs', 'check', KEY);
  ok('check doesn\'t count a merged-in offense as introduced', check1.code === 0 && json(check1).introducedErrors === 0, check1.all);
  write('sections/feature.liquid', '<div class="e2e-feature">OFFENSE</div>\n');
  commit('feature with an offense');
  ok('check counts an offense the branch adds', json(kit('shopify.mjs', 'check', KEY)).introducedErrors === 1);
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  commit('fix the offense');

  const contract = kit('contract.mjs', KEY);
  ok('contract covers this task\'s sections only', contract.code === 0 && /feature\.liquid/.test(contract.out) && !/teammate/.test(contract.out), contract.all);

  // ── Reconcile an unsynced live edit ──
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

  // ── Verify, and never write to live ──

  ok('verify: the draft matches HEAD', kit('shopify.mjs', 'verify', KEY).code === 0);

  // The wrapper never writes to a theme that isn't an unpublished draft, even if the state points at live.
  kit('kit.mjs', 'set', KEY, 'draft.themeId=1');
  const toLive = kit('shopify.mjs', 'push', KEY);
  ok('push refuses a state that points at the live theme', toLive.code === 1 && /not unpublished/.test(toLive.err), toLive.all);
  kit('kit.mjs', 'set', KEY, 'draft.themeId=2');

  // ── Mutations ──
  // Mutations run only after the guard showed them to the dev, and only once.
  const mfile = `.claude/logs/${KEY}/mutations/01-def.graphql`;
  write(mfile, 'mutation Def($d: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }\n');
  const unsealed = kit('shopify.mjs', 'mutate', KEY, mfile);
  ok('mutate refuses a call the guard never showed', unsealed.code === 1 && /wasn't shown/.test(unsealed.err), unsealed.all);
  // Feed the guard the PreToolUse JSON Claude Code would send; its "ask" writes the seal mutate needs.
  const hook = spawnSync(process.execPath, [join(repo, '.claude', 'hooks', 'guard.mjs')], {
    cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: `node .claude/kit/shopify.mjs mutate ${KEY} ${mfile}` }, cwd: repo }),
  });
  ok('the guard asks the dev, showing the mutation', /"permissionDecision":"ask"/.test(hook.stdout) && /metafieldDefinitionCreate/.test(hook.stdout), hook.stdout + hook.stderr);
  const sealed = kit('shopify.mjs', 'mutate', KEY, mfile);
  ok('mutate runs once after the guard\'s prompt, recording only the id it created',
    sealed.code === 0 && state().mutations.at(-1)?.ids.join() === 'gid://shopify/MetafieldDefinition/901', sealed.all);
  ok('the seal is single-use', kit('shopify.mjs', 'mutate', KEY, mfile).code === 1);
  // The guard can't see a No. Any guarded call after the prompt (a helper script, say) voids the seal.
  const guardSees = (command) => spawnSync(process.execPath, [join(repo, '.claude', 'hooks', 'guard.mjs')], {
    cwd: repo, env, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo }),
  });
  guardSees(`node .claude/kit/shopify.mjs mutate ${KEY} ${mfile}`);
  guardSees('node helper.mjs');
  const afterNo = kit('shopify.mjs', 'mutate', KEY, mfile);
  ok('another guarded call after the prompt voids the seal', afterNo.code === 1 && /wasn't shown/.test(afterNo.err), afterNo.all);

  // ── Lanes ──
  ok('start --small', kit('kit.mjs', 'start', 'ABC-2', '--small').out.includes('Small lane'));
  ok('lane full switches back before approval', kit('kit.mjs', 'lane', 'ABC-2', 'full').code === 0 && !kit('kit.mjs', 'status', 'ABC-2').out.includes('Small lane'));

  // ── Feasibility ──
  // A feasibility check must list the requirements (frame) and give an estimate (conclude); other investigation types don't.
  const fill = (k, heading, text) => {
    const p = join(repo, '.claude', 'logs', k, 'investigation.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(heading, `${heading}\n${text}`));
  };
  const question = '\n- **The question, precisely:** can the size chart move into a metaobject the merchant edits per product?';
  kit('kit.mjs', 'start', 'ABC-3', '--investigate');
  kit('kit.mjs', 'set', 'ABC-3', 'type=feasibility');
  fill('ABC-3', '## Question', question);
  const noReqs = kit('kit.mjs', 'done', 'ABC-3', 'frame');
  fill('ABC-3', '| --- | --- | --- | --- |', '| 1 | "The merchant edits the chart per product" | clear | none |');
  const withReqs = kit('kit.mjs', 'done', 'ABC-3', 'frame');
  ok('feasibility frame waits for § Requirements', noReqs.code !== 0 && /Requirements/.test(noReqs.all) && withReqs.code === 0, noReqs.all + withReqs.all);
  const invState = join(repo, '.claude', 'logs', 'ABC-3', 'state.json');
  writeFileSync(invState, JSON.stringify({ ...JSON.parse(readFileSync(invState, 'utf8')), stage: 'conclude' }));
  const noEstimate = kit('kit.mjs', 'done', 'ABC-3', 'conclude', '--answer', 'Accept');
  fill('ABC-3', '## Estimate', '\nM: one new section with a metaobject definition and two templates; L if the chart must also show in the cart drawer. Confidence medium.');
  const withEstimate = kit('kit.mjs', 'done', 'ABC-3', 'conclude', '--answer', 'Accept');
  ok('feasibility conclude waits for § Estimate', /Estimate/.test(noEstimate.all) && !/Estimate/.test(withEstimate.all), noEstimate.all + withEstimate.all);
  kit('kit.mjs', 'start', 'ABC-4', '--investigate');
  kit('kit.mjs', 'set', 'ABC-4', 'type=debug');
  fill('ABC-4', '## Question', question);
  const debugFrame = kit('kit.mjs', 'done', 'ABC-4', 'frame');
  ok('a debug investigation needs no § Requirements', debugFrame.code === 0, debugFrame.all);

  // ── Live theme untouched ──
  // The fake CLI logs any write to the live theme in violations.jsonl.

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
