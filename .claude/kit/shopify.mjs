#!/usr/bin/env node
// The only way the kit talks to the Shopify CLI. Usage: node .claude/kit/shopify.mjs <verb> ... (verbs in HELP below).
// It builds every argument itself, targets only this task's unpublished draft, and has no publish, live-push or
// delete-other verbs. The guard hook blocks direct CLI calls, so keep everything that touches the store in here.
// Reads .claude/shopify-kit.json; writes .claude/logs/<KEY>/ (state.json, pulls, fetches) and .claude/cli-check.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  ROOT, LOGS, KIT_DIR, KIT_VERSION, THEME_DIRS, MERCHANT_JSON, WIN, print, fail, parseArgs, normKey, now, run, git,
  currentBranch, parseCliJson, diagnosticJson, readConfig, readState, writeState, secret, inTaskFolder,
  storefrontGet, renderedTheme, storefrontPath, isThemePath, isStorable, mutationProblems, gqlScan, createdIds, namesKey, sealDigest, SEAL_FILE, draftNameFor, effectiveBase,
  shopifyIgnore, themeDigest, authSessionProps, execErrorProps, lastVerified, shapeOf,
} from './lib.mjs';

const HELP = `Usage: node .claude/kit/shopify.mjs <verb> ...
Read-only
  cli-check [--force]                    does the installed Shopify CLI and plugin still offer what the kit uses? (fast when unchanged)
  auth-check [--store S]                 CLI version, theme login, Admin API login, telemetry opt-out
  query <NAME|FILE.graphql> [--owner PRODUCT] [--handle H] [--type T] [--vars FILE.json]
                                         read-only Admin GraphQL (mutations are refused). NAME is a kit query:
                                         shop, definitions (--owner), product (--handle), collection (--handle),
                                         metaobjects (--type), menus, markets, locales
  pull-live <KEY> <file-or-glob>...      live theme files into .claude/logs/<KEY>/live/
  check <KEY>                            theme check; reports only offenses this branch introduced (changed lines, and
                                         errors naming a file the branch deleted)
  fetch <KEY> [path] [--find TEXT] [--live]
                                         one storefront page from the draft (or live), with the theme that rendered it
                                         checked; saves the HTML. Never curl ?preview_theme_id: without the cookie it serves live
  verify <KEY> [--wait SECONDS]          pull the branch's files back from the draft and compare them with HEAD
This task's draft theme
  draft <KEY> [--dry-run] [--adopt]      reuse or create the draft: a copy of the live theme named <KEY>
                                         (refuses an existing theme with that name unless the dev says --adopt)
  draft <KEY> --github [--theme ID]      adopt the theme the dev connected to the task branch (Add theme → Connect from GitHub)
  push <KEY> [--dry-run]                 upload every theme file the branch's commits touched to the draft, then verify.
                                         Refuses merchant JSON that live changed since the base; other live edits are listed
  push <KEY> --skip-ignored              the dev agreed: push all but the files .shopifyignore excludes, which status lists
  push|verify <KEY> --reconciled F,F     the dev confirms live's edits to this merchant JSON are already in the branch (a repo
                                         that doesn't sync live edits into git); the guard asks first
  preview <KEY> <overrides.json>         virtual preview of the draft with JSON overrides; prints the URL
Investigations (kit.mjs start <KEY> --investigate) can't use draft, push, preview, mutate or delete-draft.
The guard asks the dev before these run
  mutate <KEY> <FILE.graphql> [--vars FILE.json] [--dry-run]
                                         Admin GraphQL mutation (only the kit's definition, value and cleanup mutations),
                                         run once, exactly as the guard showed it to the dev; recorded in the task state
  delete-draft <KEY> [--dry-run]         delete this task's draft theme`;

// ── Login scopes and Admin API version ──
// /shopify-implement needs these. /shopify-investigate also reads menus, markets, languages, translations,
// pages and blogs, discounts, files and sales channels. One login requests both: a client approves the app once.
// auth-check builds the login command from these. .claude/README.md spells it out for whoever installs the app
// (often not the dev); test/all.mjs fails if the two differ.
const IMPLEMENT_SCOPES = 'read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects';
const INVESTIGATE_SCOPES = 'read_online_store_navigation,read_markets,read_locales,read_translations,read_content,read_discounts,read_files,read_publications';
const SCOPES = `${IMPLEMENT_SCOPES},${INVESTIGATE_SCOPES}`;
const ADMIN_API_VERSION = '2026-07';

// ── CLI contract check (cli-check) ──
// Every CLI command and flag this wrapper relies on, and what breaks if one changes.
// cli-check verifies them against the installed CLI's --help after every CLI update.
const CLI_CONTRACT = [
  { cmd: ['theme', 'list'], flags: ['--store', '--json', '--no-input'], usedBy: 'draft, push, preview, delete-draft' },
  { cmd: ['theme', 'info'], flags: ['--json', '--no-input'], usedBy: 'auth-check' },
  { cmd: ['theme', 'duplicate'], flags: ['--store', '--theme', '--name', '--force', '--json', '--no-input'], usedBy: 'draft (build skill, draft stage)' },
  { cmd: ['theme', 'push'], flags: ['--store', '--theme', '--only', '--nodelete', '--json', '--no-input'], usedBy: 'push (draft stage)' },
  { cmd: ['theme', 'pull'], flags: ['--store', '--live', '--theme', '--path', '--only', '--nodelete', '--no-input'], usedBy: 'pull-live, verify, the push drift check (also uses the hidden --force)' },
  { cmd: ['theme', 'preview'], flags: ['--store', '--theme', '--overrides', '--json', '--preview-id', '--no-input'], usedBy: 'preview (qa stage, settings behaviour)' },
  { cmd: ['theme', 'check'], flags: ['--path', '--output', '--no-input'], usedBy: 'check (build stage)' },
  { cmd: ['theme', 'delete'], flags: ['--store', '--theme', '--force', '--no-input'], usedBy: 'delete-draft (handoff cleanup)' },
  { cmd: ['store', 'execute'], flags: ['--store', '--query-file', '--variable-file', '--json', '--allow-mutations', '--version', '--no-input'], usedBy: 'query, mutate (plan and draft stages)' },
  { cmd: ['store', 'auth'], flags: ['--store', '--scopes'], usedBy: 'the login command auth-check suggests' },
  { cmd: ['store', 'auth', 'list'], flags: ['--json'], usedBy: 'auth-check scopes' },
];
const CHECK_PATH = join(ROOT, '.claude', 'cli-check.json');
// What the full check depends on from the kit: a release that doesn't change these doesn't need the minute-long check again.
const contractSha = () => {
  // 'shapes': a release whose check records something new runs it once more, so every repo records it.
  const h = createHash('sha256').update(JSON.stringify(CLI_CONTRACT)).update('shapes');
  for (const q of readdirSync(join(KIT_DIR, 'queries')).sort()) h.update(q).update(readFileSync(join(KIT_DIR, 'queries', q)));
  return h.digest('hex').slice(0, 16);
};

// The Shopify AI Toolkit plugin's version and skill folder, from Claude Code's plugin registry; null if not installed.
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
  const sessionProps = authSessionProps(schema(['store', 'auth', 'list']));
  for (const field of ['store', 'subdomain', 'scopes', 'expiresAt']) if (!sessionProps[field]) problems.push(`store auth list --json no longer documents sessions[].${field}. Affects: auth-check scopes.`);
  const errorProps = execErrorProps(schema(['store', 'execute']));
  for (const field of ['message', 'tryMessage', 'nextSteps', 'details']) if (!errorProps[field]) notes.push(`store execute errors no longer document error.${field}; error messages may lose detail.`);
  // The structure (no values) of the read-only commands test/fake-shopify.mjs mimics; test/fake-vs-real.mjs compares them.
  const shapes = {};
  const info = cli(['theme', 'info', '--json']);
  if (!cliFailed(info) && info.data) shapes['theme info'] = shapeOf(info.data);
  const warnings = [];
  let themeListUnchecked = false;
  if (store) {
    const t = checkThemeList(store);
    problems.push(...t.problems);
    if (t.shape) shapes['theme list'] = t.shape;
    if (t.warning) { warnings.push(t.warning); themeListUnchecked = true; }
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
  return { problems, notes, warnings, shapes, themeListUnchecked, pluginVersion: plugin?.version || null };
}

/**
 * Reads theme list --json the way the draft verbs do. A failed call (usually an expired theme login) is a warning,
 * not a problem: the CLI may be fine, and investigations that only query the Admin API still work.
 */
function checkThemeList(store) {
  const r = cli(['theme', 'list', '--store', store, '--json']);
  if (cliFailed(r)) {
    return { problems: [], shape: null, warning: `theme list failed, so the draft verbs' output wasn't checked; the next cli-check checks it again. ${loginHint(store, r) || cliError(r).slice(0, 300)}` };
  }
  const list = themeArray(r.data);
  const problems = [];
  if (!list) problems.push(`theme list --json is neither a list nor { themes: [...] }: ${r.stdout.trim().slice(0, 300)}. Affects: every draft verb and auth-check.`);
  else if (!list.every((t) => 'id' in t && 'name' in t && 'role' in t)) problems.push('theme list --json items no longer carry id, name and role. Affects: every draft verb.');
  else if (!list.some((t) => t.role === 'live')) problems.push('theme list --json no longer marks the live theme with role "live". Affects: draft.');
  return { problems, shape: r.data ? shapeOf(r.data) : null, warning: null };
}

// ── Write gates ──
// Checks the store-writing verbs run before they act. assertOwnDraft (Draft theme section) is the other one.

/**
 * mutate and delete-draft run only what the guard showed the dev, once. A call the guard never
 * saw (a script, a chained command it refused) has no seal, and a file changed since has another digest.
 */
function consumeSeal(key, expected) {
  const path = join(LOGS, key, SEAL_FILE);
  let seal = null;
  try { seal = JSON.parse(readFileSync(path, 'utf8')); } catch { /* none */ }
  rmSync(path, { force: true });
  const fresh = seal && Date.now() - Date.parse(seal.at) < 15 * 60 * 1000;
  if (!fresh || !Object.entries(expected).every(([k, v]) => seal[k] === v)) {
    fail(`The dev wasn't shown this exact ${expected.verb}${seal ? ': it changed after the prompt, or the prompt is over 15 minutes old' : ''}. Run the command again on its own, so the guard shows the dev what will run.`);
  }
}

/** Task state for a verb that writes to the store; investigations are read-only. */
function writableTask(key) {
  const st = readState(key);
  if (st.kind === 'investigation') fail(`${key} is an investigation, which is read-only. To change the theme or the store, finish it and run /shopify-implement ${key}.`);
  return st;
}

// ── CLI calls and errors ──
// failCli turns any CLI failure into one message, with the login command when a login is the cause.

function cli(args, { timeout } = {}) {
  const env = {};
  const token = secret('SHOPIFY_CLI_THEME_TOKEN');
  if (token) env.SHOPIFY_CLI_THEME_TOKEN = token;
  // --no-input: an expired login fails fast instead of opening a browser and hanging the tool call.
  // theme preview --overrides drops the backslashes of a Windows path (CLI 4.9.4); forward slashes work everywhere.
  const posix = args.map((a) => (/^[A-Za-z]:\\/.test(a) ? a.replaceAll('\\', '/') : a));
  const r = run('shopify', [...posix, '--no-input'], { env, shell: true, ...(timeout ? { timeout } : {}) });
  // theme preview --json prints its result to stderr, wrapped in a diagnostic event (CLI 4.9.4).
  return { ...r, data: parseCliJson(r.stdout) ?? diagnosticJson(r.stderr) };
}

// The most useful error text a CLI result carries, structured fields first.
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

// The default login covers products and metaobjects; definitions on these owners need one more scope.
const OWNER_SCOPES = { PAGE: 'write_content', ARTICLE: 'write_content', BLOG: 'write_content', CUSTOMER: 'write_customers' };
const ownerScopes = (text) => [...new Set([...String(text).matchAll(/ownerType\W+(PAGE|ARTICLE|BLOG|CUSTOMER)\b/g)].map((m) => OWNER_SCOPES[m[1]]))];

// A failed call: a non-zero exit, or exit 0 with a JSON error (store execute does that).
const cliFailed = (r) => r.code !== 0 || Boolean(r.data?.error);

function loginHint(store, r, extra = []) {
  // A call that succeeded but printed something unreadable isn't a login problem, whatever its output says
  // (theme names like "Login popup" are in it).
  if (!cliFailed(r)) return null;
  const text = cliError(r);
  if (/No stored app authentication|store auth|missing.*scope|access denied.*scope|requires.*scope/i.test(text)) {
    return `Admin API login missing or lacks scopes. Ask the dev to run once (with the ! prefix):\n! shopify store auth --store ${store} --scopes ${[SCOPES, ...extra].join(',')}`;
  }
  // \b401\b: a theme id in the detail text can contain the digits 401.
  if (/log(ged)? ?in|authenticat|session|token|\b401\b/i.test(text)) {
    return `Theme login missing or expired. Ask the dev to run once (with the ! prefix):\n! shopify theme list --store ${store}`;
  }
  return null;
}

function failCli(store, r, what, extraScopes = []) {
  const hint = loginHint(store, r, extraScopes);
  // Exit 0 with an unexpected shape, or a silent failure, still needs something to act on.
  const detail = cliError(r) || `CLI exit code ${r.code}. Output: ${(r.stdout.trim() || r.stderr.trim() || '(none)').slice(-1500)}`;
  // 423 Locked: the store is frozen, paused or unavailable (a billing or plan issue), not a login problem (CHE-865).
  const locked = /\b423\b|\bLocked\b|store (is )?unavailable/i.test(`${r.stdout}\n${r.stderr}`)
    ? `\n\nShopify answered "locked" (423): the store is frozen, paused or unavailable, often a billing or plan issue. Logging in again won't help; ask the dev or the store owner to check the store's status in the admin.` : '';
  fail(`${what} failed.\n${detail}${locked}${hint && !locked ? `\n\n${hint}` : ''}`);
}

/**
 * cli-check records shapes only on its full run, which is cached until the CLI changes. When that run couldn't list
 * themes (an expired login), the first listing that works fills the gap, so test/fake-vs-real.mjs gets something to compare.
 */
function recordShape(name, data) {
  try {
    const check = JSON.parse(readFileSync(CHECK_PATH, 'utf8'));
    if (!check.shapes || check.shapes[name]) return;
    check.shapes[name] = shapeOf(data);
    writeFileSync(CHECK_PATH, JSON.stringify(check, null, 2));
  } catch { /* no check yet: cli-check records it */ }
}

// CLI 4 prints theme ids as numbers, CLI 5 as strings. The kit keeps numbers (state, kit.mjs set, the guard's seals)
// and compares through sameId, so a string id already in a task's state still matches.
const toThemeId = (id) => (/^\d+$/.test(String(id)) ? Number(id) : id);
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

// CLI 4 prints theme list --json as a bare array, CLI 5 as { themes: [...] }.
function themeArray(data) {
  return Array.isArray(data) ? data : Array.isArray(data?.themes) ? data.themes : null;
}

// Filters locally: the CLI's --name exits with an error when nothing matches.
function listThemes(store, name) {
  const r = cli(['theme', 'list', '--store', store, '--json']);
  const list = themeArray(r.data);
  if (cliFailed(r) || !list) failCli(store, r, 'Listing themes');
  recordShape('theme list', r.data);
  return list
    .map(({ id, name: n, role, processing }) => ({ id: toThemeId(id), name: n, role, processing: Boolean(processing) }))
    .filter((t) => !name || t.name.toLowerCase().includes(name.toLowerCase()));
}

/** A freshly duplicated theme reports processing:true for a while; writes to it can fail until then. */
function waitUntilReady(store, id, maxSeconds = 300) {
  const until = Date.now() + maxSeconds * 1000;
  for (;;) {
    const theme = listThemes(store).find((t) => sameId(t.id, id));
    if (!theme || !theme.processing) return theme;
    if (Date.now() > until) fail(`Theme ${id} is still processing after ${maxSeconds}s. Try again in a few minutes.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  }
}

function storeHandle(store) {
  return store.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '');
}

// ── Draft theme ──

// The draft recorded in the task state, if the store still has it.
function taskDraft(st, themes) {
  const id = st.draft?.themeId;
  if (!id || st.draft.deletedAt) return null;
  return themes.find((t) => sameId(t.id, id)) || null;
}

/** Refuses anything that isn't this task's own unpublished theme. */
function assertOwnDraft(key, st, theme) {
  if (!theme) fail(`Theme ${st.draft?.themeId} no longer exists in the store. Run: shopify.mjs draft ${key}`);
  if (theme.role !== 'unpublished') fail(`Theme ${theme.id} is "${theme.role}", not unpublished. The kit only writes to unpublished drafts.`);
  const expected = draftNameFor(key, st);
  if (st.draft.route === 'cli' && theme.name.toUpperCase() !== expected.toUpperCase()) fail(`Theme ${theme.id} is named "${theme.name}", not ${expected}. Refusing to write to it.`);
  // A typed-in id could be a teammate's copy; a dev-made draft must carry the ticket key in its name.
  if (st.draft.route !== 'cli' && !namesKey(theme.name, key)) {
    fail(`Theme ${theme.id} is named "${theme.name}", which doesn't contain ${key}. Ask the dev to rename their draft to include ${key}, then record it again.`);
  }
}

// ── What push and verify compare ──
// Which files the branch owns, whether live changed them since the base, and reading them back from the draft.

function assertFullHistory(base) {
  if (!git(['cat-file', '-t', base], { allowFail: true })) fail(`The base commit ${base.slice(0, 7)} isn't in this clone (shallow clone?). Run: git fetch --unshallow`);
}

/**
 * Theme files the draft must match: every file any branch commit touched, not only base...HEAD,
 * so a file reverted to its base content is re-sent instead of keeping an earlier push's version.
 * Measured from the effective base, so work merged in from the base branch isn't sent as this task's;
 * the diff adds files a merge resolution changed, which a merge commit's log doesn't list.
 */
function branchFiles(st) {
  assertFullHistory(st.base);
  const base = effectiveBase(st, cfg);
  const touched = git(['log', '--format=', '--name-only', '--no-renames', '--relative', `${base}..HEAD`, '--', ...THEME_DIRS], { allowFail: true });
  const differ = git(['diff', '--name-only', '--no-renames', '--relative', base, 'HEAD', '--', ...THEME_DIRS], { allowFail: true });
  const files = [];
  const gone = [];
  // A build's sources in a subfolder (assets/src/theme.css): Shopify rejects them, and the build's output is what goes up.
  const sources = [];
  for (const f of [...new Set(`${touched}\n${differ}`.split('\n').filter(Boolean))].sort()) {
    if (!isStorable(f)) sources.push(f); else if (existsSync(join(ROOT, f))) files.push(f); else gone.push(f);
  }
  for (const out of st.buildOutputs || []) {
    if (!isThemePath(out) || !isStorable(out)) fail(`buildOutputs holds "${out}", which isn't a theme file path Shopify stores (assets/…, snippets/…, no subfolder). Fix it: kit.mjs set ${st.key} buildOutputs=<path,path>`);
    if (existsSync(join(ROOT, out)) && !files.includes(out)) files.push(out);
  }
  return { files, gone, base, sources };
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

const TEXT_FILE = /\.(liquid|json|css|scss|js|mjs|svg|txt|md|html)$/i;

/** A file's content as the drift check compares it: JSON as data, text without line-ending noise, anything else as bytes. */
function driftDigest(f, buf) {
  if (buf === null) return null;
  const text = /\.json$/i.test(f) ? normJson(buf.toString('utf8')) : TEXT_FILE.test(f) ? buf.toString('utf8').replace(/\r\n/g, '\n').trimEnd() : buf;
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** A file's drift digest at a commit; raw bytes, since git() decodes and trims (a binary asset, a last newline). */
function digestAt(commit, f) {
  const shown = spawnSync('git', ['show', `${commit}:./${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return driftDigest(f, shown.status === 0 ? shown.stdout : null);
}

// When live is a campaign theme on another branch, the theme that follows the base branch (kit.mjs set <KEY> baseTheme=<id>,
// which the guard asks about) stands in for live: comparing with the campaign flags every merchant file as a live edit.
const baseThemeArgs = (st) => (st?.baseTheme ? ['--theme', String(st.baseTheme)] : ['--live']);

/**
 * Branch files whose live copy differs from the base: pushing them overwrites those edits on the draft and, after the
 * merge, on live. Each result's `live` is a digest of live's copy. `undeployed`: live holds an earlier version from the
 * base branch's history, so the base branch is ahead of live (merged, not deployed yet), and nothing on live is lost.
 */
function liveDrift(st, files, base) {
  if (!files.length) return [];
  const dir = mkdtempSync(join(tmpdir(), 'kit-live-'));
  try {
    for (const batch of batches(files)) {
      const r = cli(['theme', 'pull', '--store', cfg.store, ...baseThemeArgs(st), '--path', dir, '--nodelete', '--force', ...batch.flatMap((f) => ['--only', f])]);
      if (r.code !== 0) failCli(cfg.store, r, 'Pulling live files for the drift check');
    }
    return files.flatMap((f) => {
      const livePath = join(dir, f);
      const live = driftDigest(f, existsSync(livePath) ? readFileSync(livePath) : null);
      // New on the branch and not on live, or unchanged on live since the base: nothing to lose.
      if (live === digestAt(base, f)) return [];
      const history = live === null ? [] : git(['log', '-n', '30', '--format=%H', base, '--', f], { allowFail: true }).split('\n').filter(Boolean);
      return [{ file: f, live: live ?? '(missing)', undeployed: history.some((c) => digestAt(c, f) === live) }];
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * The drift check push and verify run. Merchant JSON that live changed is refused until merged or reconciled
 * (the merge would silently drop a merchant's admin edits); other live edits are listed and recorded for the report.
 * buildOutputs aren't in git at the base, so live always "differs" from it there: they're left out.
 */
function driftCheck(key, st, files, base) {
  // Only files the merge changes: one the branch touched and then reverted is pushed, but overwrites nothing on live.
  const changed = new Set(git(['diff', '--name-only', '--no-renames', '--relative', base, 'HEAD', '--', ...THEME_DIRS], { allowFail: true }).split('\n').filter(Boolean));
  const drift = liveDrift(st, files.filter((f) => changed.has(f) && !(st.buildOutputs || []).includes(f)), base);
  const edited = drift.filter((d) => !d.undeployed);
  const refused = openDrift(key, st, edited.filter((d) => MERCHANT_JSON.test(d.file)));
  st.draft.liveEdits = edited.filter((d) => !MERCHANT_JSON.test(d.file)).map((d) => d.file);
  return {
    refused,
    report: {
      ...(st.draft.liveEdits.length ? { liveEditedSinceBase: st.draft.liveEdits, liveEditNote: `Live has changed these since the base (${base.slice(0, 7)}), and the branch's version replaces them on the draft and, after the merge, on live. Check with pull-live ${key} <file> whether those edits must be carried into the branch; list them in report.md § You must still do.` } : {}),
      ...(drift.some((d) => d.undeployed) ? { baseAheadOfLive: drift.filter((d) => d.undeployed).map((d) => d.file), baseAheadNote: `Live has an earlier version of these from ${cfg.baseBranch || 'main'}: work merged there but not deployed yet, not a live edit.` } : {}),
    },
  };
}

/**
 * Drifted merchant JSON the dev hasn't reconciled. --reconciled records the named files at their current live version,
 * so a later live edit to the same file is flagged again.
 */
function openDrift(key, st, drifted) {
  if (flags.reconciled === undefined) return drifted.filter((d) => st.liveReconciled?.[d.file]?.live !== d.live);
  if (typeof flags.reconciled !== 'string') fail('Name the files: --reconciled templates/product.json,sections/header-group.json');
  const named = flags.reconciled.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = named.filter((f) => !drifted.some((d) => d.file === f));
  if (unknown.length) fail(`--reconciled names ${unknown.join(', ')}, which live hasn't changed since the base, or which isn't merchant JSON (other live edits are only listed). Name only files the drift check refused.`);
  for (const d of drifted) if (named.includes(d.file)) (st.liveReconciled ||= {})[d.file] = { live: d.live, at: now() };
  writeState(key, st);
  return drifted.filter((d) => st.liveReconciled?.[d.file]?.live !== d.live);
}

function driftMessage(key, open, base) {
  return `Live has changed ${open.map((d) => d.file).join(', ')} since this branch's base (${base.slice(0, 7)}), and no earlier version on ${cfg.baseBranch || 'main'} matches it: a merchant's admin edit. Pushing would overwrite it on the draft and, after the merge, on live.\n`
    + `- Shopify syncs admin edits into git ("Update from Shopify" commits): git fetch, merge origin/${cfg.baseBranch || 'main'} into the branch, resolve, commit, push again.\n`
    + `- It doesn't (or the sync hasn't arrived): pull-live ${key} <file> shows live's version. Carry its edits into the branch's file, keeping the branch's own changes, commit, and once the dev confirms, run the push or verify again with --reconciled ${open.map((d) => d.file).join(',')}.`;
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

// How long a draft run that timed out mid-duplicate still owns a theme with the task's name. Long enough for
// a slow copy and a retry; short enough that a teammate's same-named draft weeks later is asked about.
const PENDING_HOURS = 6;

// ── Admin GraphQL ──
// query refuses mutations; mutate runs only what lib.mjs mutationProblems allows and the guard showed the dev.

function gqlFile(file) {
  if (!existsSync(file)) fail(`No such file: ${file}`);
  return readFileSync(file, 'utf8');
}

// Read the way mutationProblems reads it: comments end at a newline or a lone CR, and a "#" inside a string isn't a comment
// (a regex that stripped comments first let `shop(x: "#") … mutation M { themePublish }` through as a query).
const hasMutation = (text) => gqlScan(text).tokens.includes('mutation');

function storeExecute(store, file, vars, { mutate = false } = {}) {
  // Pinned: queries are validated against this version; the CLI would otherwise use the newest.
  const args = ['store', 'execute', '--store', store, '--query-file', file, '--json', '--version', cfg?.adminApiVersion || ADMIN_API_VERSION];
  if (vars) args.push('--variable-file', vars);
  if (mutate) args.push('--allow-mutations');
  const r = cli(args);
  if (r.code !== 0 || r.data?.error) failCli(store, r, 'Admin GraphQL', mutate ? ownerScopes(`${readFileSync(file, 'utf8')}\n${vars ? readFileSync(vars, 'utf8') : ''}`) : []);
  // A GraphQL response can carry top-level errors with exit 0.
  if (Array.isArray(r.data?.errors) && r.data.errors.length) fail(`Admin GraphQL returned errors:\n${r.data.errors.map((e) => `- ${e.message || JSON.stringify(e)}`).join('\n')}`);
  return r.data;
}

// Every value anywhere in a GraphQL response whose key/value pair passes test (userErrors, gids).
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

// ── Local files and theme check ──

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
  // --relative keeps paths relative to this folder when the theme lives in a repo subfolder. The prefixes and quotePath are
  // fixed: diff.noprefix, diff.mnemonicPrefix or a quoted non-ASCII path would leave no "+++ b/" line, so nothing counted.
  const diff = git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--relative', base, '--', ...THEME_DIRS], { allowFail: true });
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
  const untracked = git(['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '--', ...THEME_DIRS], { allowFail: true });
  for (const f of untracked.split('\n').filter(Boolean)) ranges[f] = [[1, Infinity]];
  return ranges;
}

/** The offenses, or { crashed } when theme check gave no report (a crash, an unsupported .theme-check.yml). */
function themeCheck() {
  // Repos that keep locales/ out of git (edited in the admin) have none locally, and theme check crashes reading it. It runs
  // with an empty one; its translation checks then have no locale files to compare with, so their findings are dropped.
  const locales = join(ROOT, 'locales');
  const noLocales = !existsSync(locales);
  if (noLocales) mkdirSync(locales);
  let r;
  try { r = run('shopify', ['theme', 'check', '--path', ROOT, '--output', 'json', '--no-input'], { shell: true }); }
  finally { if (noLocales) rmSync(locales, { recursive: true, force: true }); }
  const data = parseCliJson(r.stdout);
  // Older CLIs print [{ path, offenses: [{ start_row, 0-based }] }]; newer ones { valid, issues: [{ filePath, startRow, 1-based }] }.
  const found = Array.isArray(data)
    ? data.flatMap((f) => (f.offenses || []).map((o) => ({ ...o, file: f.path, line: (o.start_row ?? 0) + 1 })))
    : Array.isArray(data?.issues) ? data.issues.map((o) => ({ ...o, file: o.filePath, line: o.startRow ?? 1 })) : null;
  if (!found) {
    const said = [r.stderr, r.stdout].join('\n').split('\n').filter((l) => l.trim() && !l.startsWith('<claude-code-hint')).join('\n');
    return { crashed: (said || `exit ${r.code}`).trim().slice(0, 1500) };
  }
  const offenses = [];
  for (const o of found) {
    if (noLocales && /translation/i.test(o.check)) continue;
    offenses.push({ path: relative(ROOT, o.file).replaceAll('\\', '/'), line: o.line, check: o.check, severity: o.severity, message: o.message });
  }
  if (noLocales) offenses.localesMissing = true;
  return offenses;
}

// ── CLI entry ──
// cli-check and auth-check run before setup, so they don't require .claude/shopify-kit.json.

const args = parseArgs(process.argv.slice(2));
const [verb, ...pos] = args._;
const { flags } = args;

if (!verb || verb === 'help' || flags.help) { print(HELP); process.exit(verb && verb !== 'help' ? 1 : 0); }

const cfg = verb === 'auth-check' || verb === 'cli-check' ? readConfig({ required: false }) : readConfig();
// adminApi: false in shopify-kit.json means nobody could approve the CLI's app on this store.
const NO_ADMIN = 'This repo runs without Admin API access (adminApi: false in .claude/shopify-kit.json), so the kit can\'t query or change store data. '
  + 'Use the manual path: read the admin page in Chrome (look only) or ask the dev, and give store changes to the dev as admin steps. '
  + 'Once someone approves the login (shopify.mjs auth-check prints the command), set adminApi to true.';

// ── Verbs ──

switch (verb) {
  // Cached: the full check reruns only when the last one failed, the CLI or plugin version changed, or with --force.
  case 'cli-check': {
    const v = run('shopify', ['version'], { shell: true });
    if (v.code !== 0) fail('Shopify CLI not found. Ask the dev to install it: ! npm i -g @shopify/cli@latest');
    const cliVersion = v.stdout.trim().split('\n').pop();
    const pluginVersion = pluginInfo()?.version || null;
    // A kit update that changes the CLI contract or the queries, and a new adminApiVersion, need the full check again.
    const adminApiVersion = cfg?.adminApiVersion || ADMIN_API_VERSION;
    const contract = contractSha();
    let last = null;
    try { last = existsSync(CHECK_PATH) ? JSON.parse(readFileSync(CHECK_PATH, 'utf8')) : null; } catch { /* unreadable: run the full check */ }
    if (!flags.force && last?.ok && last.cliVersion === cliVersion && last.pluginVersion === pluginVersion && last.contract === contract && last.adminApiVersion === adminApiVersion) {
      const cached = { ok: true, cliVersion, pluginVersion, kitVersion: KIT_VERSION, adminApiVersion, verifiedAt: last.checkedAt, note: 'unchanged since the last full check' };
      // The last check couldn't read theme list (login): check just that, so the cached ok doesn't hide it.
      if (last.themeListUnchecked && cfg?.store) {
        const t = checkThemeList(cfg.store);
        const updated = {
          ...last, ok: t.problems.length === 0, problems: [...(last.problems || []), ...t.problems], warnings: t.warning ? [t.warning] : [],
          themeListUnchecked: Boolean(t.warning), shapes: { ...last.shapes, ...(t.shape ? { 'theme list': t.shape } : {}) },
        };
        writeFileSync(CHECK_PATH, JSON.stringify(updated, null, 2));
        if (!updated.ok) { print(updated); process.exit(2); }
        print({ ...cached, ...(t.warning ? { warnings: updated.warnings } : { note: 'unchanged since the last full check; theme list checked now' }) });
        break;
      }
      print(cached);
      break;
    }
    const result = fullCliCheck(cfg?.store);
    const report = {
      ok: result.problems.length === 0, cliVersion, pluginVersion, kitVersion: KIT_VERSION, adminApiVersion, contract,
      previous: lastVerified(last),
      checkedAt: now(), problems: result.problems, warnings: result.warnings, notes: result.notes, shapes: result.shapes,
      themeListUnchecked: result.themeListUnchecked,
    };
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
    out.cliCommands = missing.length ? `missing: ${missing.join(', ')} (ask the dev to update: ! npm i -g @shopify/cli@latest)` : 'ok';
    // The CLI remembers the last store it was used with, often the previous project's: a hint, never this repo's store.
    const info = cli(['theme', 'info', '--json']);
    out.cliLastStore = info.data?.storeDomain || info.data?.store || null; // CLI 5: storeDomain; CLI 4: store
    const store = flags.store || cfg?.store;
    out.store = store || null;
    if (!store) {
      out.next = `No store set for this repo. Ask the dev for its myshopify.com domain${out.cliLastStore ? ` (the CLI was last used with ${out.cliLastStore}, which may be another project's)` : ''}, then run auth-check --store <domain>.`;
      print(out);
      break;
    }
    if (out.cliLastStore && out.cliLastStore !== store) out.note = `The CLI was last used with ${out.cliLastStore}; the kit passes --store ${store} on every call, so that doesn't matter here.`;
    // The storefront names the store it belongs to: a store from another project's config shows up here (CHE-865).
    if (cfg?.storefrontUrl && !flags.store) {
      try {
        const page = await storefrontGet(cfg.storefrontUrl.replace(/\/+$/, '') + '/');
        const served = page.html.match(/Shopify\.shop\s*=\s*["']([\w.-]+\.myshopify\.com)["']/)?.[1] || null;
        out.storefrontServes = served;
        if (served && served.toLowerCase() !== store.toLowerCase()) out.storeMismatch = `${cfg.storefrontUrl} belongs to ${served}, but store in .claude/shopify-kit.json is ${store}. One of them is wrong: ask the dev which store this repo's theme lives on before anything else.`;
      } catch { out.storefrontServes = null; }
    }
    const themes = cli(['theme', 'list', '--store', store, '--json', '--role', 'live']);
    const live = cliFailed(themes) ? null : themeArray(themes.data);
    // A call that succeeded with an unreadable list is a shape change, not a login problem: logging in again wouldn't help.
    out.themeLogin = live ? 'ok' : cliFailed(themes) ? 'missing' : `unreadable output (run cli-check --force): ${themes.stdout.trim().slice(0, 200)}`;
    if (live) out.liveTheme = live.filter((t) => t.role === 'live').map(({ id, name }) => ({ id: toThemeId(id), name }))[0] || null;
    else if (cliFailed(themes)) out.themeLoginFix = `! shopify theme list --store ${store}`;
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
        if (forImplement.length) out.adminScopesFix = `Missing ${forImplement.join(', ')} (needed by /shopify-implement): ! shopify store auth --store ${store} --scopes ${SCOPES}`;
        if (forInvestigate.length) out.investigateScopesFix = `Missing ${forInvestigate.join(', ')} (needed by /shopify-investigate for menus, markets, languages and other store settings): ! shopify store auth --store ${store} --scopes ${SCOPES}`;
      }
    } else {
      out.adminLogin = 'missing';
      out.adminLoginNote = 'Optional. The login installs Shopify\'s CLI app on the store, so it needs someone allowed to install apps, once per store. Without it, set adminApi: false and the kit uses manual admin steps instead.';
      out.adminLoginFix = `! shopify store auth --store ${store} --scopes ${SCOPES}`;
    }
    // The same path kit.mjs optout writes.
    const optOut = WIN
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shopify-ai-toolkit', 'opt-out')
      : join(homedir(), '.config', 'shopify-ai-toolkit', 'opt-out');
    out.pluginTelemetryOptOut = existsSync(optOut) || process.env.OPT_OUT_INSTRUMENTATION === 'true';
    out.pluginTelemetryOptOutFile = existsSync(optOut) ? optOut : 'missing (node .claude/kit/kit.mjs optout)';
    print(out);
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
    const st = readState(key);
    const files = pos.slice(1);
    if (!files.length) fail('Name the files or globs to pull, e.g. pull-live ABC-123 "templates/product*.json"');
    const odd = files.filter((f) => !isThemePath(f));
    if (odd.length) fail(`Not theme paths: ${odd.join(', ')}. Name them from the theme root with forward slashes, e.g. sections/header.liquid or "templates/product*.json".`);
    const dest = join(LOGS, key, 'live');
    mkdirSync(dest, { recursive: true });
    // --force: the CLI refuses a non-theme folder that already has files (the second pull of a task).
    const r = cli(['theme', 'pull', '--store', cfg.store, ...baseThemeArgs(st), '--path', dest, '--nodelete', '--force', ...files.flatMap((f) => ['--only', f])]);
    if (r.code !== 0) failCli(cfg.store, r, 'Pulling live files');
    print({ folder: relative(ROOT, dest).replaceAll('\\', '/'), files: walk(dest) });
    break;
  }

  // Runs on the working tree, so the builder checks its own uncommitted change; done build reads the last result.
  case 'check': {
    const key = normKey(pos[0]);
    const st = readState(key);
    if (!st.base) fail(`No base commit recorded yet. Record it first: kit.mjs set ${key} base=<sha>`);
    assertFullHistory(st.base);
    // content: done build compares it with the branch's, so a check on other content (before a fix, say) doesn't count.
    const at = { at: now(), head: git(['rev-parse', 'HEAD'], { allowFail: true }) || null, dirty: Boolean(git(['status', '--porcelain', '--', ...THEME_DIRS], { allowFail: true })), content: themeDigest() };
    const offenses = themeCheck();
    if (offenses.crashed) {
      // Recorded, so done build doesn't wait forever on a check that can't run here.
      st.check = { ...at, crashed: offenses.crashed.slice(0, 300) };
      writeState(key, st);
      fail(`theme check gave no report, so nothing was checked:\n${offenses.crashed}\nRecorded as crashed: done build won't wait for it. Report it in As built ("theme check: crashed …"); Shopify still rejects Liquid syntax errors at push.`, 2);
    }
    // From the effective base, so base-branch changes merged into the task branch don't count as introduced.
    const base = effectiveBase(st, cfg);
    const ranges = changedRanges(base);
    // A deleted or renamed file breaks what still uses it, on lines this branch never touched.
    const gone = git(['diff', '--name-only', '--no-renames', '--relative', '--diff-filter=D', base, '--', ...THEME_DIRS], { allowFail: true }).split('\n').filter(Boolean);
    const namesGone = (o) => o.severity === 'error' && gone.some((f) => o.message.includes(f) || o.message.includes(`'${f.split('/').pop().replace(/\.liquid$/, '')}'`));
    const introduced = offenses.filter((o) => (ranges[o.path] || []).some(([a, b]) => o.line >= a && o.line <= b) || namesGone(o));
    const result = {
      base: base.slice(0, 7),
      introduced,
      introducedErrors: introduced.filter((o) => o.severity === 'error').length,
      introducedWarnings: introduced.filter((o) => o.severity !== 'error').length,
      ...(offenses.localesMissing ? { note: 'No locales/ folder here (kept out of git?), so translation keys weren\'t checked. Check new | t keys on the draft.' } : {}),
    };
    st.check = { ...at, introducedErrors: result.introducedErrors, introducedWarnings: result.introducedWarnings };
    writeState(key, st);
    print(result);
    break;
  }

  // In order: reuse the recorded draft; with --github adopt the connected one; refuse a same-named theme unless
  // --adopt; else copy live.
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
    const name = draftNameFor(key, st);
    // The draft copies the theme the branch follows: live, or the base theme when live is a campaign theme.
    const live = st.baseTheme
      ? themes.find((t) => sameId(t.id, st.baseTheme)) || fail(`Base theme ${st.baseTheme} isn't in the store. Check the id: kit.mjs set ${key} baseTheme=<id>.`)
      : themes.find((t) => t.role === 'live') || fail('No live theme found in the store.');
    const same = themes.find((t) => t.name.toUpperCase() === name.toUpperCase() && t.role === 'unpublished');
    const others = themes.filter((t) => t.role !== 'live' && t !== same && namesKey(t.name, key));
    const record = (theme, source, route = 'cli') => {
      const handle = storeHandle(cfg.store);
      st.draft = {
        themeId: toThemeId(theme.id), name: theme.name, route, source, liveThemeId: live.id, createdAt: now(),
        previewUrl: `https://${cfg.store}/?preview_theme_id=${theme.id}`,
        editorUrl: `https://admin.shopify.com/store/${handle}/themes/${theme.id}/editor`,
        lastPushedCommit: null,
      };
      writeState(key, st);
    };
    if (flags.github && st.test) fail(`${key} is a test run, and its branch is never pushed, so it can't have a GitHub-connected draft. Run: shopify.mjs draft ${key} (a CLI copy of live named ${name}).`);
    if (flags.github) {
      // Connecting a branch is admin-only (no CLI or API); the dev does it once, the kit adopts the result.
      const branch = st.branch || fail('No task branch recorded yet; the build stage creates it.');
      const local = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
      if (!local || local !== git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { allowFail: true })) {
        fail(`Push the task branch first, so Shopify can see it: git push -u origin ${branch}`);
      }
      const wanted = typeof flags.theme === 'string' ? Number(flags.theme) : null;
      const candidates = themes.filter((t) => t.role === 'unpublished'
        && (wanted ? sameId(t.id, wanted) : namesKey(t.name, key) || namesKey(t.name, branch)));
      // A theme named for removal is likely an old connection whose GitHub link is gone (POP-1065): adopt it only by id.
      const retired = !wanted && candidates.length === 1 && /remove|delete|old\b|archiv|backup|unused|alt\b/i.test(candidates[0].name);
      if (candidates.length !== 1 || retired) {
        const repo = git(['remote', 'get-url', 'origin'], { allowFail: true }).replace(/^.*[:/]([^/:]+\/[^/]+?)(\.git)?$/, '$1');
        print({
          connected: false,
          candidates,
          ...(retired ? { why: `The only theme naming ${key} is "${candidates[0].name}", which reads like one marked for removal. If it is the task's draft, run this again with --theme ${candidates[0].id}; otherwise connect a new one.` } : {}),
          ...(!candidates.length ? { unpublished: themes.filter((t) => t.role === 'unpublished').slice(0, 20).map((t) => ({ id: toThemeId(t.id), name: t.name })) } : {}),
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
      if (!namesKey(candidates[0].name, key)) fail(`Theme ${candidates[0].id} is named "${candidates[0].name}". Ask the dev to rename it to include ${key}, then run this again.`);
      record(candidates[0], `GitHub-connected to ${branch}`, 'github');
      print({ adopted: true, ...st.draft, next: `shopify.mjs verify ${key}` });
      break;
    }
    // A duplicate this task started and didn't see finish (the call timed out): the copy is the kit's own.
    const pending = st.draft?.pending;
    if (same && pending?.name?.toUpperCase() === name.toUpperCase() && Date.now() - Date.parse(pending.at) < PENDING_HOURS * 3600 * 1000) {
      record(same, `copy of live theme ${live.id} (adopted after the duplicate started at ${pending.at} didn't report back)`);
      waitUntilReady(cfg.store, same.id);
      print({ adopted: true, ...st.draft, note: 'The earlier draft run started this copy and timed out before it finished; the kit took it over.' });
      break;
    }
    if (same) {
      // Often a teammate's draft for the same ticket: pushing into it would overwrite their work, so only on request.
      if (!flags.adopt) {
        fail(`An unpublished theme named ${name} already exists (id ${same.id}): probably a teammate's draft for this ticket, made by hand or by another session.\nAsk the dev. Only if it's free to reuse: shopify.mjs draft ${key} --adopt. Otherwise stop here; the kit names its draft after the key, so it can't make a second one.`, 3);
      }
      // Someone else may have made it (a teammate, or by hand), so the kit never offers to delete it on its own.
      record(same, 'adopted an existing theme with this task\'s name', 'manual');
      print({ adopted: true, ...st.draft, note: `An unpublished theme named ${name} existed already (a teammate's draft, an earlier session, or made by hand). The kit will push to it. Pushing replaces the changed files, so check with whoever made it first.` });
      break;
    }
    // No draft yet: duplicate the live theme under the task's name.
    const command = `shopify theme duplicate --store ${cfg.store} --theme ${live.id} --name ${name} --force --json --no-input`;
    if (flags['dry-run']) { print({ dryRun: true, wouldRun: command, otherDraftsForThisTask: others }); break; }
    // Recorded first: if this call times out, the next draft run adopts the copy instead of refusing it as a stranger's.
    st.draft = { ...st.draft, pending: { name, at: now() } };
    writeState(key, st);
    // Under the Bash timeout the kit's settings give (10 minutes), so this process, not the tool call, reports a slow copy.
    const r = cli(['theme', 'duplicate', '--store', cfg.store, '--theme', String(live.id), '--name', name, '--force', '--json'], { timeout: 540000 });
    const theme = r.data?.theme;
    if (!theme?.id) {
      // Timed out: the copy may still finish, and the pending marker lets the next run adopt it.
      if (r.timedOut) fail(`theme duplicate didn't answer within 9 minutes; the copy may still be on its way. Run draft ${key} again: it adopts that copy (for ${PENDING_HOURS} hours) instead of refusing it as someone else's.`, 3);
      // The CLI answered, so nothing is still being copied.
      delete st.draft.pending;
      writeState(key, st);
      const errors = (r.data?.errors || []).join('; ');
      if (/maximum number of themes/i.test(errors)) {
        const unpublished = themes.filter((t) => t.role === 'unpublished');
        fail(`The theme library is full (${themes.length} themes, ${unpublished.length} unpublished). Unpublished themes:\n${unpublished.map((t) => `- ${t.id} ${t.name}`).join('\n')}\nAsk the dev to free a slot: kit drafts of finished tasks via shopify.mjs delete-draft <KEY>, anything else in the admin.`);
      }
      failCli(cfg.store, r, 'Duplicating the live theme');
    }
    record(theme, `copy of live theme ${live.id}`);
    waitUntilReady(cfg.store, toThemeId(theme.id));
    print({ created: true, ...st.draft, otherDraftsForThisTask: others });
    break;
  }

  // Gates (branch, clean tree, own draft, .shopifyignore, live drift), upload in batches, then read every file back.
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

    const { files: all, gone: deleted, base, sources } = branchFiles(st);
    if (!all.length) fail(`Nothing to push: the branch has no committed theme changes beyond its base${sources.length ? ` that Shopify stores (${sources.join(', ')} sit in a subfolder: record the build's output with kit.mjs set ${key} buildOutputs=<path>)` : ''}.`);
    const skipped = sources.length ? { notUploadedSubfolderFiles: sources } : {};
    const ignored = all.filter(shopifyIgnore());
    if (ignored.length && !flags['skip-ignored']) fail(`The repo's .shopifyignore excludes ${ignored.join(', ')}, so the CLI would skip them without saying so. Ask the dev how these files reach the store (often: they are edited in the admin, not in git). If the draft can go without them: push ${key} --skip-ignored, and list them in report.md § You must still do.`);
    const files = all.filter((f) => !ignored.includes(f));
    if (!files.length) fail('Every file this branch changes is excluded by .shopifyignore: nothing reaches the draft through push.');

    const head = git(['rev-parse', 'HEAD']);
    if (flags['dry-run']) { print({ dryRun: true, theme: target, base: base.slice(0, 7), files, deletedOnBranch: deleted, ...skipped, liveDriftCheck: 'skipped in dry run' }); break; }
    const drift = driftCheck(key, st, files, base);
    if (drift.refused.length) fail(driftMessage(key, drift.refused, base), 3);
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
    st.draft.ignoredFiles = ignored;
    if (urls.previewUrl) st.draft.previewUrl = urls.previewUrl;
    if (urls.editorUrl) st.draft.editorUrl = urls.editorUrl;
    writeState(key, st);
    print({
      pushed: files.length, base: base.slice(0, 7), verified: `${files.length}/${files.length} files match ${head.slice(0, 7)}`, previewUrl: st.draft.previewUrl, editorUrl: st.draft.editorUrl,
      deletedOnBranchButStillOnDraft: deleted, ...skipped, ...drift.report, ...(ignored.length ? { notOnDraftShopifyignore: ignored } : {}),
    });
    break;
  }

  // The read-back half of push; the only check for a GitHub-connected draft, which the kit never pushes to.
  case 'verify': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId) fail(`No draft yet. Run: shopify.mjs draft ${key}`);
    const target = listThemes(cfg.store).find((t) => sameId(t.id, st.draft.themeId));
    assertOwnDraft(key, st, target);
    const { files, gone, base, sources } = branchFiles(st);
    if (!files.length) fail('The branch has no committed theme changes beyond its base that Shopify stores.');
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
    // push runs the drift check on the CLI route; a GitHub-connected draft is never pushed, so verify runs it there.
    const drift = github ? driftCheck(key, st, files, base) : { refused: [], report: {} };
    // Refused drift isn't a verified draft either, as a refused push isn't on the CLI route.
    if (!mismatches.length && !drift.refused.length) st.draft.verifiedCommit = head;
    writeState(key, st);
    print({
      commit: head.slice(0, 7), base: base.slice(0, 7), files: files.length, matching: files.length - mismatches.length, mismatches,
      deletedOnBranchButStillOnDraft: gone, ...(sources.length ? { notOnDraftSubfolderFiles: sources } : {}), ...drift.report,
      ...(drift.refused.length ? { liveChangedSinceBase: drift.refused.map((d) => d.file), fix: driftMessage(key, drift.refused, base) } : {}),
    });
    if (mismatches.length || drift.refused.length) process.exit(3);
    break;
  }

  // Exits 2 when the page was rendered by another theme, e.g. live served in place of the draft.
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
    const rightTheme = live ? theme?.role === 'main' : sameId(theme?.id, id);
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
    assertOwnDraft(key, st, listThemes(cfg.store).find((t) => sameId(t.id, st.draft.themeId)));
    const file = relative(ROOT, abs).replaceAll('\\', '/');
    // Re-previewing the same overrides file updates its preview instead of creating another.
    const previous = [...st.previews].reverse().find((p) => p.file === file && p.id);
    const r = cli(['theme', 'preview', '--store', cfg.store, '--theme', String(st.draft.themeId), '--overrides', abs, '--json', ...(previous ? ['--preview-id', previous.id] : [])]);
    // Documented output: { url, preview_identifier }; CLI 5 nests it: { status, preview: { url, … } }.
    const p = r.data?.preview && typeof r.data.preview === 'object' ? r.data.preview : r.data;
    const pid = p?.preview_identifier || p?.previewIdentifier || p?.id || null;
    if (r.code !== 0 || !p?.url) failCli(cfg.store, r, 'Creating the preview');
    st.previews.push({ at: now(), file, url: p.url, id: pid || previous?.id || null });
    writeState(key, st);
    print({ url: p.url, previewId: pid });
    break;
  }

  // Order matters: file and content checks, then --dry-run, then the guard's seal, then the one real run.
  case 'mutate': {
    if (cfg.adminApi === false) fail(NO_ADMIN);
    const key = normKey(pos[0]);
    const st = writableTask(key);
    const { abs, ok } = inTaskFolder(key, pos[1] || '');
    if (!pos[1] || !ok || !/\.graphql$/i.test(abs)) fail(`Put the mutation in .claude/logs/${key}/mutations/ as a .graphql file and pass its path.`);
    const text = gqlFile(abs);
    if (!hasMutation(text)) fail('No mutation in this file. Read-only queries go through: shopify.mjs query <file>');
    let vars = null;
    if (typeof flags.vars === 'string') {
      const v = inTaskFolder(key, flags.vars);
      if (!v.ok || !/\.json$/i.test(v.abs) || !existsSync(v.abs)) fail(`Put the variables in a .json file in .claude/logs/${key}/mutations/ too.`);
      vars = v.abs;
    }
    const varsText = vars ? readFileSync(vars, 'utf8') : '';
    const problems = mutationProblems(text, varsText, st.mutations.flatMap((m) => m.ids || []));
    if (problems.length) fail(`The kit won't run this mutation:\n- ${problems.join('\n- ')}`);
    if (flags['dry-run']) { print({ dryRun: true, store: cfg.store, mutation: text, variables: vars ? varsText : null }); break; }
    consumeSeal(key, { verb: 'mutate', sha: sealDigest(text, varsText) });
    // The CLI gets the exact bytes that were checked and sealed, from a private copy: a file changed since can't run.
    const tmp = mkdtempSync(join(tmpdir(), 'kit-mutate-'));
    let data;
    try {
      writeFileSync(join(tmp, 'm.graphql'), text);
      if (vars) writeFileSync(join(tmp, 'v.json'), varsText);
      data = storeExecute(cfg.store, join(tmp, 'm.graphql'), vars ? join(tmp, 'v.json') : null, { mutate: true });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
    const userErrors = collect(data, (k, v) => k === 'userErrors' && Array.isArray(v) && v.length).flat();
    const ids = createdIds(data);
    st.mutations.push({ at: now(), file: relative(ROOT, abs).replaceAll('\\', '/'), vars: vars ? relative(ROOT, vars).replaceAll('\\', '/') : null, ids, userErrors });
    writeState(key, st);
    print({ ok: userErrors.length === 0, ids, userErrors, data: data?.data ?? data });
    if (userErrors.length) process.exit(1);
    break;
  }

  // Deletes only the task's own unpublished draft, and only with the guard's seal.
  case 'delete-draft': {
    const key = normKey(pos[0]);
    const st = writableTask(key);
    if (!st.draft?.themeId || st.draft.deletedAt) fail(`${key} has no draft to delete.`);
    const target = listThemes(cfg.store).find((t) => sameId(t.id, st.draft.themeId));
    // Deleted in the admin already: record it, so status, list and abandon stop offering it. Never suggest
    // `draft` here: it would make a new copy of live.
    if (!target) {
      if (flags['dry-run']) { print({ dryRun: true, gone: st.draft.themeId, wouldRecord: 'deleted' }); break; }
      rmSync(join(LOGS, key, SEAL_FILE), { force: true });
      st.draft.deletedAt = now();
      st.draft.goneBeforeDelete = true;
      writeState(key, st);
      print({ deleted: false, themeId: st.draft.themeId, note: `Theme ${st.draft.themeId} (${st.draft.name || key}) is no longer in the store; someone deleted it already. Recorded as deleted; nothing else to do.` });
      break;
    }
    assertOwnDraft(key, st, target);
    if (flags['dry-run']) { print({ dryRun: true, wouldDelete: target }); break; }
    consumeSeal(key, { verb: 'delete-draft', themeId: st.draft.themeId });
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
