#!/usr/bin/env node
// Records where a ticket is in the pipeline: task state for /shopify-implement and /shopify-investigate, and
// the checks a stage must pass before it can be marked done.
// Usage: node .claude/kit/kit.mjs <verb> [<KEY>] ...   (--help lists the verbs)
// One folder per ticket: .claude/logs/<KEY>/ (state.json, brief.md, plan.md, report.md or investigation.md,
// kit-notes.md). Also reads the guard's _guard.jsonl and writes logs/kit-feedback.md and kit/probe.*.js.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  ROOT, KIT_DIR, LOGS, KIT_VERSION, STAGES, stagesFor, THEME_DIRS, MERCHANT_JSON, print, fail, parseArgs, normKey, now, run, git, currentBranch,
  readConfig, readState, writeState, owner, branchFor, protectedBranches, storefrontPath, parseCliJson, diagnosticJson, ignoreMatcher, TEST_SUFFIX,
  effectiveBase, namesKey, unMsys, unMsysFrom, mutationProblems, shopifyIgnore, themeDigest, retryDelay,
  authSessionProps, execErrorProps, lastVerified,
} from './lib.mjs';
import { due, newerVersion } from './update-check.mjs';

// ── Help and settable facts ──
const HELP = `Usage: node .claude/kit/kit.mjs <verb> ...
  list                                   all tasks in this repo and their stage
  start <KEY>                            create .claude/logs/<KEY>/ (state + brief.md, plan.md, report.md); turns a finished investigation into an implementation
  start <KEY> --investigate              start a read-only investigation instead (state + investigation.md)
  start <KEY> --test                     a test run of the kit: branch and draft named <KEY>-kit-test, the branch is never pushed
  status <KEY> [--json]                  current stage, the skill to load, gates, branch, draft
  done <KEY> <stage> [--answer "TEXT"]
                                         finish the current stage; gate stages need --answer with the dev's words
  back <KEY> <stage> --reason "TEXT"     reopen an earlier stage (plan changes, QA failures, client feedback)
  set <KEY> name=value [name=value ...]  record a fact: {SETTABLE}
  qa-row <KEY> <#> [--measured T] [--how T] [--verdict PASS|FAIL|NOT TESTED|BLOCKED]
                                         fill one row of report.md § Criteria (no hand-edited tables, no heredocs);
                                         PASS and FAIL need --measured and --how, on a draft at HEAD
  qa-row <KEY> <#,#,...> --carry "WHY"   keep PASS rows measured on an earlier commit: why the new commits can't affect them
  design-audit <KEY> <viewport>          exact design mode: write the file QA runs to check every design-checks.json value
  reach <KEY>                            files in plan.md § Files that reach beyond the feature (merchant JSON, layout,
                                         snippets, sections and assets used elsewhere, files .shopifyignore excludes);
                                         each goes in Needs your attention
  summary <KEY>                          time per stage, loops, gate answers, QA verdicts, store changes (for the PR)
  premerge <KEY>                         right before merging: commits on the remote branch after QA (editor saves on a
                                         GitHub-connected draft); exit 1 when there are any
  abandon <KEY> --reason "TEXT"          stop a task and list what to clean up (draft theme, store changes)
Kit feedback (problems with the kit itself, not the ticket)
  note <KEY> "TEXT" [--kind K]           record one; K: friction, mistake, kit-bug, missing, idea. Creates kit-notes.md on first use
  retro <KEY>                            what went wrong in this run, from the record: loops back, refused stages, guard blocks (optional)
  note <KEY> --none                      nothing the kit caused
  feedback                               every task's notes and signals in .claude/logs/kit-feedback.md, for the kit maintainer
  optout                                 create the Shopify plugin's telemetry opt-out file for this machine
  build-probe [--check]                  maintainers: regenerate kit/probe.inject.js and probe.init.js after changing
                                         kit/probe.js; --check exits 1 if they don't match it
  --selftest                             test the pure helpers`;

/** HELP's lines for one verb: each line that starts with it, plus the indented continuation lines after it. */
function verbHelp(verb) {
  const out = [];
  let inVerb = false;
  for (const l of HELP.split('\n').slice(1)) {
    if (!l.startsWith(' ')) inVerb = false;
    else if (/^ {2}\S/.test(l)) inVerb = l.trim().split(/\s/)[0] === verb;
    if (inVerb) out.push(l);
  }
  return out;
}

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : fail(`Expected one of: ${allowed.join(', ')}`));
const TYPES = { implement: ['abtest', 'feature', 'bugfix'], investigation: ['feasibility', 'debug', 'question'] };
const SETTABLE = {
  type: String, // checked against the task's kind in "set"
  branch: String,
  base: String,
  // The theme that follows the base branch, when live is a campaign theme on another branch (the guard asks).
  baseTheme: (v) => (/^\d+$/.test(v) ? Number(v) : fail('baseTheme must be a numeric theme id')),
  'abtest.tool': String,
  'abtest.running': oneOf('yes', 'no', 'unknown'),
  'abtest.reference': String,
  'design.figma': String, // a Figma link, or "none"
  'design.mode': oneOf('exact', 'reference'), // the agent picks it at analyze and tells the dev, who can switch
  featurePrefix: String,
  buildOutputs: list,
  'qa.paths': (v) => list(v).map(storefrontPath),
  'draft.themeId': (v) => (/^\d+$/.test(v) ? Number(v) : fail('draft.themeId must be a numeric theme id')),
  'draft.route': oneOf('cli', 'manual', 'github'),
  'draft.name': String,
  'draft.previewUrl': String,
  'draft.editorUrl': String,
};

// ── Reading the task's markdown ──
// The logs start as copies of kit/templates/, so checks look only at what a section adds to its template.
const TEMPLATES = ['brief.md', 'plan.md', 'report.md'];
const kindOf = (st) => st?.kind || 'implement';
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const tpl = (key, file) => read(join(KIT_DIR, 'templates', file)).replaceAll('{{KEY}}', key);

/** Lines under a heading (matched by its start, e.g. "## Found"), up to the next heading of the same or higher level. */
function sectionLines(md, heading) {
  const level = heading.match(/^#+/)[0].length;
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading || l.trim().startsWith(`${heading} `) || l.trim().startsWith(`${heading}(`));
  if (start === -1) return [];
  let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).map((l) => l.trim());
}

/** Lines a section gained over the template, so an untouched template never counts as filled. */
function added(key, file, heading, within) {
  const pick = (md) => (within ? sectionLines(sectionLines(md, within).join('\n'), heading) : sectionLines(md, heading));
  const base = new Set(pick(tpl(key, file)));
  return pick(read(join(LOGS, key, file))).filter((l) => l && !base.has(l) && !/^#+\s/.test(l));
}

const filled = (key, file, heading, within) => added(key, file, heading, within).some(Boolean);
/**
 * Whether a task's document has this heading at all. A section a later kit version added to the template is required
 * only where the heading exists: a kit update mustn't fail a task already past the gate it was written for.
 */
const hasHeading = (key, file, heading) => read(join(LOGS, key, file)).split(/\r?\n/).some((l) => l.trim() === heading || l.trim().startsWith(`${heading} `));
const tableRows = (key, file, heading, within) => added(key, file, heading, within).filter((l) => l.startsWith('|') && !/^\|[\s:|-]+\|?$/.test(l));
const stageIndex = (name, st) => stagesFor(st).findIndex((s) => s.name === name);
const ref = (r) => git(['rev-parse', '--verify', '--quiet', r], { allowFail: true });
/** Cells of a markdown table row; "\|" stays inside its cell. */
const cells = (row) => row.replace(/^\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
/**
 * Rows whose last recorded verdict is FAIL on a commit other than the draft's current one:
 * the fix was never re-measured.
 */
const staleFails = (rows = {}, head) => Object.entries(rows).filter(([, r]) => r.verdict === 'FAIL' && r.commit && head && r.commit !== head).map(([n]) => n);
/**
 * PASS rows measured on an earlier commit, when theme files changed between that commit and the draft's:
 * a fix loop can break what passed. Re-measured, or carried with a reason (qa-row --carry).
 */
function stalePasses(rows = {}, head) {
  const changed = new Map();
  const since = (c) => {
    if (!changed.has(c)) {
      const r = run('git', ['diff', '--quiet', c, head, '--', ...THEME_DIRS]);
      changed.set(c, r.code !== 0); // 1: files differ; anything else (a commit gone after a rebase) can't be vouched for
    }
    return changed.get(c);
  };
  return Object.entries(rows).filter(([, r]) => r.verdict === 'PASS' && r.commit && head && r.commit !== head && r.carriedTo !== head && since(r.commit)).map(([n]) => n);
}
const saysNone = (key, file, heading, within) => /^((none|n\/a)\b|—)/i.test(added(key, file, heading, within).join(' ').replace(/^[-*]\s*/, ''));
const hasDesign = (st) => Boolean(st.design?.figma) && st.design.figma !== 'none';
const VERDICTS = ['PASS', 'FAIL', 'NOT TESTED', 'BLOCKED'];
/** Words that say a PASS isn't whole: what couldn't be shown belongs in its own NOT TESTED or BLOCKED row. */
const HEDGE = /\b(?:not provable|can(?:no|')t (?:be )?prove[nd]?|not (?:yet )?(?:verified|measured|tested|checked|shown)|unverified|untested|assumed|only partly|partially)\b|\blimit(?:ation)?s?\s*:/i;
/** A report row's verdict: the last verdict word in a cell, since Verdict is the last column. */
const rowVerdict = (row) => [...row.matchAll(/\|\s*\**(PASS|FAIL|NOT TESTED|BLOCKED)\b/g)].pop()?.[1] || null;
const short = (sha) => (sha ? sha.slice(0, 7) : 'none');
/** A bug fix's QA criterion that reproduces the bug: named as a repro, and says what live shows. */
const reproRows = (rows) => rows.filter((r) => /\brepro(duc\w*)?\b/i.test(r) && /\blive\b/i.test(r));
/** A repro measurement shows both sides, in either order: it fails on live and passes on the draft. */
/**
 * A repro row's two halves, "live: … ; draft: …": live shows the bug and the draft something else. Checking only that
 * both words appear let "live: not reproduced; draft: ok" pass.
 */
const bothSides = (measured) => {
  const half = (side) => String(measured || '').match(new RegExp(`\\b${side}\\s*:\\s*([^;]*)`, 'i'))?.[1]?.trim() || '';
  const live = half('live');
  const draft = half('draft');
  return Boolean(live && draft) && live.toLowerCase() !== draft.toLowerCase() && !/not reproduc|couldn'?t reproduc|can'?t reproduc|no (bug|issue|error)|\bworks\b/i.test(live);
};
const rowNum = (row) => cells(row)[0].replace(/\*/g, '');
/** plan.md § QA criteria: each number → the rest of its row, the text qa-row records with a measurement. */
const planCriteria = (key) => new Map(tableRows(key, 'plan.md', '## QA criteria').filter((r) => /^\d+$/.test(rowNum(r))).map((r) => [rowNum(r), cells(r).slice(1).join(' | ')]));

// ── Since the plan was approved ──
// Gate 1 approves plan.md; later edits aren't refused, they are listed for the dev at Gate 2 (accept).

const APPROVED_PLAN = 'plan.approved.md';
/** plan.md without § As built, which the builder appends to after approval. */
function planBody(md) {
  let skip = false;
  return `${md.split(/\r?\n/).filter((l) => { if (/^##\s/.test(l)) skip = /^##\s+As built\b/i.test(l.trim()); return !skip; }).join('\n').trimEnd()}\n`;
}

/** Lines added (+) and removed (-) in plan.md since Gate 1, or null when there is no approved copy (approved before kit 1.1.0's listing). */
function planDiff(key) {
  const approved = join(LOGS, key, APPROVED_PLAN);
  if (!existsSync(approved)) return null;
  const dir = mkdtempSync(join(tmpdir(), 'kit-plan-'));
  try {
    writeFileSync(join(dir, 'plan.md'), planBody(read(join(LOGS, key, 'plan.md'))));
    const r = run('git', ['diff', '--no-index', '--no-color', '-U0', approved, join(dir, 'plan.md')]);
    return r.stdout.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).map((l) => l.slice(0, 200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** What the dev should see before accepting: files the plan didn't name, and the plan's changes since Gate 1. */
function sinceApproval(key, st) {
  const planned = planPaths(key).map(globRe);
  const unplanned = st.branch && st.base ? branchDiff(st).filter((f) => !planned.some((re) => re.test(f))) : [];
  const reaching = new Map(reach(key, unplanned).map((x) => [x.file, x.reach]));
  const diff = planDiff(key);
  return [
    `Changed files plan.md § Files doesn't name: ${unplanned.length ? unplanned.map((f) => (reaching.has(f) ? `${f} (${reaching.get(f)})` : f)).join(', ') : 'none'}`,
    diff === null ? 'plan.md changes since approval: no approved copy to compare (approved before this kit version)'
      : diff.length ? `plan.md changes since approval (${diff.length} lines):\n${diff.slice(0, 40).map((l) => `  ${l}`).join('\n')}${diff.length > 40 ? `\n  … ${diff.length - 40} more` : ''}`
        : 'plan.md changes since approval: none',
  ];
}

// ── Brief and plan checks ──
// Helpers for the plan exit below; reach() also backs the reach verb.

/** The hard-coded list: each entry that touches an editability AC must have been asked on its own. */
function staysInCodeProblems(key) {
  const within = '## Decided';
  const rows = tableRows(key, 'brief.md', '#### Stays in code', within);
  if (!rows.length && !saysNone(key, 'brief.md', '#### Stays in code', within)) return ['fill brief.md § Control surface → Stays in code (one row per value the merchant can\'t change, or "none")'];
  const decided = added(key, 'plan.md', '### Decided for you', '## At a glance').join('\n').toLowerCase();
  return rows.flatMap((r) => {
    const [value, ac = '', why = '', agreed = ''] = cells(r);
    if (!ac) return [`Stays in code → "${value}": name the editability AC it touches, or "none"`];
    if (!why) return [`Stays in code → "${value}": say why it stays in code`];
    // A design constant (spacing, a breakpoint) is listed under Decided for you and approved with the plan; content the
    // merchant would change (text, images, links, which items show) is asked as its own question (Q#).
    if (!/^none\b/i.test(ac) && !/Q\s*\d+|Gate 1|Decided for you/i.test(agreed)) return [`Stays in code → "${value}" touches ${ac}. A design constant: list it under plan.md → Decided for you and write "Gate 1" in "Dev agreed". Content the merchant would change: ask it as its own question (Q#), or make it editable`];
    // "Gate 1" counts only when the dev can see it there: the value is named under Decided for you.
    if (!/^none\b/i.test(ac) && !/Q\s*\d+/i.test(agreed) && hasHeading(key, 'plan.md', '### Decided for you')
      && !decided.includes(value.replace(/[*`]/g, '').trim().toLowerCase().split(/[\s(,]/)[0])) {
      return [`Stays in code → "${value}" says Gate 1, but plan.md → Decided for you doesn't name it: list it there, so the dev sees it before approving`];
    }
    return [];
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How far a file the plan changes reaches beyond the feature, or null. A mistake in one of these shows up
 * in things that already exist, so Gate 2 names each one first. texts: theme path → content, as the code is now.
 */
function reachOf(path, texts) {
  const name = path.split('/').pop();
  const id = escapeRe(name.replace(/\.liquid$/, ''));
  const others = [...texts].filter(([p]) => p !== path);
  const count = (re) => others.filter(([, t]) => re.test(t)).length;
  if (MERCHANT_JSON.test(path)) return 'merchant-owned: admin edits land here, and the merge overwrites any made on live since the base';
  if (path.startsWith('layout/')) return 'renders on every page';
  if (path === 'config/settings_schema.json') return 'theme settings for the whole store';
  // One level up only: a snippet the layout renders (cart drawer, header parts) is on every page, however few files use it.
  const renders = (snippet) => new RegExp(`\\b(render|include)\\s+['"]${escapeRe(snippet)}['"]`);
  if (path.startsWith('snippets/')) {
    const re = renders(name.replace(/\.liquid$/, ''));
    if (others.some(([p, t]) => p.startsWith('layout/') && re.test(t))) return 'rendered from the layout, so on every page';
    const n = count(re);
    return n > 1 ? `rendered from ${n} files` : null;
  }
  if (path.startsWith('sections/') || path.startsWith('blocks/')) {
    const used = new RegExp(`"type"\\s*:\\s*"${id}"|\\bsections?\\s+['"]${id}['"]`);
    if (others.some(([p, t]) => (p.startsWith('layout/') || /^sections\/[^/]+\.json$/.test(p)) && used.test(t))) return 'in the layout or a section group, so on every page';
    const n = count(used);
    return n > 1 ? `used in ${n} templates or sections` : null;
  }
  if (path.startsWith('assets/')) {
    if (others.some(([p, t]) => p.startsWith('layout/') && t.includes(name))) return 'loaded on every page (layout)';
    const viaLayout = others.find(([p, t]) => p.startsWith('snippets/') && t.includes(name)
      && others.some(([q, u]) => q.startsWith('layout/') && renders(p.split('/').pop().replace(/\.liquid$/, '')).test(u)));
    if (viaLayout) return `loaded on every page (${viaLayout[0]}, which the layout renders)`;
    const n = count(new RegExp(`['"]${escapeRe(name)}['"]`));
    return n > 1 ? `loaded by ${n} files` : null;
  }
  return null;
}

/** Every theme path (or glob, for a grouped row) a § Files cell names: each backticked one, else each path-like word. */
function cellPaths(cell) {
  const ticked = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim().split(/\s+/)[0]);
  return (ticked.length ? ticked : cell.split(/[\s,;]+/)).filter((p) => /^[\w.-]+\/\S/.test(p));
}
const planPaths = (key) => [...new Set(tableRows(key, 'plan.md', '## Files').flatMap((r) => cellPaths(cells(r)[0])))];
const globRe = (p) => new RegExp(`^${p.split('**').map((part) => part.split('*').map(escapeRe).join('[^/]*')).join('.*')}$`);

/**
 * Files that reach beyond the feature: plan.md § Files by default, or the given paths (the branch's diff at build).
 * A file .shopifyignore excludes is listed too, new or not: push can't upload it, so the dev decides at Gate 1 how it gets there.
 */
function reach(key, given) {
  const ignored = shopifyIgnore();
  const named = (given || planPaths(key)).filter((p) => p && !/[*?]/.test(p));
  const skipped = named.filter(ignored).map((file) => ({ file, reach: '.shopifyignore excludes it, so push can\'t upload it: an admin step, or take it out of .shopifyignore' }));
  const paths = named.filter((p) => !ignored(p) && existsSync(join(ROOT, p)));
  if (!paths.length) return skipped;
  const texts = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.(liquid|json)$/.test(e.name)) texts.set(`${dir}/${e.name}`, read(join(ROOT, dir, e.name)));
    }
  };
  for (const d of THEME_DIRS) if (existsSync(join(ROOT, d))) walk(d);
  // Templates git ignores (VSD-354: templates/*.json) aren't on disk, so a section's uses would be missed: read the copies
  // pull-live saved instead, and say so when there are none.
  const live = join(LOGS, key, 'live');
  const walkLive = (dir) => {
    for (const e of readdirSync(join(live, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walkLive(`${dir}/${e.name}`);
      else if (/\.json$/.test(e.name) && !texts.has(`${dir}/${e.name}`)) texts.set(`${dir}/${e.name}`, read(join(live, dir, e.name)));
    }
  };
  for (const d of ['templates', 'sections']) if (existsSync(join(live, d))) walkLive(d);
  const noTemplates = ![...texts.keys()].some((p) => /^templates\/.+\.json$/.test(p))
    ? [{ file: 'templates/*.json', reach: 'no JSON templates in the repo or in logs/<KEY>/live, so where sections are used is unknown: shopify.mjs pull-live <KEY> "templates/*.json", then run reach again' }] : [];
  return [...skipped, ...noTemplates, ...paths.map((file) => ({ file, reach: reachOf(file, texts) })).filter((x) => x.reach)];
}

/** At a glance opens with what can affect what already exists. */
function glanceProblems(key) {
  // Only § What changes: a row under Not proven yet doesn't list the files.
  const rows = tableRows(key, 'plan.md', '### What changes', '## At a glance');
  const attention = added(key, 'plan.md', '### Needs your attention', '## At a glance');
  const said = attention.join('\n').toLowerCase();
  const indep = added(key, 'plan.md', '### Independent check', '## At a glance').join('\n');
  const unnamed = reach(key).filter((x) => !said.includes(x.file.toLowerCase()) && !said.includes(x.file.split('/').pop().toLowerCase()));
  // Definitions and the mutation files the plan wrote; QA data that only names existing products writes nothing.
  const mutations = join(LOGS, key, 'mutations');
  const storeWrites = (filled(key, 'plan.md', '### Definitions', '## Store setup') && !saysNone(key, 'plan.md', '### Definitions', '## Store setup'))
    || (existsSync(mutations) && readdirSync(mutations).some((f) => f.endsWith('.graphql')));
  return [
    !attention.length && 'fill plan.md § At a glance → ### Needs your attention: what this change can affect beyond the new feature, most impact first, or "none: only new files the feature owns"',
    unnamed.length && `Needs your attention doesn't name ${unnamed.map((x) => `${x.file} (${x.reach})`).join('; ')}. For each, say what could change for what already uses it, and how the plan contains it`,
    storeWrites && !/\bstore\b|definition|metaobject|metafield/.test(said) && 'Needs your attention: name the store writes (definitions, QA values) and whether they show on live before the merge',
    !rows.length && 'fill plan.md § At a glance → ### What changes: one row per file (or file group), "What happens" in 15 words at most',
    hasHeading(key, 'plan.md', '### Independent check') && (!/Surprises\s*:/i.test(indep) || !/Unlisted assumptions\s*:/i.test(indep))
      ? 'plan.md § At a glance → ### Independent check needs the outcome-checker agent\'s plan pass: run it (mode plan), fix what it finds, and record its "Surprises:" and "Unlisted assumptions:" lines there'
      : false,
  ];
}

/** The "Differs from the ticket" bullet under plan.md § At a glance, as lines. */
function differsLines(plan) {
  const glance = sectionLines(plan, '## At a glance');
  const from = glance.findIndex((l) => /^- \*\*Differs/.test(l));
  const to = from === -1 ? -1 : glance.findIndex((l, i) => i > from && /^- \*\*/.test(l));
  return from === -1 ? [] : glance.slice(from, to === -1 ? undefined : to);
}

/**
 * The handoff tells the client what differs from what they asked (all four real handoffs before 1.14 left it out),
 * in text they can open, and warns QA off saving in a GitHub-connected draft's editor (CHE-865).
 */
function handoffTextProblems(key, st) {
  const plan = read(join(LOGS, key, 'plan.md'));
  const differACs = [...acRefs(differsLines(plan).join('\n'))];
  // brief.md § Decided → Questions and answers: # | Question | … ; a client's call starts its Question that way.
  const clientQs = tableRows(key, 'brief.md', '### Questions and answers', '## Decided').map(cells)
    .filter((c) => /^client'?s call/i.test(c[1] || '')).map((c) => c[0].replace(/^Q?/i, 'Q'));
  const table = tableRows(key, 'report.md', '### What differs from what was asked', '## Handoff').map((r) => cells(r)[0] || '').join(' ');
  const tableACs = acRefs(table);
  const missing = [...differACs.filter((n) => !tableACs.has(n)).map((n) => `AC ${n}`), ...clientQs.filter((q) => !new RegExp(`\\b${q}\\b`, 'i').test(table))];
  const jira = added(key, 'report.md', '### Jira comment', '## Handoff').join('\n');
  const jiraACs = acRefs(jira);
  const notTold = [...tableACs].filter((n) => !jiraACs.has(n)).map((n) => `AC ${n}`);
  const pr = added(key, 'report.md', '### PR', '## Handoff').join('\n');
  const check = added(key, 'report.md', '### Client check', '## Handoff').join('\n');
  // Since 1.15.0 the agent decides what customers see itself and marks it "(client's call)" under Decided for you:
  // those reach the client too, as rows whose Ref says "client's call".
  const decidedForClient = added(key, 'plan.md', '### Decided for you', '## At a glance').filter((l) => /\(client'?s call\)/i.test(l)).length;
  const clientRows = (table.match(/client'?s call/gi) || []).length;
  // A row QA didn't PASS is named in the PR, so nobody reads "works" where it wasn't verified (GSD-80's on/off switch).
  const notVerified = Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict && r.verdict !== 'PASS').map(([n]) => n);
  const unnamed = notVerified.filter((n) => !new RegExp(`#${n}\\b`).test(pr));
  return [
    hasHeading(key, 'report.md', '### What differs from what was asked') && missing.length && `report.md § Handoff → What differs from what was asked has no row for ${missing.join(', ')} (from plan.md → Differs and brief.md's "Client's call" questions): say what the client gets instead, in their words`,
    hasHeading(key, 'report.md', '### What differs from what was asked') && clientRows < decidedForClient && `plan.md → Decided for you has ${decidedForClient} decision(s) marked "(client's call)", and What differs from what was asked has ${clientRows} row(s) with "client's call" as its Ref: give each its own row, in the client's words, so the Jira comment tells them`,
    unnamed.length && `the PR doesn't name the QA rows that weren't verified (${unnamed.map((n) => `#${n}`).join(', ')}): list each with its verdict, so the PR claims nothing QA didn't show`,
    filled(key, 'report.md', '## Handoff') && !jira.trim() && 'write report.md § Handoff → Jira comment',
    jira.trim() && notTold.length && `the Jira comment doesn't tell the client about ${notTold.join(', ')}: add each row of What differs from what was asked, in their words, with its AC`,
    /\.claude[\\/]logs|\b(report|plan|brief)\.md\b/i.test(`${pr}\n${jira}`) && 'the PR or the Jira comment points to the kit\'s files (.claude/logs/…, report.md, plan.md), which git ignores: paste what reviewers need inline',
    st.draft?.route === 'github' && jira.trim() && !/\bsav(e|ing)\b/i.test(jira) && 'the draft is GitHub-connected: the Jira comment must ask reviewers not to press Save in its theme editor (each save becomes a commit on the branch under review)',
    hasHeading(key, 'report.md', '### Client check') && filled(key, 'report.md', '## Handoff') && !/Client surprises\s*:/i.test(check) && 'report.md § Handoff → Client check needs the outcome-checker agent\'s handoff pass: run it (mode handoff), fix the Jira comment by it, and record its "Client surprises:" line',
  ];
}

// ── Retro signals ──

/**
 * What the record shows went wrong in a run. The guard log has no task key: it is matched by time, and an entry made on
 * another task's branch is dropped (the base branch is kept: intake and plan run there). Gate answers aren't blocks.
 */
function retroSignals(key, st) {
  const events = st.history || [];
  const refused = {};
  for (const e of events.filter((x) => x.event === 'refused')) (refused[e.stage] ||= []).push(...(e.missing || []));
  const from = st.createdAt;
  const to = st.stage === 'done' || st.stage === 'abandoned' ? st.updatedAt : now();
  const prot = protectedBranches(readConfig({ required: false }) || {});
  const ours = (b) => !b || !st.branch || b === st.branch || prot.includes(b);
  const guardBlocks = read(join(LOGS, '_guard.jsonl')).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    // kind: deny (a block worth checking for a false positive), ask (a prompt the dev answered), log (allowed, noted).
    .filter((g) => g && !g.gate && g.at >= from && g.at <= to && ours(g.branch)).map((g) => `${g.at.slice(0, 16)} [${g.kind || 'deny'}] ${g.reason.slice(0, 110)} ← ${g.command.slice(0, 90)}`);
  const verdicts = tableRows(key, 'report.md', '## Criteria').map((l) => (l.match(/\|\s*\**(FAIL|NOT TESTED|BLOCKED)\b/) || [])[1]).filter(Boolean);
  return {
    loopsBack: events.filter((e) => e.event === 'back').map((e) => `${e.from} → ${e.to}: ${e.reason}`),
    refusedStages: Object.entries(refused).map(([s, m]) => `${s} ×${events.filter((e) => e.event === 'refused' && e.stage === s).length}: ${[...new Set(m)].slice(0, 3).join(' / ')}`),
    guardBlocks,
    qaNotPassed: verdicts.length ? Object.entries(countOf(verdicts)).map(([v, n]) => `${n} ${v}`).join(', ') : 'none',
    gateAnswers: Object.fromEntries(Object.entries(st.gates || {}).map(([g, v]) => [g, v.answer])),
    notesSoFar: events.filter((e) => e.event === 'note' && !e.none).length,
  };
}

const countOf = (xs) => xs.reduce((acc, x) => ({ ...acc, [x]: (acc[x] || 0) + 1 }), {});

const RETRO_ASK = 'For each signal, decide whether the kit caused it (an instruction that misled, a missing verb, a check that wanted something unclear, a guard block on a harmless command) or the ticket did. '
  + 'Also count what the dev had to correct and anything you worked around. Record each kit cause: kit.mjs note <KEY> "<what happened> → <what would have prevented it>" --kind <kind>. '
  + 'Nothing kit-caused: kit.mjs note <KEY> --none.';

// ── Stage exit checks ──
// Each check proves the stage's output exists, so a stage can't be marked done on intent alone.
const EXIT_CHECKS = {
  intake: (key, st) => [
    !st.type && 'record the work type: kit.mjs set <KEY> type=abtest|feature|bugfix',
    !filled(key, 'brief.md', '### Acceptance criteria', '## Asked') && 'quote the acceptance criteria in brief.md § Asked → Acceptance criteria',
    !tableRows(key, 'brief.md', '### What the tickets say should be editable', '## Asked').length && !saysNone(key, 'brief.md', '### What the tickets say should be editable', '## Asked')
      && 'fill brief.md § Asked → What the tickets say should be editable: every line about who changes what, quoted in full (or "none")',
    st.type === 'abtest' && !st.abtest?.tool && 'record the testing tool (needed for the go-live order): kit.mjs set <KEY> abtest.tool=<tool>',
    st.type === 'abtest' && !st.abtest?.running && 'record whether the experiment still runs: kit.mjs set <KEY> abtest.running=yes|no|unknown',
  ],
  analyze: (key, st) => [
    !filled(key, 'brief.md', '### Render path', '## Found') && 'fill brief.md § Found → Render path',
    !filled(key, 'brief.md', '### Closest existing pattern', '## Found') && 'fill brief.md § Found → Closest existing pattern',
    st.type === 'abtest' && !filled(key, 'brief.md', '### A/B inventory', '## Found') && 'fill brief.md § Found → A/B inventory',
    hasDesign(st) && !tableRows(key, 'design.md', '## Elements').length
      && 'run the design-extractor agent and write .claude/logs/<KEY>/design.md from .claude/kit/templates/design.md (or kit.mjs set <KEY> design.figma=none to skip the design check)',
    hasDesign(st) && !st.design?.mode && 'pick the design check\'s mode and tell the dev in one line: kit.mjs set <KEY> design.mode=exact|reference',
    hasDesign(st) && designChecks(key).problem && `write .claude/logs/<KEY>/design-checks.json from the extractor's JSON (${designChecks(key).problem})`,
  ],
  // The questions are asked (AskUserQuestion) before the plan is written, so the plan exit checks their record too.
  plan: (key, st) => [
    !tableRows(key, 'brief.md', '### Control surface', '## Decided').length && !/no dynamic|none/i.test(added(key, 'brief.md', '### Control surface', '## Decided').join(' '))
      && 'fill brief.md § Decided → Control surface (one row per value, or say "none")',
    ...staysInCodeProblems(key),
    !tableRows(key, 'brief.md', '### Questions and answers', '## Decided').length && !saysNone(key, 'brief.md', '### Questions and answers', '## Decided')
      && 'record the questions you asked and the dev\'s answers in brief.md § Decided → Questions and answers, or "none: nothing needed the dev\'s call"',
    hasHeading(key, 'plan.md', '### Decided for you') && !filled(key, 'plan.md', '### Decided for you', '## At a glance')
      && 'fill plan.md § At a glance → ### Decided for you: one line per decision you took without asking (what, and why in a few words), most consequential first, or "none"',
    ...glanceProblems(key),
    ...unprovenProblems(key),
    ...acCoverageProblems(key),
    ...(hasDesign(st) && st.design?.mode === 'exact' ? exactDesignProblems(key) : []),
    !tableRows(key, 'plan.md', '## Files').length && 'fill plan.md § Files (builder detail): one table row per file',
    !planCriteria(key).size && 'write plan.md § QA criteria: one numbered row per criterion',
    st.type === 'bugfix' && !reproRows(tableRows(key, 'plan.md', '## QA criteria')).length
      && 'a bug fix needs a QA criterion that reproduces the bug: a row starting "Repro:", whose Expected says what live shows today (the failure) and what the draft must show',
  ],
  // Files outside the plan and plan edits since Gate 1 aren't refused: done build lists them, and Gate 2 shows them.
  build: (key, st) => {
    if (!st.branch || !st.base) return ['record branch and base: kit.mjs set <KEY> branch=... base=<sha>'];
    const dirty = git(['status', '--porcelain', '--', ...existingThemeDirs()], { allowFail: true });
    const ahead = Number(git(['rev-list', '--count', `${effectiveBase(st, readConfig({ required: false }))}..HEAD`], { allowFail: true }) || 0);
    const check = st.check;
    // A check counts for the content it ran on. A record made before the kit stored that content has none: check runs once more.
    const stale = check && check.content !== themeDigest();
    const refs = ahead > 0 ? ticketRefs(key, st) : [];
    return [
      refs.length && `code comments name the ticket, an AC or a plan question (${refs.slice(0, 6).join(', ')}${refs.length > 6 ? ` and ${refs.length - 6} more` : ''}). The PR and plan.md hold those: keep the comment's why and drop the reference, then commit and run check again`,
      currentBranch() !== st.branch && `check out the task branch ${st.branch}`,
      dirty && 'commit the theme changes on the task branch',
      ahead === 0 && 'the branch has no commits beyond its base yet',
      !check && 'no theme check recorded: run shopify.mjs check <KEY> (the builder runs it on its changes)',
      stale && `theme check last ran on other theme files than the branch has now (at ${short(check.head)}${check.dirty ? ' with uncommitted changes' : ''}). Run shopify.mjs check <KEY> again`,
      !stale && check?.introducedErrors > 0
        && `theme check's last run (${short(check.head)}${check.dirty ? ' with uncommitted changes' : ''}) found ${check.introducedErrors} errors this branch introduced. Fix them (fix mode), then run check again`,
    ];
  },
  draft: (key, st) => {
    if (!st.draft?.themeId) return ['create the draft: shopify.mjs draft <KEY>'];
    const head = ref(`refs/heads/${st.branch}`);
    if (st.draft.route === 'github') {
      return [
        !branchPushed(st) && `a GitHub-connected draft updates from the branch: run git push -u origin ${st.branch}, then node .claude/kit/shopify.mjs verify <KEY>`,
        branchPushed(st) && st.draft.verifiedCommit !== head && 'check that Shopify synced the branch: run node .claude/kit/shopify.mjs verify <KEY> (done draft passes only after verify has matched this commit)',
      ];
    }
    return [st.draft.verifiedCommit !== head && st.draft.lastPushedCommit !== head && 'push the current commit: shopify.mjs push <KEY>'];
  },
  qa: (key, st) => {
    const head = st.draft?.verifiedCommit || st.draft?.lastPushedCommit;
    const rec = st.qa?.rows || {};
    const rows = tableRows(key, 'report.md', '## Criteria');
    const open = rows.filter((l) => /\|\s*\**(BLOCKED|NOT TESTED)\b/.test(l)).length;
    // Every criterion the plan numbers, not a count: extra by-hand rows mustn't stand in for a missing one.
    const plan = planCriteria(key);
    const missing = [...plan.keys()].filter((n) => !rec[n]?.verdict);
    // Measured against other text: the dev changed or renumbered the criterion since. Older records carry no text.
    const changed = [...plan].filter(([n, text]) => rec[n]?.verdict && rec[n].criterion !== undefined && rec[n].criterion !== text).map(([n]) => n);
    // The table shows what qa-row recorded: a verdict typed in, edited or blanked since has no measurement behind it.
    const shown = new Map(rows.map((l) => [rowNum(l), rowVerdict(l)]));
    const handWritten = [...new Set([...shown.keys(), ...plan.keys()])].filter((n) => (shown.get(n) || null) !== (rec[n]?.verdict || null));
    const stale = staleFails(rec, head);
    const carried = stalePasses(rec, head);
    const oneSided = st.type === 'bugfix'
      ? reproRows(tableRows(key, 'plan.md', '## QA criteria')).map((r) => cells(r)[0]).filter((n) => rec[n]?.verdict === 'PASS' && !bothSides(rec[n].measured)) : [];
    return [
      missing.length && `plan criteria ${missing.join(', ')} have no verdict recorded with kit.mjs qa-row`,
      draftBehind(st),
      changed.length && `plan criteria ${changed.join(', ')} changed in plan.md after they were measured: copy the new text into report.md and measure them again with kit.mjs qa-row`,
      handWritten.length && `rows ${handWritten.join(', ')} in report.md don't show the verdict kit.mjs qa-row recorded (typed in, edited or blanked by hand). Record each with kit.mjs qa-row <KEY> <#> --measured "…" --how "…" --verdict …`,
      stale.length && `rows ${stale.join(', ')} failed on an earlier commit and weren't measured again on the current draft: re-measure them and record each with kit.mjs qa-row`,
      carried.length && `rows ${carried.join(', ')} passed on an earlier commit, and theme files changed since. Re-measure them, or for rows the change can't affect: kit.mjs qa-row <KEY> ${carried.join(',')} --carry "<why not>"`,
      oneSided.length && `repro rows ${oneSided.join(', ')}: record both sides in Measured, "live: … ; draft: …". A repro that wasn't seen failing on live proves nothing about the fix`,
      !filled(key, 'report.md', '## Summary') && 'write report.md § Summary',
      open && !filled(key, 'report.md', '## You must still do') && `${open} rows are BLOCKED or NOT TESTED: list what the dev must do for each in report.md § You must still do`,
    ];
  },
  handoff: (key, st) => {
    const head = ref(`refs/heads/${st.branch}`);
    return [
      !filled(key, 'report.md', '## Handoff') && 'write report.md § Handoff',
      ...handoffTextProblems(key, st),
      !st.test && !branchPushed(st) && `push the task branch: git push -u origin ${st.branch}`,
      draftBehind(st),
      // With branchPushed, this makes the pushed head the commit QA measured.
      st.qa?.commit && head !== st.qa.commit
        && `${st.branch} has commits QA didn't check (QA'd ${short(st.qa.commit)}, the branch is at ${short(head)}). Go back: kit.mjs back <KEY> qa --reason "commits after QA", push the draft, and re-measure what they touch`,
    ];
  },
  // Investigation stages: gather (the question, then the evidence), then the conclude gate.
  gather: (key, st) => {
    // Columns: # | Claim | Label | Source.
    const evidence = tableRows(key, 'investigation.md', '## Evidence').map(cells);
    const confirmed = evidence.filter((c) => /^Confirmed\b/i.test(c[2] || ''));
    const unsourced = confirmed.filter((c) => !c[3]).map((c) => `#${c[0]}`);
    // Requirements: # | Requirement | Owner | Clear? | Asked → answer. Client gets: Req | Surface | What the client gets | Differs.
    const reqs = st.type === 'feasibility' ? tableRows(key, 'investigation.md', '## Requirements').map(cells) : [];
    const reqId = (s) => s.match(/^R?(\d+)$/i)?.[1];
    const noOwner = reqs.filter((c) => !/^(Dev|Client)\b/i.test(c[2] || '')).map((c) => c[0] || '?');
    const gets = tableRows(key, 'investigation.md', '## Client gets').map(cells);
    const covered = new Set(gets.flatMap((c) => [...(c[0] || '').matchAll(/R?(\d+)/gi)].map((m) => m[1])));
    const uncovered = reqs.map((c) => c[0]).filter((id) => reqId(id) && !covered.has(reqId(id)));
    // A surface the requirement names needs its own row: one "storefront" row passed GSD-80's checkout requirement.
    const SURFACES = ['checkout', 'cart', 'mobile', 'desktop', 'email', 'thank you', 'account'];
    const surfaceGaps = reqs.filter((c) => reqId(c[0])).flatMap((c) => SURFACES
      .filter((s) => new RegExp(`\\b${s}`, 'i').test(c[1] || ''))
      .filter((s) => !gets.some((g) => [...(g[0] || '').matchAll(/R?(\d+)/gi)].some((m) => m[1] === reqId(c[0])) && new RegExp(`\\b${s}`, 'i').test(g[1] || '')))
      .map((s) => `${c[0]} on ${s}`));
    return [
      !st.type && 'record the kind of investigation: kit.mjs set <KEY> type=feasibility|debug|question',
      !filled(key, 'investigation.md', '## Question') && 'write the precise question and what counts as answered in investigation.md § Question',
      st.type === 'feasibility' && !reqs.length
        && 'list each requirement in investigation.md § Requirements (quoted, its owner, clear or not, and the answer to each open one)',
      noOwner.length && `give each requirement an owner in investigation.md § Requirements' Owner column (${noOwner.join(', ')}): Dev for how it's built, Client for what customers see. Client rows the ticket doesn't settle go to the Jira comment as questions`,
      uncovered.length && `investigation.md § Client gets has no row for ${uncovered.join(', ')}: say what the client will get on every surface the requirement touches (position, look, width, behaviour, where it's edited) and how that differs from what they expect`,
      surfaceGaps.length && `the requirement names a surface § Client gets has no row for: ${surfaceGaps.join(', ')}. Add a row per surface, with its Surface cell naming it`,
      !confirmed.length && 'no Confirmed evidence yet: read or observe something that settles a claim',
      unsourced.length && `Confirmed evidence without a Source (${unsourced.join(', ')}): cite the file:line, query, fetched page or docs URL with the quoted sentence`,
      st.type === 'debug' && tableRows(key, 'investigation.md', '## Hypotheses').length < 2
        && 'a debug investigation needs at least 2 hypotheses in investigation.md § Hypotheses, each confirmed, ruled out or open',
      st.type === 'debug' && !filled(key, 'investigation.md', '## Reproduction')
        && 'fill investigation.md § Reproduction: the steps, URL and what you observed, or why it could not be reproduced',
    ];
  },
  conclude: (key, st) => {
    const changed = themeChanges(st);
    return [
      !filled(key, 'investigation.md', '## Answer') && 'write investigation.md § Answer',
      st.type === 'feasibility' && !filled(key, 'investigation.md', '## Estimate')
        && 'write investigation.md § Estimate: agentic development hours per part (investigation and plan, build, QA and fixes, buffer), the size, what could add hours, and your confidence',
      st.type === 'feasibility' && !filled(key, 'investigation.md', '## Jira comment')
        && 'write investigation.md § Jira comment for the client: the verdict per part, every way the result differs from what they expect, the limitations, and the open Client questions',
      st.type === 'feasibility' && filled(key, 'investigation.md', '## Review') && !added(key, 'investigation.md', '## Review').some((l) => /Client surprises\s*:/i.test(l))
        && 'investigation.md § Review has no "Client surprises:" line: the evidence-checker\'s client pass is missing. Run it again (it reads the ticket, § Answer and § Jira comment as the client first) and record that line',
      !filled(key, 'investigation.md', '## Could not determine') && 'fill investigation.md § Could not determine ("Nothing material" only if that is true)',
      !filled(key, 'investigation.md', '## Next step') && 'write investigation.md § Next step',
      st.type === 'feasibility' && !filled(key, 'investigation.md', '## Review') && 'run the evidence-checker agent and record its result in investigation.md § Review',
      changed.length && `theme files changed since the investigation started (${changed.join(', ')}). Investigations are read-only: undo your own edits; edits the dev made are theirs to keep, so ask`,
    ];
  },
};
// "Approve with changes" edits the plan at the gate, so the approved plan passes the same checks.
EXIT_CHECKS.approve = EXIT_CHECKS.plan;

// ── Git and theme state ──

// Raw output: git() trims, which would cut the leading space of the first " M path" line.
const themeStatus = () => run('git', ['status', '--porcelain', '--', ...existingThemeDirs()]).stdout.split(/\r?\n/).filter(Boolean);

const statusPath = (l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
// Files the dev already had changes in keep the same status line when edited again, so their content is compared too.
const dirtyHashes = (lines) => Object.fromEntries(lines.map(statusPath).filter((p) => existsSync(join(ROOT, p)) && statSync(join(ROOT, p)).isFile())
  .map((p) => [p, createHash('sha1').update(readFileSync(join(ROOT, p))).digest('hex')]));

/** Theme files whose git status, or (for files already changed at the start) content, differs from when the investigation started. */
function themeChanges(st) {
  const before = new Set(st.readonly?.themeStatus || []);
  const current = themeStatus();
  const differ = [...current.filter((l) => !before.has(l)), ...[...before].filter((l) => !current.includes(l))].map(statusPath);
  const was = st.readonly?.hashes || {};
  const cur = dirtyHashes(current.filter((l) => before.has(l)));
  return [...new Set([...differ, ...Object.keys(was).filter((p) => p in cur && cur[p] !== was[p])])];
}

function existingThemeDirs() {
  return THEME_DIRS.filter((d) => existsSync(join(ROOT, d)));
}

// Pushed means origin has the local branch's current commit, not just a branch of that name.
function branchPushed(st) {
  const local = ref(`refs/heads/${st.branch}`);
  return Boolean(local) && local === ref(`refs/remotes/origin/${st.branch}`);
}

/** Theme files the branch changes, measured as a PR diff is (from the effective base), whatever is checked out. */
function branchDiff(st) {
  const head = `refs/heads/${st.branch}`;
  const base = effectiveBase(st, readConfig({ required: false }), head);
  return git(['diff', '--name-only', '--no-renames', '--relative', base, head, '--', ...THEME_DIRS], { allowFail: true }).split('\n').filter(Boolean);
}

/**
 * Lines the branch adds to code files (not JSON) that name a ticket of the key's project, or an AC or Q number in a
 * comment. Those belong in the PR and plan.md; in the theme they outlive the ticket. Returns "path:line" strings.
 */
function ticketRefs(key, st) {
  const base = effectiveBase(st, readConfig({ required: false }), 'HEAD');
  const diff = git(['diff', '-U0', '--no-renames', '--relative', base, 'HEAD', '--', ...THEME_DIRS], { allowFail: true });
  const ticket = new RegExp(`\\b${key.split('-')[0]}-\\d+\\b`, 'i');
  // Only lines with a comment marker: "Q4" or "AC 2" could be real text elsewhere. A ticket key never is.
  const comment = /\/\/|\/\*|^\s*\*|<!--|\{%-?\s*(comment|#)/;
  const planRef = /\bAC ?\d+\b|\bQ\d+\b/;
  const hits = [];
  let file = null;
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!l.startsWith('+') || !file || file.endsWith('.json')) continue;
    const text = l.slice(1);
    if (ticket.test(text) || (comment.test(text) && planRef.test(text))) hits.push(`${file}:${line}`);
    line++;
  }
  return hits;
}

/** Why the draft isn't the branch: push and verify record verifiedCommit only once every file reads back equal to HEAD. */
function draftBehind(st) {
  const head = ref(`refs/heads/${st.branch}`);
  if (!st.draft?.themeId || !head || st.draft.verifiedCommit === head) return null;
  return `the draft isn't at the branch head (draft verified at ${short(st.draft.verifiedCommit)}, ${st.branch} is at ${short(head)}). `
    + `${st.draft.route === 'github' ? `git push -u origin ${st.branch}, then shopify.mjs verify <KEY>` : 'Run shopify.mjs push <KEY>'}, and re-measure what the new commits touch`;
}

// ── Status and summary output ──

/** What start, status, done and back print: the stage, the skill to load next, and the task's facts. */
// ── Design checks (design-checks.json) ──
// The extractor's values per viewport, as data: exact mode audits all of them in one call per viewport
// (kit.mjs design-audit); reference mode keeps them for the builder and checks only layout and visibility.

/** { spec, problem }: the parsed file, or why it can't be used. */
function designChecks(key) {
  const p = join(LOGS, key, 'design-checks.json');
  if (!existsSync(p)) return { problem: 'missing' };
  let spec;
  try { spec = JSON.parse(read(p)); } catch (e) { return { problem: `not valid JSON: ${e.message.slice(0, 80)}` }; }
  const vps = Object.entries(spec?.viewports || {});
  if (!vps.length) return { problem: 'no viewports: { "viewports": { "desktop": { "width": 1440, "height": 900, "elements": [], "spacing": [] } } }' };
  return { spec, vps };
}

/** Exact mode, at plan: every check names the selector the build creates, and a QA criterion runs the audit. */
function exactDesignProblems(key) {
  const { vps, problem } = designChecks(key);
  if (problem) return [`design-checks.json: ${problem}`];
  const refs = { siblingGap: ['from', 'to'], trackGap: ['container'], containerPad: ['container'], toViewport: ['element'] };
  const unnamed = vps.flatMap(([vp, v]) => [
    ...(v.elements || []).filter((e) => !e.selector).map((e) => `${vp}: ${e.name}`),
    ...(v.spacing || []).filter((s) => (refs[s.type] || ['?']).some((f) => !s[f])).map((s) => `${vp}: ${s.name}`),
  ]);
  return [
    unnamed.length && `design-checks.json: fill the selector the build creates for ${unnamed.slice(0, 6).join('; ')}${unnamed.length > 6 ? ` and ${unnamed.length - 6} more` : ''}`,
    ![...planCriteria(key).values()].some((t) => /design-audit/.test(t))
      && 'add a QA criterion per viewport that runs the design audit: "Design matches Figma (kit.mjs design-audit <KEY> <viewport>)", default state',
  ];
}

// ── Acceptance criteria coverage ──
// POP-1150's targeting ACs became a merchant step with no QA row and no stated deviation: nobody decided to drop them.

/** Numbers in "AC 4", "ACs 4, 5", "AC 6/17", "AC 4–6". */
function acRefs(text) {
  const out = new Set();
  for (const m of text.replace(/#(?=\d)/g, '').matchAll(/\bACs?\s*((?:\d+\s*(?:[,/&–-]|and)?\s*)+)/g)) {
    for (const r of m[1].matchAll(/(\d+)\s*[–-]\s*(\d+)|(\d+)/g)) {
      if (r[3]) out.add(r[3]);
      else for (let n = Number(r[1]); n <= Number(r[2]) && n - Number(r[1]) < 50; n++) out.add(String(n));
    }
  }
  return out;
}

function acCoverageProblems(key) {
  const lines = added(key, 'brief.md', '### Acceptance criteria', '## Asked');
  const acs = lines.map((l) => (l.match(/^(\d+)\.\s/) || [])[1]).filter(Boolean);
  if (!acs.length) {
    return [lines.length && !saysNone(key, 'brief.md', '### Acceptance criteria', '## Asked')
      && 'number the acceptance criteria in brief.md § Asked as one list ("1. …", "2. …", across tickets), so the plan can cite each one'];
  }
  const plan = read(join(LOGS, key, 'plan.md'));
  // Covered = checked by a QA row, or set aside under Differs. A mention elsewhere ("Merchant can change … AC 4") is neither.
  const differs = differsLines(plan);
  const cited = acRefs([...sectionLines(plan, '## QA criteria'), ...differs].join('\n'));
  const open = [...new Set(acs)].filter((n) => !cited.has(n));
  return [open.length && `acceptance criteria ${open.map((n) => `AC ${n}`).join(', ')} aren't covered: cite each in a QA criterion ("AC n"), or list it under At a glance → Differs from the ticket with why ("AC 14, the implementation video: a handoff step, not theme code")`];
}

// ── Not proven yet ──
// What the plan relies on but couldn't verify (a data shape the store didn't show, an app API for another product…).
// Gate 1 shows it with a fallback, QA measures it, and Gate 2 won't take it untested unless the dev names it (POP-1150).

const UNPROVEN = ['### Not proven yet', '## At a glance'];
/** Each row's plan QA criteria numbers. */
const unprovenRows = (key) => tableRows(key, 'plan.md', ...UNPROVEN).map((r) => ({ row: r, cells: cells(r), qa: (cells(r)[3] || '').match(/\d+/g) || [] }));

function unprovenProblems(key) {
  const rows = unprovenRows(key);
  if (!rows.length) return [!saysNone(key, 'plan.md', ...UNPROVEN) && 'fill plan.md § At a glance → Not proven yet: one row per thing the plan relies on that you couldn\'t verify in this theme or store, or "none"'];
  const criteria = planCriteria(key);
  return rows.flatMap(({ cells: c, qa }) => [
    (!c[0] || !c[1] || !c[2]) && `Not proven yet → "${c[0] || '?'}": say why it isn't proven and the fallback if it doesn't hold`,
    !qa.length && `Not proven yet → "${c[0]}": name the QA criterion that tests it`,
    ...qa.filter((n) => !criteria.has(n)).map((n) => `Not proven yet → "${c[0]}": QA criterion ${n} isn't in plan.md § QA criteria`),
  ]);
}

/** Not-proven criteria that didn't PASS and that the dev's Gate 2 answer doesn't name. */
/** A FAIL is fixed, or the dev accepts it by name: "Accept, I'll do the 1 check" took GSD-80's open FAIL along. */
function openFails(st, answer) {
  const fails = Object.entries(st.qa?.rows || {}).filter(([, r]) => r.verdict === 'FAIL').map(([n]) => n)
    .filter((n) => !new RegExp(`(^|\\D)${n}(?!\\d)`).test(answer));
  return fails.length && `QA rows ${fails.map((n) => `#${n}`).join(', ')} are FAIL. Fix them (back to build), amend the criterion to a live baseline and measure again, or accept only if the dev names each one: --answer "<their words, naming ${fails.map((n) => `#${n}`).join(', ')}>"`;
}

function unprovenUntested(key, st, answer) {
  const named = (n) => new RegExp(`(^|\\D)${n}(?!\\d)`).test(answer);
  const open = [...new Set(unprovenRows(key).flatMap((r) => r.qa))].filter((n) => st.qa?.rows?.[n]?.verdict !== 'PASS' && !named(n));
  return open.length && `"Not proven yet" criteria ${open.map((n) => `#${n} (${st.qa?.rows?.[n]?.verdict || 'no verdict'})`).join(', ')} didn't pass. Test them, switch to the plan's fallback (kit.mjs back <KEY> build --reason "fallback for #…"), or accept them untested only if the dev names each one: --answer "<their words, naming ${open.map((n) => `#${n}`).join(', ')}>"`;
}

/**
 * "QA: 0 of 22 criteria measured" for a task built but not through QA, or null. A run that stops at the draft looks
 * finished to whoever picks the branch up (POP-1150: 22 criteria never measured), so list and status say so.
 */
function qaProgress(key, st) {
  if (kindOf(st) === 'investigation' || !['build', 'draft', 'qa'].includes(st.stage)) return null;
  const total = planCriteria(key).size;
  const measured = Object.keys(st.qa?.rows || {}).length;
  return total ? `QA: ${measured} of ${total} criteria measured${measured < total ? ', so the build is unchecked' : ''}` : null;
}

function summaryLines(key, st, cfg) {
  const stages = stagesFor(st);
  const i = stageIndex(st.stage, st);
  const label = kindOf(st) === 'investigation' ? `investigation (${st.type || 'type not set'})` : st.type || 'type not set';
  const lines = [];
  if (st.stage === 'done' || st.stage === 'abandoned') {
    lines.push(`${key} · ${label} · ${st.stage === 'done' ? 'finished' : 'abandoned'}`);
  } else {
    const s = stages[i];
    lines.push(`${key} · ${label} · stage ${i + 1}/${stages.length}: ${s.name}${s.gate ? ` (${s.gate})` : ''}`);
    lines.push(`Next: load the skill "${s.skill}" and do the "${s.name}" stage.`);
    if (st.resumedFrom) lines.push(`This task was at "${st.resumedFrom}", a stage this kit version folded into "${s.name}": the skill's ${s.name} stage covers what was left of it.`);
  }
  const done = stages.filter((_, j) => j < (i === -1 ? stages.length : i)).map((s) => {
    const g = st.gates?.[s.name];
    return g ? `${s.name} ✓ ("${g.answer.slice(0, 60)}${g.answer.length > 60 ? '…' : ''}")` : `${s.name} ✓`;
  });
  if (done.length) lines.push(`Done: ${done.join(' · ')}`);
  lines.push(...ownerLines(st));
  if (kindOf(st) === 'investigation') {
    lines.push('Read-only: no theme edits, no store changes, no draft theme. A fix becomes /shopify-implement on this key afterwards.');
    lines.push(`Logs: .claude/logs/${key}/investigation.md`);
    if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
    return lines.join('\n');
  }
  if (st.investigation) lines.push(`Investigated first (${st.investigation.type}): intake reads .claude/logs/${key}/investigation.md.`);
  if (st.test) lines.push(`TEST RUN of the kit: the branch and the draft are named ${key}${TEST_SUFFIX}, and the branch is never pushed (the guard blocks it). The draft is a CLI copy of live, whatever draftRoute says. Handoff writes the report but pushes nothing.`);
  lines.push(`Branch: ${st.branch || `${branchFor(cfg, key, st)} (not created yet)`} · base: ${st.base ? st.base.slice(0, 7) : '—'} · protected: ${protectedBranches(cfg).join(', ')}`);
  if (cfg?.adminApi === false) lines.push('Admin API: off in this repo. Definitions and QA values are admin steps for the dev; read store data from admin pages in Chrome (look only).');
  if (cfg?.commitPattern) lines.push(`Commit messages: ${cfg.commitPattern.replace('{KEY}', key).replace('{key}', key.toLowerCase())}`);
  if (st.stage === 'build') lines.push(`Stage with: git add -- ${existingThemeDirs().join(' ')}`);
  if (st.draft?.themeId) {
    lines.push(`Draft: ${st.draft.name || st.draft.themeId} (id ${st.draft.themeId}, ${st.draft.route})${st.draft.deletedAt ? ' — deleted' : ''}`);
    if (st.draft.previewUrl) lines.push(`Preview: ${st.draft.previewUrl}`);
    if (st.draft.editorUrl) lines.push(`Editor: ${st.draft.editorUrl}`);
    if (st.draft.ignoredFiles?.length) lines.push(`Not on the draft (.shopifyignore; list them in report.md § You must still do): ${st.draft.ignoredFiles.join(', ')}`);
    if (st.draft.liveEdits?.length) lines.push(`Live edits since the base that the merge overwrites (report them in report.md § You must still do): ${st.draft.liveEdits.join(', ')}`);
  }
  if (st.featurePrefix || st.qa?.paths?.length) lines.push(`Feature prefix: ${st.featurePrefix || '—'} · QA paths: ${st.qa?.paths?.join(', ') || '—'}`);
  if (st.baseTheme) lines.push(`Base theme: ${st.baseTheme} stands in for live (live is a campaign theme): drift checks, the draft copy and QA's comparison use it.`);
  if (qaProgress(key, st)) lines.push(qaProgress(key, st));
  if (st.type === 'abtest') lines.push(`A/B (variation and code: brief.md): tool ${st.abtest?.tool || '?'} · running ${st.abtest?.running || '?'}${st.abtest?.reference ? ` · force link ${st.abtest.reference}` : ''}`);
  if (hasDesign(st)) lines.push(`Design: Figma ${st.design.figma} (values in design.md)${st.design.mode ? ` · ${st.design.mode} mode${st.design.mode === 'exact' ? ': QA runs kit.mjs design-audit per viewport' : ': QA checks layout and visibility'}` : ''}`);
  if (cfg?.draftRoute === 'github' && !st.test && !st.draft?.themeId) lines.push('Draft route: GitHub-connected (draftRoute in shopify-kit.json). The dev connects the task branch; the kit adopts it with shopify.mjs draft <KEY> --github.');
  if (st.mutations?.length) lines.push(`Store mutations run: ${st.mutations.length} (ids: kit.mjs status ${key} --json)`);
  lines.push(`Logs: .claude/logs/${key}/ (brief.md, plan.md, report.md)`);
  if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
  if (st.stage === 'accept') lines.push('Since the plan was approved (show the dev at this gate):', ...sinceApproval(key, st));
  return lines.join('\n');
}

/** Whose task it is, and a warning when this machine's git identity is someone else (a handover). */
function ownerLines(st) {
  if (!st.owner) return [];
  const who = `${st.owner.name}${st.owner.email ? ` <${st.owner.email}>` : ''}`;
  const me = git(['config', 'user.email'], { allowFail: true });
  if (!st.owner.email || !me || me.toLowerCase() === st.owner.email.toLowerCase()) return [`Owner: ${who}`];
  return [`Owner: ${who}. WARNING: your git user.email is ${me}. Taking it over? Fetch and switch to their pushed branch${st.branch ? ` (${st.branch})` : ''} first, and agree with them before pushing to their draft.`];
}

const minutes = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

/** The summary verb's JSON. A stage's time counts from the previous done or back, so a loop back restarts the clock. */
function runSummary(key, st) {
  const events = st.history || [];
  let last = st.createdAt;
  const perStage = {};
  for (const e of events) {
    if (e.event === 'done') { perStage[e.stage] = (perStage[e.stage] || 0) + minutes(last, e.at); last = e.at; }
    if (e.event === 'back') last = e.at;
  }
  const verdicts = { PASS: 0, FAIL: 0, 'NOT TESTED': 0, BLOCKED: 0 };
  for (const l of tableRows(key, 'report.md', '## Criteria')) {
    const m = l.match(/\|\s*\**(PASS|FAIL|NOT TESTED|BLOCKED)\b/);
    if (m) verdicts[m[1]]++;
  }
  return {
    key, kind: kindOf(st), type: st.type, stage: st.stage, owner: st.owner?.name, kitVersion: st.kitVersion,
    startedAt: st.createdAt, lastUpdate: st.updatedAt, elapsedMinutes: minutes(st.createdAt, st.updatedAt),
    minutesPerStage: perStage,
    loopsBack: events.filter((e) => e.event === 'back').map((e) => `${e.from} → ${e.to}: ${e.reason}`),
    gates: Object.fromEntries(Object.entries(st.gates || {}).map(([g, v]) => [g, `${v.at.slice(0, 16)} "${v.answer}"`])),
    qaVerdicts: verdicts,
    storeChanges: (st.mutations || []).map((m) => `${m.at.slice(0, 16)} ${m.file} → ${m.ids.join(', ') || 'no ids'}${m.userErrors?.length ? ' (errors)' : ''}`),
    draft: st.draft?.themeId ? `${st.draft.name || st.draft.themeId}${st.draft.deletedAt ? ' (deleted)' : ''}` : null,
  };
}

// ── Self-test ──

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), got, want]);
  eq('parseArgs booleans', parseArgs(['push', '--dry-run', 'ABC-1']), { _: ['push', 'ABC-1'], flags: { 'dry-run': true } });
  eq('retryDelay: Retry-After wins, capped at 30 s; else 3, 8, 15 s', [retryDelay('5', 1), retryDelay('120', 1), retryDelay(null, 1), retryDelay('Wed, 21 Oct 2026', 2), retryDelay(null, 3)], [5000, 30000, 3000, 8000, 15000]);
  eq('verbHelp: the verb\'s lines with their continuations; none for an unknown verb', [verbHelp('qa-row').length, verbHelp('done').length, verbHelp('abandon').length, verbHelp('nope').length], [4, 2, 1, 0]);
  eq('repro: live shows the bug and the draft something else, not just both words', [
    bothSides('live: total 10.00; draft: total 8.00'), bothSides('live: not reproduced; draft: ok'), bothSides('live: 8.00; draft: 8.00'), bothSides('checked live and draft'),
  ], [true, false, false, false]);
  eq('accept: an open FAIL needs the dev to name it', [Boolean(openFails({ qa: { rows: { 7: { verdict: 'FAIL' } } } }, 'Accept')), openFails({ qa: { rows: { 7: { verdict: 'FAIL' } } } }, 'Accept, #7 is pre-existing')], [true, 0]);
  eq('parseArgs values', parseArgs(['done', 'ABC-1', 'approve', '--answer', 'use a block']), { _: ['done', 'ABC-1', 'approve'], flags: { answer: 'use a block' } });
  eq('storefrontPath plain', storefrontPath('cart'), '/cart');
  eq('storefrontPath home', storefrontPath('home'), '/');
  eq('storefrontPath msys', storefrontPath('C:/Program Files/Git/collections/all'), '/collections/all');
  eq('storefrontPath slash', storefrontPath('/products/x'), '/products/x');
  eq('parseCliJson ndjson', parseCliJson('{"type":"progress"}\n{"data":{"shop":1}}'), { data: { shop: 1 } });
  eq('parseCliJson pretty', parseCliJson('<claude-code-hint/>\n[\n  {"id": 1}\n]'), [{ id: 1 }]);
  eq('diagnosticJson result', diagnosticJson('<claude-code-hint />\n{"type":"diagnostic","level":"info","message":"{\\"url\\":\\"https://x\\"}"}\n'), { url: 'https://x' });
  eq('diagnosticJson plain text', diagnosticJson('{"type":"diagnostic","message":"Uploading files"}'), null);
  eq('sectionLines nested', sectionLines('## A\nx\n### B\ny\n## C\nz', '## A'), ['x', '### B', 'y']);
  eq('sectionLines suffix heading', sectionLines('## Found (analyze)\nfound it\n## Decided', '## Found'), ['found it']);
  const ignore = ignoreMatcher('*.json\n# comment\nassets/src/**\n/\\.map$/');
  eq('ignore glob any folder', ignore('templates/product.json'), true);
  eq('ignore folder glob', ignore('assets/src/theme.css'), true);
  eq('ignore regex', ignore('assets/theme.js.map'), true);
  eq('ignore miss', ignore('sections/header.liquid'), false);
  eq('stages implement', stagesFor({}).map((x) => x.name), ['intake', 'analyze', 'plan', 'approve', 'build', 'draft', 'qa', 'accept', 'handoff']);
  eq('implement gates', stagesFor({ lane: 'small' }).filter((x) => x.gate).map((x) => x.name), ['approve', 'accept']);
  eq('stages investigation, the gate still named conclude', stagesFor({ kind: 'investigation' }).map((x) => `${x.name}${x.gate ? '*' : ''}`), ['gather', 'conclude*']);
  eq('parseArgs takes a value that starts with -- but isn\'t a flag', parseArgs(['qa-row', 'A-1', '3', '--measured', '--gap: 16px', '--how', '__qa.css()']).flags, { measured: '--gap: 16px', how: '__qa.css()' });
  eq('parseArgs leaves a following flag alone', parseArgs(['push', 'A-1', '--reconciled', '--dry-run']).flags, { reconciled: true, 'dry-run': true });
  eq('unMsys with a Scoop Git root', [unMsysFrom('C:/Users/dev/scoop/apps/git/current/cart', 'C:/Users/dev/scoop/apps/git/current'), unMsysFrom('C:\\Users\\dev\\scoop\\apps\\git\\current\\cart', 'C:/Users/dev/scoop/apps/git/current'), unMsysFrom('C:/Users/x/file.txt', 'C:/Users/dev/scoop/apps/git/current')], ['/cart', '/cart', 'C:/Users/x/file.txt']);
  eq('cellPaths reads every path in a cell', [cellPaths('`locales/en.default.json`, `locales/de.json`'), cellPaths('`locales/*.json ×5`'), cellPaths('sections/a.liquid, snippets/b.liquid (new)')], [['locales/en.default.json', 'locales/de.json'], ['locales/*.json'], ['sections/a.liquid', 'snippets/b.liquid']]);
  eq('a repro measurement shows live and draft, in either order', [bothSides('live: 0 items; draft: 2 items'), bothSides('draft: 12.00; live: 24.00 (bug)'), bothSides('draft: 12.00')], [true, true, false]);
  const owned = 'gid://shopify/Metaobject/7';
  const del = (entries, vars = '') => mutationProblems(`mutation M($o: ID = "gid://shopify/Shop/1") { metafieldsDelete(metafields: [${entries}]) { userErrors { message } } }`, vars, [owned]);
  eq('metafieldsDelete refuses an ownerId given as $variable', [
    del(`{ownerId: "${owned}", namespace: "custom", key: "a"}, {ownerId: $o, namespace: "custom", key: "b"}`, '{"o":"gid://shopify/Shop/1"}').some((p) => /ownerId: \$variable/.test(p)),
    del(`{ownerId: "${owned}", namespace: "custom", key: "a"}, {ownerId: $o, namespace: "custom", key: "b"}`).some((p) => /ownerId: \$variable/.test(p)),
    del(`{ownerId: "${owned}", namespace: "custom", key: "a"}`).length,
  ], [true, true, 0]);
  process.env.SHOPIFY_FLAG_LIVE = '1';
  eq('run doesn\'t pass SHOPIFY_FLAG_* on to the CLI', run(process.execPath, ['-e', 'process.stdout.write(String(Object.keys(process.env).filter((k) => /^SHOPIFY_FLAG_/i.test(k)).length))']).stdout, '0');
  delete process.env.SHOPIFY_FLAG_LIVE;
  eq('namesKey whole word', ['ABC-12', 'ABC-12 hero', 'kit test ABC-12-kit-test', 'abc-12'].map((n) => namesKey(n, 'ABC-12')), [true, true, true, true]);
  eq('namesKey not a longer key', ['ABC-123', 'ABC-123 hero', 'XABC-12', 'ABC-12B'].map((n) => namesKey(n, 'ABC-12')), [false, false, false, false]);
  // cli-check's schema reads: CLI 4 inline, CLI 5.0.1 behind a $ref (definitions in the nested Result, or hoisted).
  const session = { type: 'object', properties: { subdomain: {}, store: {}, scopes: {}, expiresAt: {}, connected: {} } };
  const fields = (s) => ['store', 'subdomain', 'scopes', 'expiresAt'].filter((f) => authSessionProps(s)[f]).length;
  const sessionsRef = { properties: { sessions: { type: 'array', items: { $ref: '#/definitions/StoreAuthListSession' } } } };
  const { expiresAt, ...withoutExpiry } = session.properties;
  eq('cli-check reads the auth session fields in every schema shape', [
    fields({ definitions: { Result: { properties: { sessions: { items: session } } } } }),
    fields({ definitions: { Result: { ...sessionsRef, definitions: { StoreAuthListSession: session } } } }),
    fields({ definitions: { Result: sessionsRef, StoreAuthListSession: session } }),
    fields({ definitions: { Result: { ...sessionsRef, definitions: { StoreAuthListSession: { properties: withoutExpiry } } } } }),
    fields({ definitions: { Result: sessionsRef } }),
    fields(null),
  ], [4, 4, 4, 3, 0, 0]);
  const errorShape = { properties: { message: {}, tryMessage: {}, nextSteps: {}, details: {} } };
  eq('cli-check reads the execute error fields inline and behind a $ref', [
    Object.keys(execErrorProps({ definitions: { Error: { properties: { error: { anyOf: [errorShape] } } } } })).length,
    Object.keys(execErrorProps({ definitions: { Error: { properties: { error: { anyOf: [{ $ref: '#/definitions/ErrorBody' }] } }, definitions: { ErrorBody: errorShape } } } })).length,
  ], [4, 4]);
  const verified = { cliVersion: '4.9.4', pluginVersion: '2.1.0', kitVersion: '1.0.0', adminApiVersion: '2026-07' };
  eq('cli-check keeps the last verified versions across failed runs', [
    lastVerified({ ...verified, ok: true }).cliVersion,
    lastVerified({ ok: false, cliVersion: '5.0.1', previous: verified }).cliVersion,
    lastVerified({ ok: false, cliVersion: '5.0.1' }),
    lastVerified(null),
  ], ['4.9.4', '4.9.4', null, null]);
  eq('AC references', [...acRefs('AC 2 · ACs 4, 5 and 7 · AC 6/17 · AC 20–22 · BAC 9')].sort(), ['17', '2', '20', '21', '22', '4', '5', '6', '7']);
  // The session-start update notice: every 15 days, and only for a version newer than the installed one.
  const day = 86400000;
  eq('update notice due', [due(undefined), due('garbage'), due(new Date(Date.now() - 14 * day).toISOString()), due(new Date(Date.now() - 15 * day).toISOString())], [true, true, false, true]);
  eq('update notice newer', [newerVersion('1.1.2', ['1.2.0', null]), newerVersion('1.1.2', [null, '1.1.10']), newerVersion('1.2.0', ['1.1.2', '1.2.0']), newerVersion('1.2.0', [null, null])], ['1.2.0', '1.1.10', null, null]);
  // design-audit.js with fake elements: normalisation, tolerances, spacing and the missing-selector report.
  const designAudit = new Function(`${read(join(KIT_DIR, 'design-audit.js'))}\nreturn designAudit;`)();
  const box = (top, left, width, height) => ({ top, left, width, height, right: left + width, bottom: top + height });
  const els = {
    '.t': { s: { color: 'rgb(29, 29, 27)', 'font-size': '16.4px', 'font-family': '"Open Sans", sans-serif', padding: '0px 11px' }, r: box(0, 0, 100, 20) },
    '.b': { s: { 'background-color': 'rgba(0, 0, 0, 0)' }, r: box(36, 0, 100, 40) },
  };
  const fakeEnv = { q: (s) => (els[s] ? s : null), qa: () => [], vw: () => 390, rect: (el) => els[el].r,
    style: (el) => ({ getPropertyValue: (p) => els[el].s[p] || '' }) };
  const audited = designAudit({ elements: [
    { name: 'title', selector: '.t', fixed: { color: '#1D1D1B', 'font-size': '16px', 'font-family': 'Open Sans', padding: '0px 10px' } },
    { name: 'button', selector: '.b', fixed: { 'background-color': '#ffffff' } },
    { name: 'gone', selector: '.x', fixed: { color: '#000' } },
  ], spacing: [{ name: 'title → button', type: 'siblingGap', from: '.t', to: '.b', expected: 16 }] }, fakeEnv);
  eq('design audit: within tolerance passes, a wrong colour and a missing element fail', [audited.checked, audited.passed, audited.failures.map((f) => `${f.name}:${f.what}`), audited.missing, audited.verdict],
    [6, 5, ['button:background-color'], ['gone: .x'], 'FAIL']);
  els['.c'] = { s: { border: '1px solid rgb(229, 229, 229)', 'letter-spacing': 'normal', color: 'rgba(0, 0, 0, 0.5)' }, r: box(0, 0, 10, 10) };
  const audited2 = designAudit({ elements: [{ name: 'card', selector: '.c', fixed: { border: '1px solid #E5E5E5', 'letter-spacing': '0px', color: '#000000' } }] }, fakeEnv);
  eq('design audit: colours inside borders, letter-spacing normal, and a half-transparent colour', [audited2.passed, audited2.failures.map((f) => f.what)], [2, ['color']]);
  // A 2-column grid of 4 cards with a <style> first: gaps are measured within each row, never across the wrap.
  const grid = [box(0, 0, 0, 0), box(0, 0, 160, 200), box(0, 176, 160, 200), box(216, 0, 160, 200), box(216, 176, 160, 200)];
  const gridEnv = { ...fakeEnv, qa: () => grid.map((_, i) => i), rect: (i) => grid[i] };
  const audited3 = designAudit({ spacing: [{ name: 'cards', type: 'trackGap', container: '.g', axis: 'horizontal', expected: 16 }] }, gridEnv);
  eq('design audit: track gap in a wrapping grid', [audited3.checked, audited3.passed, audited3.verdict], [2, 2, 'PASS']);
  eq('design set', hasDesign({ design: { figma: 'https://www.figma.com/design/abc/x' } }), true);
  eq('design none or unset', [hasDesign({ design: { figma: 'none' } }), hasDesign({})], [false, false]);
  eq('cells', cells('| 3 | a \\| b | PASS |'), ['3', 'a \\| b', 'PASS']);
  eq('cells empty last', cells('| Icons | AC 18 | winner SVGs | |'), ['Icons', 'AC 18', 'winner SVGs', '']);
  const theme = new Map([
    ['layout/theme.liquid', "{{ 'base.css' | asset_url | stylesheet_tag }}\n{% sections 'header-group' %}\n{% render 'cart-drawer' %}"],
    ['sections/header-group.json', '{"sections":{"h":{"type":"header"}}}'],
    ['sections/a.liquid', "{% render 'icon' %}"], ['sections/b.liquid', "{% render 'icon', name: 'cart' %}\n{% render 'mnav-list' %}"],
    ['snippets/icon.liquid', ''], ['snippets/mnav-list.liquid', ''], ['sections/header.liquid', ''], ['sections/mnav.liquid', ''],
    ['snippets/cart-drawer.liquid', "{{ 'cart-drawer.js' | asset_url | script_tag }}"],
  ]);
  eq('reach snippet the layout renders', reachOf('snippets/cart-drawer.liquid', theme), 'rendered from the layout, so on every page');
  eq('reach asset of a layout snippet', reachOf('assets/cart-drawer.js', theme), 'loaded on every page (snippets/cart-drawer.liquid, which the layout renders)');
  eq('reach shared snippet', reachOf('snippets/icon.liquid', theme), 'rendered from 2 files');
  eq('reach own snippet', reachOf('snippets/mnav-list.liquid', theme), null);
  eq('reach layout asset', reachOf('assets/base.css', theme), 'loaded on every page (layout)');
  eq('reach section group member', reachOf('sections/header.liquid', theme), 'in the layout or a section group, so on every page');
  eq('reach unused section', reachOf('sections/mnav.liquid', theme), null);
  eq('reach merchant JSON', reachOf('sections/header-group.json', theme).startsWith('merchant-owned'), true);
  eq('staleFails: a FAIL measured on an older commit', staleFails({ 3: { verdict: 'FAIL', commit: 'a1' }, 4: { verdict: 'PASS', commit: 'a1' }, 5: { verdict: 'FAIL', commit: 'b2' }, 6: { verdict: 'FAIL', commit: null } }, 'b2'), ['3']);
  eq('staleFails: nothing recorded', [staleFails(undefined, 'b2'), staleFails({ 1: { verdict: 'FAIL', commit: 'a1' } }, undefined)], [[], []]);
  eq('unMsys free text', [unMsys('C:/Program Files/Git/products/x is 16px'), unMsys('C:\\Program Files\\Git\\cart'), unMsys('D:/tools/Git/a\nline 2')], ['/products/x is 16px', '/cart', '/a\nline 2']);
  eq('unMsys keeps a later /Git/ and plain text', [unMsys('C:/Program Files/Git/repos/Git/x'), unMsys('ok on /cart'), unMsys('C:/Users/x/file.txt')], ['/repos/Git/x', 'ok on /cart', 'C:/Users/x/file.txt']);
  eq('storefrontPath still undoes msys', storefrontPath('C:\\Program Files\\Git\\collections\\all'), '/collections/all');
  eq('rowVerdict takes the last column', [rowVerdict('| 1 | shows PASS badge | x | 3px | css | FAIL |'), rowVerdict('| 2 | a | b | | | |')], ['FAIL', null]);
  eq('reproRows', reproRows(['| 1 | Repro: the cart drawer total | live shows 0, draft the sum |', '| 2 | Drawer opens | yes |', '| 3 | Reproduces on mobile | draft fine |']).length, 1);
  eq('globRe', [globRe('locales/*.json').test('locales/de.json'), globRe('locales/*.json').test('locales/x/de.json'), globRe('assets/**').test('assets/a/b.js'), globRe('sections/a.liquid').test('sections/a.liquid')], [true, false, true, true]);
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  print(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

// ── Verbs ──
// One case per verb; HELP at the top describes each.
const { _: [verb, rawKey, ...words], flags } = parseArgs(process.argv.slice(2));
// Free text that starts with "/" (a storefront path, usually) arrives rewritten under Git Bash.
const rest = words.map((w) => unMsys(w));
for (const f of ['answer', 'measured', 'how', 'reason']) if (typeof flags[f] === 'string') flags[f] = unMsys(flags[f]);

if (process.argv.includes('--selftest')) selftest();
// "<verb> --help" used to reach the verb and fail on the missing key (VSD-349).
if (flags.help && verb && verb !== 'help') {
  const lines = verbHelp(verb);
  print(lines.length ? `Usage: node .claude/kit/kit.mjs\n${lines.join('\n').replace('{SETTABLE}', Object.keys(SETTABLE).join(', '))}` : HELP.replace('{SETTABLE}', Object.keys(SETTABLE).join(', ')));
  process.exit(0);
}

switch (verb) {
  case 'list': {
    const keys = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'state.json'))) : [];
    if (!keys.length) print('No tasks yet. Start one with /shopify-implement <KEY>.');
    for (const k of keys) {
      const st = readState(k);
      const draft = st.draft?.themeId && !st.draft.deletedAt ? ` · draft ${st.draft.name || st.draft.themeId} not deleted by the kit` : '';
      const type = kindOf(st) === 'investigation' ? `investigation:${st.type || '-'}` : st.type || '-';
      const qa = qaProgress(k, st) ? ` · ${qaProgress(k, st)}` : '';
      print(`${k}\t${type}${st.test ? ' (test run)' : ''}\t${st.stage}\t${st.updatedAt.slice(0, 10)}\t${st.owner?.name || ''}${draft}${qa}`);
    }
    break;
  }

  case 'start': {
    const key = normKey(rawKey);
    const cfg = readConfig();
    const existing = readState(key, { required: false });
    const implementFields = {
      kind: 'implement', type: null, stage: STAGES[0].name, gates: {},
      branch: null, base: null, abtest: {}, featurePrefix: null, buildOutputs: [], draft: {}, previews: [], qa: {},
    };
    const writeTemplates = (files) => {
      mkdirSync(join(LOGS, key), { recursive: true });
      for (const f of files) if (!existsSync(join(LOGS, key, f))) writeFileSync(join(LOGS, key, f), tpl(key, f));
    };
    if (flags.test && flags.investigate) fail('Investigations are read-only already; --test is for /shopify-implement.');
    // A real task's logs, branch and draft must not be mixed with a test run's, in either direction.
    if (flags.test && existing && kindOf(existing) !== 'investigation' && !existing.test) {
      fail(`${key} already has a real task here (stage ${existing.stage}). A test run needs its own folder: move .claude/logs/${key}/ aside first.`);
    }
    if (flags.investigate) {
      if (existing && kindOf(existing) !== 'investigation') fail(`${key} is an implementation task (stage ${existing.stage}). Investigate inside it, or start a separate key such as INV-${new Date().toISOString().slice(5, 16).replace(/\D/g, '')}.`);
      if (!existing) {
        writeTemplates(['investigation.md']);
        writeState(key, {
          schemaVersion: 1, kitVersion: KIT_VERSION, key, kind: 'investigation', type: null,
          createdAt: now(), owner: owner(), stage: stagesFor({ kind: 'investigation' })[0].name, gates: {},
          history: [{ at: now(), event: 'start' }],
          // conclude compares against this, so an investigation can't end with theme files changed.
          readonly: (() => { const s = themeStatus(); return { themeStatus: s, hashes: dirtyHashes(s) }; })(),
          draft: {}, mutations: [], previews: [],
        });
      }
    } else if (existing && kindOf(existing) === 'investigation') {
      if (!['done', 'abandoned'].includes(existing.stage)) fail(`${key} is an investigation in progress (stage ${existing.stage}). Finish it with /shopify-investigate ${key}, or abandon it, before implementing.`);
      // The finished investigation becomes the implementation's starting context; intake reads its file.
      const { readonly, ...rest } = existing;
      const st = { ...rest, ...implementFields, test: Boolean(flags.test), mutations: existing.mutations || [], investigation: { type: existing.type, stage: existing.stage, endedAt: existing.updatedAt } };
      st.history.push({ at: now(), event: 'convert', from: 'investigation' });
      writeTemplates(TEMPLATES);
      writeState(key, st);
    } else if (!existing) {
      writeTemplates(TEMPLATES);
      writeState(key, {
        schemaVersion: 1, kitVersion: KIT_VERSION, key, createdAt: now(), owner: owner(),
        history: [{ at: now(), event: 'start' }], ...implementFields, test: Boolean(flags.test), mutations: [],
      });
    }
    print(summaryLines(key, readState(key), cfg));
    break;
  }

  case 'status': {
    const key = normKey(rawKey);
    const cfg = readConfig({ required: false });
    const st = readState(key, { required: false });
    if (!st) { print(`${key} not started. Run: node .claude/kit/kit.mjs start ${key} (an implementation), or start ${key} --investigate (a read-only investigation)`); break; }
    print(flags.json ? st : summaryLines(key, st, cfg));
    break;
  }

  case 'done': {
    const key = normKey(rawKey);
    const stage = rest[0];
    if (rest.length > 1) fail(`Unexpected words after the stage: "${rest.slice(1).join(' ')}". Quote the --answer text.`);
    const st = readState(key);
    if (['done', 'abandoned'].includes(st.stage)) fail(`${key} is ${st.stage === 'done' ? 'finished' : 'abandoned'}. Use "back" to reopen a stage.`);
    if (stage !== st.stage) fail(`The current stage is "${st.stage}", not "${stage}". Finish "${st.stage}" first, or use "back" to reopen an earlier stage.`);
    const stages = stagesFor(st);
    const def = stages[stageIndex(stage, st)];
    const answer = typeof flags.answer === 'string' ? flags.answer.trim() : '';
    if (def.gate && !answer) fail(`"${stage}" is a gate (${def.gate}). Ask the dev, then record their words: --answer "..."`);
    const missing = [...(EXIT_CHECKS[stage]?.(key, st) || []), stage === 'accept' && unprovenUntested(key, st, answer), stage === 'accept' && openFails(st, answer)].filter(Boolean);
    if (missing.length) {
      // Kept for the retro: repeated refusals at one stage point at a skill that doesn't say what the check wants.
      st.history.push({ at: now(), event: 'refused', stage, missing: missing.map((m) => m.slice(0, 160)) });
      writeState(key, st);
      fail(`"${stage}" isn't finished:\n${missing.map((m) => `- ${m.replaceAll('<KEY>', key)}`).join('\n')}`);
    }
    if (def.gate) st.gates[stage] = { answer, at: now() };
    // The plan as Gate 1 approved it, so Gate 2 can show what changed since.
    if (stage === 'approve') writeFileSync(join(LOGS, key, APPROVED_PLAN), planBody(read(join(LOGS, key, 'plan.md'))));
    // The commit QA measured: handoff checks that the branch it pushes is still this one.
    if (stage === 'qa') st.qa = { ...st.qa, commit: ref(`refs/heads/${st.branch}`) };
    st.history.push({ at: now(), event: 'done', stage, answer: answer || undefined });
    delete st.resumedFrom;
    const next = stages[stageIndex(stage, st) + 1];
    st.stage = next ? next.name : 'done';
    writeState(key, st);
    print(summaryLines(key, st, readConfig({ required: false })));
    if (stage === 'build') {
      const shared = reach(key, branchDiff(st));
      if (shared.length) print(`Shared files this branch changes (QA's regression check covers what uses them): ${shared.map((x) => `${x.file} (${x.reach})`).join('; ')}`);
      print(sinceApproval(key, st).join('\n'));
      if (st.check?.crashed) print(`theme check didn't run (${st.check.crashed.slice(0, 160)}). Say so in report.md; Shopify still rejects Liquid syntax errors at push.`);
    }
    // The finished run's retro, shown only when something went wrong and never blocking: a required retro made every
    // clean run pay for it (1.1.0 dropped it), but without one a successful task left no judgement of the kit's part.
    // Allowed and asked guard entries aren't problems, so only denies count.
    if (st.stage === 'done') {
      const signals = retroSignals(key, st);
      if (signals.loopsBack.length || signals.refusedStages.length || signals.guardBlocks.some((g) => g.includes('[deny]'))) {
        st.history.push({ at: now(), event: 'retro' });
        writeState(key, st);
        print({ retro: { ...signals, ask: RETRO_ASK } });
      }
    }
    break;
  }

  case 'back': {
    const key = normKey(rawKey);
    const target = rest[0];
    const st = readState(key);
    const stages = stagesFor(st);
    const to = stageIndex(target, st);
    const from = ['done', 'abandoned'].includes(st.stage) ? stages.length : stageIndex(st.stage, st);
    if (to === -1) fail(`Unknown stage "${target}". Stages: ${stages.map((s) => s.name).join(', ')}`);
    if (to >= from) fail(`"${target}" isn't earlier than the current stage "${st.stage}".`);
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Say why: --reason "..."');
    for (const s of stages.slice(to)) delete st.gates[s.name];
    st.history.push({ at: now(), event: 'back', from: st.stage, to: target, reason: flags.reason.trim() });
    delete st.resumedFrom;
    st.stage = target;
    writeState(key, st);
    print(summaryLines(key, st, readConfig({ required: false })));
    break;
  }

  case 'set': {
    const key = normKey(rawKey);
    const st = readState(key);
    if (!rest.length) fail(`Nothing to set. Allowed: ${Object.keys(SETTABLE).join(', ')}`);
    for (const pair of rest) {
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (eq === -1 || !SETTABLE[name]) fail(`Can't set "${pair}". Allowed: ${Object.keys(SETTABLE).join(', ')}`);
      const value = SETTABLE[name](unMsys(pair.slice(eq + 1).trim()));
      if (name === 'type' && !TYPES[kindOf(st)].includes(value)) fail(`The type of ${kindOf(st) === 'investigation' ? 'an investigation' : 'an implementation'} is one of: ${TYPES[kindOf(st)].join(', ')}`);
      if (name === 'branch' && protectedBranches(readConfig({ required: false }) || {}).some((p) => p.toLowerCase() === value.toLowerCase())) {
        fail(`${value} is a protected branch: a task works on its own branch, never on ${value}.`);
      }
      // A GitHub-connected draft follows the branch it was connected to; switching the task's branch would leave QA
      // measuring a draft without the new work (POP-1150).
      if (name === 'branch' && st.branch && value !== st.branch && st.draft?.route === 'github' && !st.draft.deletedAt
        && !rest.some((p) => p.startsWith('draft.themeId='))) {
        fail(`Draft ${st.draft.themeId} is connected to ${st.branch} on GitHub, so it would not show ${value}. Keep ${st.branch}, or connect a theme to ${value} in the admin (Add theme → Connect from GitHub) and record both at once: kit.mjs set ${key} draft.themeId=<its id> branch=${value}`);
      }
      const before = st.draft?.themeId;
      const [head, sub] = name.split('.');
      if (sub) st[head] = { ...(st[head] || {}), [sub]: value };
      else st[head] = value;
      if (name === 'draft.themeId') {
        st.draft.createdAt ||= now(); st.draft.route ||= 'manual'; delete st.draft.deletedAt;
        // Another theme: what was verified or pushed, and the URLs, described the old one.
        if (before && before !== value) {
          delete st.draft.verifiedCommit; delete st.draft.lastPushedCommit;
          for (const u of ['previewUrl', 'editorUrl']) if (st.draft[u]) st.draft[u] = st.draft[u].replaceAll(String(before), String(value));
        }
      }
    }
    st.history.push({ at: now(), event: 'set', values: rest });
    writeState(key, st);
    print(`Recorded: ${rest.join(' ')}`);
    break;
  }

  // The audit and one viewport's spec in one file, run with browser_run_code_unsafe: no JSON copied by hand.
  case 'design-audit': {
    const key = normKey(rawKey);
    readState(key);
    const { spec, problem } = designChecks(key);
    if (problem) fail(`design-checks.json: ${problem}`);
    const vp = rest[0];
    const v = spec.viewports[vp] || fail(`Name a viewport: ${Object.keys(spec.viewports).join(', ')}`);
    const file = join(LOGS, key, `design-audit-${vp}.js`);
    const src = read(join(KIT_DIR, 'design-audit.js'));
    // No trailing ';': browser_run_code_unsafe evaluates the file as one expression.
    writeFileSync(file, `// Generated by kit.mjs design-audit ${key} ${vp} from design-checks.json; regenerate after changing it.\n`
      + `async (page) => page.evaluate((spec) => {\n${src}\n  const r = designAudit(spec);\n`
      + `  if (spec.width && r.viewport !== spec.width) r.verdict = 'WRONG VIEWPORT: resize to ' + spec.width + ' first';\n  return r;\n}, ${JSON.stringify(v)})\n`);
    print({
      file: relative(ROOT, file).replaceAll('\\', '/'),
      checks: (v.elements || []).length + (v.spacing || []).length,
      run: `browser_resize to ${v.width || '?'}×${v.height || '?'}, open the page in the default state (settings at the plan's defaults), then browser_run_code_unsafe with filename "${relative(ROOT, file).replaceAll('\\', '/')}". Record the result with qa-row: measured "<passed>/<checked>, failures: …".`,
    });
    break;
  }

  case 'reach': {
    const key = normKey(rawKey);
    readState(key);
    const found = reach(key);
    print(found.length ? found : 'Nothing in plan.md § Files reaches beyond the feature (or § Files is still empty).');
    break;
  }

  case 'summary': {
    const key = normKey(rawKey);
    print(runSummary(key, readState(key)));
    break;
  }

  case 'premerge': {
    // Right before the merge: commits on the remote branch QA never saw. On a GitHub-connected draft, every Save in its
    // theme editor is one ("Update from Shopify"); CHE-865's QA team saved 36 test edits that way.
    const key = normKey(rawKey);
    const st = readState(key);
    if (!st.branch) fail(`${key} has no branch yet.`);
    if (!st.qa?.commit) fail(`${key} has no QA'd commit recorded: QA hasn't run, so there is nothing to compare with.`);
    run('git', ['fetch', '--quiet', 'origin', st.branch]);
    const remote = ref(`refs/remotes/origin/${st.branch}`) || fail(`origin/${st.branch} doesn't exist: push the branch first.`);
    const log = git(['log', '--format=%H%x09%an%x09%s', `${st.qa.commit}..${remote}`], { allowFail: true }).split('\n').filter(Boolean)
      .map((l) => { const [sha, author, subject] = l.split('\t'); return { sha: sha.slice(0, 7), author, subject, fromShopify: /update from shopify/i.test(subject) }; });
    const files = log.length ? git(['diff', '--name-only', '--relative', st.qa.commit, remote], { allowFail: true }).split('\n').filter(Boolean) : [];
    print({
      branch: st.branch,
      qaCommit: short(st.qa.commit),
      remoteHead: short(remote),
      afterQa: log,
      files,
      verdict: !log.length ? 'OK: the branch is what QA measured. Merge when ready.'
        : log.some((c) => c.fromShopify) ? 'STOP: Shopify committed editor saves after QA (often test edits). Review the files; revert what isn\'t meant to ship, or re-run QA on what is (/shopify-implement <KEY>), before merging.'
          : 'STOP: the branch has commits QA didn\'t measure. Re-run QA on them (/shopify-implement <KEY>) before merging.',
    });
    process.exit(log.length ? 1 : 0);
  }

  case 'qa-row': {
    const key = normKey(rawKey);
    const st = readState(key);
    const nums = String(rest[0] || '').split(',').filter(Boolean);
    const carry = flags.carry === undefined ? null : String(flags.carry === true ? '' : flags.carry).trim();
    if (!nums.length || !nums.every((x) => /^\d+$/.test(x)) || (nums.length > 1 && carry === null)) {
      fail('Usage: qa-row <KEY> <#> [--measured T] [--how T] [--verdict V], or qa-row <KEY> <#,#,...> --carry "why"');
    }
    if (flags.verdict !== undefined && !VERDICTS.includes(flags.verdict)) fail('--verdict is one of: PASS, FAIL, NOT TESTED, BLOCKED');
    const given = (f) => (typeof flags[f] === 'string' ? flags[f].trim() : '');
    // A PASS or FAIL is a measurement: without the value and the call that produced it, it is an opinion.
    const measures = flags.verdict === 'PASS' || flags.verdict === 'FAIL';
    if (measures && (!given('measured') || !given('how'))) fail(`A ${flags.verdict} needs what was measured and how, in the same call: --measured "<value>" --how "<probe call or command>".`);
    // A PASS that says it couldn't prove part of the row (VET-689: "0 € price is not provable") is a partial result.
    const hedge = flags.verdict === 'PASS' && given('measured').match(HEDGE);
    if (hedge) fail(`--measured says "${hedge[0]}", so part of row ${rest[0]} wasn't shown. Record what was measured as PASS in its own row and the rest as NOT TESTED or BLOCKED with the reason, or measure it.`);
    // Gate 2 tells "the agent didn't check it" from "only the dev can check it" by this reason.
    if ((flags.verdict === 'NOT TESTED' || flags.verdict === 'BLOCKED') && !given('measured')) fail(`A ${flags.verdict} needs the reason in --measured: ${flags.verdict === 'BLOCKED' ? '"dev checks by hand: …" or what is missing' : 'why it wasn\'t checked here'}.`);
    if (carry !== null && (!carry || ['measured', 'how', 'verdict'].some((f) => flags[f] !== undefined))) fail('--carry takes only the reason: --carry "<why the new commits can\'t affect these rows>"');
    const head = git(['rev-parse', 'HEAD'], { allowFail: true }) || null;
    if ((measures || carry) && st.draft?.themeId && st.draft.verifiedCommit !== head) {
      fail(`The draft isn't at HEAD (draft verified at ${short(st.draft.verifiedCommit)}, HEAD ${short(head)}), so this verdict would belong to neither. Push the draft (verify on a GitHub-connected one), then measure again.`);
    }
    const p = join(LOGS, key, 'report.md');
    const lines = read(p).split(/\r?\n/);
    const start = lines.findIndex((l) => /^## Criteria\b/.test(l.trim()));
    const header = lines.findIndex((l, i) => i > start && l.trim().startsWith('|'));
    if (start === -1 || header === -1) fail('report.md has no § Criteria table yet. Copy the plan\'s QA criteria into it first.');
    const names = cells(lines[header]).map((c) => c.toLowerCase());
    const criteria = planCriteria(key);
    const out = [];
    for (const n of nums) {
      const row = lines.findIndex((l, i) => i > header && l.trim().startsWith('|') && cells(l)[0].replace(/\*/g, '') === n);
      if (row === -1) fail(`No row #${n} in report.md § Criteria.`);
      const c = cells(lines[row]);
      const at = (name) => {
        const i = names.findIndex((h) => h.startsWith(name));
        if (i === -1) fail(`The § Criteria table has no "${name}" column.`);
        return i;
      };
      const set = (name, value) => { c[at(name)] = String(value).replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|'); };
      const prev = st.qa?.rows?.[n];
      if (carry) {
        // A FAIL is fixed and measured again; only a PASS the new commits can't reach is kept.
        if (prev?.verdict !== 'PASS') fail(`Row ${n} isn't a recorded PASS, so there is nothing to carry: measure it.`);
        set('how', `${c[at('how')]} · carried to ${short(head)}: ${carry}`);
        st.qa.rows[n] = { ...prev, carriedTo: head, carry };
      }
      for (const f of ['measured', 'how', 'verdict']) if (typeof flags[f] === 'string') set(f, flags[f]);
      lines[row] = `| ${c.join(' | ')} |`;
      const col = (name) => c[names.findIndex((h) => h.startsWith(name))] || '';
      const cell = col('verdict');
      if (!carry && ['measured', 'how', 'verdict'].some((f) => typeof flags[f] === 'string')) {
        // The commit and draft a verdict was measured on tell done qa which rows a later commit may have changed;
        // the plan's text for the row, which ones the dev changed since (null: not a plan criterion).
        const rec = {
          verdict: (cell.match(/PASS|FAIL|NOT TESTED|BLOCKED/) || [''])[0], measured: col('measured'), how: col('how'),
          commit: head, themeId: st.draft?.themeId ?? null, at: now(), criterion: criteria.get(n) ?? null,
        };
        st.qa = { ...st.qa, rows: { ...st.qa?.rows, [n]: rec } };
      }
      out.push(`row ${n}: ${cell || '(no verdict yet)'}${carry ? ` (carried to ${short(head)})` : ''}`);
    }
    writeFileSync(p, lines.join('\n'));
    writeState(key, st);
    print(out.join('\n'));
    break;
  }

  case 'note': {
    const key = normKey(rawKey);
    const st = readState(key);
    if (flags.none) {
      st.history.push({ at: now(), event: 'note', none: true });
      writeState(key, st);
      print('Recorded: nothing the kit caused.');
      break;
    }
    const text = rest.join(' ').trim();
    if (!text) fail('Usage: kit.mjs note <KEY> "what happened, what you expected, what would have helped" [--kind friction|mistake|kit-bug|missing|idea]');
    const kind = typeof flags.kind === 'string' ? oneOf('friction', 'mistake', 'kit-bug', 'missing', 'idea')(flags.kind) : 'friction';
    const p = join(LOGS, key, 'kit-notes.md');
    if (!existsSync(p)) {
      writeFileSync(p, `# ${key} · Kit notes\n\n> Problems with the kit itself, not the ticket: for the kit maintainer. kit.mjs feedback collects these from every task.\n\n| When | Stage | Kind | Note |\n| --- | --- | --- | --- |\n`);
    }
    writeFileSync(p, `${read(p).trimEnd()}\n| ${now().slice(0, 16)} | ${st.stage} | ${kind} | ${text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')} |\n`);
    st.history.push({ at: now(), event: 'note', kind });
    writeState(key, st);
    print(`Noted in .claude/logs/${key}/kit-notes.md`);
    break;
  }

  case 'retro': {
    const key = normKey(rawKey);
    const st = readState(key);
    const signals = retroSignals(key, st);
    st.history.push({ at: now(), event: 'retro' });
    writeState(key, st);
    print({ ...signals, ask: RETRO_ASK });
    break;
  }

  case 'feedback': {
    const keys = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'state.json'))) : [];
    const parts = [];
    for (const k of keys) {
      const st = readState(k);
      const s = retroSignals(k, st);
      const notes = read(join(LOGS, k, 'kit-notes.md')).split(/\r?\n/).filter((l) => /^\| \d{4}-/.test(l));
      if (!notes.length && !s.loopsBack.length && !s.refusedStages.length && !s.guardBlocks.length) continue;
      parts.push([
        `## ${k} · ${st.kind === 'investigation' ? 'investigation' : st.type || '-'} · kit ${st.kitVersion} · ${st.stage} · ${st.updatedAt.slice(0, 10)}`,
        ...(notes.length ? ['', '| When | Stage | Kind | Note |', '| --- | --- | --- | --- |', ...notes] : []),
        ...(s.loopsBack.length ? ['', '**Loops back:**', ...s.loopsBack.map((x) => `- ${x}`)] : []),
        ...(s.refusedStages.length ? ['', '**Refused stage exits:**', ...s.refusedStages.map((x) => `- ${x}`)] : []),
        ...(s.guardBlocks.length ? ['', '**Guard blocks:**', ...s.guardBlocks.map((x) => `- ${x}`)] : []),
      ].join('\n'));
    }
    const out = join(LOGS, 'kit-feedback.md');
    writeFileSync(out, `# Kit feedback · ${now().slice(0, 10)}\n\n> From ${parts.length} of ${keys.length} tasks in this repo. Give this file to whoever maintains the kit.\n\n${parts.join('\n\n')}\n`);
    print(`${parts.length} tasks with notes or signals → .claude/logs/kit-feedback.md`);
    break;
  }

  case 'abandon': {
    const key = normKey(rawKey);
    const st = readState(key);
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Say why: --reason "..."');
    if (st.stage === 'abandoned') fail(`${key} is abandoned already.`);
    // A dropped task is where the kit most often got in the way, so it always gets the retro; a finished one only with signals.
    const signals = retroSignals(key, st);
    st.history.push({ at: now(), event: 'abandon', from: st.stage, reason: flags.reason.trim() }, { at: now(), event: 'retro' });
    st.stage = 'abandoned';
    writeState(key, st);
    const cleanup = [];
    // The state can't tell whether the theme still exists (it may have been deleted in the admin); delete-draft checks.
    if (st.draft?.themeId && !st.draft.deletedAt) {
      cleanup.push(st.draft.route === 'cli'
        ? `Draft theme ${st.draft.name || st.draft.themeId} (made by the kit) hasn't been deleted by the kit: ask the dev, then shopify.mjs delete-draft ${key} (it says so if the theme is gone already)`
        : `Theme ${st.draft.name || st.draft.themeId} was set up by the dev (${st.draft.route} route); the kit doesn't delete it. The dev decides.`);
    }
    for (const m of st.mutations || []) cleanup.push(`Store change from ${m.file} created ${m.ids.join(', ') || 'no ids'}: ask the dev whether to keep or remove it`);
    if (st.branch) cleanup.push(`Branch ${st.branch} stays; deleting it is the dev's call.`);
    print({ abandoned: key, cleanup: cleanup.length ? cleanup : ['Nothing left on the store.'], retro: { ...signals, ask: RETRO_ASK } });
    break;
  }

  case 'optout': {
    const p = process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'shopify-ai-toolkit', 'opt-out')
      : join(homedir(), '.config', 'shopify-ai-toolkit', 'opt-out');
    mkdirSync(dirname(p), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, '');
    print(`Shopify plugin telemetry opt-out file: ${p}`);
    break;
  }

  case 'build-probe': {
    // The page keeps the probe source in sessionStorage, so after the first injection each
    // navigation re-injects it with a one-line eval instead of resending it.
    // LF whatever the checkout's line endings, so the generated files are the same bytes on every OS.
    const source = read(join(KIT_DIR, 'probe.js')).replace(/\r\n/g, '\n');
    try { new Function(source); } catch (e) { fail(`probe.js doesn't parse: ${e.message}`); }
    const loader = `// Generated by: node .claude/kit/kit.mjs build-probe. Edit probe.js, not this file.\n`
      + `sessionStorage.setItem('__qaSrc', ${JSON.stringify(source)});\n(0, eval)(sessionStorage.getItem('__qaSrc'));\n`;
    // For the kit-browser (Playwright) server: run once per session, and every page loads the probe
    // before its own scripts, so errors() and shift() also see what happens during load.
    const init = `// Generated by: node .claude/kit/kit.mjs build-probe. Edit probe.js, not this file.\n`
      + `async (page) => {\n  await page.context().addInitScript({ content: ${JSON.stringify(source)} });\n  return 'probe loads on every page from the next navigation on';\n}\n`;
    const files = { 'probe.inject.js': loader, 'probe.init.js': init };
    if (flags.check) {
      const differ = Object.keys(files).filter((f) => read(join(KIT_DIR, f)).replace(/\r\n/g, '\n') !== files[f]);
      if (differ.length) fail(`kit/${differ.join(' and kit/')} don't match kit/probe.js. Run: node .claude/kit/kit.mjs build-probe`);
      print('kit/probe.inject.js and kit/probe.init.js match kit/probe.js.');
      break;
    }
    for (const [f, text] of Object.entries(files)) writeFileSync(join(KIT_DIR, f), text);
    print(`Wrote kit/probe.inject.js (${Math.round(loader.length / 1024)} KB) and kit/probe.init.js.`);
    break;
  }

  default:
    print(HELP.replace('{SETTABLE}', Object.keys(SETTABLE).join(', ')));
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
