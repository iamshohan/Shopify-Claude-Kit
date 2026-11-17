#!/usr/bin/env node
// The app kit's state machine: changes, stages, gates, the checks a stage must pass, verify, handoff and drift.
// Usage: node .claude/kit/app.mjs <verb> [<ID>] ...   (--help lists the verbs)
// A change is a folder in git, appspec/changes/<ID>/: proposal.md (its scenarios, surfaces and tasks) and change.json,
// written only by this script. Archive moves the folder to appspec/archive/ (the test ledger is read from there) and
// records its surfaces in appspec/surfaces.json. Kit notes and the guard's log stay local in .claude/logs/.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { print, fail, now, writeJsonAtomic, WIN, cmdExeProblem } from './core.mjs';
import {
  ROOT, KIT_DIR, LOGS, KIT_VERSION, CONFIG_REL, STAGES, TYPES, specPaths, parseArgs, readConfig, devStore, run, git, currentBranch, head,
  protectedBranches, branchFor, effectiveBase, owner, stageIndex, finished, normId, changeDir, readChange, writeChange, listChanges, isAppCode,
} from './repo.mjs';
import { tableUnder, sectionLines, saysNone, cells, checkKey, scenariosFrom, scenarioProblems, scenarioLine, scenarioRecord, changedSince, retiresFrom } from './scenarios.mjs';
import { readItems, treeReader, gitReader, diffItems, attentionFor, readSnapshot, snapshotText, extensionList, PCD_SCOPE } from './surfaces.mjs';
import { runTests, runCommand, unsafeCommand, testKey, ledgerFrom, baselineHint } from './checks.mjs';

const HELP = `Usage: node .claude/kit/app.mjs <verb> ...
  detect                                 suggest .claude/app-kit.json for this repo (kind, verify commands, app config)
  optout                                 create the Shopify plugin's telemetry opt-out file for this machine
  onboard                                create appspec/ (project.md, changes/, archive/), surfaces.json from the config
                                         files, and the security baseline
  list                                   open changes and their stage (abandoned ones are listed apart)
  start <ID> --type change|fix|maintain|ab [--title "..."] [--test]
                                         start a change on its branch (check it out first), or restart an abandoned one;
                                         --test: branch <ID>-kit-test, never pushed
  status <ID> [--json]                   stage, the skill to load, gates, what's open; for an archived ID, what's left
  gate <ID>                              what the current gate shows the dev: Gate 1 at propose (exit 1 while proposal.md
                                         has problems, listed first), Gate 2 at accept
  surfaces <ID>                          what the code changes in surfaces (last archive → working tree) against § Surfaces
  done <ID> <stage> [--answer "TEXT"] [--note "TEXT"]
                                         finish the current stage; gates need --answer with the dev's words
  back <ID> <stage> --reason "TEXT"      reopen an earlier stage (it clears the gates from there on)
  verify <ID> [--skip-tests]             run every check and record the result against the current code
  review <ID> code|security --found "TEXT"
                                         record a review of the committed code: what it found and what was done
  qa-row <ID> <scenario> --measured T --how T --verdict PASS|FAIL|BLOCKED
                                         record a measured qa: scenario (verify stage only; PASS/FAIL need both texts)
  waive <ID> <scenario> --reason "TEXT"  accept a qa: scenario that can't be measured (verify stage; the dev confirms;
                                         the handoff lists it)
  handoff <ID>                           update surfaces.json and the security baseline, write handoff.md, and move the
                                         change to archive/ (its bound tests join the ledger)
  drift [--regression]                   surfaces changed outside a change, ledgered tests that are gone; --regression runs
                                         every ledgered test
  abandon <ID> --reason "TEXT"           stop a change, list what to clean up, and show the retro signals
Kit feedback (problems with the kit, not the change)
  note <ID> "TEXT" [--kind friction|mistake|kit-bug|missing|idea]
  note <ID> --none                       nothing the kit caused
  retro <ID>                             what went wrong in this run, from the record
  feedback                               every change's signals and notes, with the kit version, for the kit maintainer
                                         (.claude/logs/kit-feedback.md)
  --selftest                             test the pure helpers`;

const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : fail(`Expected one of: ${allowed.join(', ')}`));

/**
 * Git Bash (MSYS) rewrites an argument that starts with "/" into a path under its install folder before node sees it:
 * "/app-change" arrives as "C:/Program Files/Git/app-change". Free text gets its slash back; paths are never passed through this.
 * root is that folder (cygpath -m /), which a Scoop install (…/scoop/apps/git/current) needs; without it, up to the first
 * folder named Git.
 */
export function unMsysFrom(s, root) {
  if (typeof s !== 'string') return s;
  if (root) return s.slice(0, root.length + 1).toLowerCase() === `${root.toLowerCase()}/` ? s.slice(root.length) : s;
  return s.replace(/^[A-Za-z]:\/(?:[^/\n]*\/)*?Git\/(.*)$/s, '/$1');
}
let msysRoot;
/** Git Bash's "/", asked once and only when a value looks rewritten. */
function gitBashRoot() {
  if (msysRoot === undefined) {
    const r = WIN && process.env.MSYSTEM ? run('cygpath', ['-m', '/'], { timeout: 5000 }) : null;
    msysRoot = r?.code === 0 ? r.stdout.trim().replace(/[\\/]+$/, '') || null : null;
  }
  return msysRoot;
}
export const unMsys = (s) => unMsysFrom(s, typeof s === 'string' && /^[A-Za-z]:\//.test(s) ? gitBashRoot() : null);
const freeText = (s) => (WIN ? unMsys(s) : s);
const TEXT_FLAGS = ['answer', 'note', 'measured', 'how', 'reason', 'title', 'found'];

// ── Files of a change ──

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
const tpl = (file, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), readFileSync(join(KIT_DIR, 'templates', file), 'utf8'));
const typeOf = (st) => st?.type || 'change';
const TYPE_NOTE = {
  change: 'Adds or adjusts behaviour.',
  fix: 'A bug: § Reproduce names the failing test and the failure seen before the fix, and a scenario binds that test.',
  maintain: 'No behaviour change (API version, dependencies, refactor): scenarios are optional, as re-checks of what the maintenance could break; the full regression must pass.',
  ab: 'An A/B-gated extension: § Gate says what turns the variation on, § Sunset when and how it goes.',
};
// Each type adds its own sections to the one proposal template.
const TYPE_SECTIONS = { fix: 'proposal-fix.md', ab: 'proposal-ab.md' };

function proposalTemplate(id, type) {
  const extra = TYPE_SECTIONS[type] ? `${readFileSync(join(KIT_DIR, 'templates', TYPE_SECTIONS[type]), 'utf8').trim()}\n\n` : '';
  return tpl('proposal.md', { ID: id, TYPE: type, TYPE_NOTE: TYPE_NOTE[type], TYPE_SECTIONS: extra });
}

const proposalOf = (cfg, id) => read(`${changeDir(cfg, id)}/proposal.md`);

/** Lines a proposal section gained over its template, so an untouched template never counts as filled. */
function added(cfg, id, st, heading) {
  const base = new Set(sectionLines(proposalTemplate(id, typeOf(st)), heading));
  return sectionLines(proposalOf(cfg, id), heading).filter((l) => !base.has(l));
}
const filled = (cfg, id, st, heading) => added(cfg, id, st, heading).length > 0;

// ── Surfaces of a change ──

const SURFACE_KEY = /^(scope|optional-scope|webhook|compliance-webhook|webhooks|app-proxy|config|metaobject|metafield|extension|extension-api|target|capability|extension-metafield|model|enum|view|type|db|dependency)(:.+)?$/;
// Surfaces whose addition or change needs proposal.md § Design. app-proxy is a key without a colon.
const HEAVY = /^(model|enum|db|app-proxy|config|webhook|compliance-webhook|extension)(:|$)/;
// Not declared: dependency version bumps, and extension metafields (read-only references).
const declarable = (d) => !(d.op === '~' && d.key.startsWith('dependency:')) && !d.key.startsWith('extension-metafield:');

/** Rows of proposal.md § Surfaces: [{ op, key, why, scenario }], or 'none'. */
function declaredSurfaces(md) {
  const rows = tableUnder(md, '## Surfaces').filter((r) => r.change || r.surface)
    .map((r) => ({ op: (r.change || '').replace(/[`*]/g, '').trim(), key: (r.surface || '').replace(/[`*]/g, '').trim(), why: (r.why || '').trim(), scenario: (r.scenario || '').replace(/[`*]/g, '').trim() }));
  if (!rows.length && saysNone(sectionLines(md, '## Surfaces').filter((l) => !l.startsWith('|')))) return 'none';
  return rows;
}

function declaredProblems(decl, scenarios, type, id) {
  if (decl === 'none') return [];
  if (!decl.length) return ['fill proposal.md § Surfaces: one row per surface this change adds (+), removes (-) or changes (~), or write "none"'];
  const ids = new Set(scenarios.map((s) => s.id.toLowerCase()));
  return decl.flatMap((d) => [
    !['+', '-', '~'].includes(d.op) && `§ Surfaces → "${d.key}": Change is +, - or ~ (got "${d.op}")`,
    !SURFACE_KEY.test(d.key) && `§ Surfaces → "${d.key}" isn't a surface key (scope:…, webhook:…, extension:…, model:…, dependency:… — see app.mjs surfaces ${id})`,
    d.op === '+' && /^(scope|optional-scope|webhook|compliance-webhook):/.test(d.key) && type !== 'maintain' && !ids.has(d.scenario.toLowerCase())
      && `§ Surfaces → "${d.key}": name the scenario that needs it in the Scenario column (got "${d.scenario || 'nothing'}")`,
    !d.why && `§ Surfaces → "${d.key}": say why in the Why column`,
  ]).filter(Boolean);
}

const isHeavy = (decl) => decl !== 'none' && decl.some((d) => d.op !== '-' && HEAVY.test(d.key));

/**
 * The surfaces this change makes: what differs from appspec/surfaces.json (the record as of the last archive, so a
 * branch cut from an unmerged change doesn't count that change's surfaces) and that the branch itself changed since its
 * git base. drift: what differs from the record but came with the base (changed on main outside the kit); handoff
 * records it.
 */
export function ownSurfaces(recorded, baseItems, nowItems) {
  const own = new Set(diffItems(baseItems, nowItems).map((d) => d.key));
  const all = diffItems(recorded || baseItems, nowItems);
  return { diff: all.filter((d) => own.has(d.key)), drift: all.filter((d) => !own.has(d.key) && declarable(d)) };
}

function actualSurfaces(cfg, st) {
  const base = effectiveBase(st, cfg);
  const snap = readSnapshot(join(ROOT, specPaths(cfg).surfaces));
  const recorded = snap && Object.fromEntries(Object.entries(snap.items || {}).map(([k, v]) => [k, v.value]));
  const after = readItems(treeReader(ROOT), { configName: cfg.appConfig });
  return { ...ownSurfaces(recorded, readItems(gitReader(ROOT, base), { configName: cfg.appConfig }).items, after.items), problems: after.problems, base };
}

/**
 * Declared against actual: what the code does that the proposal didn't say, and what the proposal said that didn't happen.
 * A declared new or removed extension brings its own API version and its package's dependencies (the template's rows).
 */
export function surfaceMismatch(declared, actual) {
  const decl = declared === 'none' ? [] : declared;
  const k = (d) => `${d.op} ${d.key}`;
  const want = new Set(decl.map(k));
  const exts = actual.filter((d) => d.key.startsWith('extension:') && want.has(k(d)));
  const implied = (d) => exts.some((e) => e.op === d.op && (d.key === `extension-api:${e.key.slice('extension:'.length)}`
    || d.key.startsWith(`dependency:${String(e.to ?? e.from).split(' in ')[1]}:`)));
  const got = new Set(actual.filter((d) => declarable(d) && (want.has(k(d)) || !implied(d))).map(k));
  return { undeclared: [...got].filter((x) => !want.has(x)), unhappened: [...want].filter((x) => !got.has(x)) };
}

// ── Digests ──
// Results are recorded against the app code, not the commit: committing the kit's files, docs or .gitignore mustn't
// make verify, QA or a review stale.

function codeDigest() {
  const lines = git(['ls-tree', '-r', 'HEAD'], { allowFail: true }).split(/\r?\n/).filter((l) => isAppCode(l.split('\t')[1] || ''));
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

// Line endings normalised: a CRLF checkout (core.autocrlf) of the same text must not read as changed.
const sha = (text) => createHash('sha256').update(String(text ?? '').replace(/\r\n?/g, '\n')).digest('hex').slice(0, 16);

/** What verify checked besides the code: the scenarios, the declared surfaces and the retired tests. A change to them makes it stale. */
const proposalDigest = (md) => sha([...scenariosFrom(md).map((s) => `${s.id} ${scenarioRecord(s)}`), ...retiresFrom(md).map(checkKey), approvedSections(md).surfaces].join('\n'));

/** Today's date where the dev is, for archive folder names (UTC would date an evening archive tomorrow). */
const localDay = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

/** The latest archived change with exactly this ID: { to, st } or null. */
function archivedChange(cfg, id) {
  const dir = join(ROOT, specPaths(cfg).archive);
  if (!existsSync(dir)) return null;
  const hits = readdirSync(dir).sort().map((d) => { try { return { to: `${specPaths(cfg).archive}/${d}`, st: JSON.parse(readFileSync(join(dir, d, 'change.json'), 'utf8')) }; } catch { return null; } })
    .filter((x) => x && x.st.id === id);
  return hits.pop() || null;
}

/** Uncommitted app code: results measured now wouldn't match any commit. Build output (dist/, .shopify/) doesn't count. */
function dirtyCode() {
  // Raw output: git() trims, which would cut the leading space of the first " M path" line.
  return run('git', ['status', '--porcelain', '--untracked-files=all']).stdout.split(/\r?\n/).filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').replace(/^.* -> /, '')).filter(isAppCode);
}

/** Files the branch changed since its base, lower-case with forward slashes. */
const changedFiles = (base) => git(['diff', '--name-only', `${base}...HEAD`], { allowFail: true }).split(/\r?\n/).filter(Boolean).map((p) => p.replaceAll('\\', '/').toLowerCase());

/**
 * Whether the branch touched a scenario's test: the file itself, or its fixtures/ or __snapshots__/ next to it. A test
 * named after one fixture (Shopify's Function template: "… runs at-threshold.json") needs that fixture touched.
 * Anything else next to it doesn't count: a test nobody touched passes either way.
 */
export function testTouched(changed, file, name = '') {
  const f = file.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
  const fixture = String(name).match(/\bruns (\S+\.json)$/i)?.[1]?.toLowerCase();
  if (fixture) return changed.includes(`${dir}fixtures/${fixture}`);
  return changed.some((p) => p === f || p.startsWith(`${dir}fixtures/`) || p.startsWith(`${dir}__snapshots__/`));
}

/** The extensions whose folder the branch changed: [{ handle, type, dir }]. changed: lower-case paths. */
export const extensionsTouched = (changed, items) => extensionList(items).filter((e) => e.dir && changed.some((p) => p.startsWith(`${e.dir.toLowerCase()}/`)));

// ── What Gate 1 approved ──
// Snapshot at done propose; Gate 2 lists what changed since instead of refusing it.

/** The parts of the proposal Gate 1 approves besides the scenarios: the declared surfaces and the retired tests. */
const approvedSections = (md) => {
  const decl = declaredSurfaces(md);
  return { surfaces: decl === 'none' ? 'none' : decl.map((d) => `${d.op} ${d.key}`).sort().join(', ') || 'none', retires: retiresFrom(md).map(checkKey).join(', ') || 'none' };
};
export const approvedOf = (md) => ({ approved: Object.fromEntries(scenariosFrom(md).map((s) => [s.id, scenarioRecord(s)])), approvedSections: approvedSections(md) });

/** Every scenario, § Surfaces and § Retires change since Gate 1, one line each. */
export function sinceGate1(st, md) {
  const now = approvedSections(md);
  return [...changedSince(st.approved, scenariosFrom(md)),
    ...Object.entries(st.approvedSections || {}).filter(([k, v]) => now[k] !== v).map(([k, v]) => `§ ${k[0].toUpperCase()}${k.slice(1)} changed: "${v}" → "${now[k]}"`)];
}

// ── QA and reviews ──

const qaScenarios = (rows) => rows.filter((s) => s.check.kind === 'qa');
const findScenario = (rows, n) => rows.find((s) => s.id.toLowerCase() === String(n || '').toLowerCase());

/** qa: scenarios that aren't PASS (or waived) on the current code. */
function openQa(cfg, st, rows) {
  const digest = codeDigest(cfg);
  return qaScenarios(rows).map((s) => {
    const r = st.qa?.rows?.[s.id];
    if (r?.verdict === 'WAIVED') return null;
    if (!r || r.verdict !== 'PASS') return `${s.id} (qa: ${s.check.expected}): ${r?.verdict || 'not measured'}`;
    if (r.digest !== digest) return `${s.id}: measured on older code; measure it again`;
    return null;
  }).filter(Boolean);
}

/** A review recorded against the code as it is now, or why it doesn't count. */
function reviewProblem(cfg, st, kind, digest = codeDigest(cfg)) {
  const r = st.reviews?.[kind];
  const skill = kind === 'code' ? 'code-review' : 'security-review';
  if (!r) return `run /${skill} on the change's diff and record it: app.mjs review <ID> ${kind} --found "<what it found and what was done>"`;
  if (r.digest !== digest) return `the code changed since the ${kind} review was recorded (code ${r.digest}, now ${digest}): run /${skill} on what changed, then record it again`;
  return null;
}

// ── Stage exit checks ──
// Each proves the stage's output exists, so a stage can't be marked done on intent alone.

function proposeProblems(cfg, id, st) {
  const md = proposalOf(cfg, id);
  const type = typeOf(st);
  const rows = scenariosFrom(md);
  const decl = declaredSurfaces(md);
  const attention = added(cfg, id, st, '## Needs your attention');
  // "none" hides what the dev must know before saying yes: a PCD scope, a new webhook, a model.
  const flagged = decl === 'none' ? [] : decl.filter((d) => ['+', '-', '~'].includes(d.op) && SURFACE_KEY.test(d.key) && attentionFor(d));
  const design = added(cfg, id, st, '## Design');
  const ledger = new Set(ledgerFrom(join(ROOT, specPaths().archive)).map((t) => testKey(t.file, t.name)));
  return [
    !filled(cfg, id, st, '## Why') && 'fill proposal.md § Why',
    !filled(cfg, id, st, '## What changes') && 'fill proposal.md § What changes',
    type !== 'maintain' && !rows.length && 'write the scenarios in proposal.md § Scenarios: one row per behaviour, | ID | GIVEN | WHEN | THEN | Check |',
    ...scenarioProblems(rows),
    !attention.length && 'fill proposal.md § Needs your attention (or "none: …" with the reason)',
    attention.length && saysNone(attention) && flagged.length && `proposal.md § Needs your attention can't be "none": list what each of these declared surfaces means for the merchant: ${flagged.map((d) => `${d.op} ${d.key} (${attentionFor(d)})`).join(' · ')}`,
    ...declaredProblems(decl, rows, type, id),
    // A data model, a new webhook, extension, app proxy or config change: the decisions and the deploy order are approved at Gate 1 too.
    isHeavy(decl) && (!design.length || saysNone(design)) && `fill proposal.md § Design: § Surfaces declares ${decl.filter((d) => d.op !== '-' && HEAVY.test(d.key)).map((d) => d.key).join(', ')}. Say the decisions, the data model and migration, which authenticate.* each new route uses, and the deploy order`,
    type === 'fix' && !filled(cfg, id, st, '## Reproduce') && 'fill proposal.md § Reproduce: the failing test (or the steps) and the failure seen before the fix',
    type === 'ab' && !filled(cfg, id, st, '## Gate') && 'fill proposal.md § Gate: the attribute key and values, and what happens without it',
    type === 'ab' && !filled(cfg, id, st, '## Sunset') && 'fill proposal.md § Sunset: when the test ends and how the extension is removed',
    ...retiresFrom(md).filter((c) => !ledger.has(testKey(c.file, c.name))).map((c) => `§ Retires → ${checkKey(c)} isn't a test an archived change bound; list only those there`),
    !sectionLines(md, '## Tasks').some((l) => /^- \[[ x]\] \S/.test(l)) && 'fill proposal.md § Tasks: one "- [ ] …" line per task, each naming the scenarios it satisfies',
  ].filter(Boolean);
}

const EXIT_CHECKS = {
  propose: proposeProblems,
  build: (cfg, id, st) => {
    const out = [];
    if (currentBranch() !== st.branch) out.push(`check out the change branch ${st.branch}`);
    const dirty = dirtyCode(cfg);
    if (dirty.length) out.push(`commit the work (uncommitted: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ' …' : ''})`);
    if (Number(git(['rev-list', '--count', `${effectiveBase(st, cfg)}..HEAD`], { allowFail: true }) || 0) === 0) out.push('the branch has no commits beyond its base yet');
    const mm = surfaceMismatch(declaredSurfaces(proposalOf(cfg, id)), actualSurfaces(cfg, st).diff);
    if (mm.undeclared.length) out.push(`the code changes surfaces the proposal doesn't declare: ${mm.undeclared.join(', ')}. Undo them, or go back to propose (Gate 1 again) and declare them`);
    if (mm.unhappened.length) out.push(`the proposal declares surfaces the code doesn't change: ${mm.unhappened.join(', ')}`);
    if (!st.reviews?.code) out.push(reviewProblem(cfg, st, 'code').replace('<ID>', id));
    return out;
  },
  verify: (cfg, id, st) => {
    const digest = codeDigest(cfg);
    const md = proposalOf(cfg, id);
    return [
      !st.verify && `run node .claude/kit/app.mjs verify ${id}`,
      st.verify && st.verify.digest !== digest && 'the code changed after the last verify: run verify again',
      st.verify && st.verify.proposal !== proposalDigest(md) && 'the scenarios, § Surfaces or § Retires changed after the last verify: run verify again',
      st.verify && !st.verify.ok && `verify failed: ${st.verify.checks.filter((c) => c.verdict === 'FAIL').map((c) => c.name).join(', ')}. Fix (back to build), then verify again`,
      dirtyCode(cfg).length && 'commit the work first',
      ...openQa(cfg, st, scenariosFrom(md)).map((q) => `QA ${q}`),
      reviewProblem(cfg, st, 'code', digest)?.replace('<ID>', id),
      reviewProblem(cfg, st, 'security', digest)?.replace('<ID>', id),
    ];
  },
  accept: () => [],
  handoff: (cfg, id) => [`hand off with: node .claude/kit/app.mjs handoff ${id}`],
};

// ── Verify ──

const wrapper = (args) => spawnSync(process.execPath, [join(KIT_DIR, 'shopify.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 900000 });
const parsedOut = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

const LOW_SEVERITY = new Set(['low', 'info', 'informational', 'none']);
/**
 * The security check's verdict. A finding in the baseline predates the change; with no baseline yet, so does a finding in
 * a file the change didn't touch. New findings block unless low: an unknown severity blocks, since it can mean the CLI's
 * results changed shape. With no baseline, a medium one in a touched file may well be older than the change, so it warns
 * (Gate 2 lists it).
 */
export function securityVerdict(findings, baseline, changed) {
  const known = new Set(baseline?.fingerprints || []);
  const norm = (p) => String(p || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
  const isKnown = (f) => known.has(f.fingerprint) || (!baseline && !changed.includes(norm(f.file)));
  const fresh = findings.filter((f) => !isKnown(f));
  const blocking = fresh.filter((f) => !LOW_SEVERITY.has(f.severity) && (baseline || f.severity !== 'medium'));
  return { known: findings.filter(isKnown), fresh, blocking, verdict: blocking.length ? 'FAIL' : findings.length ? 'WARN' : 'PASS' };
}

function runVerify(cfg, id, st, { skipTests }) {
  const P = specPaths(cfg);
  const checks = [];
  const add = (name, verdict, note, extra = {}) => checks.push({ name, verdict, note, ...extra });
  const md = proposalOf(cfg, id);
  const rows = scenariosFrom(md);
  const retired = new Set(retiresFrom(md).map((c) => testKey(c.file, c.name)));

  const a = actualSurfaces(cfg, st);
  const mm = surfaceMismatch(declaredSurfaces(md), a.diff);
  const attention = a.diff.filter(declarable).map((d) => ({ change: `${d.op} ${d.key}`, why: attentionFor(d) })).filter((x) => x.why);
  const drift = a.drift.length ? `changed outside the kit (on the base branch; handoff records them): ${a.drift.map((d) => `${d.op} ${d.key}`).join(', ')}` : '';
  add('surfaces', mm.undeclared.length || mm.unhappened.length || a.problems.length ? 'FAIL' : drift ? 'WARN' : 'PASS',
    [...a.problems, mm.undeclared.length && `undeclared: ${mm.undeclared.join(', ')}`, mm.unhappened.length && `declared but not in the code: ${mm.unhappened.join(', ')}`].filter(Boolean).join(' · ')
      || [`${a.diff.filter(declarable).length} surface changes, all declared`, drift].filter(Boolean).join(' · '),
    { attention });

  const changed = changedFiles(a.base);
  // A scenario proven by a test nobody touched is usually an old test that passes either way. Maintenance re-checks old tests.
  const untouched = typeOf(st) === 'maintain' ? [] : rows.filter((s) => s.check.kind === 'test' && !testTouched(changed, s.check.file, s.check.name))
    .map((s) => `${s.id}: ${s.check.file} isn't new or changed on this branch, nor its fixtures (git diff ${String(a.base || '').slice(0, 7)}...HEAD)`);
  const scenIssues = [...scenarioProblems(rows), ...untouched];
  add('scenarios', scenIssues.length ? 'FAIL' : 'PASS', scenIssues.join(' · ') || `${rows.length} scenarios: ${rows.filter((s) => s.check.kind === 'test').length} tests, ${qaScenarios(rows).length} QA, ${rows.filter((s) => s.check.kind === 'manual').length} manual`);

  // This change's tests and the ledger's, in one run per package.
  const ledger = ledgerFrom(join(ROOT, P.archive)).filter((t) => !retired.has(testKey(t.file, t.name)));
  const tests = new Map();
  for (const s of rows.filter((x) => x.check.kind === 'test')) tests.set(testKey(s.check.file, s.check.name), { key: testKey(s.check.file, s.check.name), file: s.check.file, name: s.check.name });
  for (const t of ledger) if (!tests.has(testKey(t.file, t.name))) tests.set(testKey(t.file, t.name), { key: testKey(t.file, t.name), file: t.file, name: t.name });
  const results = skipTests ? new Map() : runTests(ROOT, [...tests.values()]);
  const resultOf = (file, name) => results.get(testKey(file, name)) || { verdict: 'NOT RUN' };
  const scenarios = rows.map((s) => {
    const r = s.check.kind === 'test' ? resultOf(s.check.file, s.check.name) : { verdict: s.check.kind === 'qa' ? 'QA' : 'MANUAL' };
    return { id: s.id, check: checkKey(s.check), verdict: r.verdict, note: r.note };
  });
  const ownFails = scenarios.filter((s) => !['PASS', 'QA', 'MANUAL'].includes(s.verdict));
  add('tests', skipTests ? 'FAIL' : ownFails.length ? 'FAIL' : 'PASS', skipTests ? '--skip-tests: run verify without it before done verify'
    : ownFails.map((s) => `${s.id}: ${s.verdict}${s.note ? ` (${s.note})` : ''}`).join(' · ') || `${scenarios.filter((s) => s.verdict === 'PASS').length} scenario tests pass`);
  const own = new Set(rows.filter((s) => s.check.kind === 'test').map((s) => testKey(s.check.file, s.check.name)));
  const ledgerIssues = ledger.filter((t) => !own.has(testKey(t.file, t.name))).map((t) => ({ t, r: resultOf(t.file, t.name) })).filter(({ r }) => r.verdict !== 'PASS')
    .map(({ t, r }) => (r.verdict === 'MISSING' ? `gone: ${testKey(t.file, t.name)} (${t.change} ${t.scenario}); if this change means it, list it under proposal.md § Retires (Gate 1 again)` : `${r.verdict}: ${testKey(t.file, t.name)} (${t.change} ${t.scenario})${r.note ? `: ${r.note}` : ''}`));
  add('ledger', skipTests || ledgerIssues.length ? 'FAIL' : 'PASS', skipTests ? 'not run (--skip-tests)' : ledgerIssues.join(' · ') || (ledger.length ? `${ledger.length} ledgered tests pass` : 'no ledgered tests yet'));

  for (const c of cfg.verify || []) {
    const r = runCommand(ROOT, c.run);
    add(`command: ${c.name}`, r.verdict, r.note);
  }

  // Functions and checkout UI the change touched: fixtures, instruction counts, bundle size.
  const exts = extensionsTouched(changed, readItems(treeReader(ROOT), { configName: cfg.appConfig }).items);
  for (const ext of exts.filter((e) => e.type === 'function')) {
    const b = wrapper(['function-build', ext.handle]);
    if (b.status !== 0) { add(`function ${ext.handle}`, 'FAIL', `build failed: ${(b.stdout + b.stderr).trim().slice(-400)}`); continue; }
    if (!existsSync(join(ROOT, ext.dir, 'tests', 'fixtures'))) { add(`function ${ext.handle}`, 'WARN', 'no tests/fixtures: instruction counts unmeasured'); continue; }
    const r = parsedOut(wrapper(['function-run', ext.handle]));
    add(`function ${ext.handle}`, r?.ok ? 'PASS' : 'FAIL', r ? r.results.map((x) => `${x.fixture.split('/').pop()}: ${x.verdict}${x.instructions ? ` ${(x.instructions / 1e6).toFixed(2)}M instr` : ''}${x.note ? ` (${x.note})` : ''}`).join(' · ') : 'function-run gave no result');
  }
  if (exts.some((e) => e.type === 'ui_extension')) {
    const r = parsedOut(wrapper(['build']));
    // A web build the kit won't run leaves the sizes unmeasured: a warning, since the dev's own build is fine.
    add('bundle size', r?.skipped ? 'WARN' : r?.ok ? 'PASS' : 'FAIL', r ? r.bundles.map((x) => `${x.extension}: ${x.verdict}${x.gzipBytes ? ` ${(x.gzipBytes / 1024).toFixed(1)} KB gz / ${(x.rawBytes / 1024).toFixed(1)} KB raw` : ''}`).join(' · ') || r.error : 'build gave no result');
  }

  if (cfg.securityCheck === false) add('security check', 'WARN', 'skipped: "securityCheck": false in .claude/app-kit.json');
  else {
    const r = parsedOut(wrapper(['security']));
    // A check that didn't run has no verdict. It warns rather than blocks: an expired login shouldn't stop every change.
    if (!r?.ran) add('security check', 'WARN', `shopify app security check didn't run, so there is no verdict: ${(r?.error || 'no result').slice(0, 300)}. Run verify again once it can; to skip it for this repo, the dev sets "securityCheck": false in .claude/app-kit.json`);
    else {
      const s = securityVerdict(r.findings, readSnapshot(join(ROOT, P.securityBaseline)), changed);
      const line = (f) => `${f.check} (${f.severity}) ${f.file}: ${f.message.slice(0, 140)}`;
      const warns = s.fresh.filter((f) => !s.blocking.includes(f));
      add('security check', s.verdict,
        [s.blocking.length && `new: ${s.blocking.map(line).join(' · ')}`, warns.length && `new, not blocking: ${warns.map(line).join(' · ')}`,
          s.known.length && `known before this change: ${s.known.map((f) => f.check).join(', ')}`,
          r.unresolved.length && `not checked for this app's framework: ${r.unresolved.length} checks`].filter(Boolean).join(' · ') || 'no findings',
        { fingerprints: r.findings.map((f) => f.fingerprint) });
    }
  }
  return {
    at: now(), digest: codeDigest(cfg), proposal: proposalDigest(md), commit: head(), ok: !checks.some((c) => c.verdict === 'FAIL'), checks, scenarios,
    changedSinceGate1: sinceGate1(st, md),
  };
}

// ── Deploy checklist and handoff ──

/**
 * The deploy steps a change implies, in deploy order. keys: the surface changes ("+ scope:x"); ext: { handle: { type, targets } }
 * for the extensions the change touched; server: the app server's code changed; configs: the repo's shopify.app*.toml files.
 */
export function deploySteps({ keys, ext, server, configs, appConfig }) {
  const has = (re) => keys.some((k) => re.test(k));
  const removed = keys.filter((k) => /^- (extension|target):/.test(k)).map((k) => k.slice(2));
  // Activation and placement are once per store: only for a new extension or target, not an API bump of a live one.
  const isNew = (h, t) => keys.includes(`+ extension:${h}`) || (t ? keys.includes(`+ target:${h}/${t}`) : keys.some((k) => k.startsWith(`+ target:${h}/`)));
  const targets = (re, onlyNew) => Object.entries(ext).flatMap(([h, e]) => (e.targets || []).filter((t) => re.test(t) && (!onlyNew || isNew(h, t))).map((t) => `${h} (${t})`));
  const ofType = (re) => Object.entries(ext).filter(([h, e]) => re.test(e.type) && isNew(h)).map(([h]) => h);
  const pcd = keys.filter((k) => /^\+ scope:/.test(k) && PCD_SCOPE.test(k.slice('+ scope:'.length))).map((k) => k.slice('+ scope:'.length));
  // Block targets are placed by a merchant in the editor; static targets render where Shopify puts them.
  const blocks = targets(/^(purchase\.|customer-account\.).*\.block\.render$/, true);
  const admin = targets(/^admin\./);
  const pos = targets(/^pos\./);
  const configNote = configs.length > 1 ? ` This repo has ${configs.join(', ')}; the kit works on ${appConfig}, the dev app.` : ` This repo has only ${configs[0] || appConfig}, which the kit uses for the dev app: check which app it is linked to before deploying.`;
  return [
    has(/^[+~-] (model|enum|db|view|type):/) && 'Migrate the production database first, in a form the code running now still works with (add, don\'t rename or drop yet): the new code needs it, and the old code serves traffic until the release.',
    server && 'Deploy the app server (hosting), so new routes and webhooks answer before Shopify starts calling them.',
    pcd.length && `Request protected customer data access for ${pcd.join(', ')} in the Partner Dashboard (API access) before releasing.`,
    `Run shopify app deploy --config <the production app's config>.${configNote} Deploy creates a new app version and releases it to every installed store at once; with --no-release it only creates the version, which you release from the Partner Dashboard when ready.${removed.length ? ` This change removes ${removed.join(', ')}: deploy asks you to confirm the removal (--allow-deletes in CI), and merchants lose what they placed.` : ''} Rollback: release the previous version.`,
    has(/^\+ scope:/) && 'New scopes: each store approves them when a merchant next opens the app. Until then the app runs with its old scopes, so the new code has to cope without them.',
    has(/webhook/) && 'Webhooks change with the release; check the subscriptions in the Partner Dashboard afterwards.',
    ofType(/^function$/).length && `Activate the Function (${ofType(/^function$/).join(', ')}) on each store after the release: a discount, cart transform or customization pointing at it.`,
    blocks.length && `Place the block in each store's checkout and accounts editor after the release (the dev or the merchant): ${blocks.join(', ')}.`,
    admin.length && `Check the admin UI extension in the admin after the release: ${admin.join(', ')}.`,
    pos.length && `Check the POS UI extension in the POS app after the release: ${pos.join(', ')}.`,
    ofType(/^theme$/).length && 'Enable the theme app extension in each store\'s theme editor (the app embed, or the app block in a section) after the release.',
  ].filter(Boolean);
}

/**
 * Whether the app server needs deploying: its code or dependencies changed (changed: lower-case paths), or something
 * Shopify calls on it (a webhook, the app proxy) or its database did.
 */
export const serverChanged = (keys, changed) => keys.some((k) => /^. (webhook:|compliance-webhook:|app-proxy$|model:|enum:|db:|view:|type:)/.test(k))
  || changed.some((p) => /^(app|web|server|prisma|public)\/|^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|shopify\.web\.toml|dockerfile)$/.test(p));

/** The deploy steps for this change, from verify's surface changes and the extensions it touched. */
function stepsFor(cfg, st) {
  const keys = (st.verify?.checks.find((c) => c.name === 'surfaces')?.attention || []).map((s) => s.change);
  const items = readItems(treeReader(ROOT), { configName: cfg.appConfig }).items;
  const touched = new Set(keys.filter((k) => /^[+~] (extension|target|capability|extension-api):/.test(k)).map((k) => k.replace(/^[+~] [\w-]+:/, '').split('/')[0]));
  const ext = Object.fromEntries([...touched].map((h) => [h, {
    type: String(items[`extension:${h}`] || '').split(' ')[0],
    targets: Object.keys(items).filter((k) => k.startsWith(`target:${h}/`)).map((k) => k.slice(`target:${h}/`.length)),
  }]));
  const configs = readdirSync(ROOT).filter((f) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(f));
  const server = cfg.kind === 'admin' && serverChanged(keys, changedFiles(effectiveBase(st, cfg)));
  return deploySteps({ keys, ext, server, configs, appConfig: cfg.appConfig });
}

function handoff(cfg, id, st) {
  const md = proposalOf(cfg, id);
  const rows = scenariosFrom(md);
  const surf = st.verify.checks.find((c) => c.name === 'surfaces')?.attention || [];
  const manual = rows.filter((s) => s.check.kind === 'manual');
  const waived = Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict === 'WAIVED');
  const design = sectionLines(md, '## Design');
  // The A/B type's activation and sunset come from the proposal the dev approved at Gate 1.
  const abLines = typeOf(st) === 'ab' ? [...sectionLines(md, '## Gate').map((l) => `Gate: ${l}`), ...sectionLines(md, '## Sunset').map((l) => `Sunset: ${l}`)] : [];
  const retired = retiresFrom(md);
  const since = sinceGate1(st, md);
  return [
    `# ${id} · Handoff`,
    '',
    ...(st.title ? [st.title, ''] : []),
    '## PR description',
    '',
    `**${id}** (${typeOf(st)})${st.tickets?.length ? ` · tickets: ${st.tickets.join(', ')}` : ''}`,
    '',
    '### What changes',
    ...(sectionLines(md, '## What changes').map((l) => (/^[-*]/.test(l) ? l : `- ${l}`))),
    '',
    '### Scenarios',
    ...(rows.length ? rows.map((s) => `- ${scenarioLine(s)} (${resultOf(st, s)})`) : ['- none (maintenance: the regression covers it)']),
    '',
    '### Surfaces',
    ...(surf.length ? surf.map((s) => `- \`${s.change}\`: ${s.why}`) : ['- none']),
    '',
    '### Verified',
    ...st.verify.checks.map((c) => `- ${c.verdict} ${c.name}${c.verdict !== 'PASS' && c.note ? `: ${c.note.slice(0, 200)}` : ''}`),
    ...Object.entries(st.reviews || {}).map(([k, r]) => `- ${k} review: ${r.found}`),
    ...(since.length ? ['', '### Changed since Gate 1 (the dev saw these at Gate 2)', ...since.map((l) => `- ${l}`)] : []),
    ...(waived.length ? ['', '### Waived QA', ...waived.map(([n, r]) => `- ${n}: ${r.reason} (confirmed by the dev)`)] : []),
    ...(manual.length ? ['', '### Manual checks for the reviewer', ...manual.map((s) => `- ${s.id}: ${s.check.what}`)] : []),
    ...(retired.length ? ['', '### Retired tests', ...retired.map((c) => `- ${checkKey(c)}`)] : []),
    '',
    '### Gates',
    ...Object.entries(st.gates || {}).map(([g, v]) => `- ${g} (${v.at.slice(0, 16)}): "${v.answer}"`),
    '',
    '## Deploy checklist (the dev deploys; the kit never does)',
    '',
    ...stepsFor(cfg, st).map((s) => `- [ ] ${s}`),
    ...(design.length && !saysNone(design) ? ['', '### From proposal.md § Design (this change\'s own notes; the order above comes first)', ...design.map((l) => `- ${l.replace(/^[-*]\s*/, '')}`)] : []),
    ...(abLines.length ? ['', '### A/B test: activation and sunset', ...abLines.map((l) => `- [ ] ${l}`)] : []),
    '',
    `Store mutations run on the dev store: ${(st.mutations || []).length}.`,
    '',
  ].join('\n');
}

// ── Gates ──

/** A scenario's result: QA as measured (and how), else verify's verdict. */
function resultOf(st, s) {
  const r = st.qa?.rows?.[s.id];
  if (s.check.kind === 'qa') return r ? `${r.verdict}${r.measured ? `: ${r.measured} (${r.how})` : r.reason ? `: ${r.reason}` : ''}` : 'not measured';
  return st.verify?.scenarios.find((x) => x.id === s.id)?.verdict || 'not run';
}

/** What a gate shows the dev, in one question: Gate 1 at propose, Gate 2 at accept. */
function gateView(cfg, id, st) {
  const md = proposalOf(cfg, id);
  const rows = scenariosFrom(md);
  const decl = declaredSurfaces(md);
  const count = (k) => rows.filter((s) => s.check.kind === k).length;
  if (st.stage !== 'accept') {
    return {
      gate: 'Gate 1: the scenarios, the surfaces, how each scenario is checked',
      scenarios: rows.map(scenarioLine),
      checks: { test: count('test'), qa: count('qa'), manual: count('manual') },
      surfaces: decl === 'none' ? 'none' : decl.map((d) => `${d.op} ${d.key}: ${attentionFor(d) || 'no special attention'}`),
      pcdScopes: decl === 'none' ? [] : decl.filter((d) => d.op === '+' && /^scope:/.test(d.key) && PCD_SCOPE.test(d.key.slice(6))).map((d) => d.key),
      design: isHeavy(decl) ? sectionLines(md, '## Design') : undefined,
      attention: sectionLines(md, '## Needs your attention'),
      retires: retiresFrom(md).map(checkKey),
      ...(typeOf(st) === 'fix' ? { reproduce: sectionLines(md, '## Reproduce') } : {}),
      ...(typeOf(st) === 'ab' ? { abGate: sectionLines(md, '## Gate'), sunset: sectionLines(md, '## Sunset') } : {}),
      outOfScope: sectionLines(md, '## Out of scope'),
    };
  }
  const v = st.verify;
  return {
    gate: 'Gate 2: the measured result',
    verify: v ? `${v.ok ? 'PASS' : 'FAIL'} on code ${v.digest}${v.digest === codeDigest(cfg) ? '' : ' (outdated: the code changed since)'}` : 'not run',
    checks: (v?.checks || []).map((c) => `${c.verdict} ${c.name}${c.verdict !== 'PASS' && c.note ? `: ${c.note.slice(0, 200)}` : ''}`),
    scenarios: rows.map((s) => `${scenarioLine(s)} → ${resultOf(st, s)}`),
    changedSinceGate1: sinceGate1(st, md),
    surfaces: v?.checks.find((c) => c.name === 'surfaces')?.attention?.map((x) => `${x.change}: ${x.why}`) || [],
    deploySteps: stepsFor(cfg, st),
    manual: rows.filter((s) => s.check.kind === 'manual').map((s) => `${s.id}: ${s.check.what}`),
    waived: Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict === 'WAIVED').map(([n, r]) => `${n}: ${r.reason}`),
    reviews: Object.fromEntries(Object.entries(st.reviews || {}).map(([k, r]) => [k, r.found])),
  };
}

// ── Archive ──

function runHandoff(cfg, id, st) {
  const P = specPaths(cfg);
  const md = proposalOf(cfg, id);
  const rows = scenariosFrom(md);
  const problems = [
    st.stage !== 'handoff' && `${id} is at stage "${st.stage}"; handoff comes after Gate 2`,
    !st.verify?.ok && 'verify hasn\'t passed',
    st.verify && st.verify.digest !== codeDigest(cfg) && 'the code changed after verify: run verify again (back to verify)',
    st.verify && st.verify.proposal !== proposalDigest(md) && 'the scenarios, § Surfaces or § Retires changed after verify: run verify again (back to verify)',
    dirtyCode(cfg).length && 'commit the work first',
    ...openQa(cfg, st, rows),
  ].filter(Boolean);
  if (problems.length) fail(`Can't hand off ${id}:\n${problems.map((p) => `- ${p}`).join('\n')}`);

  const outputs = [];
  // surfaces.json: today's items, keeping each surface's recorded reason and adding the proposal's.
  const snap = readSnapshot(join(ROOT, P.surfaces)) || { items: {} };
  const decl = declaredSurfaces(md);
  const items = {};
  for (const [k, v] of Object.entries(readItems(treeReader(ROOT), { configName: cfg.appConfig }).items)) {
    const d = decl === 'none' ? null : decl.find((x) => x.key === k && x.op !== '-');
    const prev = snap.items?.[k] || {};
    items[k] = { value: v, ...(d ? { why: d.why, scenario: d.scenario || undefined, since: id } : { why: prev.why, scenario: prev.scenario, since: prev.since }) };
  }
  // No kit version or "updatedBy": two changes archiving in parallel would conflict in git on that line alone.
  outputs.push([P.surfaces, snapshotText(items)]);
  // The findings this change's verify saw become the baseline the next change is measured against.
  const sec = st.verify.checks.find((c) => c.name === 'security check' && c.fingerprints);
  if (sec) outputs.push([P.securityBaseline, JSON.stringify({ note: 'Security findings accepted as of the last handoff; verify fails only on new ones. Written by the app kit.', fingerprints: [...sec.fingerprints].sort() }, null, 2) + '\n']);
  outputs.push([`${changeDir(cfg, id)}/handoff.md`, handoff(cfg, id, st)]);

  // Everything before the move writes the same text when handoff runs again, so a failure is fixed by running it again.
  for (const [rel, text] of outputs) {
    try {
      mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
      writeFileSync(join(ROOT, rel), text);
    } catch (e) {
      fail(`Couldn't write ${rel} (${e.code || e.message}). Make it writable (a read-only file, a folder in its place, an editor holding it) and run node .claude/kit/app.mjs handoff ${id} again: it writes the same files again. To undo what it wrote: git restore ${P.dir}`);
    }
  }
  const day = localDay();
  // A reopened ticket can hand off under the same ID on the same day.
  let to = `${P.archive}/${day}-${id}`;
  for (let n = 2; existsSync(join(ROOT, to)); n++) to = `${P.archive}/${day}-${id}-${n}`;
  mkdirSync(join(ROOT, P.archive), { recursive: true });
  try {
    renameSync(join(ROOT, changeDir(cfg, id)), join(ROOT, to));
  } catch (e) {
    fail(`Couldn't move ${changeDir(cfg, id)} to ${to} (${e.code || e.message}). On Windows, a terminal, editor or Explorer window open inside that folder locks it: close it and run handoff again.`);
  }
  return finishArchive(cfg, id, st, to);
}

/** Records the moved change as done. Run again by handoff when the move happened but this didn't. */
function finishArchive(cfg, id, st, to) {
  st.history.push({ at: now(), event: 'done', stage: 'handoff' });
  st.stage = 'done';
  st.archivedAt = now();
  st.archivedTo = to;
  st.updatedAt = now();
  writeJsonAtomic(join(ROOT, to, 'change.json'), st);
  return { archived: to, next: archivedNext(cfg, id, st, to) };
}

/** What's left after a handoff: commit, push, open the PR from handoff.md. */
function archivedNext(cfg, id, st, to) {
  const P = specPaths(cfg);
  const uncommitted = run('git', ['status', '--porcelain', '--', P.dir]).stdout.trim();
  const onBranch = currentBranch() === st.branch;
  const behind = onBranch && !st.test && (() => { const r = run('git', ['rev-list', '--count', `origin/${st.branch}..HEAD`]); return r.code !== 0 || Number(r.stdout.trim()) > 0; })();
  return [
    uncommitted && `git add -- ${P.dir} && git commit -m "${(cfg.commitPattern || '{ID}: handoff').replace('{ID}', id)}"`,
    st.test ? '(test run: no push)' : (uncommitted || behind) && `git push -u origin ${st.branch}`,
    `PR text and deploy checklist: ${to}/handoff.md`,
  ].filter(Boolean);
}

// ── Retro and summary ──

function retroSignals(st) {
  const events = st.history || [];
  const refused = {};
  for (const e of events.filter((x) => x.event === 'refused')) (refused[e.stage] ||= []).push(...(e.missing || []));
  const to = finished(st) ? st.updatedAt : now();
  let guardBlocks = [];
  try {
    guardBlocks = readFileSync(join(LOGS, '_guard.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      // This change's branch; entries from before the guard logged a branch fall back to the change's time window.
      // Gate answers aren't blocks (gateAnswers has them). kind (deny, ask or log) says what the guard did.
      .filter((g) => g && !g.gate && g.at >= st.createdAt && g.at <= to && (g.branch ? g.branch === st.branch : true)).map((g) => `${g.at.slice(0, 16)} ${g.kind ? `[${g.kind}] ` : ''}${String(g.reason || '').slice(0, 110)} ← ${String(g.command || '').slice(0, 90)}`);
  } catch { /* no guard log */ }
  return {
    loopsBack: events.filter((e) => e.event === 'back').map((e) => `${e.from} → ${e.to}: ${e.reason}`),
    refusedStages: Object.entries(refused).map(([s, mm]) => `${s} ×${events.filter((e) => e.event === 'refused' && e.stage === s).length}: ${[...new Set(mm)].slice(0, 3).join(' / ')}`),
    guardBlocks,
    gateAnswers: Object.fromEntries(Object.entries(st.gates || {}).map(([g, v]) => [g, v.answer])),
  };
}

function summaryLines(cfg, id, st) {
  const i = stageIndex(st.stage);
  const lines = [];
  if (finished(st)) lines.push(`${id} · ${typeOf(st)} · ${st.stage === 'done' ? `archived to ${st.archivedTo}` : 'abandoned'}`);
  else {
    const s = STAGES[i];
    lines.push(`${id} · ${typeOf(st)} · stage ${i + 1}/${STAGES.length}: ${s.name}${s.gate ? ` (${s.gate})` : ''}`);
    lines.push(`Next: load the skill "${s.skill}" and do the "${s.name}" stage.`);
  }
  const done = STAGES.slice(0, i === -1 ? STAGES.length : i).map((s) => (st.gates?.[s.name] ? `${s.name} ✓ ("${st.gates[s.name].answer.slice(0, 60)}")` : `${s.name} ✓`));
  if (done.length && !finished(st)) lines.push(`Done: ${done.join(' · ')}`);
  if (st.test) lines.push(`TEST RUN: the branch is ${st.branch} and is never pushed (the guard blocks it).`);
  const base = effectiveBase(st, cfg);
  lines.push(`Branch: ${st.branch} · diff base: ${base ? base.slice(0, 7) : '—'} · protected: ${protectedBranches(cfg).join(', ')} · dev store: ${devStore(cfg) || '(not set)'}`);
  if (st.verify) lines.push(`Last verify: ${st.verify.ok ? 'PASS' : 'FAIL'} at ${st.verify.at.slice(0, 16)} (code ${st.verify.digest}${st.verify.digest === codeDigest(cfg) ? ', current' : ', outdated'})`);
  if (st.stage === 'build' || st.stage === 'verify') lines.push('App code is open in build. In verify, fixes go back to build: app.mjs back <ID> build --reason "…".');
  lines.push(`File: ${changeDir(cfg, id)}/proposal.md`);
  if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
  return lines.join('\n');
}

// ── Detect, onboard, drift ──

function detect() {
  const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return {}; } })();
  const scripts = pkg.scripts || {};
  const verify = [];
  // Only scripts that don't run the Shopify CLI, deploy or migrate, through their pre/post-scripts: the kit runs these itself, outside the guard.
  const usable = (name) => scripts[name] && !/\bshopify\b/.test(scripts[name]) && !unsafeCommand(ROOT, `npm run ${name}`);
  if (usable('lint')) verify.push({ name: 'lint', run: 'npm run lint' });
  if (usable('typecheck')) verify.push({ name: 'typecheck', run: 'npm run typecheck' });
  else if (existsSync(join(ROOT, 'tsconfig.json')) && existsSync(join(ROOT, 'node_modules', 'typescript'))) verify.push({ name: 'typecheck', run: 'npx tsc --noEmit' });
  if (usable('build')) verify.push({ name: 'build', run: 'npm run build' });
  // The repo's whole test suite is the regression; vitest runs once (not watching) because the kit sets CI=1.
  if (usable('test')) verify.push({ name: 'test', run: 'npm test' });
  const configs = readdirSync(ROOT).filter((f) => /^shopify\.app(\.[\w-]+)?\.toml$/.test(f));
  const admin = existsSync(join(ROOT, 'app', 'routes')) || existsSync(join(ROOT, 'prisma'));
  return {
    suggestion: {
      devStore: 'drip-dev-eho-store.myshopify.com', baseBranch: git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }).replace(/^origin\//, '') || 'main',
      appConfig: configs.includes('shopify.app.toml') ? 'shopify.app.toml' : configs[0] || 'shopify.app.toml', kind: admin ? 'admin' : 'extensions', verify,
    },
    appConfigs: configs,
    notes: [
      configs.length > 1 && `Several app configs (${configs.join(', ')}): set appConfig to the dev app's, so the kit never targets production.`,
      Object.values(scripts).some((s) => /shopify\s+app\s+deploy/.test(s)) && 'package.json has a deploy script; the guard blocks it, and the dev deploys.',
      !admin && 'No app/routes or prisma: an extension-only app. The deploy checklist skips hosting and migrations.',
    ].filter(Boolean),
    write: `Write it to ${CONFIG_REL} with the Write tool (the guard shows the dev each setting).`,
  };
}

function onboard(cfg) {
  const P = specPaths(cfg);
  const out = [];
  for (const d of [P.changes, P.archive]) { mkdirSync(join(ROOT, d), { recursive: true }); if (!readdirSync(join(ROOT, d)).length) { writeFileSync(join(ROOT, d, '.gitkeep'), ''); out.push(`${d}/`); } }
  if (!existsSync(join(ROOT, P.project))) {
    const name = read(cfg.appConfig).match(/^name\s*=\s*"([^"]+)"/m)?.[1] || 'This app';
    writeFileSync(join(ROOT, P.project), tpl('project.md', { APP: name }));
    out.push(P.project);
  }
  let surfaces = `${P.surfaces} already exists; use app.mjs drift`;
  if (!existsSync(join(ROOT, P.surfaces))) {
    const r = readItems(treeReader(ROOT), { configName: cfg.appConfig });
    if (r.problems.length) fail(`Can't read the app's surfaces:\n- ${r.problems.join('\n- ')}`);
    const items = Object.fromEntries(Object.entries(r.items).map(([k, v]) => [k, { value: v }]));
    writeFileSync(join(ROOT, P.surfaces), snapshotText(items));
    out.push(P.surfaces);
    surfaces = {};
    for (const k of Object.keys(r.items)) surfaces[k.split(':')[0]] = (surfaces[k.split(':')[0]] || 0) + 1;
  }
  // Today's security findings become the baseline: later changes fail only on findings they add. Run again to record it
  // when the check couldn't run the first time.
  let security = `${P.securityBaseline} already exists`;
  if (!existsSync(join(ROOT, P.securityBaseline))) {
    const sec = cfg.securityCheck === false ? null : parsedOut(wrapper(['security']));
    if (sec?.ran) {
      writeFileSync(join(ROOT, P.securityBaseline), JSON.stringify({ note: 'Security findings accepted as of onboarding; verify fails only on new ones. Written by the app kit.', fingerprints: sec.findings.map((f) => f.fingerprint).sort() }, null, 2) + '\n');
      out.push(P.securityBaseline);
      security = { findings: sec.findings.map((f) => `${f.check} (${f.severity}) ${f.file}: ${f.message.slice(0, 160)}`), notCheckedForThisFramework: sec.unresolved.length };
    } else {
      security = `shopify app security check didn't run (${(sec?.error || 'disabled').slice(0, 160)}). Until a baseline exists, verify treats findings in files a change didn't touch as older; run onboard again to record it, or the first handoff does`;
    }
  }
  return {
    created: out, surfaces, security,
    next: [`fill ${P.project} (a few lines each)`, `commit ${P.dir}/ on a branch`],
  };
}

function drift(cfg, { regression }) {
  const P = specPaths(cfg);
  const snap = readSnapshot(join(ROOT, P.surfaces));
  if (!snap) fail(`No ${P.surfaces}. Run app.mjs onboard first.`);
  const nowItems = readItems(treeReader(ROOT), { configName: cfg.appConfig });
  const recorded = Object.fromEntries(Object.entries(snap.items).map(([k, v]) => [k, v.value]));
  const open = listChanges(cfg).filter(({ st }) => !finished(st));
  const diff = diffItems(recorded, nowItems.items).filter(declarable);
  const ledger = ledgerFrom(join(ROOT, P.archive));
  const gone = ledger.filter((t) => !existsSync(join(ROOT, t.file))).map((t) => `${testKey(t.file, t.name)} (${t.change} ${t.scenario}): the file is gone`);
  const reg = regression ? [...runTests(ROOT, ledger.map((t) => ({ key: testKey(t.file, t.name), file: t.file, name: t.name })))].filter(([, r]) => r.verdict !== 'PASS').map(([k, r]) => `${k}: ${r.verdict}${r.note ? ` (${r.note})` : ''}`) : null;
  const stale = open.filter(({ st }) => Date.now() - Date.parse(st.updatedAt) > 14 * 864e5).map(({ id, st }) => `${id} (${st.stage}, last touched ${st.updatedAt.slice(0, 10)})`);
  return {
    surfacesChangedOutsideArchive: diff.map((d) => `${d.op} ${d.key}`),
    note: diff.length ? `Open changes on their own branches explain some of these: ${open.map((c) => c.id).join(', ') || 'none open'}. Anything else changed outside the kit.` : undefined,
    ledgerTestsGone: gone,
    regression: reg === null ? `not run (${ledger.length} ledgered tests; --regression runs them)` : reg.length ? reg : `all ${ledger.length} pass`,
    securityBaseline: existsSync(join(ROOT, P.securityBaseline)) ? undefined : `missing: app.mjs onboard records it when shopify app security check can run`,
    staleChanges: stale,
    configProblems: nowItems.problems,
  };
}

// ── Self-test ──

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), got, want]);
  eq('surfaceMismatch', surfaceMismatch([{ op: '+', key: 'scope:read_orders' }, { op: '+', key: 'webhook:orders/create' }], [{ op: '+', key: 'scope:read_orders' }, { op: '~', key: 'dependency:react' }, { op: '+', key: 'dependency:zod' }]),
    { undeclared: ['+ dependency:zod'], unhappened: ['+ webhook:orders/create'] });
  eq('surfaceMismatch none', surfaceMismatch('none', [{ op: '~', key: 'model:Session' }]), { undeclared: ['~ model:Session'], unhappened: [] });
  eq('build output in any extension folder isn\'t app code; the extension\'s source is',
    ['extensions/gift/dist/gift.js', 'checkout/ab-ship/dist/ab-ship.js', 'checkout/ab-ship/src/index.tsx', 'app/routes/app.tsx'].map(isAppCode), [false, false, true, true]);
  const newExt = [{ op: '+', key: 'extension:ab', to: 'ui_extension in extensions/ab' }, { op: '+', key: 'extension-api:ab', to: '2026-07' }, { op: '+', key: 'dependency:extensions/ab:preact' },
    { op: '+', key: 'capability:ab/api_access' }, { op: '+', key: 'dependency:extensions/other:zod' }, { op: '+', key: 'extension-api:other' }];
  eq('a declared extension brings its API version and its own dependencies, not its capabilities or another\'s rows', surfaceMismatch([{ op: '+', key: 'extension:ab' }], newExt).undeclared,
    ['+ capability:ab/api_access', '+ dependency:extensions/other:zod', '+ extension-api:other']);
  eq('an implied row declared anyway still counts as happened', surfaceMismatch([{ op: '+', key: 'extension:ab' }, { op: '+', key: 'extension-api:ab' }], newExt.slice(0, 3)), { undeclared: [], unhappened: [] });
  eq('without the extension declared, its rows are undeclared', surfaceMismatch('none', newExt.slice(0, 2)).undeclared, ['+ extension:ab', '+ extension-api:ab']);
  const own = ownSurfaces({ 'scope:a': '' }, { 'scope:a': '', 'webhook:w': '1' }, { 'scope:a': '', 'webhook:w': '1', 'scope:b': '' });
  eq('a surface changed on the base branch outside the kit is drift, not this change\'s', [own.diff.map((d) => d.op + d.key), own.drift.map((d) => d.op + d.key)], [['+scope:b'], ['+webhook:w']]);
  const inherited = ownSurfaces({ 'scope:a': '', 'scope:c': '' }, { 'scope:a': '' }, { 'scope:a': '', 'scope:c': '' });
  eq('a surface an archived parent change recorded isn\'t this change\'s', [inherited.diff, inherited.drift], [[], []]);
  eq('no snapshot: everything since the base is this change\'s', ownSurfaces(null, { 'scope:a': '' }, { 'scope:b': '' }).diff.map((d) => d.op + d.key), ['-scope:a', '+scope:b']);
  eq('surface keys', ['scope:read_orders', 'model:Gift', 'dependency:extensions/x:zod', 'app-proxy', 'sope:x'].map((k) => SURFACE_KEY.test(k)), [true, true, true, true, false]);
  eq('one stage graph, two gates', [STAGES.map((s) => s.name), STAGES.filter((s) => s.gate).map((s) => s.name)], [['propose', 'build', 'verify', 'accept', 'handoff'], ['propose', 'accept']]);
  eq('types', TYPES, ['change', 'fix', 'maintain', 'ab']);
  eq('heavy surfaces need § Design', ['app-proxy', 'model:Gift', 'scope:read_orders', 'app-proxy-x', 'extension:gift'].map((k) => HEAVY.test(k)), [true, true, false, false, true]);
  eq('declared surfaces: a new scope names its scenario', declaredProblems([{ op: '+', key: 'scope:read_orders', why: 'gift', scenario: 'S9' }], [{ id: 'S1' }], 'change', 'X').length, 1);
  eq('maintenance declares a scope without a scenario', declaredProblems([{ op: '+', key: 'scope:read_orders', why: 'api bump', scenario: '' }], [], 'maintain', 'X'), []);
  eq('a test is touched by its file, its fixtures/ or __snapshots__/, not by other files next to it', [
    testTouched(['extensions/gift/tests/gift.test.js'], 'extensions/gift/tests/gift.test.js'),
    testTouched(['extensions/gift/tests/fixtures/at-threshold.json'], './extensions/gift/tests/default.test.js'),
    testTouched(['app/routes/__snapshots__/gift.test.tsx.snap'], 'app/routes/gift.test.tsx'),
    testTouched(['app/routes/gift.tsx'], 'app/routes/gift.test.tsx'),
    testTouched(['app/routes/app.css', 'app/routes/q.graphql'], 'app/routes/gift.test.tsx'),
    testTouched(['extensions/gift/src/run.js'], 'extensions/gift/tests/gift.test.js'),
  ], [true, true, true, false, false, false]);
  eq('a test named after a fixture needs that fixture touched', [
    testTouched(['extensions/gift/tests/fixtures/at-threshold.json'], 'extensions/gift/tests/default.test.js', 'Default Integration Test runs at-threshold.json'),
    testTouched(['extensions/gift/tests/fixtures/other.json', 'extensions/gift/tests/default.test.js'], 'extensions/gift/tests/default.test.js', 'Default Integration Test runs at-threshold.json'),
  ], [true, false]);
  eq('app code is what results are recorded against', ['app/routes/a.tsx', 'extensions/x/src/run.js', 'shopify.app.toml', 'package.json', 'README.md', '.gitignore', '.github/workflows/ci.yml', 'appspec/surfaces.json',
    'extensions/x/dist/x.js', '.shopify/app-security/r.json', 'package-lock.json', 'yarn.lock', 'dist/a.js'].map(isAppCode), [true, true, true, true, false, false, false, false, false, false, true, true, false]);
  eq('extensions touched, from any extension folder', extensionsTouched(['functions/fee/src/run.rs', 'readme.md'], { 'extension:fee': 'function in functions/Fee', 'extension:gift': 'function in extensions/gift' }).map((e) => e.handle), ['fee']);
  const f = (check, severity, file = 'app/x.ts') => ({ check, severity, file, fingerprint: `${check}|${file}|m` });
  eq('security: a baselined finding is known, a new high blocks', securityVerdict([f('A', 'medium'), f('B', 'high')], { fingerprints: ['A|app/x.ts|m'] }, []).blocking.map((x) => x.check), ['B']);
  eq('security: no baseline → findings in untouched files are older', securityVerdict([f('A', 'medium', 'shopify.app.toml'), f('B', 'high', 'app/new.ts')], null, ['app/new.ts']).blocking.map((x) => x.check), ['B']);
  eq('security: no baseline → a medium finding in a touched file warns, a high one blocks', [securityVerdict([f('A', 'medium', 'app/new.ts')], null, ['app/new.ts']).verdict, securityVerdict([f('A', 'high', 'app/new.ts')], null, ['app/new.ts']).verdict, securityVerdict([f('A', 'medium')], { fingerprints: [] }, []).verdict],
    ['WARN', 'FAIL', 'FAIL']);
  eq('security: an unknown severity blocks, a low one warns', [securityVerdict([f('A', 'unknown')], { fingerprints: [] }, []).verdict, securityVerdict([f('A', 'low')], { fingerprints: [] }, []).verdict], ['FAIL', 'WARN']);
  const steps = (keys, ext = {}, server = false) => deploySteps({ keys, ext, server, configs: ['shopify.app.toml', 'shopify.app.prod.toml'], appConfig: 'shopify.app.toml' }).join('\n');
  eq('checklist: a PCD scope asks for protected customer data access', [/Request protected customer data access for read_customers/.test(steps(['+ scope:read_customers'])), /protected customer data/.test(steps(['+ scope:read_products']))], [true, false]);
  eq('checklist: deploy names --config and the repo\'s configs', /--config <the production app's config>.*shopify\.app\.prod\.toml/.test(steps([])), true);
  eq('checklist: block targets are placed, static and admin targets aren\'t', [
    /Place the block.*banner \(purchase\.checkout\.block\.render\)/.test(steps(['+ extension:banner'], { banner: { type: 'ui_extension', targets: ['purchase.checkout.block.render'] } })),
    /Place the block/.test(steps(['+ extension:note'], { note: { type: 'ui_extension', targets: ['purchase.checkout.cart-line-item.render-after'] } })),
    /Place the block/.test(steps(['+ extension:adm'], { adm: { type: 'ui_extension', targets: ['admin.product-details.block.render'] } })),
    /admin UI extension/.test(steps(['+ extension:adm'], { adm: { type: 'ui_extension', targets: ['admin.product-details.block.render'] } })),
  ], [true, false, false, true]);
  eq('checklist: a Function is activated', /Activate the Function \(gift\)/.test(steps(['+ extension:gift'], { gift: { type: 'function', targets: ['cart.transform.run'] } })), true);
  const bump = steps(['~ extension-api:gift', '~ extension-api:banner'], { gift: { type: 'function', targets: ['cart.transform.run'] }, banner: { type: 'ui_extension', targets: ['purchase.checkout.block.render'] } });
  eq('checklist: an API bump of live extensions activates and places nothing', [/Activate|Place the block/.test(bump)], [false]);
  const newTarget = steps(['+ target:banner/purchase.checkout.block.render'], { banner: { type: 'ui_extension', targets: ['purchase.checkout.block.render', 'customer-account.order.block.render'] } });
  eq('checklist: a new target is placed, the extension\'s live one isn\'t', [/Place the block.*banner \(purchase\.checkout\.block\.render\)/.test(newTarget), /customer-account/.test(newTarget)], [true, false]);
  eq('checklist: the app server is deployed only when its code changed', [/hosting/.test(steps([], {}, true)), /hosting/.test(steps([], {}, false))], [true, false]);
  eq('the server changed: its code, its dependencies, a webhook or the app proxy; not an extension', [
    serverChanged([], ['app/routes/app._index.tsx']), serverChanged([], ['package.json']), serverChanged(['+ webhook:orders/create'], []), serverChanged(['~ app-proxy'], []),
    serverChanged(['+ extension:gift', '~ extension-api:gift'], ['extensions/gift/src/run.js', 'shopify.app.toml', 'readme.md']),
  ], [true, true, true, true, false]);
  eq('Gate 2 lists § Surfaces and § Retires changed since Gate 1', (() => {
    const md = (surf, ret) => `## Scenarios\n\n| ID | GIVEN | WHEN | THEN | Check |\n| --- | --- | --- | --- | --- |\n| S1 | a | b | c | qa: d |\n\n## Surfaces\n\n${surf}\n\n## Retires\n\n${ret}\n`;
    const st = approvedOf(md('none', 'none'));
    return [sinceGate1(st, md('none', 'none')), sinceGate1(st, md('| Change | Surface | Why | Scenario |\n| --- | --- | --- | --- |\n| + | scope:read_customers | x | S1 |', '- test: a.test.js › old: renamed'))];
  })(), [[], ['§ Surfaces changed: "none" → "+ scope:read_customers"', '§ Retires changed: "none" → "test: a.test.js › old"']]);
  eq('Git Bash\'s rewrite of free text is undone', ['C:/Program Files/Git/app-change', 'C:/Program Files/Git/code-review: no findings', 'D:/tools/PortableGit/Git/x', 'C:/Program Files/Git/', 'gift line says Free', 'C:/Users/me/git/notes'].map((x) => unMsysFrom(x, null)),
    ['/app-change', '/code-review: no findings', '/x', '/', 'gift line says Free', 'C:/Users/me/git/notes']);
  eq('Git Bash\'s root from cygpath covers a Scoop install', ['C:/Users/me/scoop/apps/git/current/app-change', 'C:/Users/me/scoop/apps/git/currentx', 'C:/Program Files/Git/x'].map((x) => unMsysFrom(x, 'C:/Users/me/scoop/apps/git/current')),
    ['/app-change', 'C:/Users/me/scoop/apps/git/currentx', 'C:/Program Files/Git/x']);
  eq('a flag\'s value may start with --', [parseArgs(['qa-row', 'X', '--measured', '--gap: 16px', '--how', 'probe']).flags, parseArgs(['--reason', '--test']).flags],
    [{ measured: '--gap: 16px', how: 'probe' }, { reason: true, test: true }]);
  eq('hashes ignore line endings', [sha('a\r\nb\r\n') === sha('a\nb\n'), sha('a\nb') === sha('a\nc')], [true, false]);
  eq('cmd.exe refuses its own syntax as a failed run, not a crash', [cmdExeProblem(['app', 'function', 'run', '--input', 'C:/a & b/in.json']) !== null, cmdExeProblem(['app', 'info', '--json', '--path', 'C:/apps/gift']), /Refusing/.test(cmdExeProblem(['50%']) || '')], [true, null, true]);
  eq('the proposal template holds each type\'s sections', TYPES.map((t) => ['## Scenarios', '## Reproduce', '## Gate', '## Sunset'].filter((h) => proposalTemplate('X-1', t).includes(`\n${h}\n`))),
    [['## Scenarios'], ['## Scenarios', '## Reproduce'], ['## Scenarios'], ['## Scenarios', '## Gate', '## Sunset']]);
  eq('table cells', cells('| a | b \\| c | |'), ['a', 'b | c', '']);
  const pkgDir = mkdtempSync(join(tmpdir(), 'app-kit-selftest-'));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ scripts: {
    build: 'react-router build', prebuild: 'prisma migrate deploy', lint: 'eslint .', check: 'npm run deploy', deploy: 'x', ship: 'shopify app deploy --force',
    exe: 'shopify.cmd app execute --store client.myshopify.com', mig: 'prisma migrate dev',
    polaris: 'eslint --plugin @shopify/eslint-plugin . && tsc -p @shopify/polaris-types', notes: 'node scripts/release-notes.js --publish-dir dist',
    npx: 'npx @shopify/cli app info', dlx: 'pnpm dlx shopify version',
  } }));
  eq('libraries and the words release or publish aren\'t the CLI', [unsafeCommand(pkgDir, 'npm run polaris'), unsafeCommand(pkgDir, 'npm run notes')], [null, null]);
  eq('the CLI through npx or dlx is', [Boolean(unsafeCommand(pkgDir, 'npm run npx')), Boolean(unsafeCommand(pkgDir, 'npm run dlx'))], [true, true]);
  eq('a verify command is read through its pre-script', Boolean(unsafeCommand(pkgDir, 'npm run build')), true);
  eq('a verify command is read through the scripts it runs', Boolean(unsafeCommand(pkgDir, 'npm run check')), true);
  eq('a plain verify command is safe', unsafeCommand(pkgDir, 'npm run lint'), null);
  eq('verify reads scripts the way the guard does', ['npm --prefix . run ship', 'node --run ship', 'npx npm-run-all ship', 'pnpm --dir . ship', 'npm run exe', 'npm run mig']
    .map((c) => Boolean(unsafeCommand(pkgDir, c))), [true, true, true, true, true, true]);
  eq('"deploy" in a file or folder name isn\'t a deploy', ['node scripts/deploy-check.js', 'eslint . --ignore-pattern deploy/', 'firebase deploy --only hosting', 'bash scripts/deploy.sh', 'npm run deploy:prod']
    .map((c) => Boolean(unsafeCommand(pkgDir, c))), [false, false, true, true, true]);
  eq('a failing template test without an instruction baseline names the fix', /UPDATE_INSTRUCTION_BASELINE=1/.test(baselineHint('No baseline found for at-threshold.json')) && baselineHint('expected 1') === 'expected 1', true);
  // The ledger from archive folders: bound tests in, later retires out, in archive order.
  const arch = join(pkgDir, 'archive');
  const archived = (dir, id, at, scen, retires = 'none') => { mkdirSync(join(arch, dir), { recursive: true }); writeFileSync(join(arch, dir, 'change.json'), JSON.stringify({ id, archivedAt: at }));
    writeFileSync(join(arch, dir, 'proposal.md'), `## Scenarios\n\n| ID | GIVEN | WHEN | THEN | Check |\n| --- | --- | --- | --- | --- |\n${scen}\n\n## Retires\n\n${retires}\n`); };
  archived('2026-11-01-B-1', 'B-1', '2026-11-01T09:00:00Z', '| S1 | a | b | c | test: t.test.js › one |\n| S2 | a | b | c | qa: x |');
  archived('2026-11-01-A-1', 'A-1', '2026-11-01T10:00:00Z', '| S1 | a | b | c | test: t.test.js › two |', '- test: t.test.js › one: renamed to two');
  archived('2026-11-02-C-1', 'C-1', '2026-11-02T09:00:00Z', '| S3 | a | b | c | test: t.test.js › two |');
  eq('the ledger is read from the archive, in archive order', ledgerFrom(arch), [{ file: 't.test.js', name: 'two', change: 'C-1', scenario: 'S3' }]);
  eq('no archive, no ledger', ledgerFrom(join(pkgDir, 'none')), []);
  rmSync(pkgDir, { recursive: true, force: true });
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  print(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

// ── Verbs ──
const { _: [verb, rawId, ...rest], flags } = parseArgs(process.argv.slice(2));
if (process.argv.includes('--selftest')) selftest();
for (const f of TEXT_FLAGS) if (typeof flags[f] === 'string') flags[f] = freeText(flags[f]);

const needsConfig = !['detect', 'optout', '--help', 'help', undefined].includes(verb);
const cfg = needsConfig ? readConfig() : readConfig({ required: false });

/** An open change at the stage a verb needs. */
function atStage(id, ...stages) {
  const st = readChange(cfg, id);
  if (!stages.includes(st.stage)) fail(`That runs in the ${stages.join(' or ')} stage (${id} is at ${st.stage}).`);
  return st;
}

switch (verb) {
  case 'detect': print(detect()); break;

  case 'optout': {
    // The Shopify plugin reports prompts and code to shopify.dev unless this file exists (the theme kit's setup does the same).
    const p = WIN ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shopify-ai-toolkit', 'opt-out') : join(homedir(), '.config', 'shopify-ai-toolkit', 'opt-out');
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, '');
    print(`Shopify plugin telemetry opt-out file: ${p}`);
    break;
  }
  case 'onboard': print(onboard(cfg)); break;

  case 'list': {
    const all = listChanges(cfg);
    const open = all.filter(({ st }) => !finished(st));
    if (!open.length) print('No open changes. Start one with /app-change, /app-fix, /app-maintain or /app-ab.');
    for (const { id, st } of open) print(`${id}\t${typeOf(st)}${st.test ? ' (test run)' : ''}\t${st.stage}\t${st.updatedAt.slice(0, 10)}\t${st.owner?.name || ''}\t${st.branch}`);
    const abandoned = all.filter(({ st }) => st.stage === 'abandoned').map(({ id }) => id);
    if (abandoned.length) print(`Abandoned (not open; start <ID> --type … restarts one): ${abandoned.join(', ')}`);
    break;
  }

  case 'start': {
    const id = normId(rawId);
    const type = typeof flags.type === 'string' ? oneOf(...TYPES)(flags.type) : fail(`Name the type: --type ${TYPES.join('|')}`);
    const existing = readChange(cfg, id, { required: false });
    if (existing && existing.stage !== 'abandoned') { print(summaryLines(cfg, id, existing)); break; }
    if (!existsSync(join(ROOT, specPaths(cfg).surfaces))) {
      fail(`${specPaths(cfg).surfaces} isn't on this branch. Not onboarded yet: run /app-onboard. Onboarded on a branch that isn't merged yet: merge that PR, or cut this change's branch from the onboarding branch.`);
    }
    const st0 = { test: Boolean(flags.test) };
    const want = branchFor(cfg, id, st0);
    const branch = currentBranch();
    if (protectedBranches(cfg).some((p) => p.toLowerCase() === branch.toLowerCase())) {
      fail(`You're on ${branch}, which is protected. Create the change branch first:\n  git fetch origin\n  git switch -c ${want} --no-track origin/${cfg.baseBranch}`);
    }
    if (branch !== want) fail(`Check out the change branch first (expected ${want}, on ${branch}):\n  git switch -c ${want} --no-track origin/${cfg.baseBranch}   (or git switch ${want} if it exists)`);
    const dir = join(ROOT, changeDir(cfg, id));
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'proposal.md'))) writeFileSync(join(dir, 'proposal.md'), proposalTemplate(id, type));
    else if (TYPE_SECTIONS[type]) {
      // A restart under another type keeps the old proposal; it still needs this type's sections.
      const md = readFileSync(join(dir, 'proposal.md'), 'utf8');
      const extra = readFileSync(join(KIT_DIR, 'templates', TYPE_SECTIONS[type]), 'utf8').trim();
      const lines = md.split(/\r?\n/).map((l) => l.trim());
      if (!lines.includes(extra.match(/^## .+$/m)[0]) && lines.includes('## Scenarios')) writeFileSync(join(dir, 'proposal.md'), md.replace(/^## Scenarios\s*$/m, `${extra}\n\n## Scenarios`));
    }
    const st = {
      schemaVersion: 2, kitVersion: KIT_VERSION, id, type, title: typeof flags.title === 'string' ? flags.title : '', tickets: /^[A-Z][A-Z0-9]+-\d+$/.test(id) ? [id] : [],
      createdAt: now(), owner: owner(), stage: STAGES[0].name, gates: {}, test: st0.test,
      branch, base: effectiveBase({}, cfg) || head(), history: [{ at: now(), event: 'start' }], qa: { rows: {} }, reviews: {}, mutations: [],
    };
    // A restart keeps the abandoned attempt's documents (rewrite what no longer holds) and a pointer to why it stopped.
    if (existing) st.restartedFrom = { type: typeOf(existing), abandonedAt: existing.updatedAt, reason: (existing.history || []).filter((e) => e.event === 'abandon').pop()?.reason || '' };
    writeChange(cfg, id, st);
    print(summaryLines(cfg, id, st));
    if (existing) print(`Restarted after it was abandoned ("${st.restartedFrom.reason}"). The documents in ${changeDir(cfg, id)}/ are the old attempt's: rewrite what no longer holds.`);
    break;
  }

  case 'status': {
    const id = normId(rawId);
    const st = readChange(cfg, id, { required: false });
    if (st) { print(flags.json ? { ...st, diffBase: effectiveBase(st, cfg) } : summaryLines(cfg, id, st)); break; }
    const old = archivedChange(cfg, id);
    if (old?.st.stage === 'handoff') { print(`${id} moved to ${old.to}, but the handoff didn't record it as done: run node .claude/kit/app.mjs handoff ${id} again.`); break; }
    if (old) {
      const next = archivedNext(cfg, id, old.st, old.to);
      print(flags.json ? { ...old.st, archivedTo: old.to, next } : [`${id} is archived (${old.to}, ${typeOf(old.st)}, done ${String(old.st.archivedAt || '').slice(0, 10)}).`,
        next.length > 1 ? `Still to do:\n${next.map((n) => `- ${n}`).join('\n')}` : `Nothing left for the kit: the dev opens the PR from ${old.to}/handoff.md and deploys.`,
        'A reopened ticket is a new change under the same ID: ask the dev first.'].join('\n'));
      break;
    }
    print(`${id} not started. Create its branch (git fetch origin, then git switch -c ${branchFor(cfg, id, { test: Boolean(flags.test) })} --no-track origin/${cfg.baseBranch}), then: node .claude/kit/app.mjs start ${id} --type change|fix|maintain|ab`);
    break;
  }

  case 'gate': {
    const id = normId(rawId);
    const st = atStage(id, 'propose', 'accept');
    if (st.stage === 'accept') { print(gateView(cfg, id, st)); break; }
    // Gate 1 is asked only once the proposal is complete: the problems come first.
    const problems = proposeProblems(cfg, id, st);
    print({ ok: !problems.length, problems, ...gateView(cfg, id, st) });
    if (problems.length) process.exit(1);
    break;
  }

  case 'surfaces': {
    const id = normId(rawId);
    const st = readChange(cfg, id);
    const a = actualSurfaces(cfg, st);
    const decl = declaredSurfaces(proposalOf(cfg, id));
    print({
      measuredFrom: a.from, problems: a.problems,
      changes: a.diff.filter(declarable).map((d) => ({ change: `${d.op} ${d.key}`, attention: attentionFor(d) || undefined })),
      declared: decl === 'none' ? 'none' : decl.map((d) => `${d.op} ${d.key}`),
      ...surfaceMismatch(decl, a.diff),
      keys: 'scope:<s> optional-scope:<s> webhook:<topic> compliance-webhook:<topic> webhooks:api_version app-proxy config:<key> metaobject:<ns.type> metafield:<owner.ns.key> extension:<handle> extension-api:<handle> target:<handle>/<target> capability:<handle>/<name> model:<Name> enum:<Name> db:provider dependency:[<dir>:]<name>',
    });
    break;
  }

  case 'done': {
    const id = normId(rawId);
    const stage = rest[0];
    if (rest.length > 1) fail(`Unexpected words after the stage: "${rest.slice(1).join(' ')}". Quote the --answer text.`);
    const st = readChange(cfg, id);
    if (finished(st)) fail(`${id} is ${st.stage}.`);
    if (stage !== st.stage) fail(`The current stage is "${st.stage}", not "${stage}". Finish "${st.stage}" first, or use "back" to reopen an earlier stage.`);
    const def = STAGES[stageIndex(stage)];
    const answer = typeof flags.answer === 'string' ? flags.answer.trim() : '';
    if (def.gate && !answer) fail(`"${stage}" is a gate (${def.gate}). Ask the dev, then record their words: --answer "..."`);
    const missing = (EXIT_CHECKS[stage]?.(cfg, id, st) || []).filter(Boolean);
    if (missing.length) {
      st.history.push({ at: now(), event: 'refused', stage, missing: missing.map((x) => x.slice(0, 160)) });
      writeChange(cfg, id, st);
      fail(`"${stage}" isn't finished:\n${missing.map((x) => `- ${x}`).join('\n')}`);
    }
    if (def.gate) st.gates[stage] = { answer, at: now(), by: owner().name };
    // What Gate 1 approved: Gate 2 lists what changed since, instead of refusing it.
    if (stage === 'propose') Object.assign(st, approvedOf(proposalOf(cfg, id)));
    st.history.push({ at: now(), event: 'done', stage, answer: answer || undefined, note: flags.note || undefined });
    st.stage = STAGES[stageIndex(stage) + 1].name;
    writeChange(cfg, id, st);
    print(summaryLines(cfg, id, st));
    break;
  }

  case 'back': {
    const id = normId(rawId);
    const target = rest[0];
    const st = readChange(cfg, id);
    if (finished(st)) fail(`${id} is ${st.stage}; start a new change instead.`);
    const to = stageIndex(target);
    if (to === -1) fail(`Unknown stage "${target}". Stages: ${STAGES.map((s) => s.name).join(', ')}`);
    if (to >= stageIndex(st.stage)) fail(`"${target}" isn't earlier than the current stage "${st.stage}".`);
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Say why: --reason "..."');
    for (const s of STAGES.slice(to)) delete st.gates[s.name];
    // A result from before the code or the scenarios could change again doesn't count once the change goes back.
    if (to < stageIndex('verify')) delete st.verify;
    st.history.push({ at: now(), event: 'back', from: st.stage, to: target, reason: flags.reason.trim() });
    st.stage = target;
    writeChange(cfg, id, st);
    print(summaryLines(cfg, id, st));
    break;
  }

  case 'verify': {
    const id = normId(rawId);
    const st = atStage(id, 'verify');
    const dirty = dirtyCode(cfg);
    if (dirty.length) fail(`Commit the work first; results are recorded against committed code (uncommitted: ${dirty.slice(0, 5).join(', ')}).`);
    const v = runVerify(cfg, id, st, { skipTests: Boolean(flags['skip-tests']) });
    st.verify = v;
    st.history.push({ at: now(), event: 'verify', ok: v.ok, digest: v.digest });
    writeChange(cfg, id, st);
    print({
      ok: v.ok, digest: v.digest, checks: v.checks.map((c) => `${c.verdict.padEnd(4)} ${c.name}${c.verdict !== 'PASS' && c.note ? `: ${c.note.slice(0, 300)}` : ''}`),
      openQa: openQa(cfg, st, scenariosFrom(proposalOf(cfg, id))),
      reviews: { code: reviewProblem(cfg, st, 'code', v.digest)?.replace('<ID>', id) || 'recorded on this code', security: reviewProblem(cfg, st, 'security', v.digest)?.replace('<ID>', id) || 'recorded on this code' },
      changedSinceGate1: v.changedSinceGate1, attention: v.checks.find((c) => c.name === 'surfaces')?.attention,
    });
    if (!v.ok) process.exit(1);
    break;
  }

  case 'review': {
    const id = normId(rawId);
    const kind = rest[0];
    if (!['code', 'security'].includes(kind) || typeof flags.found !== 'string' || !flags.found.trim()) fail('Usage: review <ID> code|security --found "<what the review found and what was done about it>"');
    const st = atStage(id, 'build', 'verify');
    const dirty = dirtyCode(cfg);
    if (dirty.length) fail(`Commit first: a review is recorded against committed code (uncommitted: ${dirty.slice(0, 5).join(', ')}).`);
    const digest = codeDigest(cfg);
    st.reviews = { ...st.reviews, [kind]: { found: flags.found.trim().replace(/\r?\n/g, ' '), digest, at: now(), stage: st.stage } };
    st.history.push({ at: now(), event: 'review', kind, digest });
    writeChange(cfg, id, st);
    print(`${kind} review recorded on code ${digest}. A later code change needs it again.`);
    break;
  }

  case 'qa-row': {
    const id = normId(rawId);
    const st = atStage(id, 'verify');
    const s = findScenario(scenariosFrom(proposalOf(cfg, id)), rest[0]);
    if (!s || s.check.kind !== 'qa') fail(`Usage: qa-row <ID> <scenario> --measured T --how T --verdict PASS|FAIL|BLOCKED, for a qa: scenario of proposal.md § Scenarios (got "${rest[0] || ''}").`);
    if (!['PASS', 'FAIL', 'BLOCKED'].includes(flags.verdict)) fail('--verdict is one of: PASS, FAIL, BLOCKED');
    // A verdict is only as good as what was observed: the value seen, and where and how.
    const text = (f) => (typeof flags[f] === 'string' ? flags[f].trim().replace(/\r?\n/g, ' ') : '');
    if (flags.verdict !== 'BLOCKED' && (!text('measured') || !text('how'))) fail(`A ${flags.verdict} needs --measured "<what you observed: the text, the value, the element>" and --how "<where and how: the store page, viewport, tool>", in the same call.`);
    // The code a verdict was measured on: a row measured before a fix doesn't count after it.
    st.qa = { rows: { ...st.qa?.rows, [s.id]: { verdict: flags.verdict, measured: text('measured'), how: text('how'), digest: codeDigest(cfg), at: now() } } };
    writeChange(cfg, id, st);
    print(`${s.id}: ${flags.verdict} on code ${codeDigest(cfg)} (expected: ${s.check.expected})`);
    break;
  }

  case 'waive': {
    const id = normId(rawId);
    const st = atStage(id, 'verify');
    const s = findScenario(scenariosFrom(proposalOf(cfg, id)), rest[0]);
    if (!s || s.check.kind !== 'qa' || typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Usage: waive <ID> <scenario> --reason "why it can\'t be measured, and who checks it instead", for a qa: scenario');
    st.qa = { rows: { ...st.qa?.rows, [s.id]: { verdict: 'WAIVED', reason: flags.reason.trim(), digest: codeDigest(cfg), at: now(), by: owner().name } } };
    st.history.push({ at: now(), event: 'waive', row: s.id, reason: flags.reason.trim() });
    writeChange(cfg, id, st);
    print(`${s.id} waived: ${flags.reason.trim()}`);
    break;
  }

  case 'handoff': {
    const id = normId(rawId);
    const st = readChange(cfg, id, { required: false });
    if (st) { print(runHandoff(cfg, id, st)); break; }
    const old = archivedChange(cfg, id);
    if (old?.st.stage === 'handoff') { print(finishArchive(cfg, id, old.st, old.to)); break; }
    if (old) { print({ archived: old.to, next: archivedNext(cfg, id, old.st, old.to) }); break; }
    fail(`No change "${id}". Start one with node .claude/kit/app.mjs start ${id} --type change|fix|maintain|ab`);
    break;
  }

  case 'drift': print(drift(cfg, { regression: Boolean(flags.regression) })); break;

  case 'abandon': {
    const id = normId(rawId);
    const st = readChange(cfg, id);
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Say why: --reason "..."');
    if (finished(st)) fail(`${id} is already ${st.stage}.`);
    // An abandoned run is where the kit most often got in the way: its signals are shown, so a kit cause gets a note.
    const signals = retroSignals(st);
    st.history.push({ at: now(), event: 'abandon', from: st.stage, reason: flags.reason.trim() });
    st.stage = 'abandoned';
    writeChange(cfg, id, st);
    const cleanup = [
      ...(st.mutations || []).map((x) => `Dev-store mutation from ${x.file} (${x.fields.join(', ')}): ask the dev whether to undo it`),
      `The change folder ${changeDir(cfg, id)}/ and branch ${st.branch} stay; deleting them is the dev's call. start ${id} --type … restarts it.`,
    ];
    print({ abandoned: id, cleanup, retro: signals, ask: `If the kit caused any of this, record it: app.mjs note ${id} "<what happened> → <what would have prevented it>" --kind <kind>.` });
    break;
  }

  case 'note': {
    const id = normId(rawId);
    const st = readChange(cfg, id, { required: false }) || archivedChange(cfg, id)?.st || fail(`No change "${id}".`);
    const live = Boolean(readChange(cfg, id, { required: false }));
    if (flags.none) {
      if (live) { st.history.push({ at: now(), event: 'note', none: true }); writeChange(cfg, id, st); }
      print('Recorded: nothing the kit caused.');
      break;
    }
    const text = rest.map(freeText).join(' ').trim();
    if (!text) fail('Usage: app.mjs note <ID> "what happened, what you expected, what would have helped" [--kind friction|mistake|kit-bug|missing|idea]');
    const kind = typeof flags.kind === 'string' ? oneOf('friction', 'mistake', 'kit-bug', 'missing', 'idea')(flags.kind) : 'friction';
    const p = join(LOGS, id, 'kit-notes.md');
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, `# ${id} · Kit notes\n\n> Problems with the kit itself, not the change: for the kit maintainer.\n\n| When | Stage | Kind | Note |\n| --- | --- | --- | --- |\n`);
    writeFileSync(p, `${readFileSync(p, 'utf8').trimEnd()}\n| ${now().slice(0, 16)} | ${st.stage} | ${kind} | ${text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |\n`);
    if (live) { st.history.push({ at: now(), event: 'note', kind }); writeChange(cfg, id, st); }
    print(`Noted in .claude/logs/${id}/kit-notes.md`);
    break;
  }

  case 'retro': {
    const id = normId(rawId);
    const st = readChange(cfg, id, { required: false }) || archivedChange(cfg, id)?.st || fail(`No change "${id}".`);
    print({ ...retroSignals(st), ask: 'For each signal, decide whether the kit caused it (a misleading instruction, a missing verb, an unclear check, a guard block on a harmless command) or the change did. Record each kit cause: app.mjs note <ID> "<what happened> → <what would have prevented it>" --kind <kind>.' });
    break;
  }

  case 'feedback': {
    // Notes say what the agent noticed; the record says what happened (loops back, refusals, guard blocks), noticed or not.
    const runs = new Map();
    for (const { id, st } of listChanges(cfg)) runs.set(id, st);
    const arch = join(ROOT, specPaths(cfg).archive);
    for (const d of existsSync(arch) ? readdirSync(arch) : []) {
      try { const st = JSON.parse(readFileSync(join(arch, d, 'change.json'), 'utf8')); if (st.id && !runs.has(st.id)) runs.set(st.id, st); } catch { /* not a change */ }
    }
    const noted = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'kit-notes.md'))) : [];
    const parts = [];
    for (const k of [...new Set([...runs.keys(), ...noted])].sort()) {
      const st = runs.get(k);
      const s = st ? retroSignals(st) : null;
      const signals = s ? [...s.loopsBack.map((x) => `- back: ${x}`), ...s.refusedStages.map((x) => `- refused: ${x}`), ...s.guardBlocks.map((x) => `- guard: ${x}`)] : [];
      const notes = noted.includes(k) ? readFileSync(join(LOGS, k, 'kit-notes.md'), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('|')) : [];
      if (!signals.length && !notes.length) continue;
      parts.push([`## ${k}${st ? ` (${typeOf(st)}, ${st.stage}, started with kit ${st.kitVersion || '?'})` : ''}`, '', ...(signals.length ? ['Signals from the record:', ...signals, ''] : []), ...notes].join('\n').trimEnd());
    }
    mkdirSync(LOGS, { recursive: true });
    writeFileSync(join(LOGS, 'kit-feedback.md'), `# App kit feedback · ${now().slice(0, 10)} · kit ${KIT_VERSION}\n\n${parts.join('\n\n')}\n`);
    print(`${parts.length} changes with signals or notes → .claude/logs/kit-feedback.md (kit ${KIT_VERSION})`);
    break;
  }

  default:
    print(HELP);
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
