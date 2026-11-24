#!/usr/bin/env node
// End-to-end test of the app kit, offline: installs the kit into a temporary app repo (with a bare "origin"), puts
// test/fake-shopify.mjs on PATH as `shopify` and a fake vitest in node_modules, and drives changes through the real
// scripts and guard: onboard → start → propose (refused, then Gate 1) → build (the guard by stage, an undeclared surface,
// the code review) → verify (tests, the ledger, Function fixtures, QA, security) → Gate 2 → archive → drift; then a second
// change whose failing test, missing ledger test and new security finding block it, a dev-store mutation through the
// guard's seal, and the fix, maintain and ab types.
//   node test/e2e.mjs [--keep]      --keep leaves the temp folder for inspection
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'app-kit-e2e-'));
const repo = join(tmp, 'app');
const fakeDir = join(tmp, 'fake');
const bin = join(tmp, 'bin');
const results = [];
// The installers list every repo they install into, in the kit clone; test repos go to a temp list instead.
process.env.SHOPIFY_KIT_REGISTRY = join(tmp, 'installs.json');
const STORE = 'kit-dev.myshopify.com';

const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass || !detail ? '' : `\n      ${String(detail).trim().split('\n').slice(0, 12).join('\n      ')}`}`); };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (rel, text) => { mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), text); };
const read = (rel) => readFileSync(join(repo, rel), 'utf8');
const commit = (msg) => { git('add', '-A'); git('commit', '-qm', msg); };
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const env = { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey]}`, FAKE_SHOPIFY_DIR: fakeDir };
function node(script, args, extraEnv = {}, input) {
  const r = spawnSync(process.execPath, [join(repo, '.claude', script), ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: 'utf8', input, timeout: 300000 });
  return { code: r.status, out: r.stdout, err: r.stderr, all: `${r.stdout}\n${r.stderr}` };
}
const app = (...args) => node('kit/app.mjs', args);
const appEnv = (extra, ...args) => node('kit/app.mjs', args, extra);
const shop = (...args) => node('kit/shopify.mjs', args);
const json = (r) => { try { return JSON.parse(r.out); } catch { return {}; } };
/** The real guard hook, as Claude Code calls it. */
function guard(tool, input) {
  const r = node('hooks/guard.mjs', [], {}, JSON.stringify({ tool_name: tool, tool_input: input, cwd: repo, permission_mode: 'default' }));
  try { return JSON.parse(r.out).hookSpecificOutput; } catch { return { permissionDecision: r.code === 0 ? 'allow' : `exit ${r.code}`, permissionDecisionReason: r.err }; }
}
const decision = (tool, input) => guard(tool, input).permissionDecision;
const calls = () => readFileSync(join(fakeDir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const C = (id, f) => `appspec/changes/${id}/${f}`;
const check = (r, name) => (json(r).checks || []).find((c) => c.slice(5).startsWith(name)) || '';

const ID = 'GIFT-1';
const T1 = 'test: extensions/gift/tests/gift.test.js › gift added at threshold';
const proposal = ({ id = ID, scenarios, surfaces = 'none', design = 'none', retires = 'none', attention = 'none: new files only.', decided = '- The gift is added as a free line by the cart transform: the ticket names it.', extra = '', tasks = '- [ ] The work (S1)' }) => `# ${id} · Proposal

## Why

The merchant wants to reward carts of 50 EUR or more with a free gift (ticket ${id}).

## What changes

- Carts at or above 50 EUR get the gift line, added by a cart transform Function.

${extra}## Scenarios

| ID | GIVEN | WHEN | THEN | Check |
| --- | --- | --- | --- | --- |
${scenarios.join('\n')}

## Surfaces

${surfaces}

## Design

${design}

## Retires

${retires}

## Needs your attention

${attention}

## Decided for you

${decided}

## Out of scope

- Gift selection by the buyer.

## Tasks

${tasks}
`;
const S1 = `| S1 | a cart with a subtotal of 50 EUR | the cart transform runs | the gift is added | ${T1} |`;
const S2 = '| S2 | the gift in the cart | the buyer opens checkout | the gift\'s line shows "Free" | qa: gift line says Free |';
const SCOPE = '| Change | Surface | Why | Scenario |\n| --- | --- | --- | --- |\n| + | scope:write_cart_transforms | the Function is activated as a cart transform | S1 |';
const PROPOSAL = proposal({ scenarios: [S1, S2], surfaces: SCOPE, attention: '- New scope write_cart_transforms: stores approve it again on the next open.' });

try {
  // ── Fixtures: fake CLI, fake vitest, app repo, origin ──
  mkdirSync(bin, { recursive: true });
  mkdirSync(fakeDir, { recursive: true });
  writeFileSync(join(fakeDir, 'calls.jsonl'), '');
  const fake = join(KIT, 'test', 'fake-shopify.mjs');
  if (process.platform === 'win32') writeFileSync(join(bin, 'shopify.cmd'), `@"${process.execPath}" "${fake}" %*\r\n`);
  else { writeFileSync(join(bin, 'shopify'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); chmodSync(join(bin, 'shopify'), 0o755); }

  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', join(tmp, 'origin.git')]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.invalid'); git('config', 'user.name', 'e2e'); git('config', 'core.autocrlf', 'false');
  write('.gitignore', 'node_modules/\n.shopify/\n');
  write('shopify.app.toml', 'client_id = "e2e"\nname = "E2E Gift"\nembedded = true\n\n[access_scopes]\nscopes = "read_products"\n\n[webhooks]\napi_version = "2026-07"\n\n  [[webhooks.subscriptions]]\n  uri = "/webhooks/app/uninstalled"\n  topics = [ "app/uninstalled" ]\n');
  write('package.json', JSON.stringify({ name: 'e2e-app', private: true, scripts: { lint: 'node -e "process.exit(0)"', deploy: 'shopify app deploy' } }, null, 2));
  write('extensions/gift/shopify.extension.toml', 'api_version = "2026-07"\n\n[[extensions]]\nname = "Gift"\nhandle = "gift"\ntype = "function"\n\n  [[extensions.targeting]]\n  target = "cart.transform.run"\n  input_query = "src/run.graphql"\n  export = "run"\n');
  write('extensions/gift/package.json', JSON.stringify({ name: 'gift', private: true, type: 'module', scripts: { test: 'vitest' } }, null, 2));
  write('extensions/gift/src/run.js', 'export function run() { return { operations: [] }; }\n');
  // A fake vitest: every test("name") in each file passes, unless its line says FAILS. Full names get a "gift " describe.
  write('node_modules/vitest/vitest.mjs', `import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(3);
const files = args.filter((a) => !a.startsWith('--'));
const outFile = args.find((a) => a.startsWith('--outputFile=')).slice(13);
writeFileSync(outFile, JSON.stringify({ testResults: files.map((file) => ({ name: file, assertionResults: [...readFileSync(file, 'utf8').matchAll(/test\\("([^"]+)".*$/gm)]
  .map((m) => ({ title: m[1], fullName: 'gift ' + m[1], status: /FAILS/.test(m[0]) ? 'failed' : 'passed', failureMessages: /FAILS/.test(m[0]) ? ['expected gift'] : [] })) })) }));
`);
  commit('base app');
  git('remote', 'add', 'origin', join(tmp, 'origin.git'));
  git('push', '-q', '-u', 'origin', 'main');

  // ── Install and setup ──
  // Devs install through the kit repo's root installer, which installs the theme kit unless given --app.
  const rootInstall = (...a) => spawnSync(process.execPath, [join(KIT, '..', 'install.mjs'), ...a], { encoding: 'utf8' });
  const install = rootInstall(repo, '--app');
  ok('installer copies the kit with the real shared modules', install.status === 0 && existsSync(join(repo, '.claude', 'kit', 'app.mjs'))
    && !/Master repo only/.test(read('.claude/kit/core.mjs')), install.stderr || install.stdout);
  // update.mjs re-runs the root installer with --app for repos listed as app.
  const installList = JSON.parse(readFileSync(process.env.SHOPIFY_KIT_REGISTRY, 'utf8'));
  ok('installer lists the repo as an app-kit repo, with the clone in its manifest',
    Object.entries(installList).some(([p, k]) => k === 'app' && p === realpathSync.native(repo)) && JSON.parse(read('.claude/.kit-manifest.json')).source === join(KIT, '..'), JSON.stringify(installList));
  ok('installer refuses a folder that isn\'t an app', spawnSync(process.execPath, [join(KIT, 'install.mjs'), tmp], { encoding: 'utf8' }).status === 1);
  const noFlag = rootInstall(repo);
  ok('root installer without --app refuses an app-kit repo', noFlag.status === 1 && /holds the app kit/.test(noFlag.stderr) && !existsSync(join(repo, '.claude', 'kit', 'kit.mjs')), noFlag.stderr || noFlag.stdout);
  ok('root installer refuses --app with --theme', rootInstall(repo, '--app', '--theme').status === 1);
  // --force skips the "is it an app" check; --dry-run keeps a regression from touching the kit's own files.
  const overKit = rootInstall(join(KIT, '..'), '--app', '--force', '--dry-run');
  ok('app installer refuses the kit\'s own repo, even with --force', overKit.status === 1 && /kit's own repo/.test(overKit.stderr), overKit.stderr || overKit.stdout);
  ok('the code both kits share is in step with shared/', spawnSync(process.execPath, [join(KIT, '..', 'scripts', 'sync-shared.mjs'), '--check'], { encoding: 'utf8' }).status === 0);
  // A manifest entry pointing out of .claude/ must not delete the repo's files on the next update.
  const manifestPath = join(repo, '.claude', '.kit-manifest.json');
  const manifestText = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(manifestText), files: ['../package.json', '../../outside.txt'] }));
  writeFileSync(join(tmp, 'outside.txt'), 'x');
  const traversal = rootInstall(repo, '--app');
  ok('an update never removes a path outside .claude/ that the manifest names', traversal.status === 0 && existsSync(join(repo, 'package.json')) && existsSync(join(tmp, 'outside.txt')), traversal.stdout + traversal.stderr);
  writeFileSync(join(repo, '.claude', 'VERSION'), '99.0.0\n');
  const downgrade = rootInstall(repo, '--app');
  ok('an install refuses to go back from a newer kit without --force', downgrade.status === 1 && /newer than this checkout/.test(downgrade.stderr), downgrade.stderr);
  writeFileSync(join(repo, '.claude', 'VERSION'), readFileSync(join(KIT, '.claude', 'VERSION'), 'utf8'));
  const themed = join(tmp, 'themed-app');
  mkdirSync(join(themed, '.claude'), { recursive: true });
  writeFileSync(join(themed, 'shopify.app.toml'), 'client_id = "x"\n');
  writeFileSync(join(themed, '.claude', '.kit-manifest.json'), JSON.stringify({ version: '1.0.0', files: [] }));
  const overTheme = rootInstall(themed, '--app');
  ok('app installer refuses a repo that holds the theme kit', overTheme.status === 1 && /holds the theme kit/.test(overTheme.stderr) && !existsSync(join(themed, '.claude', 'kit')), overTheme.stderr || overTheme.stdout);
  ok('kit files stay out of git', !git('status', '--porcelain').includes('.claude'));
  const detected = json(app('detect'));
  ok('detect suggests lint, not the deploy script', detected.suggestion?.verify?.some((v) => v.name === 'lint') && detected.notes?.some((n) => /deploy script/.test(n)), JSON.stringify(detected));
  // An app with a server, so the checklist has to work out whether a change needs it deployed.
  write('.claude/app-kit.json', JSON.stringify({ ...detected.suggestion, devStore: STORE, kind: 'admin' }, null, 2));
  const optHome = join(tmp, 'home');
  const opt = appEnv({ APPDATA: optHome, HOME: optHome, USERPROFILE: optHome }, 'optout');
  ok('optout creates the Shopify plugin\'s telemetry opt-out file', opt.code === 0 && existsSync(process.platform === 'win32' ? join(optHome, 'shopify-ai-toolkit', 'opt-out') : join(optHome, '.config', 'shopify-ai-toolkit', 'opt-out')), opt.all);

  // Jira through the kit's own reader. Every case stops before a request; HOME points away from the dev's ~/.claude/.env.
  const noJira = Object.fromEntries(Object.keys(env).filter((k) => /^JIRA_/.test(k)).map((k) => [k, '']));
  const jira = (...a) => node('kit/jira.mjs', a, { ...noJira, HOME: tmp, USERPROFILE: tmp });
  const jc = jira('--check');
  ok('jira --check without credentials names ~/.claude/.env, and .env.local is git-ignored', jc.code === 0 && json(jc).credentials === 'missing' && json(jc).envLocalIgnoredByGit === true && /~\/\.claude\/\.env /.test(json(jc).fix || ''), jc.all);
  // Precedence between the dev's two files, in a home of its own.
  const jHome = join(tmp, 'jira-home');
  const globalEnv = join(jHome, '.claude', '.env');
  mkdirSync(dirname(globalEnv), { recursive: true });
  const jiraIn = () => json(node('kit/jira.mjs', ['--check'], { ...noJira, HOME: jHome, USERPROFILE: jHome }));
  writeFileSync(globalEnv, 'JIRA_USER=global@example.com\nJIRA_API_TOKEN=g\n');
  const jg = jiraIn();
  ok('jira --check uses ~/.claude/.env when the repo has none', jg.credentials === globalEnv && jg.user === 'global@example.com', JSON.stringify(jg));
  write('.claude/.env.local', 'JIRA_USER=local@example.com\nJIRA_API_TOKEN=l\n');
  const jl = jiraIn();
  ok('.claude/.env.local wins over ~/.claude/.env', /\.env\.local$/.test(jl.credentials || '') && jl.user === 'local@example.com', JSON.stringify(jl));
  rmSync(join(repo, '.claude', '.env.local'));
  writeFileSync(globalEnv, 'JIRA_USER=global@example.com\nJIRA_API_TOKEN=g\nJIRA_BASE_URL=https://other.atlassian.net\n');
  ok('a JIRA_BASE_URL in ~/.claude/.env overrides the repo\'s jiraBaseUrl (why the docs keep it out)', jiraIn().baseUrl === 'https://other.atlassian.net');
  ok('the guard lets jira.mjs run', decision('Bash', { command: 'node .claude/kit/jira.mjs GIFT-1' }) === 'allow');
  const cfgText = read('.claude/app-kit.json');
  write('.claude/app-kit.json', JSON.stringify({ ...JSON.parse(cfgText), jiraBaseUrl: 'https://evil.example' }));
  const evil = jira('GIFT-1');
  ok('jira sends no token to a non-atlassian URL from app-kit.json', evil.code !== 0 && /not an atlassian\.net site/.test(evil.all), evil.all);
  write('.claude/app-kit.json', cfgText);
  ok('jira refuses a change name that isn\'t a ticket key', /not a Jira key/.test(jira('gift-label').all));
  ok('cli-check passes against the contract', shop('cli-check').code === 0, shop('cli-check').all);
  // The kit scaffolds an extension itself, named for the feature (merchants see the name), never the ticket key.
  const gen = shop('generate-extension', 'checkout_ui', 'trust-list', '--flavor', 'react');
  ok('generate-extension scaffolds the extension with the CLI\'s template', gen.code === 0 && json(gen).generated?.name === 'trust-list' && existsSync(join(repo, 'extensions', 'trust-list', 'shopify.extension.toml')), gen.all);
  ok('generate-extension refuses a ticket key or a non-kebab name', /ticket key/.test(shop('generate-extension', 'checkout_ui', 'abc-123').all) && /kebab-case/.test(shop('generate-extension', 'checkout_ui', 'Trust List').all));
  ok('the guard lets generate-extension run without asking', decision('Bash', { command: 'node .claude/kit/shopify.mjs generate-extension checkout_ui trust-list --flavor react' }) === 'allow');
  rmSync(join(repo, 'extensions', 'trust-list'), { recursive: true, force: true });
  const shapeCheck = node('kit/shopify.mjs', ['cli-check', '--force'], { FAKE_SHAPE_CHANGED: '1' });
  ok('cli-check fails when app info\'s JSON loses grantedScopes', shapeCheck.code !== 0 && /remoteApp\.grantedScopes/.test(shapeCheck.out), shapeCheck.all);
  const shapeInfo = node('kit/shopify.mjs', ['info'], { FAKE_SHAPE_CHANGED: '1' });
  ok('info refuses an app info shape it can\'t read, instead of reporting no granted scopes', shapeInfo.code !== 0 && /changed shape/.test(shapeInfo.err), shapeInfo.all);
  ok('cli-check passes again with the current shapes', shop('cli-check', '--force').code === 0);
  const info = shop('info');
  ok('info shows local vs granted scopes and never the .env or web env', info.code === 0 && json(info).scopes?.onlyLocal?.includes('write_cart_transforms') && !/PLANTED-SECRET/.test(info.all), info.all);
  // A bare `shopify app dev` uses the CLI's cached app and store; info gives the command that names both.
  ok('info gives the app dev command with the dev store, and warns when the CLI caches another store',
    json(info).appDev === `shopify app dev --store ${STORE}` && /separate terminal/.test(json(info).appDevWhere)
      && (STORE === 'kit-dev.myshopify.com' ? !json(info).devStoreWarning : /kit-dev\.myshopify\.com/.test(json(info).devStoreWarning || '')), info.out);
  const infoCall = calls().find((c) => c.cmd === 'app info');
  ok('the default app config passes no --config (shopify.app.toml)', infoCall && !('config' in infoCall.flags), JSON.stringify(infoCall));
  ok('every CLI call runs with the CLI\'s analytics off', calls().length > 0 && calls().every((c) => c.noAnalytics), JSON.stringify(calls().filter((c) => !c.noAnalytics).slice(0, 2)));

  // ── Onboard ──
  const onb = app('onboard');
  const snap = JSON.parse(read('appspec/surfaces.json'));
  ok('onboard records the existing security finding as the baseline', JSON.parse(read('appspec/security-baseline.json')).fingerprints.some((f) => f.startsWith('MISSING_COMPLIANCE_WEBHOOKS')), onb.all);
  ok('onboard writes surfaces.json from the config files', onb.code === 0 && snap.items['scope:read_products'] && snap.items['extension:gift'] && snap.items['webhook:app/uninstalled'], onb.all);
  ok('onboard writes no ledger file (the archive is the ledger) and no specs folder', !existsSync(join(repo, 'appspec', 'tests.json')) && !existsSync(join(repo, 'appspec', 'specs')), onb.all);
  ok('surfaces.json has one item per line and no kit version for parallel archives to conflict on', !/kitVersion/.test(read('appspec/surfaces.json'))
    && read('appspec/surfaces.json').split('\n').filter((l) => /^ {4}"/.test(l)).length === Object.keys(snap.items).length);
  // A wrong baseline is redone while uncommitted (the guard keeps the agent from deleting these files itself).
  write('appspec/surfaces.json', '{}');
  const redo = app('onboard', '--redo');
  ok('onboard --redo rewrites an uncommitted baseline', redo.code === 0 && JSON.parse(read('appspec/surfaces.json')).items?.['scope:read_products'], redo.all);
  ok('onboard prints the merge link and says the first change can stack on it', (json(redo).next || []).some((l) => /merges it|merges kit-onboard|into main/.test(l)) && (json(redo).next || []).some((l) => /needn't wait: it stacks on/.test(l)), redo.all);
  commit('onboard the app kit');
  const lateRedo = app('onboard', '--redo');
  ok('onboard --redo refuses once the baseline is committed', lateRedo.code !== 0 && /is committed/.test(lateRedo.all), lateRedo.all);
  // Before the onboarding reaches a remote, a change would measure against an app the kit never recorded. Pushed to
  // origin/kit-onboard, a change may stack on it (and measures from it) before it's merged.
  const unmerged = app('start', ID, '--type', 'change');
  ok('start refuses while the onboarding is on no remote branch', unmerged.code !== 0 && /on neither origin\/main nor origin\/kit-onboard/.test(unmerged.all), unmerged.all);
  git('push', '-q', 'origin', 'main:kit-onboard');
  git('fetch', '-q', 'origin');
  const stackedHint = app('start', ID, '--type', 'change');
  ok('with the onboarding pushed but not merged, start tells the change to branch from origin/kit-onboard', /--no-track origin\/kit-onboard/.test(stackedHint.all), stackedHint.all);
  ok('status of an unstarted change names the same branch to cut from', /--no-track origin\/kit-onboard/.test(app('status', ID).all), app('status', ID).all);
  git('push', '-q', 'origin', '--delete', 'kit-onboard');
  git('fetch', '-q', '--prune', 'origin');
  git('push', '-q', 'origin', 'main');

  // ── Start ──
  ok('start refuses on the protected branch', /protected/.test(app('start', ID, '--type', 'change').all));
  ok('status of an unstarted ID names the branch to create', /git switch -c GIFT-1 --no-track origin\/main/.test(app('status', ID).out), app('status', ID).all);
  git('switch', '-q', '-c', ID, 'origin/main');
  const started = app('start', ID, '--type', 'change', '--title', 'Free gift at 50 EUR');
  ok('start creates the change folder at propose', started.code === 0 && existsSync(join(repo, C(ID, 'proposal.md'))) && /stage 1\/5: propose/.test(started.out), started.all);
  ok('the proposal template has § Scenarios and no type sections for a change', /\n## Scenarios\n/.test(read(C(ID, 'proposal.md'))) && !/## Reproduce|## A\/B test completion/.test(read(C(ID, 'proposal.md'))));

  // ── Scenarios first: the guard by stage ──
  ok('guard: app code is closed at propose', decision('Edit', { file_path: join(repo, 'extensions/gift/src/run.js') }) === 'deny');
  ok('guard: a test may be written at propose', [undefined, 'allow'].includes(decision('Write', { file_path: join(repo, 'extensions/gift/tests/gift.test.js') })));
  ok('guard: the proposal is open at propose', ['allow', undefined].includes(decision('Edit', { file_path: join(repo, C(ID, 'proposal.md')) })));
  ok('guard: surfaces.json is kit-only', decision('Write', { file_path: join(repo, 'appspec/surfaces.json') }) === 'deny');
  ok('guard: change.json is kit-only', decision('Write', { file_path: join(repo, C(ID, 'change.json')) }) === 'deny');
  ok('guard: the deploy script is denied', decision('Bash', { command: 'npm run deploy' }) === 'deny');
  ok('guard: .env is denied', decision('Bash', { command: 'cat .env' }) === 'deny');

  // ── Propose ──
  const refused = app('done', ID, 'propose', '--answer', 'ok');
  ok('done propose refuses the untouched template', refused.code !== 0 && /§ Why/.test(refused.err) && /§ Scenarios/.test(refused.err), refused.all);
  write(C(ID, 'proposal.md'), PROPOSAL.replace('- [ ] The work (S1)', ''));
  const noTasks = app('gate', ID);
  ok('gate at propose lists the problems first: § Tasks is empty', noTasks.code !== 0 && json(noTasks).problems?.some((p) => /§ Tasks/.test(p)), noTasks.all);
  write(C(ID, 'proposal.md'), PROPOSAL);
  const v = app('gate', ID);
  ok('gate passes once the proposal and its tasks are written', v.code === 0 && json(v).ok === true, v.all);
  const gate = json(v);
  ok('the Gate 1 view shows each scenario with its values and check, the surfaces and the check counts in one go',
    gate.scenarios?.includes(`S1: GIVEN a cart with a subtotal of 50 EUR · WHEN the cart transform runs · THEN the gift is added → ${T1}`)
    && gate.surfaces?.some((a) => /^\+ scope:write_cart_transforms: new access scope/.test(a)) && gate.checks?.test === 1 && gate.checks?.qa === 1 && gate.attention?.length === 1, JSON.stringify(gate));
  // What the agent decided without asking is shown at Gate 1, and the gate wants it written (or "none").
  write(C(ID, 'proposal.md'), PROPOSAL.replace('- The gift is added as a free line by the cart transform: the ticket names it.', ''));
  const noDecided = app('gate', ID);
  ok('gate wants § Decided for you, and the Gate 1 view shows it', json(noDecided).problems?.some((p) => /Decided for you/.test(p)) && gate.decided?.length === 1, noDecided.all + JSON.stringify(gate.decided));
  write(C(ID, 'proposal.md'), PROPOSAL.replace('- New scope write_cart_transforms: stores approve it again on the next open.', 'none'));
  const noneAttn = app('gate', ID);
  ok('§ Needs your attention can\'t be "none" when a declared surface needs attention', noneAttn.code !== 0 && json(noneAttn).problems?.some((p) => /can't be "none".*scope:write_cart_transforms/.test(p)), noneAttn.all);
  write(C(ID, 'proposal.md'), PROPOSAL.replace('| S1 |\n', '| S1 |\n| + | model:GiftRule | store the threshold per shop | S1 |\n'));
  const heavy = app('gate', ID);
  ok('a data model needs § Design at Gate 1 (no design stage)', heavy.code !== 0 && json(heavy).problems?.some((p) => /fill proposal\.md § Design.*model:GiftRule/.test(p)), heavy.all);
  write(C(ID, 'proposal.md'), PROPOSAL.replace('| S1 |\n', '| S1 |\n| + | scope:read_orders | order history | S9 |\n'));
  ok('a new scope names a scenario of this change', json(app('gate', ID)).problems?.some((p) => /scope:read_orders.*name the scenario/.test(p)));
  write(C(ID, 'proposal.md'), PROPOSAL.replace('| S2 |', '| S1 |').replace('qa: gift line says Free', 'tested'));
  const badRows = json(app('gate', ID)).problems || [];
  ok('scenario rows need unique IDs and a readable check', badRows.some((p) => /two rows/.test(p)) && badRows.some((p) => /Check "tested"/.test(p)), JSON.stringify(badRows));
  write(C(ID, 'proposal.md'), PROPOSAL);
  const g1 = app('done', ID, 'propose', '--answer', 'Approved: gift at 50 EUR, new scope ok');
  ok('Gate 1 opens the build, and prints no handover commit', g1.code === 0 && /build/.test(g1.out) && !/git commit/.test(g1.out), g1.all);
  ok('qa-row measures only in verify', /verify stage/.test(app('qa-row', ID, 'S2', '--verdict', 'BLOCKED').err));
  // The skill asked the dev; the guard doesn't ask a second time, it logs the answer for the retro.
  ok('guard: a gate answer runs without a second prompt and is logged', decision('Bash', { command: `node .claude/kit/app.mjs done ${ID} accept --answer "ok"` }) === 'allow'
    && /"kind":"log".*accept/.test(readFileSync(join(repo, '.claude', 'logs', '_guard.jsonl'), 'utf8')));

  // ── Build ──
  ok('guard: app code is open in build', [undefined, 'allow'].includes(decision('Edit', { file_path: join(repo, 'extensions/gift/src/run.js') })));
  // A scenario changed after Gate 1 isn't refused: Gate 2 lists it.
  ok('guard: the proposal stays open in build', [undefined, 'allow'].includes(decision('Edit', { file_path: join(repo, C(ID, 'proposal.md')) })));
  write('shopify.app.toml', read('shopify.app.toml').replace('scopes = "read_products"', 'scopes = "read_products,write_cart_transforms,read_customers"'));
  write('extensions/gift/src/run.js', 'export function run(input) { return { operations: input.cart.cost.subtotalAmount.amount >= 50 ? [{ add: "gift" }] : [] }; }\n');
  write('extensions/gift/tests/gift.test.js', 'test("gift added at threshold", () => {});\n');
  // Shopify's Function test template: one test per fixture.
  write('extensions/gift/tests/default.test.js', 'test("runs at-threshold.json", () => {});\ntest("runs below-threshold.json", () => {});\n');
  // The expected output's keys in another order than the Function prints them: equal all the same.
  write('extensions/gift/tests/fixtures/at-threshold.json', JSON.stringify({ payload: { export: 'run', target: 'cart.transform.run', input: { cart: { cost: { subtotalAmount: { amount: 50 } } } }, output: { operations: [{ quantity: 1, add: 'gift' }] } } }));
  commit('gift at threshold');
  const b1 = app('done', ID, 'build');
  ok('done build refuses an undeclared scope, and wants the code review recorded', b1.code !== 0 && /scope:read_customers/.test(b1.err) && /review .* code --found/.test(b1.err), b1.all);
  write('shopify.app.toml', read('shopify.app.toml').replace(',read_customers', ''));
  write('extensions/gift/src/wip.js', '// not committed\n');
  ok('a review is recorded only against committed code', /Commit first/.test(app('review', ID, 'code', '--found', 'no findings').err));
  rmSync(join(repo, 'extensions/gift/src/wip.js'));
  commit('drop the extra scope');
  ok('review needs what the review found', app('review', ID, 'code').code !== 0);
  ok('review records the code review', app('review', ID, 'code', '--found', 'no findings in the Function').code === 0 && json(app('status', ID, '--json')).reviews?.code?.found === 'no findings in the Function');
  ok('no verification.md: change.json and the gate output hold the record', !existsSync(join(repo, C(ID, 'verification.md'))) && !existsSync(join(repo, C(ID, 'tasks.md'))));
  const b2 = app('done', ID, 'build');
  ok('done build passes when the surfaces match and the review is recorded', b2.code === 0, b2.all);

  // ── Verify ──
  const vr = app('verify', ID);
  const vj = json(vr);
  ok('verify passes: surfaces, scenarios, tests, ledger, lint, Function fixtures (keys in any order); the known security finding warns', vr.code === 0 && vj.ok
    && ['surfaces', 'scenarios', 'tests', 'ledger', 'command: lint', 'function gift'].every((n) => check(vr, n).startsWith('PASS'))
    && /^WARN security check: known before this change/.test(check(vr, 'security check')), vr.all);
  ok('verify flags the new scope for attention', vj.attention?.some((a) => /write_cart_transforms/.test(a.change)));
  ok('verify lists the QA scenario still to measure', vj.openQa?.some((q) => /^S2 \(qa: gift line says Free\): not measured/.test(q)), JSON.stringify(vj.openQa));
  const fnCall = calls().find((c) => c.cmd === 'app function run' && !c.flags.help);
  ok('function-run reached the CLI with the extension path', fnCall && /extensions[\\/]gift/.test(fnCall.flags.path), JSON.stringify(fnCall));
  ok('verify says the code review is recorded on this code', vj.reviews?.code === 'recorded on this code' && /security-review/.test(vj.reviews?.security || ''), JSON.stringify(vj.reviews));
  const fnShape = node('kit/shopify.mjs', ['function-run', 'gift'], { FAKE_SHAPE_CHANGED: '1' });
  ok('function-run names a changed CLI output shape', fnShape.code !== 0 && /output has no instructions/.test(fnShape.out), fnShape.all);
  if (process.platform === 'win32') {
    write('extensions/gift/tests/amp.json', JSON.stringify({ payload: { export: 'run&calc', input: { cart: {} }, output: {} } }));
    const amp = shop('function-run', 'gift', '--fixture', 'extensions/gift/tests/amp.json');
    ok('an argument cmd.exe would read as syntax fails cleanly, not with a stack trace', amp.code !== 0 && /Refusing to pass/.test(amp.out) && !/at run \(/.test(amp.err), amp.all);
    rmSync(join(repo, 'extensions/gift/tests/amp.json'));
  }
  const dv1 = app('done', ID, 'verify');
  ok('done verify waits for the QA scenario and the security review', dv1.code !== 0 && /QA S2/.test(dv1.err) && /security-review/.test(dv1.err) && !/code-review/.test(dv1.err), dv1.all);
  ok('qa-row takes a qa: scenario, not a test one', /for a qa: scenario/.test(app('qa-row', ID, 'S1', '--verdict', 'PASS').err));
  const bare = app('qa-row', ID, 'S2', '--verdict', 'PASS');
  ok('a PASS needs --measured and --how in the same call', bare.code !== 0 && /--measured/.test(bare.err), bare.all);
  ok('a waiver needs a qa: scenario', app('waive', ID, 'S1', '--reason', 'cannot').code !== 0);
  app('qa-row', ID, 'S2', '--measured', 'gift line shows "Free"', '--how', 'dev store checkout, 50 EUR cart', '--verdict', 'PASS');
  app('review', ID, 'security', '--found', 'no findings; the Function reads no customer data');
  // Docs and .gitignore aren't app code: committing them keeps the QA row and the reviews. Build output isn't either.
  write('README.md', '# E2E Gift\n');
  write('.gitignore', 'node_modules/\n.shopify/\n.env\n');
  commit('docs');
  write('extensions/gift/dist/gift.js', '// built by the CLI during verify\n');
  // A scenario reworded after Gate 1: verify reruns, and Gate 2 lists the difference instead of refusing it.
  write(C(ID, 'proposal.md'), PROPOSAL.replace('a cart with a subtotal of 50 EUR', 'a cart with a subtotal of exactly 50.00 EUR'));
  const stale = app('done', ID, 'verify');
  ok('done verify wants verify again after the scenarios changed', stale.code !== 0 && /scenarios, § Surfaces or § Retires changed after the last verify/.test(stale.err), stale.all);
  const vr2b = app('verify', ID);
  ok('verify lists what changed since Gate 1', vr2b.code === 0 && json(vr2b).changedSinceGate1?.some((l) => /^S1 changed: .*exactly 50\.00 EUR/.test(l)), vr2b.all);
  const dv2 = app('done', ID, 'verify');
  ok('done verify passes after QA and reviews, with a docs commit since and build output not committed', dv2.code === 0, dv2.all);
  rmSync(join(repo, 'extensions/gift/dist'), { recursive: true, force: true });
  const g2 = json(app('gate', ID));
  ok('the Gate 2 view shows results, QA as measured, changes since Gate 1 and the deploy steps', /Gate 2/.test(g2.gate) && g2.scenarios?.some((s) => /S2.*PASS: gift line shows "Free"/.test(s))
    && g2.changedSinceGate1?.length === 1 && g2.deploySteps?.some((s) => /shopify app deploy --config/.test(s)), JSON.stringify(g2));
  ok('accept (Gate 2) moves to handoff', app('done', ID, 'accept', '--answer', 'Accept').code === 0);

  // ── Archive ──
  // A shared file that can't be written (a folder in its place): handoff stops before the move and simply runs again.
  mkdirSync(join(repo, C(ID, 'handoff.md')));
  const arFail = app('handoff', ID);
  ok('handoff stops with a clear message when a file can\'t be written, before moving anything', arFail.code !== 0 && /Couldn't write appspec\/changes\/GIFT-1\/handoff\.md/.test(arFail.err) && /handoff GIFT-1 again/.test(arFail.err)
    && !/at \w+ \(/.test(arFail.err) && existsSync(join(repo, C(ID, 'change.json'))), arFail.all);
  rmSync(join(repo, C(ID, 'handoff.md')), { recursive: true, force: true });
  const ar = app('handoff', ID);
  const archived = readdirSync(join(repo, 'appspec', 'archive')).find((d) => d.endsWith(ID));
  ok('archive moves the change and writes the handoff, with no retro required', ar.code === 0 && archived && !existsSync(join(repo, 'appspec/changes', ID)) && /Deploy checklist/.test(read(`appspec/archive/${archived}/handoff.md`)), ar.all);
  ok('the archived change\'s bound test joins the ledger', /^not run \(1 ledgered tests/.test(json(app('drift')).regression || ''), app('drift').out);
  ok('archive records why the new scope exists', JSON.parse(read('appspec/surfaces.json')).items['scope:write_cart_transforms']?.scenario === 'S1');
  const handoffText = read(`appspec/archive/${archived}/handoff.md`);
  ok('the handoff lists the scenarios with their results and what changed since Gate 1', /- S1: GIVEN a cart with a subtotal of exactly 50\.00 EUR.*\(PASS\)/.test(handoffText) && /### Changed since Gate 1/.test(handoffText), handoffText);
  ok('the handoff says deploy releases at once, how to hold it back, and which config', /releases it to every installed store at once/.test(handoffText) && /--no-release/.test(handoffText) && /--config/.test(handoffText), handoffText);
  ok('the handoff doesn\'t ask to place a block for a Function-only change', !/Place the block/.test(handoffText), handoffText);
  ok('the handoff skips the app server when only an extension and the app config changed', !/hosting/.test(handoffText), handoffText);
  ok('the handoff carries the measured QA result and the reviews', /- S2: .*\(PASS: gift line shows "Free" \(dev store checkout, 50 EUR cart\)\)/.test(handoffText) && /- code review: no findings in the Function/.test(handoffText), handoffText);
  ok('status after an uncommitted archive says what is left', /Still to do:[\s\S]*git add -- appspec/.test(app('status', ID).out), app('status', ID).all);
  commit(`${ID}: archive`);
  ok('status after the commit says to push the branch', /git push -u origin GIFT-1/.test(app('status', ID).out) && !/git add/.test(app('status', ID).out), app('status', ID).all);
  git('push', '-q', '-u', 'origin', ID);
  ok('status after the push: nothing left for the kit', /Nothing left for the kit/.test(app('status', ID).out), app('status', ID).all);
  ok('archived files carry no updatedBy or kit version line for parallel archives to conflict on', !/updatedBy|kitVersion/.test(read('appspec/surfaces.json')));
  const dr = json(app('drift'));
  ok('drift: nothing changed outside a change, no ledgered test gone', dr.surfacesChangedOutsideArchive?.length === 0 && !('unjustifiedSurfaces' in dr) && dr.ledgerTestsGone?.length === 0, JSON.stringify(dr));
  ok('drift --regression runs the ledger', /all 1 pass/.test(json(app('drift', '--regression')).regression || ''));

  // ── A second change: a failing test, a ledgered test that disappears, a new security finding ──
  const ID2 = 'gift-cap';
  git('switch', '-q', '-c', ID2);
  app('start', ID2, '--type', 'change');
  const P2 = (o = {}) => proposal({ id: ID2, scenarios: ['| S1 | a cart that already has the gift | the transform runs | the cart has one gift | test: extensions/gift/tests/gift.test.js › one gift only |'], ...o });
  write(C(ID2, 'proposal.md'), P2());
  const g2a = app('done', ID2, 'propose', '--answer', 'ok');
  ok('a second change passes Gate 1', g2a.code === 0, g2a.all);
  write('extensions/gift/tests/gift.test.js', 'test("gift added at threshold", () => {});\ntest("one gift only", () => {}); // FAILS\n');
  commit('one gift only');
  app('review', ID2, 'code', '--found', 'no findings');
  app('done', ID2, 'build');
  const vr2 = app('verify', ID2);
  ok('verify fails on the failing test', vr2.code !== 0 && /^FAIL tests: S1: FAIL/.test(check(vr2, 'tests')), vr2.all);
  ok('verify re-ran the ledgered test as regression', /^PASS ledger/.test(check(vr2, 'ledger')) && json(app('status', ID2, '--json')).verify?.checks?.find((c) => c.name === 'ledger')?.note === '1 ledgered tests pass', vr2.all);
  ok('archive refuses a change whose verify failed', app('handoff', ID2).code !== 0);
  ok('a known finding warns, it does not fail', /^WARN security check: known before this change: MISSING_COMPLIANCE_WEBHOOKS/.test(check(vr2, 'security check')), vr2.out);
  const vrSec = appEnv({ FAKE_SECURITY_FINDING: '1' }, 'verify', ID2);
  ok('a new high security finding fails verify', /^FAIL security check: new: UNAUTHENTICATED_ENDPOINT \(high\)/.test(check(vrSec, 'security check')), vrSec.out);
  const vrNoSec = appEnv({ FAKE_SECURITY_BROKEN: '1' }, 'verify', ID2);
  ok('a security check that can\'t run warns instead of failing', /^WARN security check: shopify app security check didn't run/.test(check(vrNoSec, 'security check')), vrNoSec.out);
  // No baseline yet (onboard ran while the check couldn't): older findings in files the change didn't touch don't block.
  const baselineText = read('appspec/security-baseline.json');
  rmSync(join(repo, 'appspec/security-baseline.json'));
  const noBase = appEnv({ FAKE_SECURITY_FINDING: '1' }, 'verify', ID2);
  // The branch changed shopify.app.toml (GIFT-1's scope), so that file's medium finding counts as new, but only warns: it
  // may well be older than the change. The route's file wasn't touched.
  ok('with no baseline, findings in files the change didn\'t touch are older, and a medium one in a touched file warns', /known before this change: UNAUTHENTICATED_ENDPOINT/.test(check(noBase, 'security check'))
    && !/new: [^·]*UNAUTHENTICATED_ENDPOINT/.test(check(noBase, 'security check')) && /^WARN security check: new, not blocking: MISSING_COMPLIANCE_WEBHOOKS \(medium\)/.test(check(noBase, 'security check')), noBase.out);
  write('app/routes/api.open.jsx', 'export async function loader() { return { secret: 1 }; }\n');
  commit('an open route');
  const noBase2 = appEnv({ FAKE_SECURITY_FINDING: '1' }, 'verify', ID2);
  ok('with no baseline, a finding in a file the change touched blocks', /^FAIL security check: new: .*UNAUTHENTICATED_ENDPOINT \(high\)/.test(check(noBase2, 'security check')), noBase2.out);
  write('appspec/security-baseline.json', baselineText);
  // Two tests with the bound name: whichever passes must not stand in for the other.
  write('extensions/gift/tests/gift.test.js', 'test("gift added at threshold", () => {});\ntest("one gift only", () => {});\ntest("one gift only", () => {}); // FAILS\n');
  commit('two tests named alike');
  ok('a bound name that matches two tests is AMBIGUOUS, not a pass', /S1: AMBIGUOUS \(2 tests/.test(check(app('verify', ID2), 'tests')));
  // A ledgered test renamed away: the ledger catches it, until the change retires it.
  write('extensions/gift/tests/gift.test.js', 'test("gift added at 50", () => {});\ntest("one gift only", () => {});\n');
  commit('rename the threshold test');
  const gone = app('verify', ID2);
  ok('verify fails when a ledgered test is gone', /^FAIL ledger: gone: extensions\/gift\/tests\/gift\.test\.js › gift added at threshold \(GIFT-1 S1\)/.test(check(gone, 'ledger')), gone.out);
  write(C(ID2, 'proposal.md'), P2({ retires: '- test: extensions/gift/tests/gift.test.js › gift added at threshold: renamed to gift added at 50' }));
  const retired = app('verify', ID2);
  ok('a retired test no longer fails the ledger', retired.code === 0 && /^PASS ledger/.test(check(retired, 'ledger')), retired.out);
  ok('a test retired after Gate 1 is listed as changed since Gate 1', json(retired).changedSinceGate1?.some((l) => /^§ Retires changed: "none" → "test: extensions\/gift\/tests\/gift\.test\.js › gift added at threshold"/.test(l)), retired.out);

  // ── A dev-store mutation through the guard's seal ──
  write(`.claude/logs/${ID2}/activate.graphql`, 'mutation { cartTransformCreate(functionHandle: "gift") { cartTransform { id } userErrors { message } } }\n');
  const mcmd = `node .claude/kit/shopify.mjs mutate ${ID2} .claude/logs/${ID2}/activate.graphql`;
  const noSeal = shop('mutate', ID2, `.claude/logs/${ID2}/activate.graphql`);
  ok('mutate without the guard\'s prompt is refused', noSeal.code !== 0 && /wasn't shown/.test(noSeal.err), noSeal.all);
  const asked = guard('Bash', { command: mcmd });
  ok('guard asks before a mutation and names the dev store', asked.permissionDecision === 'ask' && asked.permissionDecisionReason.includes(STORE));
  const ran = node('kit/shopify.mjs', ['mutate', ID2, `.claude/logs/${ID2}/activate.graphql`], { SHOPIFY_FLAG_STORE: 'prod-shop.myshopify.com' });
  const exec = calls().filter((c) => c.cmd === 'app execute').pop();
  ok('the sealed mutation runs once, on the dev store, without inherited SHOPIFY_FLAG_*', ran.code === 0 && exec?.flags.store === STORE && exec.leaked.length === 0, `${ran.all}\n${JSON.stringify(exec)}`);
  ok('the seal is spent after one run', shop('mutate', ID2, `.claude/logs/${ID2}/activate.graphql`).code !== 0);
  ok('query refuses a mutation file', /mutation/.test(shop('query', `.claude/logs/${ID2}/activate.graphql`).err));

  write(`.claude/logs/${ID2}/crash.json`, JSON.stringify({ payload: { export: 'run', input: { crash: true }, output: { operations: [] } } }));
  const crash = shop('function-run', 'gift', '--fixture', `.claude/logs/${ID2}/crash.json`);
  ok('a crashing Function reports its own log, not the CLI\'s generic error', crash.code !== 0 && /boom in run/.test(crash.out), crash.all);

  // ── Abandon shows the retro signals; an abandoned ID isn't open and can start again ──
  const ab = app('abandon', ID2, '--reason', 'superseded by a merchant setting');
  ok('abandon shows the retro signals and how to note a kit cause, with no handover commit', ab.code === 0 && json(ab).retro && /note gift-cap/.test(json(ab).ask || '') && !/git commit/.test(ab.out), ab.all);
  ok('note --none works', app('note', ID2, '--none').code === 0);
  const listed = app('list').out;
  ok('list doesn\'t show an abandoned change as open', !listed.split('\n').some((l) => l.startsWith(`${ID2}\t`)) && /Abandoned .*gift-cap/.test(listed), listed);
  const restart = app('start', ID2, '--type', 'fix');
  ok('an abandoned ID can be started again, as another type, and its proposal gets that type\'s sections', restart.code === 0 && /Restarted/.test(restart.out) && /gift-cap · fix · stage 1\/5: propose/.test(app('status', ID2).out)
    && /\n## Reproduce\n[\s\S]*\n## Scenarios\n/.test(read(C(ID2, 'proposal.md'))) && /a cart that already has the gift/.test(read(C(ID2, 'proposal.md'))), restart.all);

  // ── Fix: § Reproduce, a regression test that is a new fixture of an existing test ──
  commit('gift-cap wip');
  // GIFT-1 merges: later branches measure their diff from it, as a PR would.
  git('push', '-q', 'origin', `${ID}:main`);
  const FX = 'FIX-3';
  git('switch', '-q', '-c', FX, ID);
  const fxStart = app('start', FX, '--type', 'fix');
  ok('a fix starts on the one stage graph, with § Reproduce in its proposal', fxStart.code === 0 && /FIX-3 · fix · stage 1\/5: propose/.test(fxStart.out) && /## Reproduce/.test(read(C(FX, 'proposal.md'))), fxStart.all);
  const FXS = '| S1 | a cart with a subtotal of 49.99 EUR | the cart transform runs | no gift is added | test: extensions/gift/tests/default.test.js › gift runs below-threshold.json |';
  write(C(FX, 'proposal.md'), proposal({ id: FX, scenarios: [FXS] }));
  ok('a fix needs § Reproduce', /§ Reproduce/.test(app('done', FX, 'propose', '--answer', 'ok').err));
  write(C(FX, 'proposal.md'), proposal({ id: FX, scenarios: [FXS], extra: '## Reproduce\n\nbelow-threshold.json fails before the fix: a 49.99 EUR cart got the gift.\n\n' }));
  // The bound test must fail on the unfixed code; the fake vitest fails a test whose line says FAILS.
  const fxNoRepro = app('done', FX, 'propose', '--answer', 'Approved: regression at 49.99');
  const testFile = 'extensions/gift/tests/default.test.js';
  const passing = read(testFile);
  write(testFile, passing.replace('test("runs below-threshold.json", () => {});', 'test("runs below-threshold.json", () => {}); // FAILS'));
  const fxp = app('done', FX, 'propose', '--answer', 'Approved: regression at 49.99');
  write(testFile, passing);
  ok('a fix passes Gate 1 only once its bound test fails on the unfixed code',
    fxNoRepro.code !== 0 && /no bound test fails on the unfixed code \(S1: PASS\)/.test(fxNoRepro.err) && fxp.code === 0, fxNoRepro.all + fxp.all);
  write('extensions/gift/src/run.js', 'export function run(input) { return { operations: input.cart.cost.subtotalAmount.amount >= 50.0 ? [{ add: "gift" }] : [] }; }\n');
  commit('fix-3: exact comparison');
  app('review', FX, 'code', '--found', 'no findings');
  app('done', FX, 'build');
  const fxv = app('verify', FX);
  ok('verify refuses a scenario whose test and fixtures the branch never touched', fxv.code !== 0 && /S1: extensions\/gift\/tests\/default\.test\.js isn't new or changed/.test(check(fxv, 'scenarios')), fxv.out);
  write('extensions/gift/tests/fixtures/other.json', JSON.stringify({ payload: { target: 'cart.transform.run', input: { cart: { cost: { subtotalAmount: { amount: 60 } } } }, output: { operations: [{ add: 'gift', quantity: 1 }] } } }));
  commit('fix-3: another fixture');
  ok('a test named after a fixture isn\'t touched by another fixture', /S1: .*isn't new or changed/.test(check(app('verify', FX), 'scenarios')));
  // No payload.export: the toml's export for the fixture's target, as Shopify's template does.
  write('extensions/gift/tests/fixtures/below-threshold.json', JSON.stringify({ payload: { target: 'cart.transform.run', input: { cart: { cost: { subtotalAmount: { amount: 49.99 } } } }, output: { operations: [] } } }));
  commit('fix-3: below-threshold fixture');
  const fxv2 = app('verify', FX);
  ok('the bound fixture counts as a changed test, and runs with the toml\'s export', /^PASS scenarios/.test(check(fxv2, 'scenarios')) && /^PASS function gift/.test(check(fxv2, 'function gift'))
    && calls().filter((c) => c.cmd === 'app function run' && !c.flags.help).every((c) => c.flags.export === 'run'), fxv2.out);
  commit('fix-3 verify');
  // Back to propose after the fix is built (to declare a surface, say): its test passes now, and Gate 1 must still be reachable.
  app('back', FX, 'propose', '--reason', 'declare a surface');
  const fxAgain = app('done', FX, 'propose', '--answer', 'Approved again');
  ok('a fix sent back to propose after it was built passes Gate 1 again', fxAgain.code === 0, fxAgain.all);
  commit('fix-3: Gate 1 again');

  // ── Maintain: no new scenarios needed, a QA re-check allowed, the regression through archive ──
  // A hotfix on main adds a webhook outside the kit; the next change is cut from it.
  git('switch', '-q', '-c', 'hotfix', ID);
  write('shopify.app.toml', read('shopify.app.toml').replace('topics = [ "app/uninstalled" ]', 'topics = [ "app/uninstalled" ]\n\n  [[webhooks.subscriptions]]\n  uri = "/webhooks/products/update"\n  topics = [ "products/update" ]'));
  commit('hotfix: products/update webhook');
  git('push', '-q', 'origin', 'hotfix:main');
  const MN = 'MNT-4';
  git('switch', '-q', '-c', MN, 'origin/main');
  app('start', MN, '--type', 'maintain');
  const MNP = (scenarios, o = {}) => proposal({ id: MN, scenarios, attention: 'none: the regression covers the Function.', ...o }).replace(/## What changes\n\n.*\n/, '## What changes\n\n- extensions/gift/src/run.js: a named constant for the threshold, no behaviour change.\n');
  write(C(MN, 'proposal.md'), MNP([], { retires: '- test: extensions/gift/tests/gift.test.js › gift added at 50: never ledgered' }));
  ok('§ Retires lists only tests an archived change bound', json(app('gate', MN)).problems?.some((p) => /§ Retires → .*gift added at 50 isn't a test an archived change bound/.test(p)));
  write(C(MN, 'proposal.md'), MNP([]));
  ok('maintenance passes gate with no scenarios', app('gate', MN).code === 0, app('gate', MN).all);
  write(C(MN, 'proposal.md'), MNP(['| S1 | the gift in the cart | the buyer opens checkout | the line still shows "Free" | qa: gift line says Free |', `| S2 | a cart of 50 EUR | the cart transform runs | the gift is added | ${T1} |`]));
  ok('maintenance may re-check a QA scenario and bind an existing test', app('gate', MN).code === 0, app('gate', MN).all);
  ok('maintenance passes Gate 1', app('done', MN, 'propose', '--answer', 'Approved plan').code === 0);
  write('extensions/gift/src/run.js', 'const THRESHOLD = 50;\nexport function run(input) { return { operations: input.cart.cost.subtotalAmount.amount >= THRESHOLD ? [{ add: "gift" }] : [] }; }\n');
  commit('name the threshold');
  app('review', MN, 'code', '--found', 'no findings');
  const mb = app('done', MN, 'build');
  ok('a surface changed on main outside the kit doesn\'t block the build', mb.code === 0, mb.all);
  const mv = app('verify', MN);
  ok('maintenance verify runs the ledger, and its untouched test passes the scenario check', mv.code === 0 && /^PASS ledger/.test(check(mv, 'ledger')) && /^PASS scenarios/.test(check(mv, 'scenarios')), mv.all);
  ok('verify warns about the surface changed outside the kit, and doesn\'t count it as this change\'s', /^WARN surfaces: 0 surface changes, all declared · changed outside the kit .*\+ webhook:products\/update/.test(check(mv, 'surfaces'))
    && !json(mv).attention?.some((a) => /products\/update/.test(a.change)), mv.out);
  app('qa-row', MN, 'S1', '--measured', 'gift line shows "Free"', '--how', 'dev store checkout', '--verdict', 'PASS');
  app('review', MN, 'security', '--found', 'no findings');
  ok('maintain verify done', app('done', MN, 'verify').code === 0);
  app('done', MN, 'accept', '--answer', 'Accept');
  const ma = app('handoff', MN);
  ok('maintenance archives; the ledger keeps one entry per test', ma.code === 0 && /^not run \(1 ledgered tests/.test(json(app('drift')).regression || ''), ma.all);
  ok('archive records the surface changed outside the kit', 'webhook:products/update' in JSON.parse(read('appspec/surfaces.json')).items);
  commit(`${MN}: archive`);

  // ── A/B: § Gate and § A/B test completion ──
  const AB = 'AB-5';
  git('switch', '-q', '-c', AB, ID);
  app('start', AB, '--type', 'ab');
  const abScen = ['| S1 | the cart attribute _ab_gift is B | the buyer opens checkout | the banner is shown | qa: banner shown |', '| S2 | no _ab_gift attribute | the buyer opens checkout | no banner | qa: no banner |',
    '| S3 | a cart with one item | the variation code runs | /cart.js has _ab_gift = B, after one update | qa: variation writes once |', '| S4 | a cart with _ab_gift = B | the control code runs | the attribute is cleared | qa: control clears |'];
  // Without the test code's own scenarios (S3, S4), gate refuses an A/B change.
  write(C(AB, 'proposal.md'), proposal({ id: AB, scenarios: abScen.slice(0, 2) }));
  ok('an A/B change needs scenarios for its own test code (variation writes, control clears)', /measures its own test code/.test(app('done', AB, 'propose', '--answer', 'ok').err));
  write(C(AB, 'proposal.md'), proposal({ id: AB, scenarios: abScen }));
  const abNo = app('done', AB, 'propose', '--answer', 'ok');
  ok('an A/B change needs § Gate and § A/B test completion', /§ Gate/.test(abNo.err) && /§ A\/B test completion/.test(abNo.err), abNo.all);
  const abSurf = '| Change | Surface | Why | Scenario |\n| --- | --- | --- | --- |\n| + | extension:ab-ship | the gated banner | S1 |\n| + | target:ab-ship/purchase.checkout.block.render | where the banner shows | S1 |';
  write(C(AB, 'proposal.md'), proposal({ id: AB, scenarios: abScen, surfaces: abSurf, design: '- A checkout UI block, placed by the dev; no data, no server.', attention: '- A new checkout block: the dev places it after the release.',
    extra: '## Gate\n\nCart attribute _ab_gift: B shows the banner; missing or A shows nothing.\n\n## Sunset\n\nThe test ends on 2026-12-15; the dev removes the block, then a maintain change deletes the extension.\n\n' }));
  const abYes = app('done', AB, 'propose', '--answer', 'Approved: banner for B only');
  ok('an A/B change passes Gate 1', abYes.code === 0, abYes.all);
  // The dev generated the extension (into a folder extension_directories names): its template rows come with it.
  write('shopify.app.toml', read('shopify.app.toml').replace('embedded = true', 'embedded = true\nextension_directories = ["extensions/*", "checkout/*"]'));
  write('checkout/ab-ship/shopify.extension.toml', 'api_version = "2026-07"\n\n[[extensions]]\nname = "AB ship"\nhandle = "ab-ship"\ntype = "ui_extension"\n\n  [[extensions.targeting]]\n  module = "./src/Checkout.jsx"\n  target = "purchase.checkout.block.render"\n');
  write('checkout/ab-ship/package.json', JSON.stringify({ name: 'ab-ship', private: true, dependencies: { '@shopify/ui-extensions': '2026.7.0', preact: '^10.0.0' } }));
  write('checkout/ab-ship/src/Checkout.jsx', 'export default function Banner() { return null; }\n');
  commit('ab-ship banner');
  const abSurfaces = json(app('surfaces', AB));
  ok('a declared new extension brings its API version and dependencies without rows of their own', abSurfaces.undeclared?.length === 0 && abSurfaces.unhappened?.length === 0
    && abSurfaces.changes?.some((c) => c.change === '+ extension:ab-ship'), JSON.stringify(abSurfaces));
  const abBuild = shop('build');
  const buildCall = calls().filter((c) => c.cmd === 'app build').pop();
  ok('build finds checkout UI in any extension folder, and installs nothing', json(abBuild).bundles?.some((b) => b.extension === 'ab-ship' && /checkout\/ab-ship\/dist/.test(b.note)) && buildCall?.flags['skip-dependencies-installation'] === true, abBuild.all);
  write('shopify.web.toml', 'name = "web"\n\n[commands]\ndev = "npm run dev"\nbuild = "npm run deploy"\n');
  const before = calls().filter((c) => c.cmd === 'app build').length;
  const unsafeBuild = shop('build');
  ok('build refuses to run a web build command that deploys', unsafeBuild.code !== 0 && json(unsafeBuild).skipped === true && /shopify\.web\.toml builds with "npm run deploy/.test(json(unsafeBuild).error)
    && calls().filter((c) => c.cmd === 'app build').length === before, unsafeBuild.all);
  rmSync(join(repo, 'shopify.web.toml'));

  // ── Feedback carries the record, not only the notes ──
  app('feedback');
  const fb = read('.claude/logs/kit-feedback.md');
  const kitVersion = readFileSync(join(KIT, '.claude', 'VERSION'), 'utf8').trim();
  ok('feedback names the kit build (VERSION and the installed commit) and each run\'s signals (refused stages), even with no notes', new RegExp(`kit ${kitVersion.replaceAll('.', '\\.')}\\+[0-9a-f]{7}`).test(fb)
    && /## GIFT-1 \(change, done, started with kit /.test(fb) && /- refused: propose ×/.test(fb), fb);
} catch (e) {
  ok('e2e harness', false, e.stack);
} finally {
  if (process.argv.includes('--keep')) console.log(`kept: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
