#!/usr/bin/env node
// The only way the kit talks to the Shopify CLI. It builds every argument itself, targets only
// this task's unpublished draft, and has no publish, live-push or delete-other verbs.
// The guard hook blocks direct CLI calls, so keep everything that touches the store in here.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import {
  ROOT, LOGS, KIT_DIR, THEME_DIRS, MERCHANT_JSON, WIN, print, fail, parseArgs, normKey, now, run, git,
  currentBranch, parseCliJson, diagnosticJson, readConfig, readState, writeState, secret, inTaskFolder, ignoreMatcher,
  storefrontGet, renderedTheme, storefrontPath,
} from './lib.mjs';

const HELP = `Usage: node .claude/kit/shopify.mjs <verb> ...
Read-only
  cli-check [--force]                    does the installed Shopify CLI and plugin still offer what the kit uses? (fast when unchanged)
  auth-check [--store S]                 CLI version, theme login, Admin API login, telemetry opt-out
  themes [--name TEXT]                   themes in the store: id, name, role
  query <NAME|FILE.graphql> [--owner PRODUCT] [--handle H] [--type T] [--vars FILE.json]
                                         read-only Admin GraphQL (mutations are refused). NAME is a kit query:
                                         shop, definitions (--owner), product (--handle), collection (--handle),
                                         metaobjects (--type), menus, markets, locales
  pull-live <KEY> <file-or-glob>...      live theme files into .claude/logs/<KEY>/live/
  check <KEY> [--baseline]               theme check; reports only offenses this branch introduced
  fetch <KEY> [path] [--find TEXT] [--live]
                                         one storefront page from the draft (or live), with the theme that rendered it
                                         checked; saves the HTML. Never curl ?preview_theme_id: without the cookie it serves live
  verify <KEY> [--wait SECONDS]          pull the branch's files back from the draft and compare them with HEAD
This task's draft theme
  draft <KEY> [--dry-run]                reuse or create the draft: a copy of the live theme named <KEY>
  draft <KEY> --github [--theme ID]      adopt the theme the dev connected to the task branch (Add theme → Connect from GitHub)
  push <KEY> [--dry-run]                 upload every theme file the branch's commits touched to the draft, then verify
  preview <KEY> <overrides.json>         virtual preview of the draft with JSON overrides; prints the URL
Investigations (kit.mjs start <KEY> --investigate) can't use draft, push, preview, mutate or delete-draft.
The guard asks the dev before these run
  mutate <KEY> <FILE.graphql> [--vars FILE.json] [--dry-run]
                                         Admin GraphQL mutation, recorded in the task state
  delete-draft <KEY> [--dry-run]         delete this task's draft theme`;

// /implement needs these. /shopify-investigate also reads menus, markets, languages, translations,
// pages and blogs, discounts, files and sales channels. One login requests both.
const IMPLEMENT_SCOPES = 'read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects';
const INVESTIGATE_SCOPES = 'read_online_store_navigation,read_markets,read_locales,read_translations,read_content,read_discounts,read_files,read_publications';
const SCOPES = `${IMPLEMENT_SCOPES},${INVESTIGATE_SCOPES}`;
const ADMIN_API_VERSION = '2026-07';

// Every CLI command and flag this wrapper relies on, and what breaks if one changes.
// cli-check verifies them against the installed CLI's --help after every CLI update.
const CLI_CONTRACT = [
  { cmd: ['theme', 'list'], flags: ['--store', '--json', '--no-input'], usedBy: 'themes, draft, push, preview, delete-draft' },
  { cmd: ['theme', 'info'], flags: ['--json', '--no-input'], usedBy: 'auth-check' },
  { cmd: ['theme', 'duplicate'], flags: ['--store', '--theme', '--name', '--force', '--json', '--no-input'], usedBy: 'draft (build skill, draft stage)' },
  { cmd: ['theme', 'push'], flags: ['--store', '--theme', '--only', '--nodelete', '--json', '--no-input'], usedBy: 'push (draft stage)' },
  { cmd: ['theme', 'pull'], flags: ['--store', '--live', '--theme', '--path', '--only', '--nodelete', '--no-input'], usedBy: 'pull-live, verify, the push drift check (also uses the hidden --force)' },
  { cmd: ['theme', 'preview'], flags: ['--store', '--theme', '--overrides', '--json', '--preview-id', '--no-input'], usedBy: 'preview (qa stage, settings behaviour)' },
  { cmd: ['theme', 'check'], flags: ['--path', '--output', '--no-input'], usedBy: 'check (build stage)' },
  { cmd: ['theme', 'delete'], flags: ['--store', '--theme', '--force', '--no-input'], usedBy: 'delete-draft (handoff cleanup)' },
  { cmd: ['store', 'execute'], flags: ['--store', '--query-file', '--variable-file', '--json', '--allow-mutations', '--version', '--no-input'], usedBy: 'query, mutate (clarify, plan, draft stages)' },
  { cmd: ['store', 'auth'], flags: ['--store', '--scopes'], usedBy: 'the login command auth-check suggests' },
  { cmd: ['store', 'auth', 'list'], flags: ['--json'], usedBy: 'auth-check scopes' },
];
const CHECK_PATH = join(ROOT, '.claude', 'cli-check.json');

function pluginInfo() {
  try {
    const installed = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
    const entry = (installed.plugins?.['shopify-ai-toolkit@claude-plugins-official'] || [])[0];
    return entry ? { version: entry.version, dir: join(entry.installPath, 'skills', 'shopify') } : null;
  } catch { return null; }
}

/** Full check: flags in --help, documented output schemas, read-only output shapes, the plugin's scripts and topics. */
function fullCliCheck(store) {
  const problems = [];
  const notes = [];
  for (const c of CLI_CONTRACT) {
    const r = run('shopify', [...c.cmd, '--help'], { shell: true });
    const name = `shopify ${c.cmd.join(' ')}`;
    if (r.code !== 0) { problems.push(`${name} is gone or failed (--help exit ${r.code}). Affects: ${c.usedBy}.`); continue; }
    const missing = c.flags.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/-/g, '\\-')}(\\b|=|\\s|$)`, 'm').test(r.stdout));
    if (missing.length) problems.push(`${name} no longer lists ${missing.join(', ')}. Affects: ${c.usedBy}.`);
  }
  // Only the store commands publish output schemas; check the fields the wrapper reads.
  const schema = (cmd) => parseCliJson(run('shopify', [...cmd, '--json-schema'], { shell: true }).stdout);
  const authSchema = schema(['store', 'auth', 'list']);
  const sessionProps = authSchema?.definitions?.Result?.properties?.sessions?.items?.properties || {};
  for (const field of ['store', 'subdomain', 'scopes', 'expiresAt']) if (!sessionProps[field]) problems.push(`store auth list --json no longer documents sessions[].${field}. Affects: auth-check scopes.`);
  const execSchema = schema(['store', 'execute']);
  const errorProps = execSchema?.definitions?.Error?.properties?.error?.anyOf?.[0]?.properties || {};
  for (const field of ['message', 'tryMessage', 'nextSteps', 'details']) if (!errorProps[field]) notes.push(`store execute errors no longer document error.${field}; error messages may lose detail.`);
  if (store) {
    const list = cli(['theme', 'list', '--store', store, '--json']);
    if (!Array.isArray(list.data)) notes.push('theme list --json could not be read (login?), so its output shape is unchecked.');
    else if (!list.data.every((t) => 'id' in t && 'name' in t && 'role' in t)) problems.push('theme list --json items no longer carry id, name and role. Affects: every draft verb.');
    else if (!list.data.some((t) => t.role === 'live')) problems.push('theme list --json no longer marks the live theme with role "live". Affects: draft.');
  }
  notes.push('theme duplicate/push/preview publish no output schema and can\'t be run read-only; the wrapper fails loudly at run time if their JSON changes (theme.id, theme.preview_url, url).');
  const plugin = pluginInfo();
  if (!plugin) problems.push('The Shopify plugin (shopify-ai-toolkit@claude-plugins-official) isn\'t installed. Affects: fresh docs and GraphQL validation in every stage.');
  else {
    const skill = existsSync(join(plugin.dir, 'SKILL.md')) ? readFileSync(join(plugin.dir, 'SKILL.md'), 'utf8') : '';
    for (const topic of ['liquid', 'admin']) if (!new RegExp(`\\|\\s*\`${topic}\``).test(skill)) problems.push(`The plugin's skill no longer has the "${topic}" topic. Affects: docs lookups in the plan and build stages.`);
    for (const s of ['search_docs.mjs', 'validate.mjs']) if (!existsSync(join(plugin.dir, 'scripts', s))) problems.push(`The plugin no longer ships scripts/${s}. Affects: docs lookups and GraphQL validation.`);
    const version = cfg?.adminApiVersion || ADMIN_API_VERSION;
    for (const q of readdirSync(join(KIT_DIR, 'queries')).filter((f) => f.endsWith('.graphql'))) {
      const v = run(process.execPath, [join(plugin.dir, 'scripts', 'validate.mjs'), '--api', 'admin', '--version', version, '--file', join(KIT_DIR, 'queries', q)], { env: { OPT_OUT_INSTRUMENTATION: 'true' } });
      if (!/VALID|SUCCESS/i.test(v.stdout) || /INVALID|FAILED/i.test(v.stdout)) {
        problems.push(`The kit's ${q} doesn't validate against Admin API ${version} (unsupported version, or the schema changed). Affects: query ${q.replace('.graphql', '')}. Fix the query, or bump adminApiVersion in .claude/shopify-kit.json and re-validate.`);
      } else if (/deprecated/i.test(v.stdout)) {
        notes.push(`${q} uses a deprecated field; it still works on ${version}, but update it before the next version bump.`);
      }
    }
  }
  return { problems, notes, pluginVersion: plugin?.version || null };
}

/** Task state for a verb that writes to the store; investigations are read-only. */
function writableTask(key) {
  const st = readState(key);
  if (st.kind === 'investigation') fail(`${key} is an investigation, which is read-only. To change the theme or the store, finish it and run /implement ${key}.`);
  return st;
}

function cli(args) {
  const env = {};
  const token = secret('SHOPIFY_CLI_THEME_TOKEN');
  if (token) env.SHOPIFY_CLI_THEME_TOKEN = token;
  // --no-input: an expired login fails fast instead of opening a browser and hanging the tool call.
  // theme preview --overrides drops the backslashes of a Windows path (CLI 4.9.4); forward slashes work everywhere.
  const posix = args.map((a) => (/^[A-Za-z]:\\/.test(a) ? a.replaceAll('\\', '/') : a));
  const r = run('shopify', [...posix, '--no-input'], { env, shell: true });
  // theme preview --json prints its result to stderr, wrapped in a diagnostic event (CLI 4.9.4).
  return { ...r, data: parseCliJson(r.stdout) ?? diagnosticJson(r.stderr) };
}

function cliError(r) {
  const e = r.data?.error;
  const structured = [
    e?.message, e?.tryMessage, ...(e?.nextSteps || []), e?.details ? JSON.stringify(e.details).slice(0, 1200) : null,
    r.data?.message, ...(Array.isArray(r.data?.errors) ? r.data.errors.map((x) => (typeof x === 'string' ? x : x.message || JSON.stringify(x))) : []),
  ].filter(Boolean);
  if (structured.length) return structured.join('\n');
  // No structured error: stderr or stdout, without the CLI's NDJSON progress and diagnostic events.
  // <claude-code-hint> lines are the CLI's plugin hints; Claude Code hides them, so they'd read as an empty error.
  const clean = (t) => t.split('\n').filter((l) => !/^\{"type":"(progress|diagnostic)"|^<claude-code-hint\b/.test(l.trim())).join('\n').trim();
  return (clean(r.stderr) || clean(r.stdout)).slice(-1500);
}

function loginHint(store, r) {
  const text = cliError(r);
  if (/No stored app authentication|store auth|missing.*scope|access denied.*scope|requires.*scope/i.test(text)) {
    return `Admin API login missing or lacks scopes. Ask the dev to run once (with the ! prefix):\n! shopify store auth --store ${store} --scopes ${SCOPES}`;
  }
  if (/log ?in|authenticat|session|token|401/i.test(text)) {
    return `Theme login missing or expired. Ask the dev to run once (with the ! prefix):\n! shopify theme list --store ${store}`;
  }
  return null;
}

function failCli(store, r, what) {
  const hint = loginHint(store, r);
  // Exit 0 with an unexpected shape, or a silent failure, still needs something to act on.
  const detail = cliError(r) || `CLI exit code ${r.code}. Output: ${(r.stdout.trim() || r.stderr.trim() || '(none)').slice(-1500)}`;
  fail(`${what} failed.\n${detail}${hint ? `\n\n${hint}` : ''}`);
}

// Filters locally: the CLI's --name exits with an error when nothing matches.
function listThemes(store, name) {
  const r = cli(['theme', 'list', '--store', store, '--json']);
  if (r.code !== 0 || !Array.isArray(r.data)) failCli(store, r, 'Listing themes');
  return r.data
    .map(({ id, name: n, role, processing }) => ({ id, name: n, role, processing: Boolean(processing) }))
    .filter((t) => !name || t.name.toLowerCase().includes(name.toLowerCase()));
}

/** A freshly duplicated theme reports processing:true for a while; writes to it can fail until then. */
function waitUntilReady(store, id, maxSeconds = 300) {
  const until = Date.now() + maxSeconds * 1000;
  for (;;) {
    const theme = listThemes(store).find((t) => t.id === id);
    if (!theme || !theme.processing) return theme;
    if (Date.now() > until) fail(`Theme ${id} is still processing after ${maxSeconds}s. Try again in a few minutes.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
}

function storeHandle(store) {
  return store.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
}

function taskDraft(st, themes) {
  const id = st.draft?.themeId;
  if (!id || st.draft.deletedAt) return null;
  return themes.find((t) => t.id === id) || null;
}

/** Refuses anything that isn't this task's own unpublished theme. */
function assertOwnDraft(key, st, theme) {
  if (!theme) fail(`Theme ${st.draft?.themeId} no longer exists in the store. Run: shopify.mjs draft ${key}`);
  if (theme.role !== 'unpublished') fail(`Theme ${theme.id} is "${theme.role}", not unpublished. The kit only writes to unpublished drafts.`);
  // kit/<KEY>/… is the name drafts had before kit 0.2.0.
  if (st.draft.route === 'cli' && theme.name.toUpperCase() !== key && !theme.name.startsWith(`kit/${key}/`)) fail(`Theme ${theme.id} is named "${theme.name}", not ${key}. Refusing to write to it.`);
  // A typed-in id could be a teammate's copy; a dev-made draft must carry the ticket key in its name.
  if (st.draft.route !== 'cli' && !theme.name.toUpperCase().includes(key)) {
    fail(`Theme ${theme.id} is named "${theme.name}", which doesn't contain ${key}. Ask the dev to rename their draft to include ${key}, then record it again.`);
  }
}

/** The CLI skips files matching .shopifyignore without an error. */
function shopifyIgnore() {
  const p = join(ROOT, '.shopifyignore');
  return existsSync(p) ? ignoreMatcher(readFileSync(p, 'utf8')) : () => false;
}

function assertFullHistory(base) {
  if (!git(['cat-file', '-t', base], { allowFail: true })) fail(`The base commit ${base.slice(0, 7)} isn't in this clone (shallow clone?). Run: git fetch --unshallow`);
}

/**
 * Theme files the draft must match: every file any branch commit touched, not only base...HEAD,
 * so a file reverted to its base content is re-sent instead of keeping an earlier push's version.
 */
function branchFiles(st) {
  assertFullHistory(st.base);
  const touched = git(['log', '--format=', '--name-only', '--no-renames', '--relative', `${st.base}..HEAD`, '--', ...THEME_DIRS], { allowFail: true });
  const files = [];
  const gone = [];
  for (const f of [...new Set(touched.split('\n').filter(Boolean))].sort()) {
    if (existsSync(join(ROOT, f))) files.push(f); else gone.push(f);
  }
  for (const out of st.buildOutputs || []) if (existsSync(join(ROOT, out)) && !files.includes(out)) files.push(out);
  return { files, gone };
}

/** Batches stay well under cmd.exe's 8,191-character command line. */
function batches(files) {
  const out = [[]];
  for (const f of files) {
    const current = out[out.length - 1];
    if (current.length && current.join(' ').length + f.length > 5000) out.push([f]); else current.push(f);
  }
  return out;
}

/** Changed merchant JSON that live edited after the branch's base: pushing it would overwrite those edits. */
function liveDrift(st, files) {
  const jsonFiles = files.filter((f) => MERCHANT_JSON.test(f) || /^locales\/.+\.json$/.test(f));
  if (!jsonFiles.length) return [];
  const dir = mkdtempSync(join(tmpdir(), 'kit-live-'));
  try {
    const r = cli(['theme', 'pull', '--store', cfg.store, '--live', '--path', dir, '--nodelete', '--force', ...jsonFiles.flatMap((f) => ['--only', f])]);
    if (r.code !== 0) failCli(cfg.store, r, 'Pulling live JSON for the drift check');
    return jsonFiles.filter((f) => {
      const livePath = join(dir, f);
      const liveText = existsSync(livePath) ? readFileSync(livePath, 'utf8') : null;
      const baseText = git(['show', `${st.base}:./${f}`], { allowFail: true }) || null;
      return baseText !== null && normJson(liveText) !== normJson(baseText);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/** Pull the files back from the draft and compare them with the working tree (clean, so = HEAD). */
function draftMismatches(themeId, files) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-draft-'));
  try {
    for (const batch of batches(files)) {
      const r = cli(['theme', 'pull', '--store', cfg.store, '--theme', String(themeId), '--path', dir, '--nodelete', '--force', ...batch.flatMap((f) => ['--only', f])]);
      if (r.code !== 0) failCli(cfg.store, r, 'Pulling the draft\'s files to verify them');
    }
    const out = [];
    for (const f of files) {
      const onDraft = join(dir, f);
      if (!existsSync(onDraft)) { out.push({ file: f, problem: 'missing on the draft' }); continue; }
      const a = readFileSync(onDraft);
      const b = readFileSync(join(ROOT, f));
      const text = /\.(liquid|json|css|js|svg|txt|md)$/i.test(f);
      const same = /\.json$/i.test(f) ? normJson(a.toString('utf8')) === normJson(b.toString('utf8'))
        : text ? sameText(a.toString('utf8'), b.toString('utf8')) : a.equals(b);
      if (!same) out.push({ file: f, problem: /\.json$/i.test(f) ? 'differs: Shopify often drops settings or blocks its schema didn\'t know at upload time' : 'differs from HEAD' });
    }
    return out;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function gqlFile(file) {
  if (!existsSync(file)) fail(`No such file: ${file}`);
  return readFileSync(file, 'utf8');
}

const hasMutation = (text) => /\bmutation\b/.test(text.replace(/#.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, ''));

function storeExecute(store, file, vars, { mutate = false } = {}) {
  // Pinned: queries are validated against this version; the CLI would otherwise use the newest.
  const args = ['store', 'execute', '--store', store, '--query-file', file, '--json', '--version', cfg?.adminApiVersion || ADMIN_API_VERSION];
  if (vars) args.push('--variable-file', vars);
  if (mutate) args.push('--allow-mutations');
  const r = cli(args);
  if (r.code !== 0 || r.data?.error) failCli(store, r, 'Admin GraphQL');
  // A GraphQL response can carry top-level errors with exit 0.
  if (Array.isArray(r.data?.errors) && r.data.errors.length) fail(`Admin GraphQL returned errors:\n${r.data.errors.map((e) => `- ${e.message || JSON.stringify(e)}`).join('\n')}`);
  return r.data;
}

function collect(value, test, out = []) {
  if (Array.isArray(value)) value.forEach((v) => collect(v, test, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (test(k, v)) out.push(v);
      collect(v, test, out);
    }
  }
  return out;
}

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out;
}

// Shopify adds a comment header to JSON templates saved in the admin; compare data, not formatting.
function normJson(text) {
  if (text == null) return null;
  const stripped = text.replace(/^\s*\/\*[\s\S]*?\*\//, '');
  try { return JSON.stringify(JSON.parse(stripped)); } catch { return stripped.replace(/\s+/g, ''); }
}

/** Parse `git diff -U0` into changed line ranges per file. */
function changedRanges(base) {
  // --relative keeps paths relative to this folder when the theme lives in a repo subfolder.
  const diff = git(['diff', '-U0', '--no-color', '--relative', base, '--', ...THEME_DIRS], { allowFail: true });
  const ranges = {};
  let file = null;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) { file = f[1]; ranges[file] ||= []; continue; }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) ranges[file].push([start, start + count - 1]);
    }
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...THEME_DIRS], { allowFail: true });
  for (const f of untracked.split('\n').filter(Boolean)) ranges[f] = [[1, Infinity]];
  return ranges;
}

function themeCheck() {
  const r = run('shopify', ['theme', 'check', '--path', ROOT, '--output', 'json', '--no-input'], { shell: true });
  const data = parseCliJson(r.stdout);
  if (!Array.isArray(data)) fail(`theme check produced no JSON.\n${(r.stderr || r.stdout).slice(0, 1500)}`);
  const offenses = [];
  for (const f of data) {
    const path = relative(ROOT, f.path).replaceAll('\\', '/');
    for (const o of f.offenses || []) {
      offenses.push({ path, line: (o.start_row ?? 0) + 1, check: o.check, severity: o.severity, message: o.message });
    }
  }
  return offenses;
}

const countBy = (items, key) => items.reduce((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] || 0) + 1 }), {});

const args = parseArgs(process.argv.slice(2));
const [verb, ...pos] = args._;
const { flags } = args;

if (!verb || verb === 'help' || flags.help) { print(HELP); process.exit(verb && verb !== 'help' ? 1 : 0); }

const cfg = verb === 'auth-check' || verb === 'cli-check' ? readConfig({ required: false }) : readConfig();
// adminApi: false in shopify-kit.json means nobody could approve the CLI's app on this store.
const NO_ADMIN = 'This repo runs without Admin API access (adminApi: false in .claude/shopify-kit.json), so the kit can\'t query or change store data. '
  + 'Use the manual path: read the admin page in Chrome (look only) or ask the dev, and give store changes to the dev as admin steps. '
  + 'Once someone approves the login (shopify.mjs auth-check prints the command), set adminApi to true.';

switch (verb) {
  case 'cli-check': {
    const v = run('shopify', ['version'], { shell: true });
    if (v.code !== 0) fail('Shopify CLI not found. Install it: npm i -g @shopify/cli@latest');
    const cliVersion = v.stdout.trim().split('\n').pop();
    const pluginVersion = pluginInfo()?.version || null;
    const last = existsSync(CHECK_PATH) ? JSON.parse(readFileSync(CHECK_PATH, 'utf8')) : null;
    if (!flags.force && last?.ok && last.cliVersion === cliVersion && last.pluginVersion === pluginVersion) {
      print({ ok: true, cliVersion, pluginVersion, verifiedAt: last.checkedAt, note: 'unchanged since the last full check' });
      break;
    }
    const result = fullCliCheck(cfg?.store);
    const report = { ok: result.problems.length === 0, cliVersion, pluginVersion, previous: last ? { cliVersion: last.cliVersion, pluginVersion: last.pluginVersion } : null, checkedAt: now(), problems: result.problems, notes: result.notes };
    writeFileSync(CHECK_PATH, JSON.stringify(report, null, 2));
    print(report);
    if (!report.ok) process.exit(2);
    break;
  }

  case 'auth-check': {
    const out = {};
    const v = run('shopify', ['version'], { shell: true });
    out.cliVersion = v.code === 0 ? v.stdout.trim().split('\n').pop() : `not found (${v.stderr.trim().slice(0, 200)})`;
    // The kit needs these commands; older CLI versions lack some of them.
    const needed = [['theme', 'duplicate'], ['theme', 'preview'], ['theme', 'check'], ['store', 'execute']];
    const missing = needed.filter((c) => run('shopify', [...c, '--help'], { shell: true }).code !== 0).map((c) => c.join(' '));
    out.cliCommands = missing.length ? `missing: ${missing.join(', ')} (update with: npm i -g @shopify/cli@latest)` : 'ok';
    const info = cli(['theme', 'info', '--json']);
    out.cliCurrentStore = info.data?.store || null;
    const store = flags.store || cfg?.store || out.cliCurrentStore;
    out.store = store || null;
    if (!store) { out.next = 'No store known. Ask the dev for the store\'s myshopify.com domain and pass --store.'; print(out); break; }
    const themes = cli(['theme', 'list', '--store', store, '--json', '--role', 'live']);
    out.themeLogin = Array.isArray(themes.data) ? 'ok' : 'missing';
    if (Array.isArray(themes.data)) out.liveTheme = themes.data.map(({ id, name }) => ({ id, name }))[0] || null;
    else out.themeLoginFix = `! shopify theme list --store ${store}`;
    const shopQuery = join(KIT_DIR, 'queries', 'shop.graphql');
    const shop = cli(['store', 'execute', '--store', store, '--query-file', shopQuery, '--json']);
    if (shop.data?.data?.shop || shop.data?.shop) {
      out.adminLogin = 'ok';
      out.shop = shop.data.data?.shop || shop.data.shop;
      // Documented shape (store auth list --json-schema): { sessions: [{ store, subdomain, scopes, expiresAt, … }] }
      const sessions = cli(['store', 'auth', 'list', '--json']).data?.sessions || [];
      const mine = sessions.find((a) => a.store === store || `${a.subdomain}.myshopify.com` === store);
      if (mine) {
        out.adminScopes = mine.scopes;
        out.adminLoginExpires = mine.expiresAt || null;
        const lacking = (scopes) => scopes.split(',').filter((s) => !(mine.scopes || []).includes(s) && !(mine.scopes || []).includes(s.replace('read_', 'write_')));
        const forImplement = lacking(IMPLEMENT_SCOPES);
        const forInvestigate = lacking(INVESTIGATE_SCOPES);
        if (forImplement.length) out.adminScopesFix = `Missing ${forImplement.join(', ')} (needed by /implement): ! shopify store auth --store ${store} --scopes ${SCOPES}`;
        if (forInvestigate.length) out.investigateScopesFix = `Missing ${forInvestigate.join(', ')} (needed by /shopify-investigate for menus, markets, languages and other store settings): ! shopify store auth --store ${store} --scopes ${SCOPES}`;
      }
    } else {
      out.adminLogin = 'missing';
      out.adminLoginNote = 'Optional. The login installs Shopify\'s CLI app on the store, so it needs someone allowed to install apps, once per store. Without it, set adminApi: false and the kit uses manual admin steps instead.';
      out.adminLoginFix = `! shopify store auth --store ${store} --scopes ${SCOPES}`;
    }
    const optOut = WIN
      ? join(process.env.APPDATA || '', 'shopify-ai-toolkit', 'opt-out')
      : join(process.env.HOME || '', '.config', 'shopify-ai-toolkit', 'opt-out');
    out.pluginTelemetryOptOut = existsSync(optOut) || process.env.OPT_OUT_INSTRUMENTATION === 'true';
    out.pluginTelemetryOptOutFile = existsSync(optOut) ? optOut : 'missing (node .claude/kit/kit.mjs optout)';
    print(out);
    break;
  }

  case 'themes': {
    print(listThemes(cfg.store, typeof flags.name === 'string' ? flags.name : undefined));
    break;
  }

  case 'query': {
    if (cfg.adminApi === false) fail(NO_ADMIN);
    const what = pos[0] || fail('Usage: query <NAME|FILE.graphql> [--owner PRODUCT] [--handle H] [--type T] [--vars FILE.json]');
    let file = what;
    let vars = typeof flags.vars === 'string' ? flags.vars : null;
    const named = join(KIT_DIR, 'queries', `${what}.graphql`);
    if (/^[a-z-]+$/.test(what) && existsSync(named)) {
      file = named;
      // The kit's queries take at most one simple variable, given as a flag.
      const given = {
        ownerType: what === 'definitions' ? String(flags.owner || 'PRODUCT').toUpperCase() : undefined,
        handle: typeof flags.handle === 'string' ? flags.handle : undefined,
        type: typeof flags.type === 'string' ? flags.type : undefined,
      };
      const needed = [...readFileSync(named, 'utf8').matchAll(/\$(\w+):/g)].map((m) => m[1]);
      const missing = needed.filter((n) => given[n] === undefined);
      if (missing.length) fail(`query ${what} needs --${missing.map((n) => (n === 'ownerType' ? 'owner' : n)).join(' --')}`);
      if (needed.length) {
        vars = join(mkdtempSync(join(tmpdir(), 'kit-')), 'vars.json');
        writeFileSync(vars, JSON.stringify(Object.fromEntries(needed.map((n) => [n, given[n]]))));
      }
    } else if (!existsSync(file)) {
      fail(`No kit query named "${what}" and no such file. Kit queries: ${readdirSync(join(KIT_DIR, 'queries')).map((f) => f.replace('.graphql', '')).join(', ')}`);
    }
    if (hasMutation(gqlFile(file))) fail('This file contains a mutation. Mutations go through: shopify.mjs mutate <KEY> <file> (the dev approves it).');
    const data = storeExecute(cfg.store, file, vars);
    print(data?.data ?? data);
    break;
  }

  case 'pull-live': {
    const key = normKey(pos[0]);
    readState(key);
    const files = pos.slice(1);
    if (!files.length) fail('Name the files or globs to pull, e.g. pull-live ABC-123 "templates/product*.json"');
    const dest = join(LOGS, key, 'live');
    mkdirSync(dest, { recursive: true });
    // --force: the CLI refuses a non-theme folder that already has files (the second pull of a task).
    const r = cli(['theme', 'pull', '--store', cfg.store, '--live', '--path', dest, '--nodelete', '--force', ...files.flatMap((f) => ['--only', f])]);
    if (r.code !== 0) failCli(cfg.store, r, 'Pulling live files');
    print({ folder: relative(ROOT, dest).replaceAll('\\', '/'), files: walk(dest) });
    break;
  }

  case 'check': {
    const key = normKey(pos[0]);
    const st = readState(key);
    const baselinePath = join(LOGS, key, 'theme-check-baseline.json');
    if (flags.baseline) {
      const head = git(['rev-parse', 'HEAD'], { allowFail: true });
      const cached = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
      if (cached && (cached.commit === head || (st.base && head !== st.base)) && !flags.force) { print({ baseline: 'already recorded', commit: cached.commit.slice(0, 7), total: cached.total }); break; }
      // A baseline taken after edits would hide the offenses those edits introduced.
      if (st.base && head !== st.base) fail('Record the baseline right after creating the branch, while HEAD is still the base commit.');
      if (git(['status', '--porcelain', '--', ...THEME_DIRS], { allowFail: true })) fail('Record the baseline on a clean tree, before any theme file changes.');
      const offenses = themeCheck();
      const baseline = { at: now(), commit: head, total: offenses.length, byCheck: countBy(offenses, 'check') };
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      print({ baseline: 'saved', total: baseline.total, note: 'Existing offenses are recorded; later checks report only what this branch adds.' });
      break;
    }
    if (!st.base) fail(`No base commit recorded yet. Record it first: kit.mjs set ${key} base=<sha>`);
    assertFullHistory(st.base);
    const offenses = themeCheck();
    // Diff from the merge base, so base-branch changes merged into the task branch don't count as introduced.
    const ranges = changedRanges(git(['merge-base', st.base, 'HEAD'], { allowFail: true }) || st.base);
    const introduced = offenses.filter((o) => (ranges[o.path] || []).some(([a, b]) => o.line >= a && o.line <= b));
    const result = {
      introduced,
      introducedErrors: introduced.filter((o) => o.severity === 'error').length,
      introducedWarnings: introduced.filter((o) => o.severity !== 'error').length,
    };
    if (existsSync(baselinePath)) {
      const before = JSON.parse(readFileSync(baselinePath, 'utf8')).byCheck;
      const after = countBy(offenses, 'check');
      // Catches offenses the change causes in files it didn't touch (e.g. a removed snippet).
      result.checksThatRose = Object.entries(after).filter(([c, n]) => n > (before[c] || 0)).map(([check, n]) => ({ check, before: before[check] || 0, after: n }));
    } else {
      result.note = `No baseline; only offenses on changed lines are shown. Run: shopify.mjs check ${key} --baseline (before building).`;
    }
    print(result);
    break;
  }

  case 'draft': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    const themes = listThemes(cfg.store);
    const existing = taskDraft(st, themes);
    if (existing) {
      assertOwnDraft(key, st, existing);
      print({ reused: true, ...st.draft });
      break;
    }
    const name = key;
    const live = themes.find((t) => t.role === 'live') || fail('No live theme found in the store.');
    const same = themes.find((t) => t.name.toUpperCase() === key && t.role === 'unpublished');
    const others = themes.filter((t) => t.role !== 'live' && t !== same && t.name.toUpperCase().includes(key));
    const record = (theme, source, route = 'cli') => {
      const handle = storeHandle(cfg.store);
      st.draft = {
        themeId: theme.id, name: theme.name, route, source, liveThemeId: live.id, createdAt: now(),
        previewUrl: `https://${cfg.store}/?preview_theme_id=${theme.id}`,
        editorUrl: `https://admin.shopify.com/store/${handle}/themes/${theme.id}/editor`,
        lastPushedCommit: null,
      };
      writeState(key, st);
    };
    if (flags.github) {
      // Connecting a branch is admin-only (no CLI or API); the dev does it once, the kit adopts the result.
      const branch = st.branch || fail('No task branch recorded yet; the build stage creates it.');
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
      if (!local || local !== git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true })) {
        fail(`Push the task branch first, so Shopify can see it: git push -u origin ${branch}`);
      }
      const wanted = typeof flags.theme === 'string' ? Number(flags.theme) : null;
      const candidates = themes.filter((t) => t.role === 'unpublished'
        && (wanted ? t.id === wanted : t.name.toUpperCase().includes(key) || t.name.toLowerCase().includes(branch.toLowerCase())));
      if (candidates.length !== 1) {
        const repo = git(['remote', 'get-url', 'origin'], { allowFail: true }).replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, '$1');
        print({
          connected: false,
          candidates,
          devSteps: [
            'Shopify admin → Online Store → Themes → Add theme → Connect from GitHub.',
            `Pick the repository ${repo || '(this repo)'} and the branch ${branch}.`,
            `When the theme appears in the library: if its name doesn't contain ${key}, rename it (… → Rename) so the kit can recognise it.`,
            `Then: shopify.mjs draft ${key} --github${candidates.length > 1 ? ' --theme <id>' : ''}`,
          ],
          note: 'Every save in this theme\'s admin (editor or code editor) becomes a commit on the branch. That is how customizer settings reach the PR; the kit itself never saves there.',
        });
        process.exit(2);
      }
      if (!candidates[0].name.toUpperCase().includes(key)) fail(`Theme ${candidates[0].id} is named "${candidates[0].name}". Ask the dev to rename it to include ${key}, then run this again.`);
      record(candidates[0], `GitHub-connected to ${branch}`, 'github');
      print({ adopted: true, ...st.draft, next: `shopify.mjs verify ${key}` });
      break;
    }
    if (same) {
      // Someone else may have made it (a teammate, or by hand), so the kit never offers to delete it on its own.
      record(same, 'adopted an existing theme with this task\'s name', 'manual');
      print({ adopted: true, ...st.draft, note: `An unpublished theme named ${key} existed already (a teammate's draft, an earlier session, or made by hand). The kit will push to it. Pushing replaces the changed files, so check with whoever made it first.` });
      break;
    }
    const command = `shopify theme duplicate --store ${cfg.store} --theme ${live.id} --name ${name} --force --json --no-input`;
    if (flags['dry-run']) { print({ dryRun: true, wouldRun: command, otherDraftsForThisTask: others }); break; }
    const r = cli(['theme', 'duplicate', '--store', cfg.store, '--theme', String(live.id), '--name', name, '--force', '--json']);
    const theme = r.data?.theme;
    if (!theme?.id) {
      const errors = (r.data?.errors || []).join('; ');
      if (/maximum number of themes/i.test(errors)) {
        const unpublished = themes.filter((t) => t.role === 'unpublished');
        fail(`The theme library is full (${themes.length} themes, ${unpublished.length} unpublished). Unpublished themes:\n${unpublished.map((t) => `- ${t.id} ${t.name}`).join('\n')}\nAsk the dev to free a slot: kit drafts of finished tasks via shopify.mjs delete-draft <KEY>, anything else in the admin.`);
      }
      failCli(cfg.store, r, 'Duplicating the live theme');
    }
    record(theme, `copy of live theme ${live.id}`);
    waitUntilReady(cfg.store, theme.id);
    print({ created: true, ...st.draft, otherDraftsForThisTask: others });
    break;
  }

  case 'push': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId) fail(`No draft yet. Run: shopify.mjs draft ${key}`);
    if (st.draft.route === 'github') fail('This draft is GitHub-connected: update it with git push origin <branch>, not the CLI.');
    if (!st.base) fail(`No base commit recorded. Run: kit.mjs set ${key} base=<sha>`);
    const branch = currentBranch();
    if (branch !== st.branch) fail(`You're on "${branch}", but this task's branch is "${st.branch}".`);
    if (git(['status', '--porcelain', '--', ...THEME_DIRS], { allowFail: true })) fail('Commit the theme changes first, so the draft matches a commit.');
    const target = waitUntilReady(cfg.store, st.draft.themeId);
    assertOwnDraft(key, st, target);

    const { files, gone: deleted } = branchFiles(st);
    if (!files.length) fail('Nothing to push: the branch has no committed theme changes beyond its base.');
    const ignored = files.filter(shopifyIgnore());
    if (ignored.length) fail(`The repo's .shopifyignore excludes ${ignored.join(', ')}, so the CLI would skip them without saying so. Ask the dev how these files reach the store (often: they are edited in the admin, not in git).`);

    const head = git(['rev-parse', 'HEAD']);
    if (flags['dry-run']) { print({ dryRun: true, theme: target, files, deletedOnBranch: deleted, jsonDriftCheck: 'skipped in dry run' }); break; }
    const drifted = liveDrift(st, files);
    if (drifted.length) {
      fail(`Live has changed ${drifted.join(', ')} since this branch's base. Pushing would overwrite those edits on the draft and, after merge, on live.\nMerge origin/${cfg.baseBranch || 'main'} into the branch (Shopify syncs live edits into it), resolve, commit, then push again. If this repo doesn't sync live edits into git, ask the dev how to reconcile.`, 3);
    }
    let urls = {};
    for (const batch of batches(files)) {
      const r = cli(['theme', 'push', '--store', cfg.store, '--theme', String(target.id), '--nodelete', '--json', ...batch.flatMap((f) => ['--only', f])]);
      if (r.code !== 0) failCli(cfg.store, r, `Pushing ${batch.length} files`);
      // Shopify can reject single files (e.g. a Liquid syntax error) while the command still exits 0.
      if (r.data?.theme?.warning || r.data?.theme?.errors) {
        fail(`Shopify rejected files: ${r.data.theme.warning || ''}\n${JSON.stringify(r.data.theme.errors || {}, null, 2).slice(0, 2500)}\nFix them, commit, and push again. The draft is not up to date.`);
      }
      urls = { previewUrl: r.data?.theme?.preview_url, editorUrl: r.data?.theme?.editor_url };
    }
    // An exit code of 0 doesn't prove the draft holds the files; read them back.
    const mismatches = draftMismatches(target.id, files);
    if (mismatches.length) {
      fail(`Uploaded, but the draft doesn't match ${head.slice(0, 7)}:\n${mismatches.map((m) => `- ${m.file}: ${m.problem}`).join('\n')}\nPush once more. If the same files differ again, stop and show the dev this list.`, 3);
    }
    st.draft.lastPushedCommit = head;
    st.draft.verifiedCommit = head;
    st.draft.pushedAt = now();
    st.draft.pushedFiles = files.length;
    if (urls.previewUrl) st.draft.previewUrl = urls.previewUrl;
    if (urls.editorUrl) st.draft.editorUrl = urls.editorUrl;
    writeState(key, st);
    print({
      pushed: files.length, verified: `${files.length}/${files.length} files match ${head.slice(0, 7)}`, previewUrl: st.draft.previewUrl, editorUrl: st.draft.editorUrl,
      deletedOnBranchButStillOnDraft: deleted,
    });
    break;
  }

  case 'verify': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId) fail(`No draft yet. Run: shopify.mjs draft ${key}`);
    const target = listThemes(cfg.store).find((t) => t.id === st.draft.themeId);
    assertOwnDraft(key, st, target);
    const { files, gone } = branchFiles(st);
    if (!files.length) fail('The branch has no committed theme changes beyond its base.');
    const head = git(['rev-parse', 'HEAD']);
    const github = st.draft.route === 'github';
    if (github) {
      const remote = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${st.branch}`], { allowFail: true });
      if (remote !== head) fail(`origin/${st.branch} isn't at HEAD. A GitHub-connected draft follows the remote branch: git push -u origin ${st.branch}`);
    }
    // GitHub sync takes a few seconds to a minute after a push.
    const waitSeconds = Number(flags.wait ?? (github ? 120 : 0));
    const until = Date.now() + waitSeconds * 1000;
    let mismatches = draftMismatches(target.id, files);
    while (mismatches.length && Date.now() < until) { sleep(15000); mismatches = draftMismatches(target.id, files); }
    const drifted = github ? liveDrift(st, files) : [];
    if (!mismatches.length) { st.draft.verifiedCommit = head; writeState(key, st); }
    print({
      commit: head.slice(0, 7), files: files.length, matching: files.length - mismatches.length, mismatches,
      deletedOnBranchButStillOnDraft: gone,
      ...(drifted.length ? { liveChangedSinceBase: drifted, fix: `Merge origin/${cfg.baseBranch || 'main'} into the branch, resolve, commit and push: the merge would otherwise overwrite these live edits.` } : {}),
    });
    if (mismatches.length || drifted.length) process.exit(3);
    break;
  }

  case 'fetch': {
    const key = normKey(pos[0]);
    const st = readState(key);
    const live = Boolean(flags.live);
    const id = st.draft?.themeId;
    if (!live && (!id || st.draft.deletedAt)) fail(`${key} has no draft. Use --live to fetch the live theme.`);
    const path = storefrontPath(pos[1] || 'home');
    const origin = (cfg.storefrontUrl || `https://${cfg.store}`).replace(/\/+$/, '');
    const url = live ? origin + path : `${origin}${path}${path.includes('?') ? '&' : '?'}preview_theme_id=${id}`;
    const page = await storefrontGet(url);
    const theme = renderedTheme(page.html);
    const rightTheme = live ? theme?.role === 'main' : theme?.id === id;
    const dir = join(LOGS, key, 'fetch');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${live ? 'live' : 'draft'}-${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}.html`);
    writeFileSync(file, page.html);
    const count = (needle) => page.html.split(needle).length - 1;
    const out = {
      url, status: page.status, finalUrl: page.url, theme, rightTheme,
      ...(st.featurePrefix ? { featurePrefixHits: count(st.featurePrefix) } : {}),
      ...(typeof flags.find === 'string' ? { find: { [flags.find]: count(flags.find) } } : {}),
      html: relative(ROOT, file).replaceAll('\\', '/'),
    };
    if (!rightTheme) out.problem = theme ? `Rendered theme ${theme.id} (${theme.role}), not ${live ? 'the live theme' : id}.` : 'No Shopify.theme in the page (password page, bot protection or an error page?).';
    print(out);
    if (!rightTheme) process.exit(2);
    break;
  }

  case 'preview': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId) fail(`No draft yet. Run: shopify.mjs draft ${key}`);
    const { abs, ok } = inTaskFolder(key, pos[1] || '');
    if (!pos[1] || !ok) fail(`Put the overrides file in .claude/logs/${key}/previews/ and pass its path.`);
    let overrides;
    try { overrides = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { fail(`Overrides file isn't valid JSON: ${e.message}`); }
    if (!overrides.theme_changes) fail('Overrides need a top-level "theme_changes" object. Start from .claude/kit/templates/preview-overrides.example.json.');
    assertOwnDraft(key, st, listThemes(cfg.store).find((t) => t.id === st.draft.themeId));
    const file = relative(ROOT, abs).replaceAll('\\', '/');
    // Re-previewing the same overrides file updates its preview instead of creating another.
    const previous = [...st.previews].reverse().find((p) => p.file === file && p.id);
    const r = cli(['theme', 'preview', '--store', cfg.store, '--theme', String(st.draft.themeId), '--overrides', abs, '--json', ...(previous ? ['--preview-id', previous.id] : [])]);
    // Documented output: { url, preview_identifier }.
    if (r.code !== 0 || !r.data?.url) failCli(cfg.store, r, 'Creating the preview');
    st.previews.push({ at: now(), file, url: r.data.url, id: r.data.preview_identifier || previous?.id || null });
    writeState(key, st);
    print({ url: r.data.url, previewId: r.data.preview_identifier || null });
    break;
  }

  case 'mutate': {
    if (cfg.adminApi === false) fail(NO_ADMIN);
    const key = normKey(pos[0]);
    const st = writableTask(key);
    const { abs, ok } = inTaskFolder(key, pos[1] || '');
    if (!pos[1] || !ok) fail(`Put the mutation in .claude/logs/${key}/mutations/ and pass its path.`);
    const text = gqlFile(abs);
    if (!hasMutation(text)) fail('No mutation in this file. Read-only queries go through: shopify.mjs query <file>');
    let vars = null;
    if (typeof flags.vars === 'string') {
      const v = inTaskFolder(key, flags.vars);
      if (!v.ok || !existsSync(v.abs)) fail(`Put the variables file in .claude/logs/${key}/mutations/ too.`);
      vars = v.abs;
    }
    if (flags['dry-run']) { print({ dryRun: true, store: cfg.store, mutation: text, variables: vars ? readFileSync(vars, 'utf8') : null }); break; }
    const data = storeExecute(cfg.store, abs, vars, { mutate: true });
    const userErrors = collect(data, (k, v) => k === 'userErrors' && Array.isArray(v) && v.length).flat();
    const ids = [...new Set(collect(data, (k, v) => typeof v === 'string' && /^gid:\/\/shopify\//.test(v)))];
    st.mutations.push({ at: now(), file: relative(ROOT, abs).replaceAll('\\', '/'), vars: vars ? relative(ROOT, vars).replaceAll('\\', '/') : null, ids, userErrors });
    writeState(key, st);
    print({ ok: userErrors.length === 0, ids, userErrors, data: data?.data ?? data });
    if (userErrors.length) process.exit(1);
    break;
  }

  case 'delete-draft': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId || st.draft.deletedAt) fail(`${key} has no draft to delete.`);
    const target = listThemes(cfg.store).find((t) => t.id === st.draft.themeId);
    assertOwnDraft(key, st, target);
    if (flags['dry-run']) { print({ dryRun: true, wouldDelete: target }); break; }
    const r = cli(['theme', 'delete', '--store', cfg.store, '--theme', String(target.id), '--force']);
    if (r.code !== 0) failCli(cfg.store, r, 'Deleting the draft');
    st.draft.deletedAt = now();
    writeState(key, st);
    print({ deleted: target });
    break;
  }

  default:
    print(HELP);
    process.exit(1);
}
