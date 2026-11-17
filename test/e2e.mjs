#!/usr/bin/env node
// End-to-end test of the kit's scripts, offline: installs the kit into a temporary theme repo
// (with a bare "origin"), puts test/fake-shopify.mjs on PATH as `shopify`, and drives install → draft → push →
// live drift → merge → push → check → contract → reconcile → mutate → stage exits through the real scripts and guard.
//   node test/e2e.mjs [--keep]      --keep leaves the temp folder for inspection
// Exits 1 if any check fails.
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
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
// The installers list every repo they install into, in the kit clone; test repos go to a temp list instead.
process.env.SHOPIFY_KIT_REGISTRY = join(tmp, 'installs.json');

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
  // A manifest is a file anyone can edit: an entry pointing out of .claude/ must not delete the repo's files.
  writeFileSync(join(repo, 'keep-me.txt'), 'x');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), files: ['../keep-me.txt', '../sections/main-product.liquid', 'kit/gone.mjs'] }));
  writeFileSync(join(repo, '.claude', 'kit', 'gone.mjs'), '');
  const traversal = reinstall();
  ok('an update removes only kit files the kit dropped, never a path outside .claude/', traversal.status === 0 && existsSync(join(repo, 'keep-me.txt')) && !existsSync(join(repo, '.claude', 'kit', 'gone.mjs')), traversal.stdout + traversal.stderr);
  rmSync(join(repo, 'keep-me.txt'));
  // VERSION stays put between releases, so the build is the commit: one this checkout lacks came from a newer clone.
  const built = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...built, commit: 'deadbeef'.repeat(5) }));
  const olderBuild = reinstall();
  ok('an install refuses to replace a build from a commit this checkout lacks, at the same VERSION', olderBuild.status === 1 && /newer build/.test(olderBuild.stderr), olderBuild.stderr);
  writeFileSync(manifestPath, JSON.stringify(built));
  writeFileSync(join(repo, '.claude', 'VERSION'), '99.0.0\n');
  const downgrade = reinstall();
  ok('an install refuses to go back from a newer kit without --force', downgrade.status === 1 && /newer than this checkout/.test(downgrade.stderr), downgrade.stderr);
  ok('the installer refuses the kit\'s own repo', spawnSync(process.execPath, [join(KIT, 'install.mjs'), KIT, '--force', '--dry-run'], { encoding: 'utf8' }).status === 1);
  // A repo first installed with --force: updates (update.mjs passes no flags) skip the layout check.
  const odd = join(tmp, 'odd-theme');
  mkdirSync(odd);
  const oddFirst = spawnSync(process.execPath, [join(KIT, 'install.mjs'), odd], { encoding: 'utf8' });
  spawnSync(process.execPath, [join(KIT, 'install.mjs'), odd, '--force'], { encoding: 'utf8' });
  const oddUpdate = spawnSync(process.execPath, [join(KIT, 'install.mjs'), odd], { encoding: 'utf8' });
  ok('a repo installed with --force updates without --force', oddFirst.status === 1 && oddUpdate.status === 0, oddUpdate.stderr);
  ok('the code both kits share is in step with shared/', spawnSync(process.execPath, [join(KIT, 'scripts', 'sync-shared.mjs'), '--check'], { encoding: 'utf8' }).status === 0);
  writeFileSync(join(repo, '.claude', 'VERSION'), readFileSync(join(KIT, '.claude', 'VERSION'), 'utf8'));
  reinstall();

  // ── Updating every repo on the machine, and the update notice ──
  const registry = () => JSON.parse(readFileSync(process.env.SHOPIFY_KIT_REGISTRY, 'utf8'));
  ok('the installer lists the repo, and the manifest names the clone it came from',
    registry()[resolve(repo)] === 'theme' && JSON.parse(readFileSync(manifestPath, 'utf8')).source === resolve(KIT), JSON.stringify(registry()));
  const deletedRepo = join(tmp, 'deleted-theme');
  writeFileSync(process.env.SHOPIFY_KIT_REGISTRY, JSON.stringify({ ...registry(), [deletedRepo]: 'theme' }));
  const updateAll = spawnSync(process.execPath, [join(KIT, 'update.mjs'), '--no-pull'], { encoding: 'utf8' });
  ok('update.mjs updates every listed repo and drops one whose kit is gone',
    updateAll.status === 0 && updateAll.stdout.includes(`ok ${resolve(repo)}`) && /dropped/.test(updateAll.stdout) && !(deletedRepo in registry()), updateAll.stdout + updateAll.stderr);
  writeFileSync(process.env.SHOPIFY_KIT_REGISTRY, '{}');
  const scan = spawnSync(process.execPath, [join(KIT, 'update.mjs'), '--scan', tmp, '--list'], { encoding: 'utf8' });
  ok('update.mjs --scan finds repos installed before the list existed', scan.status === 0 && registry()[resolve(repo)] === 'theme' && scan.stdout.includes(resolve(repo)), scan.stdout + scan.stderr);
  // The notice reads the clone's own VERSION offline (SHOPIFY_KIT_NO_FETCH), and remembers its last check.
  const stateFile = join(tmp, 'update-check.json');
  const notice = () => spawnSync(process.execPath, [join(repo, '.claude', 'kit', 'update-check.mjs'), '--hook'], {
    cwd: repo, encoding: 'utf8', env: { ...env, CLAUDE_PROJECT_DIR: repo, SHOPIFY_KIT_UPDATE_STATE: stateFile, SHOPIFY_KIT_NO_FETCH: '1', SHOPIFY_KIT_DEBUG: '1' },
  });
  const upToDate = notice();
  const installedManifest = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(installedManifest), version: '0.0.1' }));
  rmSync(stateFile, { force: true });
  const behindNotice = notice();
  const shown = (() => { try { return JSON.parse(behindNotice.stdout); } catch { return {}; } })();
  const quiet = notice();
  writeFileSync(manifestPath, installedManifest);
  ok('the update notice says a newer kit is available once, then stays quiet until the next check',
    upToDate.status === 0 && upToDate.stdout === '' && /is available \(this repo has 0\.0\.1\)/.test(shown.systemMessage || '')
      && /update\.mjs/.test(shown.systemMessage) && shown.hookSpecificOutput?.hookEventName === 'SessionStart' && quiet.stdout === '',
    `${upToDate.stdout}\n${behindNotice.stdout}${behindNotice.stderr}\n${quiet.stdout}`);
  // Back to a clean install, then the config /shopify-setup would write.
  rmSync(localPath);
  rmSync(join(repo, '.claude', 'CLAUDE.md.pre-kit'));
  writeFileSync(join(repo, '.claude', 'shopify-kit.json'), JSON.stringify({
    store: 'fake-store.myshopify.com', baseBranch: 'main', protectedBranches: ['main'], branchPattern: '{KEY}', adminApi: true, draftRoute: 'cli', adminApiVersion: '2026-07',
  }));

  // ── Task start, branch ──
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
  ok('analyze asks for the design mode and design-checks.json', /design\.mode=exact\|reference/.test(withDesign.err) && /design-checks\.json from the extractor's JSON \(missing\)/.test(withDesign.err), withDesign.all);
  // Exact mode: the plan names every selector and runs the audit; design-audit builds one file per viewport.
  const checksPath = join(repo, '.claude', 'logs', KEY, 'design-checks.json');
  const checks = (selector) => ({ viewports: { desktop: { width: 1440, height: 900,
    elements: [{ name: 'Title', node: '1:2', selector, fixed: { 'font-size': '16px' } }],
    spacing: [{ name: 'Title → cards', type: 'siblingGap', from: selector, to: selector && '.cards', expected: 16 }] } } });
  writeFileSync(checksPath, JSON.stringify(checks('')));
  kit('kit.mjs', 'set', KEY, 'design.figma=https://www.figma.com/design/abc/Feature', 'design.mode=exact');
  writeFileSync(statePath, JSON.stringify({ ...state(), stage: 'plan' }));
  const exactPlan = kit('kit.mjs', 'done', KEY, 'plan');
  writeFileSync(checksPath, JSON.stringify(checks('.feat__title')));
  const audit = kit('kit.mjs', 'design-audit', KEY, 'desktop');
  const auditFile = join(repo, '.claude', 'logs', KEY, 'design-audit-desktop.js');
  ok('exact mode: plan wants every selector and an audit row; design-audit writes the audit with the spec built in',
    /fill the selector the build creates for desktop: Title; desktop: Title → cards/.test(exactPlan.err) && /design-audit ABC-1 <viewport>/.test(exactPlan.err)
      && audit.code === 0 && /function designAudit/.test(readFileSync(auditFile, 'utf8')) && readFileSync(auditFile, 'utf8').includes('"selector":".feat__title"')
      && kit('kit.mjs', 'design-audit', KEY, 'mobile').code === 1 && /Design: Figma .* exact mode/.test(kit('kit.mjs', 'status', KEY).out), exactPlan.all + audit.all);
  rmSync(checksPath);
  rmSync(auditFile);
  writeFileSync(statePath, fresh);
  git('switch', '-q', '--no-track', '-c', KEY, 'origin/main');
  const base = git('rev-parse', 'origin/main');
  kit('kit.mjs', 'set', KEY, `branch=${KEY}`, `base=${base}`);

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
  // A dev's git config can change the diff's "+++ b/" prefix; check sets its own.
  const prefixed = ['diff.mnemonicPrefix', 'diff.noprefix'].map((c) => {
    git('config', c, 'true');
    const n = json(kit('shopify.mjs', 'check', KEY)).introducedErrors;
    git('config', '--unset', c);
    return n;
  });
  ok('check counts an offense the branch adds, whatever diff prefixes git is set to use',
    json(kit('shopify.mjs', 'check', KEY)).introducedErrors === 1 && prefixed.join() === '1,1', prefixed.join());
  // git quotes a non-ASCII name unless told not to; a new, uncommitted file is how the builder leaves its work.
  write('sections/größe-neu.liquid', '<div>OFFENSE</div>\n');
  const unicodeNew = json(kit('shopify.mjs', 'check', KEY)).introducedErrors;
  rmSync(join(repo, 'sections', 'größe-neu.liquid'));
  ok('check counts an offense in a new, uncommitted file with a non-ASCII name', unicodeNew === 2, String(unicodeNew));
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  commit('fix the offense');

  const contract = kit('contract.mjs', KEY);
  ok('contract covers this task\'s sections only', contract.code === 0 && /feature\.liquid/.test(contract.out) && !/teammate/.test(contract.out), contract.all);
  // Theme settings are customizer surface too (POP-1150's only one): changed groups are listed and checked.
  const schemaPath = join(repo, 'config', 'settings_schema.json');
  const schemaBefore = readFileSync(schemaPath, 'utf8');
  writeFileSync(schemaPath, JSON.stringify([...JSON.parse(schemaBefore), { name: 'Bundle', settings: [{ type: 'select', id: 'mode', label: 'Mode', default: 'x', options: [{ value: 'a', label: 'A' }] }] }]));
  const settingsContract = kit('contract.mjs', KEY);
  writeFileSync(schemaPath, schemaBefore);
  ok('contract lists changed theme settings groups and checks their settings',
    /Theme settings → Bundle/.test(settingsContract.out) && /default \\"x\\" of \\"mode\\" isn't one of its options/.test(settingsContract.out) && !/theme_info/.test(settingsContract.out), settingsContract.all);

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

  // ── Live drift in code ──
  // A hotfix in live's code editor is listed for the report, not refused: only merchant JSON is.
  setLive('sections/header.liquid', '<header class="hotfix"></header>\n');
  write('sections/header.liquid', '<header class="hotfix"><nav></nav></header>\n');
  commit('header nav, with live\'s hotfix copied in');
  const codeDrift = kit('shopify.mjs', 'push', KEY);
  ok('push lists a Liquid file live changed, without refusing it', codeDrift.code === 0 && json(codeDrift).liveEditedSinceBase?.join() === 'sections/header.liquid'
    && state().draft.liveEdits?.join() === 'sections/header.liquid' && /Live edits since the base.*header\.liquid/.test(kit('kit.mjs', 'status', KEY).out), codeDrift.all);

  // ── The base branch ahead of live ──
  // A teammate's merged, undeployed edit to merchant JSON the branch also changes: live holds main's earlier version, not an admin edit.
  git('switch', '-q', 'main');
  write('templates/index.json', '{ "order": ["v1"] }\n');
  commit('index v1');
  setLive('templates/index.json', '{ "order": ["v1"] }\n');
  write('templates/index.json', '{ "order": ["v2"] }\n');
  commit('index v2, merged and not deployed');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', KEY);
  git('fetch', '-q', 'origin');
  git('merge', '-q', '--no-edit', 'origin/main');
  write('templates/index.json', '{ "order": ["v2", "feature"] }\n');
  commit('feature on the home page');
  const ahead = kit('shopify.mjs', 'push', KEY);
  ok('push lets merchant JSON through when live only lags the base branch', ahead.code === 0 && json(ahead).baseAheadOfLive?.join() === 'templates/index.json', ahead.all);

  // ── Verify, and never write to live ──

  ok('verify: the draft matches HEAD', kit('shopify.mjs', 'verify', KEY).code === 0);

  // A GitHub-connected draft is never pushed, so verify runs the drift check there: a refused one isn't a verified draft.
  git('push', '-q', '-u', 'origin', KEY);
  const verifiedAt = state().draft.verifiedCommit;
  writeFileSync(statePath, JSON.stringify({ ...state(), draft: { ...state().draft, route: 'github', verifiedCommit: null } }));
  setLive('templates/product.json', product('A', 'D5'));
  const ghVerify = kit('shopify.mjs', 'verify', KEY, '--wait', '0');
  ok('verify on a GitHub-connected draft doesn\'t record it as verified while live drift is refused', ghVerify.code === 3 && state().draft.verifiedCommit === null, ghVerify.all);
  // POP-1150: the branch changed after a GitHub-connected draft was adopted, so the draft showed the old branch.
  const moveBranch = kit('kit.mjs', 'set', KEY, 'branch=other-branch');
  ok('set refuses a new branch while a GitHub-connected draft follows the old one', moveBranch.code === 1 && /connected to ABC-1 on GitHub/.test(moveBranch.err) && state().branch === KEY, moveBranch.all);
  // A campaign theme is live: the theme that follows the base branch stands in for live.
  writeFileSync(join(store, 'themes.json'), JSON.stringify([...JSON.parse(readFileSync(join(store, 'themes.json'), 'utf8')), { id: 7, name: 'Regular', role: 'unpublished' }]));
  cpSync(join(store, 'themes', '1'), join(store, 'themes', '7'), { recursive: true });
  writeFileSync(join(store, 'themes', '7', 'templates', 'product.json'), product('A', 'BASE'));
  kit('kit.mjs', 'set', KEY, 'baseTheme=7');
  const pulledBase = kit('shopify.mjs', 'pull-live', KEY, 'templates/product.json');
  ok('with baseTheme set, pull-live reads the base theme instead of live, and status says so',
    pulledBase.code === 0 && /"BASE"/.test(readFileSync(join(repo, '.claude', 'logs', KEY, 'live', 'templates', 'product.json'), 'utf8')) && /Base theme: 7 stands in for live/.test(kit('kit.mjs', 'status', KEY).out), pulledBase.all);
  const { baseTheme, ...withoutBase } = state();
  writeFileSync(statePath, JSON.stringify(withoutBase));
  setLive('templates/product.json', product('A', 'D3'));
  writeFileSync(statePath, JSON.stringify({ ...state(), draft: { ...state().draft, route: 'cli', verifiedCommit: verifiedAt } }));

  // The wrapper never writes to a theme that isn't an unpublished draft, even if the state points at live.
  kit('kit.mjs', 'set', KEY, 'draft.themeId=1');
  const toLive = kit('shopify.mjs', 'push', KEY);
  ok('push refuses a state that points at the live theme', toLive.code === 1 && /not unpublished/.test(toLive.err), toLive.all);
  kit('kit.mjs', 'set', KEY, 'draft.themeId=2');
  // Nor to a CLI draft named other than the key; the kit/<KEY>/… names from before kit 0.2.0 included.
  const themesJson = join(store, 'themes.json');
  const themesBefore = readFileSync(themesJson, 'utf8');
  writeFileSync(themesJson, JSON.stringify(JSON.parse(themesBefore).map((t) => (t.id === 2 ? { ...t, name: `kit/${KEY}/feature` } : t))));
  const oldName = kit('shopify.mjs', 'push', KEY);
  writeFileSync(themesJson, themesBefore);
  ok('push refuses a CLI draft not named after the key, an old kit/<KEY>/ name included', oldName.code === 1 && /not ABC-1/.test(oldName.err), oldName.all);

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

  // ── Stage exits: approve → build → draft → qa → accept → handoff ──
  const logFile = (k, f) => join(repo, '.claude', 'logs', k, f);
  const edit = (k, f, from, to) => writeFileSync(logFile(k, f), readFileSync(logFile(k, f), 'utf8').replace(from, to));
  const head = () => git('rev-parse', 'HEAD');
  edit(KEY, 'plan.md', '### Needs your attention\n', '### Needs your attention\n\n- `templates/product.json` (merchant-owned): sets section a\'s title; the merge overwrites admin edits made since the base.\n- Store: one metafield definition, created at the draft stage; it shows in the admin, not on live.\n');
  edit(KEY, 'plan.md', '| --- | --- | --- | --- | --- |\n', '| --- | --- | --- | --- | --- |\n| `sections/feature.liquid` | create | the feature | — | — |\n| `templates/product.json` | modify | title A2 | sections.a | — |\n');
  edit(KEY, 'plan.md', '| --- | --- | --- | --- | --- | --- |\n', '| --- | --- | --- | --- | --- | --- |\n| 1 | Feature renders | present | product | 390 | — |\n| 2 | Title | A2 | product | 390 | — |\n| 3 | Header nav | present | home | 390 | — |\n');

  // .shopifyignore: a planned file it excludes is flagged at plan, and push skips it only when the dev agreed.
  writeFileSync(join(repo, '.shopifyignore'), 'templates/product.json\n');
  const ignoredReach = kit('kit.mjs', 'reach', KEY);
  const ignoredPush = kit('shopify.mjs', 'push', KEY);
  const skipPush = kit('shopify.mjs', 'push', KEY, '--skip-ignored');
  ok('a planned file .shopifyignore excludes is flagged at plan, refused by push, and skipped and listed with --skip-ignored',
    /templates\/product\.json[^\n]*\n[^\n]*shopifyignore excludes it/.test(ignoredReach.out) && ignoredPush.code === 1 && /--skip-ignored/.test(ignoredPush.err)
    && skipPush.code === 0 && json(skipPush).notOnDraftShopifyignore?.join() === 'templates/product.json' && /Not on the draft.*product\.json/.test(kit('kit.mjs', 'status', KEY).out),
    ignoredReach.all + ignoredPush.all + skipPush.all);
  rmSync(join(repo, '.shopifyignore'));
  ok('a push with nothing ignored clears that list', kit('shopify.mjs', 'push', KEY).code === 0 && !state().draft.ignoredFiles.length);

  // Approve runs the plan's checks again: "Approve with changes" edits the plan at the gate.
  writeFileSync(statePath, JSON.stringify({ ...state(), stage: 'approve', type: 'feature' }));
  const unproven = '| What the plan relies on | Why it isn\'t proven | Fallback if it doesn\'t hold | QA # |\n| --- | --- | --- | --- |\n';
  const noUnproven = kit('kit.mjs', 'done', KEY, 'approve', '--answer', 'Approve');
  edit(KEY, 'plan.md', unproven, `${unproven}| the header nav markup | rate-limited | | 9 |\n`);
  const unchecked = kit('kit.mjs', 'done', KEY, 'approve', '--answer', 'Approve');
  ok('plan needs "Not proven yet" filled, and each row with a fallback and a QA criterion that exists',
    /Not proven yet: one row per thing/.test(noUnproven.err) && /the header nav markup.*fallback/.test(unchecked.err) && /QA criterion 9 isn't in plan\.md/.test(unchecked.err), noUnproven.all + unchecked.all);
  edit(KEY, 'plan.md', '| the header nav markup | rate-limited | | 9 |', '| the header nav markup | rate-limited | keep the header as it is | 3 |');
  // Every numbered AC is cited by a QA row or listed under Differs: POP-1150's targeting ACs were in neither.
  const briefBefore = readFileSync(logFile(KEY, 'brief.md'), 'utf8');
  const planBefore = readFileSync(logFile(KEY, 'plan.md'), 'utf8');
  edit(KEY, 'brief.md', '### Acceptance criteria (quoted from the ticket)\n', '### Acceptance criteria (quoted from the ticket)\n\n1. "The feature renders"\n2. "Only on the listed products"\n3. "Attach a video"\n');
  edit(KEY, 'plan.md', '| 1 | Feature renders |', '| 1 | Feature renders (AC 1) |');
  const acGap = kit('kit.mjs', 'done', KEY, 'approve', '--answer', 'Approve');
  edit(KEY, 'plan.md', '- **Differs from the ticket or the A/B test:**', '- **Differs from the ticket or the A/B test:** AC 2–3 not checked here: targeting is merchant data, the video is a handoff step.');
  const acCovered = kit('kit.mjs', 'done', KEY, 'approve', '--answer', 'Approve');
  writeFileSync(logFile(KEY, 'brief.md'), briefBefore);
  writeFileSync(logFile(KEY, 'plan.md'), planBefore);
  ok('plan refuses an acceptance criterion no QA row cites and Differs doesn\'t list',
    /AC 2, AC 3 aren't covered/.test(acGap.err) && !/aren't covered/.test(acCovered.err), acGap.all + acCovered.all);
  edit(KEY, 'brief.md', '| Value | Where the merchant changes it | Type, options, default | Empty state | Why |\n| --- | --- | --- | --- | --- |\n',
    '| Value | Where the merchant changes it | Type, options, default | Empty state | Why |\n| --- | --- | --- | --- | --- |\n| Title | section a setting | text, "A2" | hidden | per placement |\n');
  edit(KEY, 'brief.md', '#### Stays in code (the merchant can\'t change it)\n', '#### Stays in code (the merchant can\'t change it)\n\nnone\n');
  // The "(Recommended)" tag in the dev's choice is no longer refused.
  edit(KEY, 'brief.md', '| # | Question | The dev\'s choice (verbatim) | Applied as | Date |\n| --- | --- | --- | --- | --- |\n',
    '| # | Question | The dev\'s choice (verbatim) | Applied as | Date |\n| --- | --- | --- | --- | --- |\n| Q1 | Control surface OK? | OK (Recommended) | as listed | 2026-11-01 |\n');
  edit(KEY, 'plan.md', '| File | What happens |\n| --- | --- |\n', '| File | What happens |\n| --- | --- |\n| `sections/feature.liquid` | the new feature section |\n');
  ok('approve runs the plan checks, and keeps a copy of the plan it approved', unchecked.code === 1 && /Control surface/.test(unchecked.err)
    && kit('kit.mjs', 'done', KEY, 'approve', '--answer', 'Approve').code === 0 && existsSync(logFile(KEY, 'plan.approved.md')), unchecked.all);

  // Build: the last theme check decides, on the content it checked; files outside the plan and plan edits are listed, not refused.
  const build0 = kit('kit.mjs', 'done', KEY, 'build');
  ok('build refuses a theme check that ran on other content than the branch has', build0.code === 1 && /ran on other theme files/.test(build0.err) && !/errors this branch introduced/.test(build0.err), build0.all);
  write('sections/feature.liquid', '<div class="e2e-feature">OFFENSE</div>\n');
  kit('shopify.mjs', 'check', KEY);
  const build1 = kit('kit.mjs', 'done', KEY, 'build');
  write('sections/feature.liquid', '<div class="e2e-feature"></div>\n');
  ok('build refuses while the last theme check found errors the branch introduced', build1.code === 1 && /found 1 errors this branch introduced/.test(build1.err) && !/other theme files/.test(build1.err), build1.all);
  const check2 = kit('shopify.mjs', 'check', KEY);
  ok('check records its result', check2.code === 0 && state().check?.head === head() && state().check.introducedErrors === 0 && !state().check.dirty, check2.all);
  // A theme check that gives no report is recorded, so done build doesn't wait on it forever.
  const broken = join(tmp, 'broken-bin');
  mkdirSync(broken);
  if (process.platform === 'win32') writeFileSync(join(broken, 'shopify.cmd'), '@echo theme check crashed 1>&2\r\n@exit /b 1\r\n');
  else { writeFileSync(join(broken, 'shopify'), '#!/bin/sh\necho theme check crashed >&2\nexit 1\n'); chmodSync(join(broken, 'shopify'), 0o755); }
  const crashed = spawnSync(process.execPath, [join(repo, '.claude', 'kit', 'shopify.mjs'), 'check', KEY], { cwd: repo, env: { ...env, [pathKey]: `${broken}${delimiter}${process.env[pathKey]}` }, encoding: 'utf8' });
  ok('a crashing theme check is reported and recorded', crashed.status === 2 && /crashed/.test(crashed.stderr) && Boolean(state().check?.crashed), crashed.stdout + crashed.stderr);
  edit(KEY, 'plan.md', '## Approach\n', '## Approach\n\nRewritten after approval.\n');
  const build2 = kit('kit.mjs', 'done', KEY, 'build');
  ok('build passes, listing unplanned files, the plan\'s changes since approval, the shared files and the crashed check',
    build2.code === 0 && /doesn't name: .*sections\/header\.liquid/.test(build2.out) && /\+Rewritten after approval\./.test(build2.out)
    && /Shared files.*templates\/product\.json/.test(build2.out) && /theme check didn't run/.test(build2.out), build2.all);
  ok('draft passes: the draft is at HEAD', kit('kit.mjs', 'done', KEY, 'draft').code === 0);

  // QA: every plan criterion recorded with qa-row, on a draft that is the branch.
  edit(KEY, 'report.md', '| --- | --- | --- | --- | --- | --- |\n', '| --- | --- | --- | --- | --- | --- |\n| 1 | Feature renders | present | | | |\n| 2 | Title | A2 | | | |\n| 3 | Header nav | present | | | |\n');
  edit(KEY, 'report.md', '## Summary\n', '## Summary\n\n3 criteria: 3 PASS, 0 FAIL, 0 NOT TESTED, 0 BLOCKED.\n');
  const bare = kit('kit.mjs', 'qa-row', KEY, '1', '--verdict', 'PASS');
  ok('qa-row refuses a PASS without --measured and --how', bare.code === 1 && /needs what was measured/.test(bare.err), bare.all);
  // As Git Bash hands over "--measured /products/x: 1 match".
  const row1 = kit('kit.mjs', 'qa-row', KEY, '1', '--measured', 'C:/Program Files/Git/products/x: 1 match', '--how', "__qa.see('.e2e-feature')", '--verdict', 'PASS');
  const r1 = state().qa.rows[1];
  ok('qa-row records the measurement, commit, draft and the plan\'s criterion text', row1.code === 0 && r1.commit === head() && r1.themeId === 2
    && r1.criterion === 'Feature renders | present | product | 390 | —', row1.all + JSON.stringify(r1));
  ok('qa-row undoes Git Bash\'s rewrite of a leading "/"', r1.measured === '/products/x: 1 match', JSON.stringify(r1));
  ok('qa-row refuses NOT TESTED without a reason', kit('kit.mjs', 'qa-row', KEY, '2', '--verdict', 'NOT TESTED').code === 1);
  kit('kit.mjs', 'qa-row', KEY, '2', '--measured', 'A', '--how', 'fetch --find A', '--verdict', 'FAIL');
  kit('kit.mjs', 'qa-row', KEY, '2', '--measured', '--gap: 16px', '--how', "__qa.css('.t', ['--gap'])", '--verdict', 'PASS');
  const r2 = state().qa.rows[2];
  ok('a re-measured row replaces the measurement, and a value may start with --', r2.verdict === 'PASS' && r2.measured === '--gap: 16px' && !('earlier' in r2), JSON.stringify(r2));
  edit(KEY, 'report.md', '| 3 | Header nav | present | | | |', '| 3 | Header nav | present | 1 nav | looked | PASS |');
  const handQa = kit('kit.mjs', 'done', KEY, 'qa');
  ok('done qa refuses a hand-written verdict and names the plan criterion qa-row never recorded',
    handQa.code === 1 && /rows 3 in report\.md don't show/.test(handQa.err) && /plan criteria 3 have no verdict/.test(handQa.err), handQa.all);
  kit('kit.mjs', 'qa-row', KEY, '3', '--measured', '1 nav', '--how', "__qa.see('header nav')", '--verdict', 'PASS');
  write('sections/feature.liquid', '<div class="e2e-feature" data-v="2"></div>\n');
  commit('feature v2');
  const behindRow = kit('kit.mjs', 'qa-row', KEY, '3', '--measured', '1 nav', '--how', 'see', '--verdict', 'PASS');
  const behindQa = kit('kit.mjs', 'done', KEY, 'qa');
  ok('qa-row and done qa refuse while the draft isn\'t the branch head', behindRow.code === 1 && /draft isn't at HEAD/.test(behindRow.err) && behindQa.code === 1 && /draft isn't at the branch head/.test(behindQa.err), behindRow.all + behindQa.all);
  kit('shopify.mjs', 'push', KEY);
  const staleQa = kit('kit.mjs', 'done', KEY, 'qa');
  ok('done qa refuses passes measured before theme files changed', staleQa.code === 1 && /rows 1, 2, 3 passed on an earlier commit/.test(staleQa.err), staleQa.all);
  const carried = kit('kit.mjs', 'qa-row', KEY, '2,3', '--carry', 'title and header don\'t render the feature section');
  // A blanked verdict, and a criterion the dev changed after it was measured, have no measurement behind them.
  edit(KEY, 'report.md', /^(\| 1 \|.*\| )PASS \|$/m, '$1 |');
  edit(KEY, 'plan.md', '| 3 | Header nav | present |', '| 3 | Header nav | two links |');
  const blanked = kit('kit.mjs', 'done', KEY, 'qa');
  ok('done qa refuses a blanked verdict and a criterion the plan changed after it was measured',
    blanked.code === 1 && /rows 1 in report\.md don't show/.test(blanked.err) && /plan criteria 3 changed/.test(blanked.err), blanked.all);
  edit(KEY, 'plan.md', '| 3 | Header nav | two links |', '| 3 | Header nav | present |');
  kit('kit.mjs', 'qa-row', KEY, '1', '--measured', '1 match', '--how', "__qa.see('.e2e-feature')", '--verdict', 'PASS');
  // A row recorded before qa-row kept the criterion's text still counts (tasks in flight).
  const { criterion, ...oldRow } = state().qa.rows[2];
  writeFileSync(statePath, JSON.stringify({ ...state(), qa: { ...state().qa, rows: { ...state().qa.rows, 2: oldRow } } }));
  const qaDone = kit('kit.mjs', 'done', KEY, 'qa');
  ok('rows carried with a reason, a re-measured row and an older record pass done qa, which records the QA\'d commit and shows what changed since approval',
    carried.code === 0 && /carried to .*: title and header/.test(readFileSync(logFile(KEY, 'report.md'), 'utf8')) && Boolean(criterion)
    && qaDone.code === 0 && state().qa.commit === head() && /Since the plan was approved/.test(qaDone.out), carried.all + qaDone.all);
  // Gate 2's list is the task branch's, whatever is checked out (a new session may start on main).
  git('switch', '-q', 'main');
  const offBranch = kit('kit.mjs', 'status', KEY);
  git('switch', '-q', KEY);
  ok('the since-approval list at Gate 2 doesn\'t depend on the checkout', /doesn't name: [^\n]*sections\/header\.liquid/.test(offBranch.out), offBranch.all);
  // A "not proven yet" criterion that didn't pass: Gate 2 takes it only when the dev names it.
  const passed3 = state().qa.rows[3];
  writeFileSync(statePath, JSON.stringify({ ...state(), qa: { ...state().qa, rows: { ...state().qa.rows, 3: { ...passed3, verdict: 'NOT TESTED' } } } }));
  writeFileSync(statePath, JSON.stringify({ ...state(), stage: 'qa' }));
  const listed = kit('kit.mjs', 'list').out;
  writeFileSync(statePath, JSON.stringify({ ...state(), stage: 'accept' }));
  const blindAccept = kit('kit.mjs', 'done', KEY, 'accept', '--answer', 'Accept');
  const namedAccept = kit('kit.mjs', 'done', KEY, 'accept', '--answer', 'Accept, #3 untested: my risk');
  ok('accept refuses an untested "not proven yet" criterion unless the dev names it',
    blindAccept.code === 1 && /#3 \(NOT TESTED\)/.test(blindAccept.err) && namedAccept.code === 0, blindAccept.all + namedAccept.all);
  ok('list shows how much of QA was measured for a task between build and accept', /QA: 3 of 3 criteria measured/.test(listed), listed);
  writeFileSync(statePath, JSON.stringify({ ...state(), qa: { ...state().qa, rows: { ...state().qa.rows, 3: passed3 } } }));

  // Handoff: the pushed branch is the commit QA measured. The refused handoff below is a signal, so done shows the
  // retro, without making it a condition.
  edit(KEY, 'report.md', '### PR\n', '### PR\n\nABC-1: add the e2e feature section and the product title; QA 3 PASS; preview on draft 2; merge after AC review.\n');
  git('push', '-q', '-u', 'origin', KEY);
  write('sections/feature.liquid', '<div class="e2e-feature" data-v="3"></div>\n');
  commit('after QA');
  const lateHandoff = kit('kit.mjs', 'done', KEY, 'handoff');
  ok('handoff refuses commits QA didn\'t check', lateHandoff.code === 1 && /commits QA didn't check/.test(lateHandoff.err) && /draft isn't at the branch head/.test(lateHandoff.err), lateHandoff.all);
  git('reset', '-q', '--hard', 'HEAD~1');
  const handoff = kit('kit.mjs', 'done', KEY, 'handoff');
  ok('handoff passes on the QA\'d commit and shows the retro for the refused handoff',
    handoff.code === 0 && state().stage === 'done' && /handoff ×1/.test(handoff.out) && /kit\.mjs note/.test(handoff.out) && state().history.some((e) => e.event === 'retro'), handoff.all);

  // Handover: status names the owner and warns another git identity.
  const mine = kit('kit.mjs', 'status', KEY).out;
  writeFileSync(statePath, JSON.stringify({ ...state(), owner: { name: 'Ana', email: 'ana@example.invalid' } }));
  const theirs = kit('kit.mjs', 'status', KEY).out;
  ok('status shows the owner, and warns when git user.email is someone else', /Owner: e2e <e2e@example\.invalid>/.test(mine) && !/WARNING/.test(mine) && /Owner: Ana .*WARNING/.test(theirs), mine + theirs);

  // ── Tasks in flight at a stage this kit version folded away ──
  kit('kit.mjs', 'start', 'ABC-2');
  const st2 = join(repo, '.claude', 'logs', 'ABC-2', 'state.json');
  writeFileSync(st2, JSON.stringify({ ...JSON.parse(readFileSync(st2, 'utf8')), stage: 'clarify', lane: 'small' }));
  const resumed2 = kit('kit.mjs', 'status', 'ABC-2');
  ok('a task at the old clarify stage resumes at plan', /stage 3\/9: plan/.test(resumed2.out) && /was at "clarify"/.test(resumed2.out), resumed2.all);

  // ── Feasibility ──
  // A feasibility check must list the requirements and give an estimate, checked by the evidence-checker; other investigation types don't.
  const fill = (k, heading, text) => {
    const p = join(repo, '.claude', 'logs', k, 'investigation.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(heading, `${heading}\n${text}`));
  };
  const question = '\n- **The question, precisely:** can the size chart move into a metaobject the merchant edits per product?';
  kit('kit.mjs', 'start', 'ABC-3', '--investigate');
  kit('kit.mjs', 'set', 'ABC-3', 'type=feasibility');
  fill('ABC-3', '## Question', question);
  const noReqs = kit('kit.mjs', 'done', 'ABC-3', 'gather');
  fill('ABC-3', '| --- | --- | --- | --- |', '| 1 | "The merchant edits the chart per product" | clear | none |');
  const withReqs = kit('kit.mjs', 'done', 'ABC-3', 'gather');
  ok('feasibility gather waits for § Requirements', noReqs.code !== 0 && /Requirements/.test(noReqs.all) && !/Requirements/.test(withReqs.all), noReqs.all + withReqs.all);
  const invState = join(repo, '.claude', 'logs', 'ABC-3', 'state.json');
  writeFileSync(invState, JSON.stringify({ ...JSON.parse(readFileSync(invState, 'utf8')), stage: 'conclude' }));
  const noEstimate = kit('kit.mjs', 'done', 'ABC-3', 'conclude', '--answer', 'Accept');
  fill('ABC-3', '## Estimate', '\nM: one new section with a metaobject definition and two templates; L if the chart must also show in the cart drawer. Confidence medium.');
  const withEstimate = kit('kit.mjs', 'done', 'ABC-3', 'conclude', '--answer', 'Accept');
  ok('feasibility conclude waits for § Estimate and the evidence-checker', /Estimate/.test(noEstimate.all) && /evidence-checker/.test(noEstimate.all) && !/Estimate/.test(withEstimate.all), noEstimate.all + withEstimate.all);
  kit('kit.mjs', 'start', 'ABC-4', '--investigate');
  kit('kit.mjs', 'set', 'ABC-4', 'type=debug');
  fill('ABC-4', '## Question', question);
  const st4 = join(repo, '.claude', 'logs', 'ABC-4', 'state.json');
  writeFileSync(st4, JSON.stringify({ ...JSON.parse(readFileSync(st4, 'utf8')), stage: 'frame' }));
  const debugGather = kit('kit.mjs', 'done', 'ABC-4', 'gather');
  writeFileSync(st4, JSON.stringify({ ...JSON.parse(readFileSync(st4, 'utf8')), stage: 'conclude' }));
  const debugConclude = kit('kit.mjs', 'done', 'ABC-4', 'conclude', '--answer', 'Accept');
  ok('an investigation at the old frame stage resumes at gather; a debug one needs no § Requirements and no evidence-checker',
    /hypotheses/.test(debugGather.err) && !/Requirements|current stage/.test(debugGather.all) && !/evidence-checker/.test(debugConclude.all), debugGather.all + debugConclude.all);
  // A run with nothing to look back on finishes quietly: no retro printed or recorded.
  kit('kit.mjs', 'start', 'ABC-9', '--investigate');
  kit('kit.mjs', 'set', 'ABC-9', 'type=question');
  fill('ABC-9', '## Answer', 'The menu comes from the main-menu linklist.');
  fill('ABC-9', '## Could not determine', 'Nothing material.');
  fill('ABC-9', '## Next step', 'Nothing to do: it works as designed.');
  const st9 = join(repo, '.claude', 'logs', 'ABC-9', 'state.json');
  writeFileSync(st9, JSON.stringify({ ...JSON.parse(readFileSync(st9, 'utf8')), stage: 'conclude' }));
  const clean = kit('kit.mjs', 'done', 'ABC-9', 'conclude', '--answer', 'Accept');
  ok('a clean run finishes without a retro', clean.code === 0 && !/retro/.test(clean.out) && !JSON.parse(readFileSync(st9, 'utf8')).history.some((e) => e.event === 'retro'), clean.all);

  // ── Bug fixes reproduce the bug ──
  kit('kit.mjs', 'start', 'ABC-6');
  kit('kit.mjs', 'set', 'ABC-6', 'type=bugfix');
  const st6 = join(repo, '.claude', 'logs', 'ABC-6', 'state.json');
  writeFileSync(st6, JSON.stringify({ ...JSON.parse(readFileSync(st6, 'utf8')), stage: 'plan' }));
  const noRepro = kit('kit.mjs', 'done', 'ABC-6', 'plan');
  const qaHeader = '| --- | --- | --- | --- | --- | --- |\n';
  const plan6 = join(repo, '.claude', 'logs', 'ABC-6', 'plan.md');
  writeFileSync(plan6, readFileSync(plan6, 'utf8').replace(qaHeader, `${qaHeader}| 1 | Repro: cart total after removing a line | live shows the old total; the draft the new one | cart | 390 | — |\n`)
    .replace('### QA test data\n', '### QA test data\n\nproducts/shirt and products/mug as they are: nothing is set on them.\n'));
  const withRepro = kit('kit.mjs', 'done', 'ABC-6', 'plan');
  ok('a bug fix\'s plan needs a criterion that reproduces the bug on live', /reproduces the bug/.test(noRepro.err) && !/reproduces the bug/.test(withRepro.err), noRepro.all + withRepro.all);
  mkdirSync(join(repo, '.claude', 'logs', 'ABC-6', 'mutations'));
  writeFileSync(join(repo, '.claude', 'logs', 'ABC-6', 'mutations', '01-value.graphql'), 'mutation { metafieldsSet(metafields: []) { userErrors { message } } }\n');
  const withWrites = kit('kit.mjs', 'done', 'ABC-6', 'plan');
  ok('QA data on existing products isn\'t a store write to name; a mutation file the plan wrote is',
    !/store writes/.test(withRepro.err) && /name the store writes/.test(withWrites.err), withRepro.all + withWrites.all);

  // ── State, verbs and flags this kit version dropped ──
  kit('kit.mjs', 'start', 'ABC-7');
  kit('kit.mjs', 'set', 'ABC-7', 'type=abtest', 'abtest.tool=VWO', 'abtest.running=no');
  const intake7 = kit('kit.mjs', 'done', 'ABC-7', 'intake');
  const dropped7 = ['tickets=ABC-7', 'qa.products=shirt', 'abtest.variation=B', 'abtest.path=x'].filter((v) => kit('kit.mjs', 'set', 'ABC-7', v).code === 0);
  ok('an A/B port records the tool and running state; the variation, code path, tickets and QA products live in the documents',
    intake7.code === 1 && /acceptance criteria/.test(intake7.err) && !/abtest\./.test(intake7.err) && !dropped7.length, intake7.all + dropped7.join());
  ok('note --none needs no retro first; the themes verb is gone', kit('kit.mjs', 'note', 'ABC-7', '--none').code === 0 && kit('shopify.mjs', 'themes').code === 1);

  // ── Draft: a timed-out duplicate, a draft deleted in the admin, abandon ──
  const themesFile = join(store, 'themes.json');
  const themesNow = () => JSON.parse(readFileSync(themesFile, 'utf8'));
  kit('kit.mjs', 'start', 'ABC-5');
  const st5 = join(repo, '.claude', 'logs', 'ABC-5', 'state.json');
  const state5 = () => JSON.parse(readFileSync(st5, 'utf8'));
  writeFileSync(themesFile, JSON.stringify([...themesNow(), { id: 50, name: 'ABC-5', role: 'unpublished' }]));
  cpSync(join(store, 'themes', '1'), join(store, 'themes', '50'), { recursive: true });
  const stranger = kit('shopify.mjs', 'draft', 'ABC-5');
  ok('draft refuses a same-named theme it didn\'t start', stranger.code === 3, stranger.all);
  writeFileSync(st5, JSON.stringify({ ...state5(), draft: { pending: { name: 'ABC-5', at: new Date().toISOString() } } }));
  const resumed = kit('shopify.mjs', 'draft', 'ABC-5');
  ok('draft adopts the copy a timed-out run started', resumed.code === 0 && state5().draft.themeId === 50 && state5().draft.route === 'cli' && !state5().draft.pending, resumed.all);
  writeFileSync(themesFile, JSON.stringify(themesNow().filter((t) => t.id !== 50)));
  const gone = kit('shopify.mjs', 'delete-draft', 'ABC-5');
  ok('delete-draft on a draft deleted in the admin records it, without suggesting a new draft',
    gone.code === 0 && /no longer in the store/.test(gone.out) && !/shopify\.mjs draft/.test(gone.all) && Boolean(state5().draft.deletedAt), gone.all);
  ok('list doesn\'t claim a deleted draft exists', !/ABC-5.*draft/.test(kit('kit.mjs', 'list').out));
  const dropped = kit('kit.mjs', 'abandon', 'ABC-5', '--reason', 'client dropped it');
  ok('abandon runs the retro and asks for a note', dropped.code === 0 && /kit\.mjs note/.test(json(dropped).retro?.ask || '') && state5().history.some((e) => e.event === 'retro'), dropped.all);

  // ── cli-check's cache, and compare's section check ──
  // A home without the plugin registry, so the full check never reaches the real plugin.
  const cliCheck = () => spawnSync(process.execPath, [join(repo, '.claude', 'kit', 'shopify.mjs'), 'cli-check'], { cwd: repo, env: { ...env, USERPROFILE: tmp, HOME: tmp }, encoding: 'utf8' });
  cliCheck();
  const checkFile = join(repo, '.claude', 'cli-check.json');
  const lastCheck = JSON.parse(readFileSync(checkFile, 'utf8'));
  writeFileSync(checkFile, JSON.stringify({ ...lastCheck, ok: true }));
  const cached = cliCheck();
  writeFileSync(checkFile, JSON.stringify({ ...lastCheck, ok: true, kitVersion: '0.0.1' }));
  const rerun = cliCheck();
  ok('cli-check reuses its last result only for the same kit and Admin API version',
    lastCheck.adminApiVersion === '2026-07' && /unchanged since/.test(cached.stdout) && !/unchanged since/.test(rerun.stdout), cached.stdout + rerun.stdout);
  // /shopify-update pins previous.cliVersion, so a failed run (the fake CLI never passes) must not overwrite it.
  writeFileSync(checkFile, JSON.stringify({ ...lastCheck, ok: false, cliVersion: '5.0.1', previous: { cliVersion: '4.9.4', pluginVersion: null, kitVersion: null, adminApiVersion: '2026-07' } }));
  const failedAgain = cliCheck();
  const afterFail = JSON.parse(readFileSync(checkFile, 'utf8'));
  ok('a failed cli-check keeps the last verified CLI version as previous',
    failedAgain.status === 2 && afterFail.ok === false && afterFail.previous?.cliVersion === '4.9.4', failedAgain.stdout);
  // VERSION stays put between releases, so the build id carries the kit commit the installer recorded.
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const buildId = `${readFileSync(join(KIT, '.claude', 'VERSION'), 'utf8').trim()}+${installed.commit.slice(0, 7)}${installed.uncommitted ? '-dirty' : ''}`;
  ok('the build id is VERSION plus the kit commit, in cli-check and in a task\'s state',
    json({ out: cached.stdout }).kitVersion === buildId && JSON.parse(readFileSync(st5, 'utf8')).kitVersion === buildId, `${buildId}\n${cached.stdout}`);
  // build-probe --check: the generated probe files match probe.js, and stop matching once it changes.
  const probeOk = kit('kit.mjs', 'build-probe', '--check');
  writeFileSync(join(repo, '.claude', 'kit', 'probe.js'), `${readFileSync(join(repo, '.claude', 'kit', 'probe.js'), 'utf8')}\n// changed\n`);
  const probeStale = kit('kit.mjs', 'build-probe', '--check');
  ok('build-probe --check passes on the shipped files and fails once probe.js changes', probeOk.code === 0 && probeStale.code === 1 && /don't match/.test(probeStale.err), probeOk.all + probeStale.all);
  const cmp = kit('compare.mjs', '--selftest');
  ok('compare reports a section whose HTML changed', cmp.code === 0, cmp.all);

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
