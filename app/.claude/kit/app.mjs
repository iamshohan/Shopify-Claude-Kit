#!/usr/bin/env node
// The app kit's state machine: changes, stages, gates, the checks a stage must pass, verify, handoff and drift.
// Usage: node .claude/kit/app.mjs <verb> [<ID>] ...   (--help lists the verbs)
// A change is a folder in git, appspec/changes/<ID>/: proposal.md (its scenarios, surfaces and tasks) and change.json,
// written only by this script. Archive moves the folder to appspec/archive/ (the test ledger is read from there) and
// records its surfaces in appspec/surfaces.json. Kit notes and the guard's log stay local in .claude/logs/.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { print, fail, now, writeJsonAtomic, WIN, cmdExeProblem } from './core.mjs';
import {
  ROOT, KIT_DIR, LOGS, KIT_VERSION, CONFIG_REL, STAGES, TYPES, specPaths, parseArgs, readConfig, devStore, run, git, currentBranch, head,
  protectedBranches, branchFor, effectiveBase, ONBOARD_BRANCH, owner, stageIndex, finished, normId, changeDir, readChange, writeChange, listChanges, isAppCode,
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
  start <ID> --type change|fix|maintain|ab [--title "..."] [--test] [--quick]
                                         start a change on its branch (check it out first), or restart an abandoned one;
                                         --test: branch <ID>-kit-test, never pushed; --quick: a small fix with no surfaces
                                         (no outside review, precedent search or blind QA)
  status <ID> [--json]                   stage, the skill to load, gates, what's open; for an archived ID, what's left
  ticket <ID>                            read the change's Jira ticket(s) and keep them in .claude/logs/<ID>/ticket.json
                                         (gate checks § Asked's quotes and the Figma frames against it)
  precedent <ID> <words…>                search this and the sibling app repos' archived changes (same target, component,
                                         API) and record the search; hits are options, each still checked in the docs
  gate <ID>                              what the current gate shows the dev: Gate 1 at propose (exit 1 while proposal.md
                                         has problems, listed first), Gate 2 at accept
  surfaces <ID>                          what the code changes in surfaces (last archive → working tree) against § Surfaces
  done <ID> <stage> [--answer "TEXT"] [--note "TEXT"]
                                         finish the current stage; gates need --answer with the dev's words
  back <ID> <stage> --reason "TEXT"      reopen an earlier stage (it clears the gates from there on)
  verify <ID> [--skip-tests]             run every check and record the result against the current code
  review <ID> code|security|outside|blind|handoff --found "TEXT"
                                         record a review: code and security of the committed code (build, verify);
                                         outside: the outcome-checker on the proposal (propose); blind: the blind-qa
                                         agent's run (verify); handoff: the outcome-checker on the client comment (handoff)
  qa-add <ID> --source asked|figma|blind|journey|data --criterion T --expected T [--asked N]
                                         add a QA row beyond the scenarios (verify stage): Q1, Q2, …; --asked: the § Asked
                                         row it checks (figma rows need it)
  qa-row <ID> <S#|Q#> --measured T --how T --verdict PASS|FAIL|BLOCKED   (or --file rows.json for several)
                                         record a measured qa: scenario or Q row (verify stage; PASS/FAIL need both texts);
                                         --baseline: a fix's qa: row on the unfixed build, at propose
  waive <ID> <S#|Q#> --reason "TEXT" --answer "DEV'S WORDS"  accept a row that can't be measured (verify stage; the dev confirms;
                                         the handoff lists it)
  predeploy [ID]                         for the dev before deploying (read-only): the tree is clean, on the merged base,
                                         no QA or debug code in the extensions; prints the deploy command tied to the commit
  revert <ID> <file…>                    undo uncommitted edits to app files (build, verify): saves them as a patch in
                                         .claude/logs/<ID>/ first, so nothing is lost
  handoff <ID>                           update surfaces.json and the security baseline, write handoff.md, and move the
                                         change to archive/ (its bound tests join the ledger)
  drift [--regression]                   surfaces changed outside a change, ledgered tests that are gone; --regression runs
                                         every ledgered test
  abandon <ID> --reason "TEXT"           stop a change, list what to clean up, and show the retro signals
Kit feedback (problems with the kit, not the change)
  note <ID> "TEXT" [--kind friction|mistake|kit-bug|missing|idea]
  note <ID> --none                       nothing the kit caused
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
const TEXT_FLAGS = ['answer', 'note', 'measured', 'how', 'reason', 'title', 'found', 'criterion', 'expected'];

// ── Files of a change ──

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
const tpl = (file, vars) => Object.entries(vars).reduce((t, [k, v]) => t.replaceAll(`{{${k}}}`, v), readFileSync(join(KIT_DIR, 'templates', file), 'utf8'));
const typeOf = (st) => st?.type || 'change';
const TYPE_NOTE = {
  change: 'Adds or adjusts behaviour.',
  fix: 'A bug: § Reproduce names the failing test and the failure seen before the fix, and a scenario binds that test.',
  maintain: 'No behaviour change (API version, dependencies, refactor): scenarios are optional, as re-checks of what the maintenance could break; the full regression must pass.',
  ab: 'An A/B-gated extension: § Gate says what turns the variation on, § A/B test completion when and how it goes.',
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

// ── What was asked ──
// asmc ASM-924: scenarios paraphrased the AC ("two most recent" became "2 review cards"), Figma was never opened, and
// verify graded the agent's own scenarios. § Asked quotes the ticket and the frames, each tied to the scenarios that prove it.

/** Changes started before 0.5.0 (schemaVersion 2) predate § Asked, the outside review and the extra QA rows. */
const strict = (st) => (st?.schemaVersion || 2) >= 3;
// A quick fix and maintenance (no behaviour change; the regression is the proof) skip the outside review, precedent and blind QA.
const light = (st) => Boolean(st?.quick) || typeOf(st) === 'maintain';
const ticketFile = (id) => join(LOGS, id, 'ticket.json');
const ticketsOf = (id) => { try { return JSON.parse(readFileSync(ticketFile(id), 'utf8')); } catch { return null; } };
/** Lower case, one space, no markdown emphasis or typographic quotes: a quote copied from Jira matches its source. */
const plain = (s) => String(s || '').toLowerCase().replace(/[*_`]/g, '').replace(/[‘’]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, ' ').trim();
const ticketText = (tickets) => plain((tickets || []).map((t) => [t.summary, t.description, ...Object.values(t.fields || {}), ...(Array.isArray(t.comments) ? t.comments.map((c) => c.text) : [])].join('\n')).join('\n'));
/** Figma node ids a link names (node-id=12-34 → 12:34), or [] for a file link. */
// Only the node-id parameter itself: a prototype link's starting-point-node-id isn't a frame to build.
export const figmaNodes = (url) => [...String(url).matchAll(/[?&]node-id=(\d+)(?:-|:|%3A)(\d+)/gi)].map((m) => `${m[1]}:${m[2]}`);

/** Rows of § Asked: [{ n, asked, scenarios: ['S1'], outOfScope }]. */
export function askedFrom(md) {
  return tableUnder(md, '## Asked').filter((r) => r.asked || r['asked (quoted)'])
    .map((r, i) => {
      const asked = (r['asked (quoted)'] || r.asked || '').trim();
      const sc = r.scenarios || r.scenario || '';
      return { n: (r['#'] || String(i + 1)).replace(/[^\w]/g, '') || String(i + 1), asked, scenarios: [...sc.matchAll(/\bS\d+\b/gi)].map((m) => m[0].toUpperCase()), outOfScope: /out of scope/i.test(sc) };
    });
}
const isFigmaRow = (a) => /^[*_\s]*figma\b/i.test(a.asked);

/**
 * § Not proven yet: what the design relies on that the docs don't promise (a workaround seen working elsewhere, an
 * undocumented behaviour), each with its fallback and the scenario that proves it. asmc ASM-924 shipped data-URI icons
 * against the s-image docs with the risk buried in § Design.
 */
export function notProvenFrom(md) {
  return tableUnder(md, '## Not proven yet').filter((r) => r.claim).map((r) => ({ claim: r.claim, evidence: r.evidence || '', fallback: r.fallback || '', scenarios: [...String(r.scenario || r.scenarios || '').matchAll(/\bS\d+\b/gi)].map((m) => m[0].toUpperCase()) }));
}
// English "…" and “…”, German „…“, French «…».
const quotesIn = (s) => [...String(s).matchAll(/["“„«]\s*([^"“”„«»]{3,}?)\s*["”“»]/g)].map((m) => m[1]);

/** § Asked against the scenarios and the cached ticket: refusals only for what is missing or untrue. */
export function askedProblems(md, rows, tickets, id, designFrames = []) {
  const asked = askedFrom(md);
  if (!asked.length) return ['fill proposal.md § Asked: every acceptance criterion and deciding ticket line quoted word for word in "…", and every Figma frame the change builds, each with the scenarios that prove it'];
  const ids = new Set(rows.map((s) => s.id.toUpperCase()));
  const qa = new Set(rows.filter((s) => s.check.kind === 'qa').map((s) => s.id.toUpperCase()));
  const text = tickets ? ticketText(tickets) : null;
  const out = [];
  for (const a of asked) {
    const unknown = a.scenarios.filter((s) => !ids.has(s));
    if (unknown.length) out.push(`§ Asked #${a.n}: ${unknown.join(', ')} isn't in § Scenarios`);
    if (!a.scenarios.length && !a.outOfScope) out.push(`§ Asked #${a.n} ("${a.asked.slice(0, 60)}"): name the scenarios that prove it, or write "out of scope" and say why under § Out of scope`);
    if (isFigmaRow(a)) {
      if (!a.outOfScope && !a.scenarios.some((s) => qa.has(s))) out.push(`§ Asked #${a.n} is a Figma frame: tie it to a qa: scenario, which verify measures against the frame`);
      continue;
    }
    if (/^[*_\s]*dev\b/i.test(a.asked)) continue;
    const quotes = quotesIn(a.asked);
    if (!quotes.length) out.push(`§ Asked #${a.n}: quote the ticket word for word in "…" (a paraphrase is how "two most recent" became "2 review cards"), or start the row with Figma: or Dev:`);
    else if (text) for (const q of quotes) if (!text.includes(plain(q))) out.push(`§ Asked #${a.n}: "${q.slice(0, 80)}" isn't in the ticket word for word (.claude/logs/${id}/ticket.json): copy it exactly`);
  }
  // Every frame the ticket links, and every frame the design-extractor read, is either built (a Figma row names its
  // node) or said to be out of scope.
  const outOfScope = sectionLines(md, '## Out of scope');
  const figmaText = plain([...asked.map((a) => a.asked), ...outOfScope].join(' '));
  const listed = (n) => new RegExp(`(^|[^\\d])${n.split(':')[0]}[:-]${n.split(':')[1]}([^\\d]|$)`).test(figmaText);
  for (const link of (tickets || []).flatMap((t) => t.figmaLinks || [])) {
    const nodes = figmaNodes(link);
    if (nodes.length) { for (const n of nodes) if (!listed(n)) out.push(`the ticket links Figma node ${n}: add a § Asked row "Figma: <frame> · ${n} · <width>px" with its qa: scenarios, or name the node under § Out of scope`); }
    else if (!asked.some(isFigmaRow) && !/figma/.test(plain(outOfScope.join(' ')))) out.push(`the ticket links a Figma file (${link.slice(0, 80)}): add a § Asked row per frame the change builds ("Figma: <frame> · <node> · <width>px")`);
  }
  for (const f of designFrames || []) if (f.node && !listed(f.node)) out.push(`design-checks.json has frame ${f.node} (${[f.variation, f.viewport, f.width && `${f.width}px`].filter(Boolean).join(' · ')}): add a § Asked Figma row for it, or name it under § Out of scope (each variation's frame is its own design)`);
  // Each acceptance criterion the ticket states is quoted in a row, or named out of scope: a quote can be true and an AC
  // line still missing.
  const words = (s) => new Set(plain(s).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(' ').filter((w) => w.length > 2));
  const texts = [...asked.map((a) => a.asked), outOfScope.join(' ')].map(words);
  for (const ac of acLines(tickets)) {
    const w = [...words(ac)];
    if (w.length < 3) continue;
    const best = Math.max(0, ...texts.map((t) => w.filter((x) => t.has(x)).length / w.length));
    if (best < 0.6) out.push(`the ticket's acceptance criterion "${ac.slice(0, 90)}" has no § Asked row: quote it with the scenarios that prove it, or name it under § Out of scope with why`);
  }
  return out;
}

/** The ticket's acceptance criteria: list lines under an "Acceptance criteria" / "AC" heading, or in a field so named. */
export function acLines(tickets) {
  const out = [];
  const items = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^([-*•]|\d+[.)])\s+\S/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, ''));
  for (const t of tickets || []) {
    for (const [name, v] of Object.entries(t.fields || {})) if (/acceptance|akzeptanz|criteria|kriterien|^ac$/i.test(name)) out.push(...(items(v).length ? items(v) : String(v).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
    const lines = String(t.description || '').split(/\r?\n/);
    const at = lines.findIndex((l) => /^(#+\s*|\*+)?\s*(acceptance criteria|akzeptanzkriterien|AC)\b[\s:*]*$/i.test(l.trim()));
    if (at === -1) continue;
    const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l.trim()));
    out.push(...items(lines.slice(at + 1, end === -1 ? undefined : end).join('\n')));
  }
  return [...new Set(out)];
}

/**
 * Words that carry a criterion's meaning (counts, "most recent", where a link lands, a new tab) and so must survive into
 * the scenarios that prove it: "the two most recent" became "2 review cards" in ASM-924.
 */
const NUMBER_WORDS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eins: '1', zwei: '2', drei: '3', vier: '4', fünf: '5' };
export function droppedWords(asked, rows) {
  const KEY = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|zwei|drei|vier|fünf|most recent|newest|latest|oldest|neueste[nr]?|first|last|top|section|anchor|new tab|neuen tab)\b/gi;
  const out = [];
  for (const a of asked.filter((x) => !isFigmaRow(x) && x.scenarios.length)) {
    const said = plain(a.scenarios.map((id) => rows.find((r) => r.id.toUpperCase() === id)).filter(Boolean).map((r) => `${r.given} ${r.when} ${r.then} ${r.checkText}`).join(' '));
    const missing = [...new Set(quotesIn(a.asked).join(' ').toLowerCase().match(KEY) || [])].filter((k) => !new RegExp(`\\b${k}\\b`).test(said) && !(NUMBER_WORDS[k] && new RegExp(`\\b${NUMBER_WORDS[k]}\\b`).test(said)));
    if (missing.length) out.push(`§ Asked #${a.n} says ${missing.map((k) => `"${k}"`).join(', ')}, which ${a.scenarios.join(', ')} ${a.scenarios.length > 1 ? "don't" : "doesn't"} carry: a scenario that drops it can pass while the criterion fails`);
  }
  return out;
}

// ── Surfaces of a change ──

const SURFACE_KEY = /^(scope|optional-scope|webhook|compliance-webhook|webhooks|app-proxy|config|metaobject|metafield|extension|extension-api|target|capability|extension-metafield|model|enum|view|type|db|dependency)(:.+)?$/;
// Surfaces whose addition or change needs proposal.md § Design. app-proxy is a key without a colon.
const HEAVY = /^(model|enum|db|app-proxy|config|webhook|compliance-webhook)(:|$)/;
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
// § Gate's key and values too: a self-fixing verify that edited them to match the code would otherwise go unseen.
const proposalDigest = (md) => sha([...scenariosFrom(md).map((s) => `${s.id} ${scenarioRecord(s)}`), ...retiresFrom(md).map(checkKey), approvedSections(md).surfaces,
  ...(sectionLines(md, '## Gate').length ? [JSON.stringify(abGateOf(md))] : [])].join('\n'));

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
  const { key, values } = abGateOf(md);
  return {
    surfaces: decl === 'none' ? 'none' : decl.map((d) => `${d.op} ${d.key}`).sort().join(', ') || 'none', retires: retiresFrom(md).map(checkKey).join(', ') || 'none',
    // § Gate's key and values, so Gate 2 lists a change to them (only A/B proposals have the section).
    ...(sectionLines(md, '## Gate').length ? { gate: key ? `${key} = ${values.join(' | ') || '?'}` : 'none' } : {}),
  };
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
/** A qa: scenario or a Q row, as { id, expected }. */
function qaTarget(st, rows, n) {
  const key = String(n || '').toUpperCase();
  const s = rows.find((x) => x.id.toUpperCase() === key && x.check.kind === 'qa');
  if (s) return { id: s.id, expected: s.check.expected };
  const q = (st.qa?.extra || []).find((x) => x.id === key);
  return q ? { id: q.id, expected: q.expected } : null;
}

/** QA rows beyond the scenarios (qa-add): what the ticket, Figma, the blind QA agent, the journey and the data check found to measure. */
const extraRows = (st) => st.qa?.extra || [];
const QA_SOURCES = ['asked', 'figma', 'blind', 'journey', 'data'];

/** qa: scenarios and Q rows that aren't PASS (or waived) on the current code. */
function openQa(cfg, st, rows) {
  const digest = codeDigest(cfg);
  const items = [...qaScenarios(rows).map((s) => ({ id: s.id, label: `qa: ${s.check.expected}` })), ...extraRows(st).map((q) => ({ id: q.id, label: `${q.source}: ${q.criterion}` }))];
  return items.map(({ id, label }) => {
    const r = st.qa?.rows?.[id];
    if (r?.verdict === 'WAIVED') return null;
    if (!r || r.verdict !== 'PASS') return `${id} (${label.slice(0, 120)}): ${r?.verdict || 'not measured'}`;
    if (r.digest !== digest) return `${id}: measured on older code; measure it again`;
    return null;
  }).filter(Boolean);
}

/**
 * The QA a change owes beyond its own scenarios (asmc ASM-924: verify passed, then a blind human QA found 5 bugs). A UI
 * change: a blind QA run by someone who never read the proposal. Each Figma frame in § Asked: a row measured against it.
 * An A/B change: the real journey for each arm and control. A change that fetches data: the data checked against its source.
 */
export function owedQa({ rows, extra, reviews, asked, values, ab, fetches, quick }) {
  const has = (src, pred = () => true) => extra.some((q) => q.source === src && pred(q));
  const ui = rows.some((s) => s.check.kind === 'qa');
  return [
    ui && !quick && !reviews?.blind && 'run the blind-qa agent (it gets the ticket, design.md and the dev store, never the proposal), add each criterion it reports with qa-add --source blind, measure them, and record the run: app.mjs review <ID> blind --found "…"',
    ui && !quick && reviews?.blind && !has('blind') && 'the blind QA run is recorded but none of its criteria are: add each with qa-add --source blind',
    ...asked.filter(isFigmaRow).filter((a) => !a.outOfScope && !has('figma', (q) => String(q.asked) === a.n))
      .map((a) => `§ Asked #${a.n} (${a.asked.slice(0, 70)}): measure the build against that frame at its width: qa-add --source figma --asked ${a.n} (sizes, colours, spacing, assets from design.md)`),
    ab && ui && !quick && extra.filter((q) => q.source === 'journey').length < values.length + 1
      && `an A/B change runs the real journey per arm (${values.map((v) => `"${v}"`).join(', ')}) and control: through each add-to-cart path the storefront has, the trigger, checkout. qa-add --source journey, one row each (${extra.filter((q) => q.source === 'journey').length} of ${values.length + 1} so far)`,
    fetches && !quick && !has('data') && 'the change fetches data (network_access): check what it shows against the source itself (the newest items really are the newest, the counts match): qa-add --source data',
  ].filter(Boolean);
}
function owedQaOf(cfg, id, st, md) {
  const decl = declaredSurfaces(md);
  return owedQa({
    rows: scenariosFrom(md), extra: extraRows(st), reviews: st.reviews, asked: askedFrom(md), values: abGateOf(md).values, ab: typeOf(st) === 'ab', quick: light(st),
    // Data fetched by a checkout extension, or served through the app proxy.
    fetches: decl !== 'none' && decl.some((d) => (d.op === '+' && /^capability:[^/]+\/network_access$/.test(d.key)) || (d.op !== '-' && d.key === 'app-proxy')),
  });
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

/**
 * A fix's bound tests, run on the unfixed code (app code is still closed at propose): at least one must fail by itself,
 * or nothing shows the bug was reproduced, and verify's later PASS proves nothing. qa:/manual repros aren't run here.
 */
function reproProblems(rows) {
  const tests = rows.filter((s) => s.check.kind === 'test').map((s) => ({ id: s.id, key: testKey(s.check.file, s.check.name), file: s.check.file, name: s.check.name }));
  if (!tests.length) return [];
  const results = runTests(ROOT, tests);
  // A new Function fixture fails on its missing instruction baseline, whatever the code does: not a reproduction.
  const reproduces = (r) => r?.ran && r.verdict === 'FAIL' && !/baseline/i.test(r.note || '');
  if (tests.some((t) => reproduces(results.get(t.key)))) return [];
  return [`fix: no bound test fails on the unfixed code (${tests.map((t) => `${t.id}: ${results.get(t.key)?.verdict || 'NOT RUN'}`).join(', ')}), so none reproduces the bug. Bind a scenario to a test that fails now, with the failure § Reproduce describes`];
}

/**
 * An exit finding that doesn't stop the stage: how the proposal is worded (a phrase, a name it should mention), not a
 * missing fact. done and gate list it under "Worth a look"; a refusal needs something unrecorded or untrue.
 */
const warn = (msg) => (msg ? { warn: msg } : false);
const refusals = (found) => found.filter((m) => typeof m === 'string');
const warningsOf = (found) => found.filter((m) => m?.warn).map((m) => m.warn);

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
    // What the agent decided without asking is reviewed at Gate 1 (it asks only the dev's real calls). A proposal started
    // before the section existed has no heading: a kit update mustn't fail a change already approved (asmc first run).
    md.split(/\r?\n/).some((l) => l.trim() === '## Decided for you') && !filled(cfg, id, st, '## Decided for you')
      && 'fill proposal.md § Decided for you: one line per decision you took without asking (what, and why), or "none"',
    attention.length && saysNone(attention) && flagged.length && warn(`proposal.md § Needs your attention can't be "none": list what each of these declared surfaces means for the merchant: ${flagged.map((d) => `${d.op} ${d.key} (${attentionFor(d)})`).join(' · ')}`),
    ...declaredProblems(decl, rows, type, id),
    // A data model, a new webhook, extension, app proxy or config change: the decisions and the deploy order are approved at Gate 1 too.
    isHeavy(decl) && (!design.length || saysNone(design)) && `fill proposal.md § Design: § Surfaces declares ${decl.filter((d) => d.op !== '-' && HEAVY.test(d.key)).map((d) => d.key).join(', ')}. Say the decisions, the data model and migration, which authenticate.* each new route uses, and the deploy order`,
    type === 'fix' && !filled(cfg, id, st, '## Reproduce') && 'fill proposal.md § Reproduce: the failing test (or the steps) and the failure seen before the fix',
    // Only before the first Gate 1 (after it the fix may be built, so its test passes), and once the rest is in order.
    ...(type === 'fix' && !st.approved && !scenarioProblems(rows).length ? reproProblems(rows) : []),
    type === 'ab' && !filled(cfg, id, st, '## Gate') && 'fill proposal.md § Gate: the attribute key and values, and what happens without it',
    // A proposal from before the rename has § Sunset; it counts.
    type === 'ab' && !filled(cfg, id, st, '## A/B test completion') && !filled(cfg, id, st, '## Sunset') && 'fill proposal.md § A/B test completion: when the test ends and how the extension is removed',
    // The test code is measured too: verify records its checks as qa: rows, and qa-row takes only declared scenarios, so
    // without these two nothing ever measures "writes once" or "control clears" (verify's key check only reads the files).
    type === 'ab' && !(rows.some((s) => /variation/i.test(JSON.stringify(s)) && /cart\.js|attribute|propert/i.test(JSON.stringify(s)))
      && rows.some((s) => /control/i.test(JSON.stringify(s)) && /clear|remov|delet|absent/i.test(JSON.stringify(s))))
      && 'an A/B change measures its own test code: add qa: scenarios for "the variation code writes the key and value to /cart.js (once, no update loop)" and "the control code clears it"',
    ...retiresFrom(md).filter((c) => !ledger.has(testKey(c.file, c.name))).map((c) => `§ Retires → ${checkKey(c)} isn't a test an archived change bound; list only those there`),
    !sectionLines(md, '## Tasks').some((l) => /^- \[[ x]\] \S/.test(l)) && 'fill proposal.md § Tasks: one "- [ ] …" line per task, each naming the scenarios it satisfies',
    ...(strict(st) ? strictProposeProblems(cfg, id, st, md, rows, decl) : []),
  ].filter(Boolean);
}

/** A digest of what the outside reviewer read: the proposal without its task ticks and client comment. */
const reviewedText = (md) => sha(md.replace(/^- \[x\]/gim, '- [ ]').replace(/## Client comment[\s\S]*$/, ''));
// A claim that something can't be done decides the design; asmc ASM-924 approved one read from an outdated guide list.
const IMPOSSIBLE = /\b(not possible|isn'?t possible|impossible|not supported|unsupported|isn'?t supported|platform limit|not reachable|isn'?t reachable|no (?:slot|target|way|api)\b|can'?t (?:be )?(?:placed|rendered|shown|styled|coloured|colored|reached|tracked|used)|cannot (?:be )?(?:placed|rendered|shown|styled|reached|tracked|used)|doesn'?t (?:let|allow|support))/i;
// A reference page (a target, component or API), not a guide: ASM-924's wrong claim came from a testing guide.
const REFERENCE = /shopify\.dev\/docs\/api\//;
/** "NOT READ: …" when the ticket links Figma but the design-extractor had no access: the dev checks the design by hand. */
const figmaUnread = (id) => { const d = read(`.claude/logs/${id}/design.md`); return /^\s*NO FIGMA ACCESS/im.test(d) ? `NOT READ, the dev checks the design by hand: ${d.match(/NO FIGMA ACCESS[^\n]*/i)[0].slice(0, 160)}` : null; };
/** The frames the design-extractor read: design-checks.json's frames, or [] without one. */
const designFramesOf = (id) => { try { return JSON.parse(readFileSync(join(LOGS, id, 'design-checks.json'), 'utf8')).frames || []; } catch { return []; } };

/** Proposals started with 0.5.0 or later: what was asked, the ticket, Figma, precedent and the outside review. */
function strictProposeProblems(cfg, id, st, md, rows, decl) {
  const tickets = ticketsOf(id);
  const jira = /^[A-Z][A-Z0-9]+-\d+$/.test(id) || (st.tickets || []).length > 0;
  const figma = (tickets || []).some((t) => (t.figmaLinks || []).length);
  const newExtension = decl !== 'none' && decl.some((d) => d.op === '+' && /^(extension|target):/.test(d.key));
  const claims = ['## Decided for you', '## Design', '## Needs your attention', '## What changes', '## Client comment'].flatMap((h) => sectionLines(md, h)).filter((l) => IMPOSSIBLE.test(l) && !REFERENCE.test(l));
  return [
    jira && !tickets && `read the ticket into the change: node .claude/kit/app.mjs ticket ${id}`,
    // Maintenance promises no behaviour change: § Asked may stay empty ("none").
    ...(typeOf(st) === 'maintain' && !askedFrom(md).length ? [] : askedProblems(md, rows, tickets, id, designFramesOf(id))),
    ...droppedWords(askedFrom(md), rows).map(warn),
    st.quick && decl !== 'none' && `a --quick change has no surfaces (§ Surfaces declares ${decl.map((d) => `${d.op} ${d.key}`).join(', ')}): abandon it and start again without --quick`,
    figma && existsSync(join(LOGS, id, 'design.md')) && !ranSince('agent design-extractor', st.createdAt) && !/^untraced:/im.test(read(`.claude/logs/${id}/design.md`)) && `the guard log shows no design-extractor run for this change: run the agent and save its report as design.md (if it ran and the log missed it, add a first line "Untraced: <why>"; Gate 1 shows it)`,
    figma && !existsSync(join(LOGS, id, 'design.md')) && `the ticket links Figma: run the design-extractor agent on the frames § Asked lists and save its report as .claude/logs/${id}/design.md (its JSON block as design-checks.json). No Figma access: write that in design.md, and the dev checks the design by hand`,
    !light(st) && newExtension && !st.precedent && `this change adds an extension or target: search earlier changes for the same target first: node .claude/kit/app.mjs precedent ${id} <target, component or API>`,
    !light(st) && !st.reviews?.outside && 'run the outcome-checker agent (mode proposal) on this proposal and record what it found and what you changed: app.mjs review <ID> outside --found "…"'.replace('<ID>', id),
    !light(st) && st.reviews?.outside && st.reviews.outside.proposal !== reviewedText(md) && warn('the proposal changed since the outside review: run the outcome-checker again if more than wording changed, then record it'),
    ...notProvenFrom(md).flatMap((n) => [
      !n.fallback.trim() && `§ Not proven yet → "${n.claim.slice(0, 60)}": name the fallback if QA disproves it`,
      !n.scenarios.length && `§ Not proven yet → "${n.claim.slice(0, 60)}": name the scenario that proves it`,
      ...n.scenarios.filter((s) => !rows.some((r) => r.id.toUpperCase() === s)).map((s) => `§ Not proven yet → "${n.claim.slice(0, 60)}": ${s} isn't in § Scenarios`),
    ]),
    // asm-924-c-icons passed Gate 1 as a fix with no failing test: nothing showed the bug before the fix.
    typeOf(st) === 'fix' && !rows.some((s) => s.check.kind === 'test') && !Object.values(st.qa?.baseline || {}).some((b) => b.verdict === 'FAIL')
      && `a fix needs something that fails before the fix: bind a test: scenario if the bug is in logic, or measure the qa: row on the unfixed build now: app.mjs qa-row ${id} <S#> --baseline --verdict FAIL --measured "…" --how "…"`,
    claims.length && warn(`a "can't be done" claim decides the design, so cite the target's or component's own reference page (shopify.dev/docs/api/…, the app's API version; a guide isn't one) in the same line: ${claims.map((l) => `"${l.slice(0, 90)}"`).join(' · ')}`),
  ];
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
      ...(strict(st) ? owedQaOf(cfg, id, st, md).map((q) => q.replace('<ID>', id)) : []),
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
const REPO_HYGIENE = /^MISSING_DEPENDENCY_SECURITY_AUTOMATION$/i;
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
  // Repo hygiene, not the change's code: asmc ASM-924 failed verify because its first package.json had no Dependabot.
  const blocking = fresh.filter((f) => !LOW_SEVERITY.has(f.severity) && !REPO_HYGIENE.test(f.check) && (baseline || f.severity !== 'medium'));
  return { known: findings.filter(isKnown), fresh, blocking, verdict: blocking.length ? 'FAIL' : findings.length ? 'WARN' : 'PASS' };
}

/**
 * An A/B change gates on one key: the test code in abtest/<ID>/ must write § Gate's key and values, and the extension
 * must read that key. Nothing else ties them together: with the template's "true" left in, verify's hand-set attribute
 * passes every scenario while every variation visitor sees control.
 */
export function abGateOf(md) {
  const gate = sectionLines(md, '## Gate').join(' ');
  const ticks = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const key = ticks(gate).find((t) => /^_[\w-]+$/.test(t)) || null;
  // Only the "Values:" clause: other backticked words in § Gate (a file, an event, a click) aren't values.
  const clause = gate.match(/\bValues?\s*:\s*(.*?)(?:\.\s|$)/i)?.[1] || '';
  const values = [...new Set(ticks(clause).filter((t) => t !== key && /^[\w-]{1,20}$/.test(t)))];
  return { key, values };
}

/** Code without its comments, so a value or key that only a comment mentions doesn't count. */
const codeOnly = (src) => String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');

/** § A/B test completion, or § Sunset in a proposal written before the rename. */
const completionOf = (md) => { const l = sectionLines(md, '## A/B test completion'); return l.length ? l : sectionLines(md, '## Sunset'); };

/** The A/B activation and completion as steps in their order, from § Gate and the files in abtest/<ID>/. */
function abSteps(id, md) {
  const { key, values } = abGateOf(md);
  const dir = join(ROOT, 'abtest', id);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.js$/.test(f)) : [];
  const variations = files.filter((f) => !/control/i.test(f));
  const control = files.find((f) => /control/i.test(f));
  return [
    'After the deploy and the block placed (or the Function activated) on the client store, before the test starts:',
    `Paste the test code into the A/B tool: ${variations.map((f) => `abtest/${id}/${f}`).join(', ') || `abtest/${id}/variation*.js`} into its variation${variations.length > 1 ? 's' : ''}${control ? `, abtest/${id}/${control} into control` : ''}.`,
    'Set the targeting and the trigger as § Gate says.',
    `Preview each arm on the client store (the dev store's theme can't test the client's cart trigger): ${key ? `/cart.js shows ${key} = ${values.join(' or ') || 'its value'} before checkout, after one /cart/update.js; control shows no ${key}` : 'the attribute reaches /cart.js before checkout'}. Then start the test.`,
    'When it ends, in this order: remove the block (or deactivate the Function), then stop the test, then delete the extension in a maintain change. Stopping the test first leaves carts that have the attribute showing the variation.',
  ];
}

function abCodeProblems(id, md, base) {
  const { key, values } = abGateOf(md);
  if (!key) return ['§ Gate names no key: write it in backticks, e.g. `_abc-123`'];
  if (!values.length) return ['§ Gate names no values: write them after "Values:", in backticks, e.g. Values: `1` → B, `2` → C'];
  const dir = join(ROOT, 'abtest', id);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.js$/.test(f)) : [];
  if (!files.length) return [`abtest/${id}/ has no test code: write the variation and control files from .claude/kit/templates/abtest-*.js`];
  const out = [];
  const code = Object.fromEntries(files.map((f) => [f, codeOnly(readFileSync(join(dir, f), 'utf8'))]));
  // The template derives the key from its ID constant: _${ID.toLowerCase()}.
  const writesKey = (src) => src.includes(key) || `_${(src.match(/var ID = ["']([^"']+)["']/)?.[1] || '').toLowerCase()}` === key;
  const literal = (src, v) => new RegExp(`["'\`]${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`).test(src);
  const control = files.filter((f) => /control/i.test(f));
  // Helper files in the folder aren't arms: the variation files are named so.
  const variations = files.filter((f) => /variation/i.test(f));
  if (!variations.length) out.push(`abtest/${id}/ has no variation file (name it variation.js, or variation-1.js and so on per arm)`);
  const written = new Map();
  for (const f of [...variations, ...control]) {
    if (/["']TICKET["']|TEST NAME/.test(code[f])) out.push(`abtest/${id}/${f} still has the template's TICKET or TEST NAME`);
    if (!writesKey(code[f])) out.push(`abtest/${id}/${f} doesn't use the key ${key}`);
  }
  for (const f of variations) {
    const mine = values.filter((v) => literal(code[f], v));
    if (!mine.length) out.push(`abtest/${id}/${f} writes none of § Gate's values (${values.join(', ')})`);
    else if (mine.length > 1) out.push(`abtest/${id}/${f} has more than one of § Gate's values (${mine.join(', ')}): each variation file writes its own`);
    else if (written.has(mine[0])) out.push(`abtest/${id}/${f} and ${written.get(mine[0])} both write "${mine[0]}": each arm needs its own value`);
    else written.set(mine[0], f);
    if (!values.includes('true') && /\]:\s*["']true["']/.test(code[f])) out.push(`abtest/${id}/${f} still writes the template's "true", which § Gate doesn't list`);
  }
  for (const v of values) if (variations.length && ![...written.keys()].includes(v)) out.push(`no variation file in abtest/${id}/ writes "${v}"`);
  // The control may legitimately be missing when the tool can't run code in control; § Gate says so then.
  if (!control.length && !/can'?t run code in control|no control code/i.test(sectionLines(md, '## Gate').join(' '))) out.push(`abtest/${id}/ has no control file (control.js clears the key)`);
  // The extension this change touched must read the key, in its own source (not a test, not a comment).
  const touched = git(['diff', '--name-only', `${base}...HEAD`], { allowFail: true }).split('\n').filter(Boolean)
    .filter((p) => !p.startsWith('abtest/') && !p.startsWith('appspec/') && /\.(m?[jt]sx?|graphql|rs|toml|liquid)$/.test(p) && !/(^|\/)(tests?|__tests__|fixtures)\/|\.test\./.test(p));
  if (!touched.some((p) => codeOnly(read(p)).includes(key))) out.push(`no source file this change touched reads the key ${key} (tests and comments don't count): the extension and the test code disagree`);
  return out;
}

const walk = (d) => { try { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (['node_modules', 'dist', 'generated'].includes(e.name) || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); } catch { return []; } };
const sourceOf = (dir) => walk(join(ROOT, dir)).filter((f) => /\.(m?[jt]sx?)$/.test(f) && !/(^|[\\/])(tests?|__tests__)[\\/]|\.test\./.test(f)).map((f) => codeOnly(readFileSync(f, 'utf8'))).join('\n');

/**
 * Checkout and customer-account extensions whose capabilities don't match their code: fetch needs network_access (or the
 * deploy works and every request fails). Admin and POS extensions fetch their own backend without it.
 */
function capabilityProblems(exts, items) {
  const fail = []; const warn = [];
  const buyerFacing = (h) => Object.keys(items).some((k) => k.startsWith(`target:${h}/purchase.`) || k.startsWith(`target:${h}/customer-account.`));
  for (const e of exts.filter((x) => buyerFacing(x.handle))) {
    const toml = read(`${e.dir}/shopify.extension.toml`);
    const src = sourceOf(e.dir);
    const network = /network_access\s*=\s*true/.test(toml);
    if (/\bfetch\s*\(/.test(src) && !network) fail.push(`${e.handle} calls fetch() without [extensions.capabilities] network_access = true`);
    if (network && !/\bfetch\s*\(/.test(src)) warn.push(`${e.handle} asks for network_access but never calls fetch(): drop it (narrowest capability)`);
  }
  return { fail, warn };
}

/** API versions over 12 months old (the CLI refuses to deploy them); touched: an extension this change touched. */
export function staleApiVersions(items, touched, today = new Date()) {
  const cutoff = new Date(today.getFullYear() - 1, today.getMonth(), 1);
  return Object.entries(items).filter(([k, v]) => /^(extension-api:|webhooks:api_version$)/.test(k) && /^\d{4}-\d{2}$/.test(String(v)))
    .filter(([, v]) => new Date(`${v}-01T00:00:00`) < cutoff).map(([k, v]) => ({ key: k, version: v, touched: touched.includes(k.slice('extension-api:'.length)) }));
}

/**
 * A line of QA or debug code: a debugger statement, the kit's probe names, an all-caps PROBE marker, qa/debug logging.
 * Not lint config ('no-debugger') or the word "probe" in prose.
 */
export const isLeftover = (line) => (/^\s*debugger\s*;?\s*$|[;{}]\s*debugger\s*;/.test(line) && !/no-debugger/.test(line)) || /\bPROBE\b/.test(line) || /__aq\b|qa-probe/.test(line)
  || /\bconsole\.(log|debug)\s*\(\s*['"`]\[?(qa|probe|debug)\b/i.test(line) || /\bTODO:? remove\b/i.test(line);

/** Lines the branch added since its base: [{ file, line }]. */
const addedLines = (base) => {
  const out = [];
  let file = '';
  for (const l of git(['diff', '--unified=0', `${base}...HEAD`], { allowFail: true }).split(/\r?\n/)) {
    if (l.startsWith('+++ ')) file = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('+') && !l.startsWith('+++')) out.push({ file, line: l.slice(1) });
  }
  return out;
};

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
  // A maintenance change promises "no behaviour change": with no test of any kind run, nothing showed that.
  const anyTests = tests.size > 0 || (cfg.verify || []).some((c) => /\b(test|vitest|jest)\b/.test(c.run));
  if (typeOf(st) === 'maintain' && !anyTests && !skipTests) add('regression', 'FAIL', 'no test ran: no scenario or ledgered test, and no test command in verify (.claude/app-kit.json). Add one, or bind scenarios that re-check what the maintenance could break');

  // Functions and checkout UI the change touched: fixtures, instruction counts, bundle size.
  const exts = extensionsTouched(changed, readItems(treeReader(ROOT), { configName: cfg.appConfig }).items);
  for (const ext of exts.filter((e) => e.type === 'function')) {
    const b = wrapper(['function-build', ext.handle]);
    if (b.status !== 0) { add(`function ${ext.handle}`, 'FAIL', `build failed: ${(b.stdout + b.stderr).trim().slice(-400)}`); continue; }
    if (!existsSync(join(ROOT, ext.dir, 'tests', 'fixtures'))) { add(`function ${ext.handle}`, 'WARN', 'no tests/fixtures: instruction counts unmeasured'); continue; }
    const r = parsedOut(wrapper(['function-run', ext.handle]));
    add(`function ${ext.handle}`, r?.ok ? 'PASS' : 'FAIL', r ? r.results.map((x) => `${x.fixture.split('/').pop()}: ${x.verdict}${x.instructions ? ` ${(x.instructions / 1e6).toFixed(2)}M instr` : ''}${x.note ? ` (${x.note})` : ''}`).join(' · ') : 'function-run gave no result');
  }
  for (const ext of exts.filter((e) => e.type === 'function')) {
    // Shopify refuses an input query over 3000 bytes at deploy (Functions limits, 2026-10); the fixtures never see it.
    // Measured without comments and with LF line ends, so a Windows checkout or a comment doesn't count.
    const qsize = (f) => Buffer.byteLength(readFileSync(f, 'utf8').replace(/#[^\n]*/g, '').replace(/\r\n/g, '\n').trim());
    const big = walk(join(ROOT, ext.dir)).filter((f) => /\.graphql$/i.test(f) && !/schema\.graphql$/i.test(f) && qsize(f) > 3000);
    if (big.length) add(`function ${ext.handle} input query`, 'FAIL', `${big.map((f) => `${f.slice(ROOT.length + 1).replaceAll('\\', '/')} is ${qsize(f)} bytes`).join(', ')}: the limit is 3000`);
  }
  if (exts.some((e) => e.type === 'ui_extension' || e.type === 'theme')) {
    const r = parsedOut(wrapper(['build']));
    // A web build the kit won't run leaves the sizes unmeasured: a warning, since the dev's own build is fine.
    add('build and size', r?.skipped ? 'WARN' : r?.ok ? 'PASS' : 'FAIL', r ? [r.error && !r.ok ? r.error.slice(0, 300) : '', ...r.bundles.map((x) => `${x.extension}: ${x.verdict}${x.gzipBytes ? ` ${(x.gzipBytes / 1024).toFixed(1)} KB gz` : ''}${x.liquidBytes !== undefined ? ` ${(x.liquidBytes / 1024).toFixed(1)} KB Liquid, ${x.blocks} blocks` : ''}${x.note ? ` (${x.note})` : ''}`)].filter(Boolean).join(' · ') : 'build gave no result');
  }
  const itemsNow = readItems(treeReader(ROOT), { configName: cfg.appConfig }).items;
  const caps = capabilityProblems(exts.filter((e) => e.type === 'ui_extension'), itemsNow);
  if (caps.fail.length || caps.warn.length) add('capabilities', caps.fail.length ? 'FAIL' : 'WARN', [...caps.fail, ...caps.warn].join(' · '));
  // APP_KIT_TODAY: the e2e's fixed date, so its fixtures' versions don't age into failures.
  const old = staleApiVersions(itemsNow, exts.map((e) => e.handle), process.env.APP_KIT_TODAY ? new Date(process.env.APP_KIT_TODAY) : new Date());
  if (old.length) add('API versions', 'WARN', `${old.map((o) => `${o.key} = ${o.version}${o.touched ? ' (this change touches it)' : ''}`).join(', ')}: over 12 months old. Shopify retires API versions after about a year; check the deploy accepts it, or bump it in a maintain change`);
  // Debug code that reached a client's checkout (asmc ASM-924: QA probes went out with a deploy). Code files only.
  const leftovers = addedLines(a.base).filter(({ file, line }) => isAppCode(file) && /\.(m?[jt]sx?|liquid|rs)$/.test(file) && !/(^|\/)(tests?|__tests__|fixtures)\/|\.test\./.test(file) && isLeftover(line));
  if (leftovers.length) add('debug leftovers', 'FAIL', leftovers.slice(0, 5).map(({ file, line }) => `${file}: ${line.trim().slice(0, 80)}`).join(' · '));
  {
    // The dev app's config must be valid; the production one may need a login the kit doesn't have, so it warns.
    const r = parsedOut(wrapper(['validate', '--all']));
    const bad = (r?.results || []).filter((x) => !x.valid);
    if (r) add('app configs', bad.some((x) => x.config === cfg.appConfig) ? 'FAIL' : bad.length ? 'WARN' : 'PASS',
      bad.map((x) => `${x.config}: ${x.error}`).join(' · ') || `${r.results.length} config${r.results.length === 1 ? '' : 's'} valid`);
  }

  if (typeOf(st) === 'ab') {
    const problems = abCodeProblems(id, md, a.base);
    add('ab code', problems.length ? 'FAIL' : 'PASS', problems.join(' · ') || 'the test code writes § Gate\'s key and values, and the extension reads the key');
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
export function deploySteps({ keys, ext, server, serverGone = false, configs, appConfig }) {
  const has = (re) => keys.some((k) => re.test(k));
  // A change that removes the backend (asmc first run) has nothing to migrate or host: the old ones are retired instead.
  const dbKeys = keys.filter((k) => /^[+~-] (model|enum|db|view|type):/.test(k));
  const dbGone = serverGone || (dbKeys.length > 0 && dbKeys.every((k) => k.startsWith('- ')));
  const prodConfigs = configs.filter((c) => c !== appConfig);
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
    // Deploy uploads the working tree: uncommitted experiments and QA probes went to every store in asmc ASM-924.
    'On the merged base branch, run node .claude/kit/app.mjs predeploy: a clean tree, up to date, no QA or debug code. It prints the deploy command with --message and --source-control-url, so the app version names this commit.',
    // The kit only validates the dev app's config; the production one is first checked here, by the dev.
    prodConfigs.length > 0 && `Validate the production config before deploying: shopify app config validate --config ${prodConfigs.join(' (and --config ')}${prodConfigs.length > 1 ? ')' : ''}. The kit validated only ${appConfig}.`,
    dbKeys.length > 0 && !dbGone && 'Migrate the production database first, in a form the code running now still works with (add, don\'t rename or drop yet): the new code needs it, and the old code serves traffic until the release.',
    server && !serverGone && 'Deploy the app server (hosting), so new routes and webhooks answer before Shopify starts calling them.',
    (serverGone || dbGone) && `After the release, retire what the app no longer uses: ${[serverGone && 'the app server\'s hosting', dbGone && 'the production database (take a backup first)'].filter(Boolean).join(' and ')}. Nothing to migrate or deploy there.`,
    pcd.length && `Request protected customer data access for ${pcd.join(', ')} in the Partner Dashboard (API access) before releasing.`,
    // A checkout extension that calls out (reviews, an API) needs this approved first, or the deploy is refused.
    has(/^\+ capability:[^/]+\/network_access$/) && `Request network access for ${keys.filter((k) => /^\+ capability:[^/]+\/network_access$/.test(k)).map((k) => k.slice('+ capability:'.length).split('/')[0]).join(', ')} in the Dev Dashboard (the app's API access) before deploying: without it the deploy is refused.`,
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

/** What the repo is now: an app server (routes or a database) is admin; without one, extensions only. */
const appKindNow = () => (existsSync(join(ROOT, 'app', 'routes')) || existsSync(join(ROOT, 'prisma')) ? 'admin' : 'extensions');

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
  // The kind setup recorded can go stale: a change that removes the backend leaves kind admin behind (asmc first run).
  const removedServer = git(['diff', '--name-only', '--diff-filter=D', `${effectiveBase(st, cfg)}...HEAD`, '--', 'app/routes', 'prisma', 'shopify.web.toml'], { allowFail: true });
  const serverGone = cfg.kind === 'admin' && appKindNow() !== 'admin' && Boolean(removedServer);
  // What the repo is now decides, not the kind setup recorded: an app with no server has nothing to host.
  const server = appKindNow() === 'admin' && !serverGone && serverChanged(keys, changedFiles(effectiveBase(st, cfg)));
  return deploySteps({ keys, ext, server, serverGone, configs, appConfig: cfg.appConfig });
}

/** Markdown lines as bullets: a wrapped line joins the bullet above it instead of becoming one (asmc ASM-924's PR text). */
export function asBullets(lines) {
  const out = [];
  for (const l of lines) {
    // A numbered step ("2. Deploy") is its own item and keeps its number.
    const t = l.replace(/^[-*]\s+/, '');
    if (/^([-*]|\d+[.)])\s/.test(l) || !out.length) out.push(`- ${t}`);
    else out[out.length - 1] += ` ${t}`;
  }
  return out;
}

function handoff(cfg, id, st) {
  const md = proposalOf(cfg, id);
  const rows = scenariosFrom(md);
  const surf = st.verify.checks.find((c) => c.name === 'surfaces')?.attention || [];
  const manual = rows.filter((s) => s.check.kind === 'manual');
  const waived = Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict === 'WAIVED');
  const design = sectionLines(md, '## Design');
  // The A/B type's activation and completion come from the proposal the dev approved at Gate 1.
  const abLines = typeOf(st) === 'ab' ? [...sectionLines(md, '## Gate').map((l) => `Gate: ${l}`), ...completionOf(md).map((l) => `When the test ends: ${l}`)] : [];
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
    ...asBullets(sectionLines(md, '## What changes')),
    '',
    '### Scenarios',
    ...(rows.length ? rows.map((s) => `- ${scenarioLine(s)} (${resultOf(st, s)})`) : ['- none (maintenance: the regression covers it)']),
    ...(extraRows(st).length ? ['', '### QA beyond the scenarios (ticket, Figma, blind QA, journeys, data)', ...extraRows(st).map((q) => `- ${q.id} [${q.source}] ${q.criterion}: expected ${q.expected} (${qaResult(st, q.id)})`)] : []),
    ...(notProvenFrom(md).length ? ['', '### Not proven by the docs (relied on, measured in QA)', ...notProvenFrom(md).map((n) => `- ${n.claim}. Evidence: ${n.evidence || '—'}. Fallback: ${n.fallback}.`)] : []),
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
    ...(sectionLines(md, '## Client comment').filter((l) => !l.startsWith('<!--')).length ? ['## Client comment (for the dev to post on the ticket)', '', ...sectionLines(md, '## Client comment').filter((l) => !l.startsWith('<!--')), ''] : []),
    '## Deploy checklist (the dev deploys; the kit never does)',
    '',
    ...stepsFor(cfg, st).map((s) => `- [ ] ${s}`),
    ...(design.length && !saysNone(design) ? ['', '### From proposal.md § Design (this change\'s own notes; the order above comes first)', ...asBullets(design)] : []),
    ...(abLines.length ? ['', '### A/B test: activation and completion', ...abSteps(id, md).map((l) => `- [ ] ${l}`), '', 'From proposal.md § Gate (targeting and trigger):', ...asBullets(sectionLines(md, '## Gate'))] : []),
    '',
    `Store mutations run on the dev store: ${(st.mutations || []).length}.`,
    '',
  ].join('\n');
}

// ── Gates ──

/** A scenario's result: QA as measured (and how), else verify's verdict. */
function resultOf(st, s) {
  if (s.check.kind === 'qa') return qaResult(st, s.id);
  return st.verify?.scenarios.find((x) => x.id === s.id)?.verdict || 'not run';
}
function qaResult(st, id) {
  const r = st.qa?.rows?.[id];
  return r ? `${r.verdict}${r.measured ? `: ${r.measured} (${r.how})` : r.reason ? `: ${r.reason}` : ''}` : 'not measured';
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
      ...(strict(st) ? {
        ...(figmaUnread(id) ? { figma: figmaUnread(id) } : {}),
        asked: askedFrom(md).map((a) => `#${a.n} ${a.asked.slice(0, 120)} → ${a.outOfScope ? 'out of scope' : a.scenarios.join(', ')}`),
        notProvenYet: notProvenFrom(md).map((n) => `${n.claim} (fallback: ${n.fallback}; proven by ${n.scenarios.join(', ')})`),
        outsideReview: st.reviews?.outside?.found || (light(st) ? 'not needed (quick or maintenance)' : 'not run yet'),
      } : {}),
      scenarios: rows.map(scenarioLine),
      checks: { test: count('test'), qa: count('qa'), manual: count('manual') },
      surfaces: decl === 'none' ? 'none' : decl.map((d) => `${d.op} ${d.key}: ${attentionFor(d) || 'no special attention'}`),
      pcdScopes: decl === 'none' ? [] : decl.filter((d) => d.op === '+' && /^scope:/.test(d.key) && PCD_SCOPE.test(d.key.slice(6))).map((d) => d.key),
      design: isHeavy(decl) ? sectionLines(md, '## Design') : undefined,
      attention: sectionLines(md, '## Needs your attention'),
      decided: sectionLines(md, '## Decided for you'),
      retires: retiresFrom(md).map(checkKey),
      ...(typeOf(st) === 'fix' ? { reproduce: sectionLines(md, '## Reproduce') } : {}),
      ...(typeOf(st) === 'ab' ? { abGate: sectionLines(md, '## Gate'), completion: completionOf(md) } : {}),
      outOfScope: sectionLines(md, '## Out of scope'),
    };
  }
  const v = st.verify;
  return {
    gate: 'Gate 2: the measured result',
    verify: v ? `${v.ok ? 'PASS' : 'FAIL'} on code ${v.digest}${v.digest === codeDigest(cfg) ? '' : ' (outdated: the code changed since)'}` : 'not run',
    checks: (v?.checks || []).map((c) => `${c.verdict} ${c.name}${c.verdict !== 'PASS' && c.note ? `: ${c.note.slice(0, 200)}` : ''}`),
    ...(figmaUnread(id) ? { figma: figmaUnread(id) } : {}),
    // What the design relied on without the docs' promise, first: a row that isn't PASS is the dev's risk to name.
    notProvenYet: notProvenFrom(md).map((n) => `${n.claim}: ${n.scenarios.map((s) => `${s} ${resultOf(st, rows.find((r) => r.id.toUpperCase() === s) || { id: s, check: { kind: 'qa' } }).split(':')[0]}`).join(', ')} (fallback: ${n.fallback})`),
    scenarios: rows.map((s) => `${scenarioLine(s)} → ${resultOf(st, s)}`),
    qaBeyondScenarios: extraRows(st).map((q) => `${q.id} [${q.source}${q.asked ? ` #${q.asked}` : ''}] ${q.criterion} (expected ${q.expected}) → ${qaResult(st, q.id)}`),
    blindQa: st.reviews?.blind?.found,
    changedSinceGate1: sinceGate1(st, md),
    surfaces: v?.checks.find((c) => c.name === 'surfaces')?.attention?.map((x) => `${x.change}: ${x.why}`) || [],
    deploySteps: stepsFor(cfg, st),
    manual: rows.filter((s) => s.check.kind === 'manual').map((s) => `${s.id}: ${s.check.what}`),
    waived: Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict === 'WAIVED').map(([n, r]) => `${n}: ${r.reason}`),
    reviews: Object.fromEntries(Object.entries(st.reviews || {}).map(([k, r]) => [k, r.found])),
    untracedReviews: Object.entries(st.reviews || {}).filter(([, r]) => r.untraced).map(([k, r]) => `${k}: recorded without a logged run (${r.untraced})`),
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
    // A proposal from before 0.3.0 has no such heading; it isn't refused for it.
    md.split(/\r?\n/).some((l) => l.trim() === '## Client comment') && !sectionLines(md, '## Client comment').some((l) => l && !l.startsWith('<!--'))
      && 'write proposal.md § Client comment: the comment for the dev to post for the client (what\'s done and when shoppers see it, what differs from the ticket, what the client or CRO does next)',
    // The client reads the comment, not the proposal: someone who didn't write it reads it as the client first.
    strict(st) && !light(st) && !st.reviews?.handoff && `run the outcome-checker agent (mode handoff) on § Client comment and record it: app.mjs review ${id} handoff --found "…"`,
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

/** Where a new change's branch starts: the base, or the onboarding branch while that isn't merged. */
function changeSource(cfg) {
  const has = (ref) => run('git', ['cat-file', '-e', `${ref}:${specPaths(cfg).surfaces}`]).code === 0;
  return !has(`origin/${cfg.baseBranch}`) && has(`origin/${ONBOARD_BRANCH}`) ? `origin/${ONBOARD_BRANCH}` : `origin/${cfg.baseBranch}`;
}

/**
 * owner/repo on GitHub, from origin: https or git@github.com, and an SSH alias such as drip-dev:Org/repo (the asmc
 * remote), which the team only uses for GitHub. null for anything else.
 */
function githubRepo() {
  const remote = (run('git', ['remote', 'get-url', 'origin']).stdout || '').trim();
  return remote.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(\.git)?$/)?.[1]
    || remote.match(/^(?:[\w.-]+@)?[\w.-]+:([\w.-]+\/[\w.-]+?)(\.git)?$/)?.[1] || null;
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
    st.stackedOn && run('git', ['cat-file', '-e', `origin/${cfg.baseBranch}:${specPaths(cfg).surfaces}`]).code !== 0 && `merge ${st.stackedOn} into ${cfg.baseBranch} first, with a merge commit (a squash merge would make this PR repeat the onboarding)`,
    !st.test && githubRepo() && `open the PR: https://github.com/${githubRepo()}/compare/${cfg.baseBranch}...${st.branch}?expand=1 (with gh: gh pr create --draft --base ${cfg.baseBranch} --head ${st.branch} --body-file ${to}/handoff.md)`,
  ].filter(Boolean);
}

/** The guard's log: [{ at, kind, tool, reason, command, branch }]. */
const guardLog = () => { try { return readFileSync(join(LOGS, '_guard.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
/** Whether the guard logged that agent or skill ("agent outcome-checker", "skill code-review") at or after since. */
export const ranIn = (entries, what, since) => entries.some((g) => g.kind === 'log' && /^(Agent|Task|Skill)$/.test(g.tool || '') && (g.reason === `ran ${what}` || String(g.reason).endsWith(`:${what.split(' ')[1]}`)) && g.at >= since);
const ranSince = (what, since) => ranIn(guardLog(), what, since);

// ── Retro and summary ──

const RETRO_ASK = 'For each signal, decide whether the kit caused it (a misleading instruction, a missing verb, an unclear check, a guard block on a harmless command) or the change did. Record each kit cause: app.mjs note <ID> "<what happened> → <what would have prevented it>" --kind <kind>.';

function retroSignals(st) {
  const events = st.history || [];
  const refused = {};
  for (const e of events.filter((x) => x.event === 'refused')) (refused[e.stage] ||= []).push(...(e.missing || []));
  const to = finished(st) ? st.updatedAt : now();
  let guardBlocks = [];
  try {
    guardBlocks = readFileSync(join(LOGS, '_guard.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      // This change's branch; entries from before the guard logged a branch fall back to the change's time window.
      // Logs from before 0.3 also hold gate answers (gate: true), which aren't blocks. kind (deny, ask or log) says what the guard did.
      .filter((g) => g && !g.gate && !/^(Agent|Task|Skill)$/.test(g.tool || '') && g.at >= st.createdAt && g.at <= to && (g.branch ? g.branch === st.branch : true)).map((g) => `${g.at.slice(0, 16)} ${g.kind ? `[${g.kind}] ` : ''}${String(g.reason || '').slice(0, 110)} ← ${String(g.command || '').slice(0, 90)}`);
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
  if (st.quick) lines.push('QUICK: a small fix with no surfaces. No outside review, precedent search or blind QA; § Asked, the scenarios and their QA still apply.');
  if (cfg.kind && cfg.kind !== appKindNow()) lines.push(`${CONFIG_REL} says kind "${cfg.kind}", but the app is now "${appKindNow()}" (${appKindNow() === 'admin' ? 'it has app/routes or prisma' : 'no app/routes or prisma'}): set kind to "${appKindNow()}" there (the guard shows the dev the change).`);
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
  const admin = appKindNow() === 'admin';
  // shopify.app.toml is usually production; a named one (shopify.app.<name>.toml) is the dev app config link made.
  const devConfig = configs.find((c) => c !== 'shopify.app.toml');
  // Shopify's app template with only its scaffold commit: setup can make it extension-only before onboarding.
  const commits = Number(git(['rev-list', '--count', 'HEAD'], { allowFail: true }) || 0);
  const untouchedTemplate = admin && existsSync(join(ROOT, 'app', 'routes')) && commits > 0 && commits <= 2 && !existsSync(join(ROOT, 'appspec'));
  return {
    suggestion: {
      devStore: 'drip-dev-eho-store.myshopify.com', baseBranch: git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }).replace(/^origin\//, '') || 'main',
      appConfig: devConfig || 'shopify.app.toml', kind: admin ? 'admin' : 'extensions', verify,
    },
    appConfigs: configs,
    untouchedTemplate,
    notes: [
      configs.length > 1 && `Several app configs (${configs.join(', ')}): set appConfig to the dev app's, so the kit never targets production.`,
      Object.values(scripts).some((s) => /shopify\s+app\s+deploy/.test(s)) && 'package.json has a deploy script; the guard blocks it, and the dev deploys.',
      !admin && 'No app/routes or prisma: an extension-only app. The deploy checklist skips hosting and migrations.',
    ].filter(Boolean),
    write: `Write it to ${CONFIG_REL} with the Write tool (the guard shows the dev each setting).`,
  };
}

function onboard(cfg, flags = {}) {
  const P = specPaths(cfg);
  const out = [];
  // --redo: a wrong baseline (a nearly empty dev toml, the template onboarded by mistake) is rewritten while it isn't
  // committed. The guard keeps the agent from deleting these files itself; once committed, a change records what changed.
  if (flags.redo) {
    for (const rel of [P.surfaces, P.securityBaseline]) {
      if (run('git', ['ls-files', '--error-unmatch', rel]).code === 0) fail(`${rel} is committed, so onboarding is done. Record what changed with a change (/app-implement), not a redo.`);
      rmSync(join(ROOT, rel), { force: true });
    }
  }
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
  // The dev merges onboarding before the first change starts; give them the link, not "open a PR".
  const repo = githubRepo();
  const branch = currentBranch();
  return {
    created: out, surfaces, security,
    next: [
      `fill ${P.project} (a few lines each)`,
      `commit ${P.dir}/ on ${branch} and push it: git push -u origin ${branch}`,
      repo ? `the dev merges it: https://github.com/${repo}/compare/${cfg.baseBranch}...${branch}?expand=1` : `the dev merges ${branch} into ${cfg.baseBranch}`,
      `the first change needn't wait: it stacks on ${branch} (app.mjs start says how). Merge ${branch} first, with a merge commit, then the change's PR`,
    ],
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
  eq('heavy surfaces need § Design; a new extension does not (the deploy checklist orders it)', ['app-proxy', 'model:Gift', 'scope:read_orders', 'app-proxy-x', 'extension:gift'].map((k) => HEAVY.test(k)), [true, true, false, false, false]);
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
  eq('A/B gate: the key and the values, not file names or event names', abGateOf('## Gate\n\n- Key: cart attribute `_asm-924`. Values: `1` → B, `2` → C.\n- Code: `abtest/ASM-924/variation-1.js`, `control.js`; trigger `cart:item-added`, `/cart/update.js`.\n'),
    { key: '_asm-924', values: ['1', '2'] });
  eq('checklist: the production config is validated by the dev first', /Validate the production config.*--config shopify\.app\.prod\.toml/.test(steps([])), true);
  // asmc first run: a change that removed the backend got "migrate the database" and "deploy the app server".
  const gone = deploySteps({ keys: ['- model:Session'], ext: {}, server: false, serverGone: true, configs: ['shopify.app.toml'], appConfig: 'shopify.app.toml' }).filter(Boolean).join('\n');
  eq('checklist: a removed backend retires hosting and the database instead of migrating and deploying them',
    [/Migrate the production database|Deploy the app server/.test(gone), /retire.*hosting.*database/.test(gone), /Migrate the production database/.test(steps(['+ model:GiftRule']))], [false, true, true]);
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
  eq('the proposal template holds each type\'s sections', TYPES.map((t) => ['## Scenarios', '## Reproduce', '## Gate', '## A/B test completion'].filter((h) => proposalTemplate('X-1', t).includes(`\n${h}\n`))),
    [['## Scenarios'], ['## Scenarios', '## Reproduce'], ['## Scenarios'], ['## Scenarios', '## Gate', '## A/B test completion']]);
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
  // § Asked (0.5.0): quotes against the ticket, scenarios that exist, Figma frames tied to qa: rows.
  const scen = (id, kind = 'qa') => ({ id, check: kind === 'qa' ? { kind: 'qa', expected: 'x' } : { kind: 'test', file: 'a.test.js', name: 'n' } });
  const tk = [{ summary: 'Trust section', description: 'AC: Show the **two most recent** 5-star reviews.\nLink to the form section.', fields: {}, comments: [{ text: 'Use “WhatsApp Support”' }], figmaLinks: ['https://www.figma.com/design/abc/x?node-id=12-34'] }];
  const askedMd = (rows) => `## Asked\n\n| # | Asked (quoted) | Scenarios |\n| --- | --- | --- |\n${rows.join('\n')}\n\n## Out of scope\n\n- none\n`;
  eq('§ Asked: a quote found in the ticket passes; a paraphrase or a missing quote is refused', [
    askedProblems(askedMd(['| 1 | AC: "two most recent 5-star reviews" | S1 |', '| 2 | "WhatsApp Support" | S1 |', '| 3 | Figma: Variation C · 12:34 · 360px | S1 |']), [scen('S1')], tk, 'X'),
    askedProblems(askedMd(['| 1 | AC: "the 2 newest reviews" | S1 |', '| 2 | Figma: C · 12:34 · 360px | S1 |']), [scen('S1')], tk, 'X').length,
    askedProblems(askedMd(['| 1 | show reviews | S1 |', '| 2 | Figma: C · 12:34 | S1 |']), [scen('S1')], tk, 'X').some((p) => /quote the ticket word for word/.test(p)),
  ], [[], 1, true]);
  eq('§ Asked: unknown scenarios, unproven rows, Figma rows without a qa: scenario, and unlisted Figma nodes are refused', [
    askedProblems(askedMd(['| 1 | "two most recent" | S9 |']), [scen('S1')], null, 'X').some((p) => /S9 isn't in § Scenarios/.test(p)),
    askedProblems(askedMd(['| 1 | "two most recent" | |']), [scen('S1')], null, 'X').some((p) => /name the scenarios/.test(p)),
    askedProblems(askedMd(['| 1 | "two most recent" | out of scope: later ticket |']), [scen('S1')], null, 'X'),
    askedProblems(askedMd(['| 1 | Figma: B · 1:2 · 1280px | S1 |']), [scen('S1', 'test')], null, 'X').some((p) => /tie it to a qa: scenario/.test(p)),
    askedProblems(askedMd(['| 1 | "two most recent" | S1 |']), [scen('S1')], tk, 'X').some((p) => /Figma node 12:34/.test(p)),
    askedProblems('## Asked\n\nnone\n', [], null, 'X').length,
  ], [true, true, [], true, true, 1]);
  eq('Figma node ids from links', [figmaNodes('https://figma.com/design/k/n?node-id=12-34&t=x'), figmaNodes('https://figma.com/design/k/n?node-id=1%3A2'), figmaNodes('https://figma.com/file/k/n')], [['12:34'], ['1:2'], []]);
  const owe = (o) => owedQa({ rows: [scen('S1')], extra: [], reviews: {}, asked: [], values: [], ab: false, fetches: false, quick: false, ...o });
  eq('owed QA: a UI change needs the blind run and its rows; each Figma row a figma row; an A/B change a journey per arm and control; fetched data its source', [
    owe({}).length, owe({ reviews: { blind: { found: 'x' } }, extra: [{ source: 'blind' }] }).length,
    owe({ reviews: { blind: {} }, extra: [{ source: 'blind' }], asked: [{ n: '2', asked: 'Figma: C · 1:2', scenarios: ['S1'] }] }).some((p) => /§ Asked #2/.test(p)),
    owe({ reviews: { blind: {} }, extra: [{ source: 'blind' }, { source: 'figma', asked: '2' }], asked: [{ n: '2', asked: 'Figma: C · 1:2', scenarios: ['S1'] }] }).length,
    owe({ reviews: { blind: {} }, extra: [{ source: 'blind' }, { source: 'journey' }, { source: 'journey' }], ab: true, values: ['1', '2'] }).some((p) => /2 of 3 so far/.test(p)),
    owe({ reviews: { blind: {} }, extra: [{ source: 'blind' }], fetches: true }).some((p) => /source itself/.test(p)),
    owe({ quick: true, ab: true, values: ['1'], fetches: true }).length, owe({ rows: [scen('S1', 'test')] }).length,
  ], [1, 0, true, 0, true, true, 0, 0]);
  eq('PR bullets: a wrapped line joins its bullet; numbered steps stay separate', [asBullets(['- one that', 'wraps', '- two', 'and wraps']), asBullets(['1. Request access', '2. Deploy'])], [['- one that wraps', '- two and wraps'], ['- 1. Request access', '- 2. Deploy']]);
  // Round 2 (the 0.5.0 review): German quotes, AC coverage, dropped words, node boundaries, design frames.
  const tkDe = [{ summary: 'x', description: '### Akzeptanzkriterien\n- Zeige die zwei neuesten 5-Sterne-Bewertungen\n- Link zum Kontaktformular öffnet einen neuen Tab\n### Notes\n- not an AC line here', fields: {}, comments: [], figmaLinks: ['https://www.figma.com/proto/k/x?node-id=12-34&starting-point-node-id=9-9'] }];
  eq('acceptance criteria are read from the AC heading\'s list', acLines(tkDe), ['Zeige die zwei neuesten 5-Sterne-Bewertungen', 'Link zum Kontaktformular öffnet einen neuen Tab']);
  eq('German „…“ quotes count; an AC line no row quotes is refused; a prototype\'s starting node isn\'t a frame', [
    askedProblems(askedMd(['| 1 | „Zeige die zwei neuesten 5-Sterne-Bewertungen“ | S1 |', '| 2 | „Link zum Kontaktformular öffnet einen neuen Tab“ | S1 |', '| 3 | **Figma:** C · 12:34 · 360px | S1 |']), [scen('S1')], tkDe, 'X'),
    askedProblems(askedMd(['| 1 | „Zeige die zwei neuesten 5-Sterne-Bewertungen“ | S1 |', '| 3 | Figma: C · 12:34 · 360px | S1 |']), [scen('S1')], tkDe, 'X').some((p) => /acceptance criterion "Link zum Kontaktformular/.test(p)),
  ], [[], true]);
  eq('a Figma node is matched whole (2:3 isn\'t listed by 12:34); every design-checks frame needs a row', [
    askedProblems(askedMd(['| 1 | Figma: B · 12:34 · 1280px | S1 |']), [scen('S1')], [{ figmaLinks: ['https://figma.com/design/k/x?node-id=2-3'] }], 'X').some((p) => /node 2:3/.test(p)),
    askedProblems(askedMd(['| 1 | Figma: B · 12:34 · 1280px | S1 |']), [scen('S1')], null, 'X', [{ node: '12:34' }, { node: '12:35', variation: 'C', viewport: 'mobile', width: 360 }]).some((p) => /frame 12:35 \(C · mobile · 360px\)/.test(p)),
  ], [true, true]);
  eq('words that carry a criterion must reach its scenarios', [
    droppedWords([{ n: '1', asked: '"the two most recent reviews"', scenarios: ['S1'] }], [{ id: 'S1', given: '', when: '', then: '2 review cards', checkText: 'qa: 2 cards' }]),
    droppedWords([{ n: '1', asked: '"the two most recent reviews"', scenarios: ['S1'] }], [{ id: 'S1', given: '', when: '', then: 'the 2 most recent reviews', checkText: '' }]),
  ], [['§ Asked #1 says "most recent", which S1 doesn\'t carry: a scenario that drops it can pass while the criterion fails'], []]);
  eq('debug leftovers: markers and qa logging, not lint config or prose', ['  debugger;', 'x(); debugger;', "'no-debugger': 'error',", '// probe the proxy first', 'const PROBE = 1;', "console.log('[qa] gate', v)", "console.log('[trust]', v)", 'window.__aq.env()']
    .map(isLeftover), [true, true, false, false, true, true, false, true]);
  const glog = [{ at: '2026-11-26T10:00:00Z', kind: 'log', tool: 'Agent', reason: 'ran agent outcome-checker' }, { at: '2026-11-26T11:00:00Z', kind: 'log', tool: 'Skill', reason: 'ran skill plugin:code-review' }, { at: '2026-11-26T12:00:00Z', kind: 'deny', tool: 'Bash', reason: 'ran agent blind-qa' }];
  eq('a review needs the guard\'s record of the agent or skill, after the last one', [ranIn(glog, 'agent outcome-checker', '2026-11-26T09:00:00Z'), ranIn(glog, 'agent outcome-checker', '2026-11-26T10:30:00Z'), ranIn(glog, 'skill code-review', '2026-11-26T10:30:00Z'), ranIn(glog, 'agent blind-qa', '2026-11-26T00:00:00Z')], [true, false, true, false]);
  eq('API versions over 12 months old; touched ones flagged', staleApiVersions({ 'extension-api:a': '2025-07', 'extension-api:b': '2026-04', 'webhooks:api_version': '2025-10', 'scope:x': '' }, ['a'], new Date('2026-11-25')),
    [{ key: 'extension-api:a', version: '2025-07', touched: true }, { key: 'webhooks:api_version', version: '2025-10', touched: false }]);
  eq('security: a missing Dependabot setup is repo hygiene, not a blocking finding', securityVerdict([{ check: 'MISSING_DEPENDENCY_SECURITY_AUTOMATION', severity: 'unknown', file: 'package.json', fingerprint: 'd' }], { fingerprints: [] }, []).verdict, 'WARN');
  eq('§ Not proven yet rows', notProvenFrom('## Not proven yet\n\n| Claim | Evidence | Fallback | Scenario |\n| --- | --- | --- | --- |\n| data-URI icons render | SEE-402 | hosted file | S3, S8 |\n'), [{ claim: 'data-URI icons render', evidence: 'SEE-402', fallback: 'hosted file', scenarios: ['S3', 'S8'] }]);
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
  case 'onboard': print(onboard(cfg, flags)); break;

  case 'list': {
    const all = listChanges(cfg);
    const open = all.filter(({ st }) => !finished(st));
    if (!open.length) print('No open changes. Start one with /app-implement <KEY>.');
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
    // Every change measures its surfaces against the base. Before the onboarding is merged, the change stacks on the
    // onboarding branch and measures against it (asmc first run: measured against main, 7 removals showed as missing).
    const onBase = run('git', ['cat-file', '-e', `origin/${cfg.baseBranch}:${specPaths(cfg).surfaces}`]).code === 0;
    const onOnboard = !onBase && run('git', ['cat-file', '-e', `origin/${ONBOARD_BRANCH}:${specPaths(cfg).surfaces}`]).code === 0;
    if (!onBase && !onOnboard && !flags.test) {
      fail(existsSync(join(ROOT, specPaths(cfg).surfaces))
        ? `${specPaths(cfg).surfaces} is on neither origin/${cfg.baseBranch} nor origin/${ONBOARD_BRANCH}: push the onboarding branch (git push -u origin ${ONBOARD_BRANCH}), then start again.`
        : `${specPaths(cfg).surfaces} isn't on this branch. Not onboarded yet: run /app-setup, which onboards the app.`);
    }
    const from = onOnboard ? `origin/${ONBOARD_BRANCH}` : `origin/${cfg.baseBranch}`;
    const holdsOnboarding = !onOnboard || run('git', ['merge-base', '--is-ancestor', from, 'HEAD']).code === 0;
    const st0 = { test: Boolean(flags.test) };
    const want = branchFor(cfg, id, st0);
    const branch = currentBranch();
    if (protectedBranches(cfg).some((p) => p.toLowerCase() === branch.toLowerCase())) {
      fail(`You're on ${branch}, which is protected. Create the change branch first:\n  git fetch origin\n  git switch -c ${want} --no-track ${from}`);
    }
    if (branch !== want) fail(`Check out the change branch first (expected ${want}, on ${branch}):\n  git switch -c ${want} --no-track ${from}   (or git switch ${want} if it exists)`);
    if (!holdsOnboarding) fail(`${branch} doesn't contain ${from}, where this app's onboarding is. Cut the branch from it:\n  git switch -c ${want}-2 --no-track ${from}   (or rebase ${branch} onto ${from})`);
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
      schemaVersion: 3, kitVersion: KIT_VERSION, id, type, title: typeof flags.title === 'string' ? flags.title : '', tickets: /^[A-Z][A-Z0-9]+-\d+$/.test(id) ? [id] : [],
      createdAt: now(), owner: owner(), stage: STAGES[0].name, gates: {}, test: st0.test, ...(flags.quick ? { quick: true } : {}),
      ...(onOnboard ? { stackedOn: ONBOARD_BRANCH, stackedSha: git(['rev-parse', from], { allowFail: true }) || null } : {}),
      branch, base: effectiveBase(onOnboard ? { stackedOn: ONBOARD_BRANCH } : {}, cfg) || head(), history: [{ at: now(), event: 'start' }], qa: { rows: {} }, reviews: {}, mutations: [],
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
    print(`${id} not started. Create its branch (git fetch origin, then git switch -c ${branchFor(cfg, id, { test: Boolean(flags.test) })} --no-track ${changeSource(cfg)}), then: node .claude/kit/app.mjs start ${id} --type change|fix|maintain|ab`);
    break;
  }

  case 'gate': {
    const id = normId(rawId);
    const st = atStage(id, 'propose', 'accept');
    if (st.stage === 'accept') { print(gateView(cfg, id, st)); break; }
    // Gate 1 is asked only once the proposal is complete: the problems come first.
    const found = proposeProblems(cfg, id, st);
    const problems = refusals(found);
    const warnings = warningsOf(found);
    print({ ok: !problems.length, problems, ...(warnings.length ? { warnings } : {}), ...gateView(cfg, id, st) });
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
    const found = (EXIT_CHECKS[stage]?.(cfg, id, st) || []).filter(Boolean);
    const missing = refusals(found);
    const warnings = warningsOf(found);
    const worth = (title) => (warnings.length ? `\n${title}\n${warnings.map((w) => `- ${w}`).join('\n')}` : '');
    if (missing.length) {
      st.history.push({ at: now(), event: 'refused', stage, missing: missing.map((x) => x.slice(0, 160)) });
      writeChange(cfg, id, st);
      fail(`"${stage}" isn't finished:\n${missing.map((x) => `- ${x}`).join('\n')}${worth('Also worth a look (not blocking):')}`);
    }
    if (def.gate) st.gates[stage] = { answer, at: now(), by: owner().name };
    // What Gate 1 approved: Gate 2 lists what changed since, instead of refusing it.
    if (stage === 'propose') Object.assign(st, approvedOf(proposalOf(cfg, id)));
    st.history.push({ at: now(), event: 'done', stage, answer: answer || undefined, note: flags.note || undefined, warnings: warnings.length ? warnings.map((w) => w.slice(0, 160)) : undefined });
    st.stage = STAGES[stageIndex(stage) + 1].name;
    writeChange(cfg, id, st);
    print(summaryLines(cfg, id, st));
    if (warnings.length) print(worth('Worth a look before you go on:').trimStart());
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
    const STAGE_OF = { code: ['build', 'verify'], security: ['build', 'verify'], outside: ['propose'], blind: ['verify'], handoff: ['handoff'] };
    if (!STAGE_OF[kind] || typeof flags.found !== 'string' || !flags.found.trim()) fail('Usage: review <ID> code|security|outside|blind|handoff --found "<what the review found and what was done about it>"');
    const st = atStage(id, ...STAGE_OF[kind]);
    const found = flags.found.trim().replace(/\r?\n/g, ' ');
    // asmc ASM-924 recorded "reviewed inline" and a security review "carried over" from an earlier commit: neither ran
    // the review on this code.
    if (/\b(reviewed inline|inline review|carried over from|from (an |the )?earlier review|already reviewed|same as before|not re-?run)\b/i.test(found)) fail(`--found says the review didn't run on this code ("${found.slice(0, 80)}"). Run ${kind === 'code' ? '/code-review' : kind === 'security' ? '/security-review' : `the ${kind === 'blind' ? 'blind-qa' : 'outcome-checker'} agent`} now and record what it found.`);
    if (['code', 'security', 'blind'].includes(kind)) {
      const dirty = dirtyCode(cfg);
      if (dirty.length) fail(`Commit first: a review is recorded against committed code (uncommitted: ${dirty.slice(0, 5).join(', ')}).`);
    }
    // The guard logs every agent and skill call by name: a record needs a run after the last one (or, for the handoff
    // read, after Gate 2), or --untraced with why, which Gate 2 shows the dev.
    const RUN = { outside: 'agent outcome-checker', handoff: 'agent outcome-checker', blind: 'agent blind-qa', code: 'skill code-review', security: 'skill security-review' };
    const since = kind === 'handoff' ? st.gates?.accept?.at || st.createdAt : st.reviews?.[kind]?.at || st.createdAt;
    const untraced = typeof flags.untraced === 'string' ? flags.untraced.trim() : '';
    if (!untraced && !ranSince(RUN[kind], since)) fail(`The guard log shows no ${RUN[kind].replace(' ', ' "')}" run since ${since.slice(0, 16)}, so there's nothing to record yet: run it, then record what it found. If it did run and the log missed it (an older Claude Code that doesn't hook ${RUN[kind].startsWith('agent') ? 'Agent' : 'Skill'} calls), add --untraced "<why>": Gate 2 shows that to the dev.`);
    const digest = codeDigest(cfg);
    st.reviews = { ...st.reviews, [kind]: { found, digest, at: now(), stage: st.stage, ...(untraced ? { untraced } : {}), ...(kind === 'outside' ? { proposal: reviewedText(proposalOf(cfg, id)) } : {}) } };
    st.history.push({ at: now(), event: 'review', kind, digest });
    writeChange(cfg, id, st);
    print(['code', 'security'].includes(kind) ? `${kind} review recorded on code ${digest}. A later code change needs it again.` : `${kind} review recorded.`);
    break;
  }

  case 'qa-add': {
    const id = normId(rawId);
    const st = atStage(id, 'verify');
    const text = (f) => (typeof flags[f] === 'string' ? flags[f].trim().replace(/\r?\n/g, ' ') : '');
    const source = text('source');
    if (!QA_SOURCES.includes(source) || !text('criterion') || !text('expected')) fail(`Usage: qa-add <ID> --source ${QA_SOURCES.join('|')} --criterion "<what is checked>" --expected "<the value or behaviour, from the ticket or Figma>" [--asked <§ Asked #>]`);
    const asked = text('asked').replace(/^#/, '');
    if (source === 'figma' && !askedFrom(proposalOf(cfg, id)).some((a) => a.n === asked && isFigmaRow(a))) fail(`A figma row names the § Asked row of its frame: --asked <#> (the Figma rows: ${askedFrom(proposalOf(cfg, id)).filter(isFigmaRow).map((a) => `#${a.n}`).join(', ') || 'none'}).`);
    const extra = extraRows(st);
    const q = { id: `Q${extra.length + 1}`, source, criterion: text('criterion'), expected: text('expected'), ...(asked ? { asked } : {}), at: now() };
    st.qa = { ...st.qa, rows: { ...st.qa?.rows }, extra: [...extra, q] };
    writeChange(cfg, id, st);
    print(`${q.id} (${source}): ${q.criterion} → expected ${q.expected}. Measure it: app.mjs qa-row ${id} ${q.id} --measured … --how … --verdict …`);
    break;
  }

  case 'qa-row': {
    const id = normId(rawId);
    const baseline = Boolean(flags.baseline);
    const st = baseline ? atStage(id, 'propose') : atStage(id, 'verify');
    if (baseline && typeOf(st) !== 'fix') fail('--baseline is for a fix: the qa: row measured on the unfixed build, before Gate 1.');
    const md = proposalOf(cfg, id);
    const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\r?\n/g, ' ') : '');
    let batch;
    if (typeof flags.file === 'string') {
      // A batch (a blind QA run's criteria): one write, so parallel calls can't overwrite each other.
      try { batch = JSON.parse(readFileSync(resolve(ROOT, flags.file), 'utf8')); } catch (e) { fail(`--file: unreadable JSON (${e.message}). It holds [{ "row": "Q3", "verdict": "PASS", "measured": "…", "how": "…" }, …].`); }
      if (!Array.isArray(batch) || !batch.length) fail('--file holds a JSON array of { row, verdict, measured, how }.');
    } else batch = [{ row: rest[0], verdict: flags.verdict, measured: flags.measured, how: flags.how }];
    const digest = codeDigest(cfg);
    const asked = askedFrom(md);
    const done = [];
    for (const r of batch) {
      const s = qaTarget(st, scenariosFrom(md), r.row);
      if (!s) fail(`Usage: qa-row <ID> <S#|Q#> --measured T --how T --verdict PASS|FAIL|BLOCKED (or --file rows.json), for a qa: scenario of proposal.md § Scenarios or a row qa-add made (got "${r.row || ''}"). Nothing was recorded.`);
      if (!['PASS', 'FAIL', 'BLOCKED'].includes(r.verdict)) fail(`${s.id}: the verdict is one of PASS, FAIL, BLOCKED. Nothing was recorded.`);
      // A verdict is only as good as what was observed: the value seen, and where and how.
      const measured = clean(r.measured); const how = clean(r.how);
      if (r.verdict !== 'BLOCKED' && (!measured || !how)) fail(`${s.id}: a ${r.verdict} needs what you observed (--measured: the text, the value, the element) and where and how (--how: the store page, viewport, tool). Nothing was recorded.`);
      // A PASS that says part of it wasn't shown is partial (as the theme kit refuses since 1.13.10's review): split it.
      const hedge = r.verdict === 'PASS' && measured.match(/\b(?:not provable|can(?:no|')t (?:be )?prove[nd]?|not (?:yet )?(?:verified|measured|tested|checked)|unverified|untested|assumed|only partly|partially)\b|\blimitations?\s*:/i);
      if (hedge) fail(`${s.id}: the measurement says "${hedge[0]}", so part of it wasn't shown. Measure it, or record BLOCKED with what's missing. Nothing was recorded.`);
      // A frame is measured at its own width (ASM-924 measured mobile at 390 px against a 360 px frame).
      const q = (st.qa?.extra || []).find((x) => x.id === s.id);
      const width = q?.source === 'figma' && r.verdict !== 'BLOCKED' && asked.find((a) => a.n === q.asked)?.asked.match(/\b(\d{3,4})\s?px\b/)?.[1];
      if (width && !new RegExp(`\\b${width}\\s?px\\b`).test(how)) fail(`${s.id} checks a ${width}px frame: measure it at ${width}px and say so in --how (e.g. "kit-browser at ${width}px, __aq.box"). Nothing was recorded.`);
      done.push([s, { verdict: r.verdict, measured, how, digest, at: now() }]);
    }
    if (baseline) {
      st.qa = { ...st.qa, rows: { ...st.qa?.rows }, baseline: { ...st.qa?.baseline, ...Object.fromEntries(done.map(([s, v]) => [s.id, v])) } };
      writeChange(cfg, id, st);
      print(done.map(([s, v]) => `${s.id}: baseline ${v.verdict} on the unfixed code`).join('\n'));
      break;
    }
    // The code a verdict was measured on: a row measured before a fix doesn't count after it.
    st.qa = { ...st.qa, rows: { ...st.qa?.rows, ...Object.fromEntries(done.map(([s, v]) => [s.id, v])) } };
    writeChange(cfg, id, st);
    print(done.map(([s, v]) => `${s.id}: ${v.verdict} on code ${digest} (expected: ${s.expected})`).join('\n'));
    break;
  }

  case 'waive': {
    const id = normId(rawId);
    const st = atStage(id, 'verify');
    const s = qaTarget(st, scenariosFrom(proposalOf(cfg, id)), rest[0]);
    if (!s || typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Usage: waive <ID> <S#|Q#> --reason "why it can\'t be measured, and who checks it instead", for a qa: scenario or a Q row');
    // Skipping a check is the dev's call, recorded in their words like a gate answer.
    if (typeof flags.answer !== 'string' || !flags.answer.trim()) fail(`Waiving ${s.id} is the dev's call: ask them, then add --answer "<their words>".`);
    st.qa = { ...st.qa, rows: { ...st.qa?.rows, [s.id]: { verdict: 'WAIVED', reason: flags.reason.trim(), answer: flags.answer.trim(), digest: codeDigest(cfg), at: now(), by: owner().name } } };
    st.history.push({ at: now(), event: 'waive', row: s.id, reason: flags.reason.trim() });
    writeChange(cfg, id, st);
    print(`${s.id} waived: ${flags.reason.trim()}`);
    break;
  }

  case 'handoff': {
    const id = normId(rawId);
    const st = readChange(cfg, id, { required: false });
    if (st) {
      const out = runHandoff(cfg, id, st);
      // Shown only when something went wrong, as in the theme kit: a clean run isn't asked about the kit.
      const s = retroSignals(st);
      if (s.loopsBack.length || s.refusedStages.length || s.guardBlocks.some((g) => g.includes('[deny]'))) out.retro = { ...s, ask: RETRO_ASK.replaceAll('<ID>', id) };
      print(out);
      break;
    }
    const old = archivedChange(cfg, id);
    if (old?.st.stage === 'handoff') { print(finishArchive(cfg, id, old.st, old.to)); break; }
    if (old) { print({ archived: old.to, next: archivedNext(cfg, id, old.st, old.to) }); break; }
    fail(`No change "${id}". Start one with node .claude/kit/app.mjs start ${id} --type change|fix|maintain|ab`);
    break;
  }

  case 'drift': print(drift(cfg, { regression: Boolean(flags.regression) })); break;

  case 'predeploy': {
    // Read-only, for the dev before shopify app deploy: deploy uploads the working tree, not the commit, so uncommitted
    // experiments and QA probes reach every store (asmc ASM-924's probes went out this way).
    const dirty = run('git', ['status', '--porcelain', '--untracked-files=all']).stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3)).filter((p) => isAppCode(p.replace(/^"|"$/g, '')));
    const branch = currentBranch();
    const items = readItems(treeReader(ROOT), { configName: cfg.appConfig }).items;
    const dirs = extensionList(items).map((e) => e.dir).filter(Boolean);
    const found = dirs.flatMap((d) => walk(join(ROOT, d)).filter((f) => /\.(m?[jt]sx?|liquid)$/.test(f) && !/[\\/](tests?|__tests__)[\\/]|\.test\./.test(f))
      .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/).filter(isLeftover).map((l) => `${relative(ROOT, f).replaceAll('\\', '/')}: ${l.trim().slice(0, 80)}`)));
    git(['fetch', '-q', 'origin', cfg.baseBranch], { allowFail: true });
    const behind = git(['rev-list', '--count', `HEAD..origin/${cfg.baseBranch}`], { allowFail: true });
    const sha = head();
    const problems = [
      dirty.length && `uncommitted app files would deploy as they are: ${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ' …' : ''} (commit, or node .claude/kit/app.mjs revert <ID> <file…>)`,
      branch !== cfg.baseBranch && `on ${branch}, not ${cfg.baseBranch}: deploy what was merged`,
      Number(behind) > 0 && `${behind} commit(s) behind origin/${cfg.baseBranch}: git pull --ff-only first`,
      found.length && `QA or debug code in the extensions: ${found.slice(0, 5).join(' · ')}`,
    ].filter(Boolean);
    const repo = githubRepo();
    print({ ok: !problems.length, problems,
      deploy: `shopify app deploy --config <the production app's config> --message "${String(rawId || 'release').replace(/"/g, '')} @ ${String(sha).slice(0, 7)}"${repo ? ` --source-control-url https://github.com/${repo}/commit/${sha}` : ''}`,
      note: '--message and --source-control-url tie the app version to this commit (shopify app versions list shows them).' });
    if (problems.length) process.exit(1);
    break;
  }

  case 'ticket': {
    const id = normId(rawId);
    const st = readChange(cfg, id);
    const keys = [...new Set([...(st.tickets || []), ...(/^[A-Z][A-Z0-9]+-\d+$/.test(id) ? [id] : [])])];
    if (!keys.length) fail(`${id} names no Jira ticket. § Asked quotes what the dev asked for instead (rows starting "Dev:").`);
    const got = keys.map((k) => {
      const r = spawnSync(process.execPath, [join(KIT_DIR, 'jira.mjs'), k], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      try { return JSON.parse(r.stdout); } catch { fail(`jira.mjs ${k} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`); }
      return null;
    });
    mkdirSync(join(LOGS, id), { recursive: true });
    writeFileSync(ticketFile(id), `${JSON.stringify(got, null, 2)}\n`);
    print({ saved: `.claude/logs/${id}/ticket.json`, tickets: got.map((t) => `${t.key}: ${t.summary}`), figmaLinks: got.flatMap((t) => t.figmaLinks || []),
      next: 'Quote every acceptance criterion and deciding line from it in proposal.md § Asked, word for word in "…"; one Figma row per frame the change builds.' });
    break;
  }

  case 'precedent': {
    const id = normId(rawId);
    const st = atStage(id, 'propose');
    const words = rest.map((w) => w.toLowerCase()).filter((w) => w.length > 2);
    if (!words.length) fail('Usage: precedent <ID> <words…>: the target (purchase.checkout.block.render), the component (s-image), the API or the feature (trust list)');
    // Archived changes here and in the sibling app repos (the folder that holds this one): the team's earlier answers to
    // the same placement, asset or API question (asmc ASM-924 missed seeberger-cms SEE-402's).
    const parent = dirname(ROOT);
    const ls = (d, opts) => { try { return readdirSync(d, opts); } catch { return []; } };
    const repos = [ROOT, ...ls(parent, { withFileTypes: true }).filter((e) => e.isDirectory() && join(parent, e.name) !== ROOT).map((e) => join(parent, e.name))];
    const hits = [];
    for (const repo of repos) {
      const arch = join(repo, 'appspec', 'archive');
      for (const dir of ls(arch)) {
        const text = (() => { try { return readFileSync(join(arch, dir, 'proposal.md'), 'utf8'); } catch { return ''; } })();
        const lower = text.toLowerCase();
        const matched = words.filter((w) => lower.includes(w));
        if (!matched.length) continue;
        const lines = text.split(/\r?\n/).filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 4).map((l) => l.trim().slice(0, 200));
        hits.push({ change: `${repo === ROOT ? '(this repo)' : repo.split(/[\\/]/).pop()}/appspec/archive/${dir}`, matched, lines });
      }
    }
    hits.sort((a, b) => b.matched.length - a.matched.length);
    // Other clients' repo and ticket names stay in the local logs: change.json and the proposal are committed and reach
    // this client's PR.
    st.precedent = { query: words.join(' '), at: now(), hits: hits.length };
    writeChange(cfg, id, st);
    mkdirSync(join(LOGS, id), { recursive: true });
    writeFileSync(join(LOGS, id, 'precedent.json'), `${JSON.stringify({ query: words, at: now(), hits: hits.slice(0, 10) }, null, 2)}\n`);
    print({ searched: `${repos.length} repos under ${parent}`, hits: hits.slice(0, 10),
      next: hits.length ? 'Read the closest hits\' proposal.md and handoff.md. Each borrowed pattern is an option, not a fact: check it in the docs for this app\'s API version (a sibling app\'s data-URI icons went against the s-image docs). In § Decided for you say what you took, as "an earlier change in another app": never another client\'s name or ticket.' : 'No earlier change matched: say "Precedent: none found" in § Decided for you.' });
    break;
  }

  case 'revert': {
    const id = normId(rawId);
    atStage(id, 'build', 'verify');
    // Resolved against the repo first: "app/../../x.ts" must not reach outside it.
    const files = rest.map((f) => relative(ROOT, resolve(ROOT, f)).replaceAll('\\', '/'));
    if (!files.length) fail('Usage: revert <ID> <file…>: app files with uncommitted edits to put back as committed');
    const bad = files.filter((f) => !f || f.startsWith('..') || isAbsolute(f) || !isAppCode(f));
    if (bad.length) fail(`Only app files in this repo (got ${bad.join(', ') || rest.join(', ')}).`);
    const tracked = files.filter((f) => run('git', ['ls-files', '--error-unmatch', '--', f]).code === 0);
    const untracked = files.filter((f) => !tracked.includes(f) && existsSync(join(ROOT, f)));
    // Kept first, so undoing the revert is git apply on the patch (or a copy back from the folder).
    const stamp = now().replace(/[:.]/g, '-');
    const dir = join(LOGS, id, `reverted-${stamp}`);
    mkdirSync(dir, { recursive: true });
    // --binary: an edited image or font must come back from the patch too. No patch, no checkout.
    if (tracked.length) {
      const d = run('git', ['diff', '--binary', 'HEAD', '--', ...tracked]);
      if (d.code !== 0) fail(`git diff failed, so nothing was reverted: ${d.stderr.trim()}`);
      writeFileSync(join(dir, 'changes.patch'), d.stdout);
    }
    for (const f of untracked) { mkdirSync(dirname(join(dir, 'new', f)), { recursive: true }); renameSync(join(ROOT, f), join(dir, 'new', f)); }
    if (tracked.length) { const r = run('git', ['checkout', 'HEAD', '--', ...tracked]); if (r.code !== 0) fail(`git checkout failed: ${r.stderr.trim()}. The patch is in ${dir}.`); }
    print(`Reverted ${[...tracked, ...untracked].join(', ') || 'nothing (no such files)'}. Kept in .claude/logs/${id}/${dir.split(/[\\/]/).pop()}/ (changes.patch: git apply it to undo; new/: files that weren't committed).`);
    break;
  }

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

  default:
    print(HELP);
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
