#!/usr/bin/env node
// The app kit's only door to the Shopify CLI. Local verbs run freely; the store verbs reach only the dev store from
// .claude/app-kit.json, and mutate runs only what the guard showed the dev (the seal). There is no verb for deploy,
// release, env, dev or dev clean: the dev runs those, with the ! prefix.
// Every call drops SHOPIFY_FLAG_* from the environment (they would pick the store or app config silently), passes --no-input
// and turns the CLI's analytics off.
// Usage: node .claude/kit/shopify.mjs <verb> ...   (--help lists the verbs)
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { print, fail, now, parseCliJson, gqlOperations, sealDigest, consumeSeal } from './core.mjs';
import { ROOT, LOGS, KIT_VERSION, parseArgs, readConfig, devStore, run, normId, readChange, writeChange } from './repo.mjs';
import { parseToml } from './toml.mjs';
import { readItems, treeReader, extensionList, stable } from './surfaces.mjs';
import { unsafeCommand } from './checks.mjs';

const HELP = `Usage: node .claude/kit/shopify.mjs <verb> ...
Local (no store):
  cli-check [--force]                    the CLI still has every command and flag the kit uses (cached per CLI version)
  info                                   app name, extensions, local scopes vs scopes granted on Shopify (never secrets)
  validate [--all]                       app config validate: the app and extension configs are valid; --all: every
                                         shopify.app*.toml (the production config too)
  dev-status                             the dev's running app dev, from its log: which store, whether it rebuilt after
                                         the last edit, build errors, bundle sizes (no CLI call)
  generate-extension <template> <name> [--flavor F]
                                         scaffold an extension from Shopify's template (local files; e.g. checkout_ui trust-list --flavor react)
  build                                  shopify app build (Theme Check included), then each checkout UI bundle against the
                                         64 KB compressed limit and each theme app extension against its size limits
  function-build <extension>             build one Function to wasm
  function-typegen <extension>           regenerate one Function's input types
  function-run <extension> [--fixture <file.json>]
                                         run the Function on its test fixtures: output vs expected, and instructions vs the 11M limit
  security                               shopify app security check, summarised by severity
Dev store (devStore in .claude/app-kit.json):
  query <file.graphql> [--vars <file.json>]            a read-only Admin GraphQL query, with the app's own token
  mutate <ID> <file.graphql> [--vars <file.json>]      a mutation; the guard shows it to the dev first. Files live in .claude/logs/<ID>/
The dev runs these with the ! prefix: shopify app init | config link | config use | graphiql | deploy | release; app dev in its own terminal`;

// Every command and flag the wrapper uses. cli-check fails when one disappears, so a CLI update breaks loudly here.
const CLI_CONTRACT = [
  { cmd: ['app', 'info'], flags: ['--json', '--no-input', '--path'], usedBy: 'info' },
  { cmd: ['app', 'config', 'validate'], flags: ['--json', '--no-input', '--path'], usedBy: 'validate' },
  { cmd: ['app', 'generate', 'extension'], flags: ['--template', '--name', '--flavor', '--json', '--no-input', '--path'], usedBy: 'generate-extension' },
  { cmd: ['app', 'build'], flags: ['--no-input', '--path', '--skip-dependencies-installation'], usedBy: 'build' },
  { cmd: ['app', 'function', 'build'], flags: ['--path', '--no-input'], usedBy: 'function-build' },
  { cmd: ['app', 'function', 'typegen'], flags: ['--path', '--no-input'], usedBy: 'function-typegen' },
  { cmd: ['app', 'function', 'run'], flags: ['--path', '--input', '--export', '--json', '--no-input'], usedBy: 'function-run' },
  { cmd: ['app', 'security', 'check'], flags: ['--path', '--no-input', '--skip-instructions'], usedBy: 'security' },
  { cmd: ['app', 'execute'], flags: ['--store', '--query-file', '--variable-file', '--path', '--no-input'], usedBy: 'query, mutate' },
];
const CHECK_PATH = join(ROOT, '.claude', 'cli-check.json');
// From shopify.dev: Function runs are capped at 11M instructions (carts up to 200 lines); checkout UI bundles at 64 KB.
const INSTRUCTION_LIMIT = 11_000_000;
const BUNDLE_LIMIT = 64 * 1024;

// ── CLI calls ──

/** -c <name> when the repo pins a config other than shopify.app.toml (shopify.app.dev.toml → dev). */
export function configFlag(cfg) {
  const m = String(cfg?.appConfig || 'shopify.app.toml').match(/^shopify\.app(?:\.([\w-]+))?\.toml$/);
  if (!m) fail(`appConfig "${cfg.appConfig}" in .claude/app-kit.json isn't a shopify.app[.<name>].toml file name.`);
  return m[1] ? ['--config', m[1]] : [];
}

// The kit says telemetry is opted out; the CLI reports usage (the security check's finding counts too) unless told not to.
const NO_ANALYTICS = { SHOPIFY_CLI_NO_ANALYTICS: '1' };

function cli(args, cfg, { path = ROOT, config } = {}) {
  // The CLI wants forward slashes in some paths on Windows (theme kit finding, CLI 4.9.4).
  const posix = args.map((a) => (/^[A-Za-z]:\\/.test(a) ? a.replaceAll('\\', '/') : a));
  const r = run('shopify', [...posix, '--path', path.replaceAll('\\', '/'), ...configFlag(config ? { appConfig: config } : cfg), '--no-input'], { shell: true, dropEnv: /^SHOPIFY_FLAG_/, env: NO_ANALYTICS });
  return { ...r, data: parseCliJson(r.stdout) };
}

/** The first top-level JSON object in the output that has `key`: for commands that print more than one value. */
export function jsonWith(text, key) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('{')) continue;
    for (let j = i; j < lines.length; j++) {
      if (!lines[j].startsWith('}') && !(j === i && lines[j].endsWith('}'))) continue;
      try { const v = JSON.parse(lines.slice(i, j + 1).join('\n')); if (v && key in v) return v; break; } catch { /* not complete yet */ }
    }
  }
  return null;
}

function cliError(r) {
  const e = r.data?.error;
  const text = [e?.message, e?.tryMessage, ...(e?.nextSteps || []), r.stderr.trim().split('\n').slice(-6).join('\n')].filter(Boolean).join('\n');
  const login = /log ?in|auth|session|token/i.test(text) ? '\nIf this is a login problem, ask the dev to run: ! shopify auth login' : '';
  return `${text || `exit ${r.code}`}${login}`;
}

// ── Extensions and files ──

/** The app's extensions, from its config (extension_directories, default extensions/*). */
const extensions = (cfg) => extensionList(readItems(treeReader(ROOT), { configName: cfg.appConfig }).items);

/** An extension folder by handle or folder name. */
function extensionDir(cfg, name) {
  if (!name) fail('Name the extension (its handle or folder).');
  const all = extensions(cfg);
  const e = all.find((x) => x.handle === name || x.dir.split('/').pop() === name);
  if (!e) fail(`No extension "${name}". Extensions: ${all.map((x) => x.handle).join(', ') || '(none)'}`);
  return { dir: join(ROOT, e.dir), rel: e.dir, toml: parseToml(readFileSync(join(ROOT, e.dir, 'shopify.extension.toml'), 'utf8')) };
}

/** A file inside the change's log folder: the only place store-changing files are read from. */
function changeFile(id, file) {
  const abs = resolve(ROOT, file);
  const folder = resolve(LOGS, id);
  const rel = relative(folder, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) fail(`Mutation files live in .claude/logs/${id}/ (got ${file}).`);
  if (!existsSync(abs)) fail(`No such file: ${file}`);
  return abs;
}

function storeOrFail(cfg) {
  const store = devStore(cfg);
  if (!store) fail('No devStore in .claude/app-kit.json. Run /app-setup.');
  return store;
}

// ── Verbs ──

function cliCheck(force) {
  const v = run('shopify', ['version'], { shell: true, dropEnv: /^SHOPIFY_FLAG_/, env: NO_ANALYTICS });
  const version = (v.stdout.match(/\d+\.\d+\.\d+/) || [])[0];
  if (!version) fail(`The Shopify CLI isn't installed or didn't answer (${v.stderr.trim().slice(0, 200)}). Ask the dev to install it: npm install -g @shopify/cli`);
  let cached = null;
  try { cached = JSON.parse(readFileSync(CHECK_PATH, 'utf8')); } catch { /* first run */ }
  if (!force && cached?.ok && cached.cliVersion === version && cached.kitVersion === KIT_VERSION) return { ...cached, cached: true };
  const problems = [];
  for (const c of CLI_CONTRACT) {
    const r = run('shopify', [...c.cmd, '--help'], { shell: true, dropEnv: /^SHOPIFY_FLAG_/, env: NO_ANALYTICS });
    const name = `shopify ${c.cmd.join(' ')}`;
    if (r.code !== 0) { problems.push(`${name} is gone or failed (--help exit ${r.code}). Affects: ${c.usedBy}.`); continue; }
    const missing = c.flags.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/-/g, '\\-')}(\\b|=|\\s|$)`, 'm').test(r.stdout));
    if (missing.length) problems.push(`${name} no longer lists ${missing.join(', ')}. Affects: ${c.usedBy}.`);
  }
  // Flags can stay while the JSON the kit reads changes shape. app info is checked here; it reaches Shopify, so a failed
  // call (no login yet) is a note, not a problem. function run needs a built Function and an input, which cli-check has
  // neither of: functionRun checks that shape on every run instead.
  const notes = [];
  const inf = cli(['app', 'info', '--json'], cfg);
  if (inf.code === 0 && inf.data) problems.push(...infoShapeProblems(inf.data));
  else notes.push(`app info didn't answer (${cliError(inf).split('\n')[0].slice(0, 160)}), so its JSON shape wasn't checked; run cli-check --force once it works`);
  // previous is the last version that passed; a failed run must not replace it.
  const previous = cached?.ok ? cached.cliVersion : (cached?.previous ?? null);
  const result = { ok: !problems.length, cliVersion: version, kitVersion: KIT_VERSION, previous, checkedAt: now(), problems, notes };
  writeFileSync(CHECK_PATH, JSON.stringify(result, null, 2) + '\n');
  return result;
}

/** Fields of app info --json the kit reads (CLI 4.9.4) that are missing. A missing grantedScopes would show every scope as not granted. */
function infoShapeProblems(d) {
  return [
    !Array.isArray(d?.project?.appConfigFiles) && 'app info --json has no project.appConfigFiles (the app config the kit reads the name and local scopes from)',
    !Array.isArray(d?.project?.extensionConfigFiles) && 'app info --json has no project.extensionConfigFiles (the extensions info lists)',
    !Array.isArray(d?.remoteApp?.grantedScopes) && 'app info --json has no remoteApp.grantedScopes (the scopes Shopify granted): info would report every local scope as not granted',
  ].filter(Boolean).map((p) => `${p}. Affects: info.`);
}

/** app info, cut down to what the kit uses. dotenv contents and web env are never printed. */
function info(cfg) {
  const r = cli(['app', 'info', '--json'], cfg);
  if (r.code !== 0 || !r.data?.project) fail(`app info failed:\n${cliError(r)}`);
  const d = r.data;
  const shape = infoShapeProblems(d);
  if (shape.length) fail(`The CLI's app info output changed shape, so the kit can't read it reliably:\n- ${shape.join('\n- ')}\nRun node .claude/kit/shopify.mjs cli-check --force and tell the kit maintainer.`);
  const app = d.project.appConfigFiles?.[0]?.content || {};
  const local = String(app.access_scopes?.scopes || '').split(',').map((s) => s.trim()).filter(Boolean).sort();
  const granted = [...d.remoteApp.grantedScopes].sort();
  // A bare `shopify app dev` uses the CLI's cached config and store, possibly production or another project's store.
  const cached = d._hiddenConfig?.dev_store_url || null;
  const store = devStore(cfg);
  return {
    app: app.name, clientId: app.client_id, embedded: app.embedded, account: d.account?.email || null,
    cliCachedStore: cached,
    // A server that keeps running: with the ! prefix it would hold the Claude Code session, so it goes in its own terminal.
    appDev: `shopify app dev ${[...configFlag(cfg), '--store', store].join(' ')}`,
    appDevWhere: 'in a separate terminal in this folder, not with ! in Claude Code: it keeps running until stopped with Ctrl+C',
    ...(cached && store && cached !== store ? { devStoreWarning: `The CLI's cached dev store is ${cached}, not ${store}: have the dev run the appDev command above, which names the store.` } : {}),
    extensions: (d.project.extensionConfigFiles || []).flatMap((f) => (f.content?.extensions || [f.content]).map((e) => ({ handle: e.handle, type: e.type || f.content.type, apiVersion: f.content.api_version }))),
    scopes: { local, granted, onlyLocal: local.filter((s) => !granted.includes(s)), onlyGranted: granted.filter((s) => !local.includes(s)) },
    note: 'scopes.granted come from Shopify (the released app version); onlyLocal are in shopify.app.toml but not granted yet, which is normal until the dev deploys.',
  };
}

/**
 * A web build command app build would run that deploys, migrates or runs the CLI, or null. app build also runs each
 * shopify.web.toml's [commands] build, outside the guard's view. Looked for in the root and the folders below it.
 */
function unsafeWebBuild() {
  const dirs = [ROOT, ...readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')).map((e) => join(ROOT, e.name))];
  for (const d of dirs.filter((x) => existsSync(join(x, 'shopify.web.toml')))) {
    let cmd;
    try { cmd = parseToml(readFileSync(join(d, 'shopify.web.toml'), 'utf8')).commands?.build; } catch (e) { return `${relative(ROOT, d) || '.'}/shopify.web.toml is unreadable (${e.message})`; }
    const hit = cmd && unsafeCommand(d, String(cmd));
    if (hit) return `${relative(ROOT, join(d, 'shopify.web.toml')).replaceAll('\\', '/')} builds with "${hit}"`;
  }
  return null;
}

function build(cfg) {
  const unsafe = unsafeWebBuild();
  if (unsafe) return { ok: false, skipped: true, error: `not run: ${unsafe}, which could deploy, migrate or reach a store. Bundle sizes are unmeasured; the dev builds it.`, bundles: [] };
  // The kit installs nothing: dependencies are the dev's.
  const r = cli(['app', 'build', '--skip-dependencies-installation'], cfg);
  const bundles = [];
  for (const e of extensions(cfg).filter((x) => x.type === 'ui_extension')) {
    const file = join(ROOT, e.dir, 'dist', `${e.handle}.js`);
    if (!existsSync(file)) { bundles.push({ extension: e.handle, verdict: 'MISSING', note: `no ${e.dir}/dist/${e.handle}.js after the build` }); continue; }
    const raw = statSync(file).size;
    const gz = gzipSync(readFileSync(file)).length;
    // Shopify counts the compressed size (optimize-bundle-size docs; the CLI's own log prints both): asmc's 59 KB raw
    // bundle was 22 KB compressed, so a raw-size warning was noise.
    bundles.push({ extension: e.handle, rawBytes: raw, gzipBytes: gz, limitBytes: BUNDLE_LIMIT, verdict: gz > BUNDLE_LIMIT ? 'FAIL' : 'PASS' });
  }
  for (const e of extensions(cfg).filter((x) => x.type === 'theme')) bundles.push({ extension: e.handle, ...themeExtensionLimits(join(ROOT, e.dir)) });
  return { ok: r.code === 0 && !bundles.some((b) => b.verdict === 'FAIL' || b.verdict === 'MISSING'), exit: r.code, error: r.code ? cliError(r) : undefined, bundles };
}

/** A theme app extension against Shopify's limits: 100 KB of Liquid in all, 15 KB per locale file, 30 blocks. */
export function themeExtensionLimits(dir) {
  const files = (sub, re) => { const d = join(dir, sub); return existsSync(d) ? readdirSync(d).filter((f) => re.test(f)).map((f) => join(d, f)) : []; };
  const liquid = ['blocks', 'snippets'].flatMap((s) => files(s, /\.liquid$/)).reduce((n, f) => n + statSync(f).size, 0);
  const blocks = files('blocks', /\.liquid$/).length;
  const bigLocales = files('locales', /\.json$/).filter((f) => statSync(f).size > 15 * 1024).map((f) => f.split(/[\\/]/).pop());
  const problems = [liquid > 100 * 1024 && `${(liquid / 1024).toFixed(1)} KB of Liquid (limit 100 KB)`, blocks > 30 && `${blocks} blocks (limit 30)`, bigLocales.length && `locale files over 15 KB: ${bigLocales.join(', ')}`].filter(Boolean);
  return { liquidBytes: liquid, blocks, verdict: problems.length ? 'FAIL' : 'PASS', ...(problems.length ? { note: problems.join('; ') } : {}) };
}

/**
 * The dev's app dev, from the CLI's own log (.shopify/dev/app-dev-<config>-*.jsonl: { timestamp, source, message }).
 * The kit can't run app dev; this says whether what QA is about to measure is the current code on the dev store.
 */
export function devStatus(cfg, root = ROOT) {
  const dir = join(root, '.shopify', 'dev');
  const logs = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`app-dev-${cfg.appConfig}-`) && f.endsWith('.jsonl')).map((f) => join(dir, f)) : [];
  if (!logs.length) return { running: false, problems: [`no app dev log for ${cfg.appConfig}: ask the dev to start the appDev command from shopify.mjs info, in a separate terminal`] };
  const file = logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const last = (re) => [...lines].reverse().find((l) => re.test(l.message || ''));
  const store = (last(/(?:Preparing|Updated) dev preview on (\S+)/)?.message.match(/on (\S+?\.myshopify\.com)/) || [])[1] || null;
  const updated = last(/Updated dev preview|Ready, watching for changes/)?.timestamp || null;
  // Edits the dev server hasn't picked up yet: extension files newer than its last update.
  const newest = extensions(cfg).flatMap((e) => walkFiles(join(root, e.dir))).reduce((m, f) => Math.max(m, statSync(f).mtimeMs), 0);
  const stale = updated && newest > Date.parse(updated) + 2000;
  // Per source (each extension, the app server): only errors after that source's last successful build. One fixed long
  // ago mustn't keep failing, and another extension's success mustn't hide one still broken.
  const lastOk = {};
  lines.forEach((l, i) => { if (/successfully built|Updated dev preview|Ready, watching for changes/.test(l.message || '')) lastOk[l.source] = i; });
  const errors = lines.filter((l, i) => (l.level === 'error' || /\b(error|failed)\b/i.test(l.message || '')) && i > (lastOk[l.source] ?? -1)).slice(-5)
    .map((l) => `${l.timestamp} ${l.source}: ${String(l.message).replace(/([?&]key=)[^&\s]+/g, '$1…').slice(0, 200)}`);
  const sizes = Object.fromEntries(lines.map((l) => (l.message || '').match(/^(\S+) successfully built in \S+ \(([^)]+)\)/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const want = devStore(cfg);
  return {
    running: Boolean(updated), log: relative(root, file).replaceAll('\\', '/'), store, lastUpdate: updated, lastLine: lines.at(-1)?.timestamp || null, sizes, errors,
    // The preview link, without the GraphiQL key the same log holds.
    preview: (last(/^Preview URL:/)?.message || '').replace(/^Preview URL:\s*/, '').replace(/([?&]key=)[^&\s]+/g, '$1…') || null,
    problems: [
      store && want && store !== want && `app dev is previewing on ${store}, not the dev store ${want}: ask the dev to restart it with the appDev command`,
      stale && 'extension files changed after app dev\'s last update: wait for "Updated dev preview" (or ask the dev to restart it) before measuring',
      errors.length && 'the log has build errors (see errors): fix them before measuring',
    ].filter(Boolean),
    note: 'The log can outlive the process: if lastLine is old and nothing updates after an edit, app dev has stopped.',
  };
}
const walkFiles = (d) => { try { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.') ? [] : e.isDirectory() ? walkFiles(join(d, e.name)) : [join(d, e.name)])); } catch { return []; } };

/** Each fixture (payload: { export, input, output }) run through the built Function. */
function functionRun(cfg, name, fixture) {
  const ext = extensionDir(cfg, name);
  // Like Shopify's test template: the export the toml names for the fixture's target, else the fixture's own.
  const exportFor = (payload) => (Array.isArray(ext.toml.extensions) ? ext.toml.extensions : [ext.toml]).flatMap((e) => e.targeting || []).find((t) => t.target === payload.target)?.export ?? payload.export;
  const files = fixture ? [resolve(ROOT, fixture)] : (() => {
    const dir = join(ext.dir, 'tests', 'fixtures');
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];
  })();
  if (!files.length) fail(`${ext.rel} has no tests/fixtures/*.json. Each fixture is { "payload": { "export", "input", "output" } }, the shape Shopify's test helpers use.`);
  const tmp = join(tmpdir(), `app-kit-fn-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const results = files.map((f) => {
    let payload;
    try { payload = JSON.parse(readFileSync(f, 'utf8')).payload; } catch (e) { return { fixture: relative(ROOT, f), verdict: 'FAIL', note: `unreadable fixture: ${e.message}` }; }
    const fnExport = payload && exportFor(payload);
    if (!fnExport || !payload.input) return { fixture: relative(ROOT, f), verdict: 'FAIL', note: 'fixture lacks payload.input, or an export (payload.export, or a payload.target the toml names)' };
    const input = join(tmp, 'input.json');
    writeFileSync(input, JSON.stringify(payload.input));
    const r = cli(['app', 'function', 'run', '--input', input, '--export', fnExport, '--json'], cfg, { path: ext.dir });
    // A crashing Function prints its result (with the Function's own log) and then an {"error":…} line (CLI 4.9.4).
    const out = jsonWith(r.stdout, 'instructions') || r.data;
    // A clean exit with JSON but none of the fields the kit reads: the CLI changed shape, not the Function.
    if (r.code === 0 && out && typeof out === 'object' && !['instructions', 'output', 'success'].every((k) => k in out)) {
      return { fixture: relative(ROOT, f), verdict: 'FAIL', note: `the CLI's function run output has no ${['instructions', 'output', 'success'].filter((k) => !(k in out)).join(', ')} (its shape changed): run cli-check --force and tell the kit maintainer` };
    }
    if (!out || typeof out.instructions !== 'number') return { fixture: relative(ROOT, f), verdict: 'FAIL', note: cliError(r).slice(0, 400) };
    // Key order doesn't matter (the template compares with toEqual); array order does.
    const sameOutput = stable(out.output) === stable(payload.output);
    const overLimit = out.instructions > INSTRUCTION_LIMIT;
    return {
      fixture: relative(ROOT, f).replaceAll('\\', '/'), instructions: out.instructions, limit: INSTRUCTION_LIMIT, memory: out.memory_usage,
      ran: out.success, outputMatches: sameOutput,
      verdict: out.success && sameOutput && !overLimit ? 'PASS' : 'FAIL',
      note: !out.success ? String(out.logs || '').split('\n')[0].slice(0, 200) : !sameOutput ? 'output differs from payload.output' : overLimit ? 'over the instruction limit' : undefined,
    };
  });
  rmSync(tmp, { recursive: true, force: true });
  return { extension: ext.rel, ok: results.every((x) => x.verdict === 'PASS'), results };
}

/**
 * shopify app security check, flattened. The results (CLI 4.9.4, schema_version 1): deterministic-findings.json holds
 * checks[] { id, status: executed|unresolved|not_applicable, findings[] { location.file, message, fix } }, and the
 * severity of each check is in agent-checks.json. ran: false means the check itself didn't run (no verdict either way).
 */
export function readSecurity(dir) {
  const det = JSON.parse(readFileSync(join(dir, 'deterministic-findings.json'), 'utf8'));
  let severity = {};
  try { severity = Object.fromEntries(JSON.parse(readFileSync(join(dir, 'agent-checks.json'), 'utf8')).checks.map((c) => [c.id, c.severity])); } catch { /* no severities */ }
  const checks = Array.isArray(det.checks) ? det.checks : [];
  return {
    ran: checks.length > 0,
    engine: det.engine?.version || null,
    findings: checks.flatMap((c) => (c.findings || []).map((f) => ({
      check: c.id, severity: String(severity[c.id] || 'unknown').toLowerCase(), file: f.location?.file || '', message: String(f.message || '').slice(0, 300), fix: f.fix?.description || '',
      fingerprint: `${c.id}|${f.location?.file || ''}|${String(f.message || '').slice(0, 120)}`,
    }))),
    // Checks the CLI couldn't run here (for example "unsupported_framework"): coverage gaps, not passes.
    unresolved: checks.filter((c) => c.status === 'unresolved').map((c) => `${c.id} (${c.reason?.code || 'unresolved'})`),
  };
}

function security(cfg) {
  const started = Date.now();
  const dir = join(ROOT, '.shopify', 'app-security');
  // An earlier run's results must not stand in for a run that failed before writing any (the mtime check below allows 2 s).
  for (const k of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, k, 'deterministic-findings.json'), { force: true });
  const r = cli(['app', 'security', 'check', '--skip-instructions'], cfg);
  // The results folder is named after the config file (or client id); take the newest, and only one this run wrote.
  const found = existsSync(dir) ? readdirSync(dir).map((k) => join(dir, k)).filter((d) => existsSync(join(d, 'deterministic-findings.json')))
    .sort((a, b) => statSync(join(b, 'deterministic-findings.json')).mtimeMs - statSync(join(a, 'deterministic-findings.json')).mtimeMs)[0] : null;
  if (!found || statSync(join(found, 'deterministic-findings.json')).mtimeMs < started - 2000) return { ran: false, exit: r.code, error: cliError(r), findings: [], unresolved: [] };
  return { ...readSecurity(found), exit: r.code, file: relative(ROOT, join(found, 'deterministic-findings.json')).replaceAll('\\', '/') };
}

/**
 * app execute on the dev store. allowMutation: false refuses anything but a single query. sealed: the exact text and
 * variables the seal was checked against; they run from a private copy, so a file changed after the check can't run.
 */
function execute(cfg, file, vars, { allowMutation, sealed = null }) {
  const text = sealed ? sealed.text : readFileSync(file, 'utf8');
  const parsed = gqlOperations(text);
  if (parsed.problem) fail(parsed.problem);
  if (parsed.ops.length !== 1) fail(`A file holds exactly one operation; this one has ${parsed.ops.length}.`);
  const [op] = parsed.ops;
  if (op.type === 'subscription') fail('Subscriptions aren\'t run.');
  if (op.type === 'mutation' && !allowMutation) fail('This file has a mutation. Store writes go through: node .claude/kit/shopify.mjs mutate <ID> <file> (the guard shows it to the dev first).');
  if (op.type !== 'mutation' && allowMutation) fail('This file has no mutation; run it with query.');
  let paths = { file, vars };
  const tmp = sealed ? mkdtempSync(join(tmpdir(), 'app-kit-mutate-')) : null;
  if (tmp) {
    paths = { file: join(tmp, 'm.graphql'), vars: vars ? join(tmp, 'v.json') : null };
    writeFileSync(paths.file, sealed.text);
    if (paths.vars) writeFileSync(paths.vars, sealed.varsText);
  }
  const args = ['app', 'execute', '--store', storeOrFail(cfg), '--query-file', paths.file];
  if (paths.vars) args.push('--variable-file', paths.vars);
  let r;
  try { r = cli(args, cfg); } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
  if (r.code !== 0 && !r.data) fail(`app execute failed:\n${cliError(r)}`);
  return { store: devStore(cfg), operation: op.type, fields: op.fields, result: r.data ?? r.stdout.trim() };
}

// ── Entry ──

const { _: [verb, ...rest], flags } = parseArgs(process.argv.slice(2));
const cfg = ['--help', 'help', undefined, 'cli-check'].includes(verb) ? readConfig({ required: false }) : readConfig();

switch (verb) {
  case 'cli-check': {
    const c = cliCheck(Boolean(flags.force));
    print(c);
    if (!c.ok) process.exit(1);
    break;
  }
  case 'info': print(info(cfg)); break;
  case 'generate-extension': {
    // The scaffold from Shopify's template, with the CLI's cached login: local files only, nothing changes on Shopify
    // until the dev deploys. Before, the run stopped in propose for the dev to answer the CLI's prompts.
    const [template, name] = rest;
    if (!template || !name) fail('Usage: generate-extension <template> <name> [--flavor <flavor>]: e.g. checkout_ui trust-list --flavor react');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(`Name the extension by its feature in kebab-case (e.g. trust-list), not "${name}".`);
    if (/^[a-z]+-\d+(-|$)/.test(name)) fail(`"${name}" looks like a ticket key. Merchants see the extension's name: name the feature instead (e.g. trust-list).`);
    const r = cli(['app', 'generate', 'extension', '--template', template, '--name', name, ...(typeof flags.flavor === 'string' ? ['--flavor', flags.flavor] : []), '--json'], cfg);
    const ext = jsonWith(r.stdout, 'extension')?.extension || r.data?.extension;
    if (r.code !== 0 || !ext) fail(`generate extension failed: ${cliError(r) || r.stderr.slice(-600)}\nIf the CLI needs a login or a choice it can't make without prompts, ask the dev to run: ! shopify app generate extension --template ${template} --name ${name}${configFlag(cfg).length ? ` ${configFlag(cfg).join(' ')}` : ''}`);
    print({ generated: ext, next: 'Write § Surfaces from app.mjs surfaces <ID>; build commits the folder as its first commit.' });
    break;
  }
  case 'validate': {
    if (flags.all) {
      // The production config is deployed by the dev; a broken one would only show at their deploy (asmc first run).
      const configs = readdirSync(ROOT).filter((f) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(f));
      const results = configs.map((c) => { const r = cli(['app', 'config', 'validate', '--json'], cfg, { config: c }); return { config: c, valid: Boolean(r.data?.valid), ...(r.data?.valid ? {} : { error: (r.data ? JSON.stringify(r.data) : cliError(r)).slice(0, 400) }) }; });
      print({ valid: results.every((x) => x.valid), results });
      if (!results.every((x) => x.valid)) process.exit(1);
      break;
    }
    const r = cli(['app', 'config', 'validate', '--json'], cfg);
    print(r.data ?? { error: cliError(r) });
    if (!r.data?.valid) process.exit(1);
    break;
  }
  case 'dev-status': { const s = devStatus(cfg); print(s); if (s.problems.length) process.exit(1); break; }
  case 'build': { const b = build(cfg); print(b); if (!b.ok) process.exit(1); break; }
  case 'function-build':
  case 'function-typegen': {
    const ext = extensionDir(cfg, rest[0]);
    const r = cli(['app', 'function', verb.split('-')[1]], cfg, { path: ext.dir });
    print(r.code === 0 ? `${verb} ${ext.rel}: ok` : `${verb} ${ext.rel} failed:\n${cliError(r)}`);
    if (r.code !== 0) process.exit(1);
    break;
  }
  case 'function-run': {
    const r = functionRun(cfg, rest[0], typeof flags.fixture === 'string' ? flags.fixture : null);
    print(r);
    if (!r.ok) process.exit(1);
    break;
  }
  // Exit 1 only when the check didn't run; whether a finding blocks is verify's call (it knows the baseline).
  case 'security': { const s = security(cfg); print(s); if (!s.ran) process.exit(1); break; }
  case 'query': {
    const file = rest[0];
    if (!/\.graphql$/i.test(file || '')) fail('Usage: query <file.graphql> [--vars <file.json>]');
    print(execute(cfg, resolve(ROOT, file), typeof flags.vars === 'string' ? resolve(ROOT, flags.vars) : null, { allowMutation: false }));
    break;
  }
  case 'mutate': {
    const id = normId(rest[0]);
    const st = readChange(cfg, id);
    const file = rest[1];
    const vars = typeof flags.vars === 'string' ? flags.vars : null;
    if (!/\.graphql$/i.test(file || '') || (vars && !/\.json$/i.test(vars))) fail(`Usage: mutate <ID> <file.graphql> [--vars <file.json>], both in .claude/logs/${id}/`);
    const abs = changeFile(id, file);
    const varsAbs = vars ? changeFile(id, vars) : null;
    const text = readFileSync(abs, 'utf8');
    const varsText = varsAbs ? readFileSync(varsAbs, 'utf8') : '';
    // Order matters: the file checks, then the guard's seal, then the one real run.
    if (flags['dry-run']) { print({ wouldRun: text, variables: varsText || null, store: storeOrFail(cfg) }); break; }
    consumeSeal(join(LOGS, id), { verb: 'mutate', sha: sealDigest(text, varsText), store: devStore(cfg) });
    const res = execute(cfg, abs, varsAbs, { allowMutation: true, sealed: { text, varsText } });
    st.mutations = [...(st.mutations || []), { at: now(), file: relative(ROOT, abs).replaceAll('\\', '/'), fields: res.fields, store: res.store }];
    writeChange(cfg, id, st);
    print(res);
    break;
  }
  default:
    print(HELP);
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
