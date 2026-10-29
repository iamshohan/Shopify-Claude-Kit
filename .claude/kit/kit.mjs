#!/usr/bin/env node
// Records where a ticket is in the pipeline: task state for /shopify-implement and /shopify-investigate, and
// the checks a stage must pass before it can be marked done.
// Usage: node .claude/kit/kit.mjs <verb> [<KEY>] ...   (--help lists the verbs)
// One folder per ticket: .claude/logs/<KEY>/ (state.json, brief.md, plan.md, report.md or investigation.md,
// kit-notes.md). Also reads the guard's _guard.jsonl and writes logs/kit-feedback.md and kit/probe.*.js.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  ROOT, KIT_DIR, LOGS, KIT_VERSION, STAGES, stagesFor, THEME_DIRS, MERCHANT_JSON, print, fail, parseArgs, normKey, now, run, git, currentBranch,
  readConfig, readState, writeState, owner, branchFor, protectedBranches, storefrontPath, parseCliJson, diagnosticJson, ignoreMatcher, TEST_SUFFIX,
  effectiveBase,
} from './lib.mjs';

// ── Help and settable facts ──
const HELP = `Usage: node .claude/kit/kit.mjs <verb> ...
  list                                   all tasks in this repo and their stage
  start <KEY>                            create .claude/logs/<KEY>/ (state + brief.md, plan.md, report.md); turns a finished investigation into an implementation
  start <KEY> --investigate              start a read-only investigation instead (state + investigation.md)
  start <KEY> --test                     a test run of the kit: branch and draft named <KEY>-kit-test, the branch is never pushed
  start <KEY> --small                    the small lane: no separate clarify gate; done plan refuses work that needs one
  lane <KEY> small|full                  switch lanes, up to the plan's approval (full reopens clarify for Gate 1)
  status <KEY> [--json]                  current stage, the skill to load, gates, branch, draft
  done <KEY> <stage> [--answer "TEXT"] [--note "TEXT"]
                                         finish the current stage; gate stages need --answer with the dev's words
  back <KEY> <stage> --reason "TEXT"     reopen an earlier stage (plan changes, QA failures, client feedback)
  set <KEY> name=value [name=value ...]  record a fact: {SETTABLE}
  qa-row <KEY> <#> [--measured T] [--how T] [--verdict PASS|FAIL|NOT TESTED|BLOCKED] [--expected T]
                                         fill one row of report.md § Criteria (no hand-edited tables, no heredocs)
  reach <KEY>                            files in plan.md § Files that reach beyond the feature (merchant JSON, layout,
                                         snippets, sections and assets used elsewhere); each goes in Needs your attention
  summary <KEY>                          time per stage, loops, gate answers, QA verdicts, store changes (for the PR)
  abandon <KEY> --reason "TEXT"          stop a task and list what to clean up (draft theme, store changes)
Kit feedback (problems with the kit itself, not the ticket)
  note <KEY> "TEXT" [--kind K]           record one; K: friction, mistake, kit-bug, missing, idea. Creates kit-notes.md on first use
  retro <KEY>                            what went wrong in this run, from the record: loops back, refused stages, guard blocks
  note <KEY> --none                      after retro: nothing the kit caused
  feedback                               every task's notes and signals in .claude/logs/kit-feedback.md, for the kit maintainer
  optout                                 create the Shopify plugin's telemetry opt-out file for this machine
  build-probe                            maintainers: regenerate kit/probe.inject.js after changing kit/probe.js
  --selftest                             test the pure helpers`;

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : fail(`Expected one of: ${allowed.join(', ')}`));
const TYPES = { implement: ['abtest', 'feature', 'bugfix'], investigation: ['feasibility', 'debug', 'question'] };
const SETTABLE = {
  type: String, // checked against the task's kind in "set"
  tickets: list,
  branch: String,
  base: String,
  'abtest.variation': String,
  'abtest.path': String,
  'abtest.tool': String,
  'abtest.running': oneOf('yes', 'no', 'unknown'),
  'abtest.reference': String,
  'design.figma': String, // a Figma link, or "none"
  featurePrefix: String,
  buildOutputs: list,
  'qa.paths': (v) => list(v).map(storefrontPath),
  'qa.products': list,
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

const filled = (key, file, heading, within, min = 20) => added(key, file, heading, within).join('').length >= min;
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
const saysNone = (key, file, heading, within) => /^(none|n\/a|—)\b/i.test(added(key, file, heading, within).join(' ').replace(/^[-*]\s*/, ''));
const NO_RECOMMENDED = /\(Recommended\)/i;
const hasDesign = (st) => Boolean(st.design?.figma) && st.design.figma !== 'none';

// ── Brief and plan checks ──
// Helpers for the clarify and plan exits below; reach() also backs the reach verb.

/** Gate 1's hard-coded list: each entry that touches an editability AC must have been asked on its own. */
function staysInCodeProblems(key) {
  const within = '## Decided';
  const rows = tableRows(key, 'brief.md', '#### Stays in code', within);
  if (!rows.length && !saysNone(key, 'brief.md', '#### Stays in code', within)) return ['fill brief.md § Control surface → Stays in code (one row per value the merchant can\'t change, or "none")'];
  return rows.flatMap((r) => {
    const [value, ac = '', why = '', agreed = ''] = cells(r);
    if (!ac) return [`Stays in code → "${value}": name the editability AC it touches, or "none"`];
    if (!why) return [`Stays in code → "${value}": say why it stays in code`];
    if (!/^none\b/i.test(ac) && !/Q\s*\d+/i.test(agreed)) return [`Stays in code → "${value}" touches ${ac}. Ask the dev about it as its own question and cite it (Q#) in "Dev agreed", or make it editable`];
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
  if (path.startsWith('snippets/')) {
    const n = count(new RegExp(`\\b(render|include)\\s+['"]${id}['"]`));
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
    const n = count(new RegExp(`['"]${escapeRe(name)}['"]`));
    return n > 1 ? `loaded by ${n} files` : null;
  }
  return null;
}

/** Existing files in plan.md § Files that reach beyond the feature. */
function reach(key) {
  const paths = [...new Set(tableRows(key, 'plan.md', '## Files').map((r) => cells(r)[0].replace(/`/g, '').trim().split(/\s+/)[0]))]
    .filter((p) => p && !/[*?]/.test(p) && existsSync(join(ROOT, p)));
  if (!paths.length) return [];
  const texts = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}/${e.name}`);
      else if (/\.(liquid|json)$/.test(e.name)) texts.set(`${dir}/${e.name}`, read(join(ROOT, dir, e.name)));
    }
  };
  for (const d of THEME_DIRS) if (existsSync(join(ROOT, d))) walk(d);
  return paths.map((file) => ({ file, reach: reachOf(file, texts) })).filter((x) => x.reach);
}

/** At a glance has to stay readable at a glance, and open with what can affect what already exists. */
function glanceProblems(key) {
  const lines = added(key, 'plan.md', '## At a glance');
  const rows = tableRows(key, 'plan.md', '## At a glance');
  const attention = added(key, 'plan.md', '### Needs your attention', '## At a glance');
  const said = attention.join('\n').toLowerCase();
  const unnamed = reach(key).filter((x) => !said.includes(x.file.toLowerCase()) && !said.includes(x.file.split('/').pop().toLowerCase()));
  const storeWrites = ['### Definitions', '### QA test data'].some((h) => filled(key, 'plan.md', h, '## Store setup', 10) && !saysNone(key, 'plan.md', h, '## Store setup'));
  return [
    !attention.length && 'fill plan.md § At a glance → ### Needs your attention: what this change can affect beyond the new feature, most impact first, or "none: only new files the feature owns"',
    unnamed.length && `Needs your attention doesn't name ${unnamed.map((x) => `${x.file} (${x.reach})`).join('; ')}. For each, say what could change for what already uses it, and how the plan contains it`,
    storeWrites && !/\bstore\b|definition|metaobject|metafield/.test(said) && 'Needs your attention: name the store writes (definitions, QA values) and whether they show on live before the merge',
    attention.filter((l) => /^[-*]\s/.test(l)).length > 6 && 'Needs your attention has more than 6 points. Keep the ones the dev must weigh; the rest belong in § Files',
    !rows.length && 'fill plan.md § At a glance: one row per file (or file group), "What happens" in 15 words at most',
    lines.length > 25 && `plan.md § At a glance has ${lines.length} lines; keep it to 25 (group files such as locales into one row)`,
  ];
}

/** done plan in the small lane: the work must not need Gate 1. Each refusal names the way back. */
function smallLaneProblems(key, st) {
  const out = ` → it needs the full lane: kit.mjs lane ${key} full (reopens clarify for Gate 1)`;
  const rows = tableRows(key, 'plan.md', '## Files').map((r) => cells(r)[0].replace(/`/g, '').trim());
  // A grouped row ("locales/*.json ×5") counts as its group.
  const count = rows.reduce((n, c) => n + Number((c.match(/×\s*(\d+)/) || [])[1] || 1), 0);
  const editable = tableRows(key, 'brief.md', '### What the tickets say should be editable', '## Asked');
  const store = ['### Definitions', '### QA test data'].some((h) => filled(key, 'plan.md', h, '## Store setup', 10) && !saysNone(key, 'plan.md', h, '## Store setup'));
  return [
    st.type === 'abtest' && `A/B ports decide what merchants control at Gate 1${out}`,
    editable.length > 0 && `the ticket says who may change what (brief.md § Asked → What the tickets say should be editable)${out}`,
    count > 3 && `plan.md § Files has ${count} files; the small lane takes at most 3${out}`,
    rows.some((c) => MERCHANT_JSON.test(c.split(/\s+/)[0])) && `the plan edits merchant-owned JSON${out}`,
    store && `the plan writes to the store (definitions or QA values)${out}`,
  ];
}

// ── Retro signals ──

/** What the record shows went wrong in a run. The guard log has no task key, so it is matched by time. */
function retroSignals(key, st) {
  const events = st.history || [];
  const refused = {};
  for (const e of events.filter((x) => x.event === 'refused')) (refused[e.stage] ||= []).push(...(e.missing || []));
  const from = st.createdAt;
  const to = st.stage === 'done' || st.stage === 'abandoned' ? st.updatedAt : now();
  const guardBlocks = read(join(LOGS, '_guard.jsonl')).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((g) => g && g.at >= from && g.at <= to).map((g) => `${g.at.slice(0, 16)} ${g.reason.slice(0, 110)} ← ${g.command.slice(0, 90)}`);
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

/** Retro done at the end of a task: signals shown, then notes or "none". */
function retroDone(st) {
  const shown = (st.history || []).map((e) => e.event).lastIndexOf('retro');
  return shown !== -1 && (st.history || []).slice(shown + 1).some((e) => e.event === 'note');
}

// ── Stage exit checks ──
// Each check proves the stage's output exists, so a stage can't be marked done on intent alone.
const EXIT_CHECKS = {
  intake: (key, st) => [
    !st.type && 'record the work type: kit.mjs set <KEY> type=abtest|feature|bugfix',
    !filled(key, 'brief.md', '### Acceptance criteria', '## Asked') && 'quote the acceptance criteria in brief.md § Asked → Acceptance criteria',
    !tableRows(key, 'brief.md', '### What the tickets say should be editable', '## Asked').length && !saysNone(key, 'brief.md', '### What the tickets say should be editable', '## Asked')
      && 'fill brief.md § Asked → What the tickets say should be editable: every line about who changes what, quoted in full (or "none")',
    st.type === 'abtest' && !st.abtest?.variation && 'record the winning variation: kit.mjs set <KEY> abtest.variation=<V>',
    st.type === 'abtest' && !st.abtest?.path && 'record where the A/B code is: kit.mjs set <KEY> abtest.path=<path>',
    st.type === 'abtest' && !st.abtest?.tool && 'record the testing tool (needed for the go-live order): kit.mjs set <KEY> abtest.tool=<tool>',
    st.type === 'abtest' && !st.abtest?.running && 'record whether the experiment still runs: kit.mjs set <KEY> abtest.running=yes|no|unknown',
  ],
  analyze: (key, st) => [
    !filled(key, 'brief.md', '### Render path', '## Found') && 'fill brief.md § Found → Render path',
    !filled(key, 'brief.md', '### Closest existing pattern', '## Found') && 'fill brief.md § Found → Closest existing pattern',
    st.type === 'abtest' && !filled(key, 'brief.md', '### A/B inventory', '## Found') && 'fill brief.md § Found → A/B inventory',
    hasDesign(st) && !tableRows(key, 'design.md', '## Elements').length
      && 'run the design-extractor agent and write .claude/logs/<KEY>/design.md from .claude/kit/templates/design.md (or kit.mjs set <KEY> design.figma=none to skip the design check)',
  ],
  clarify: (key) => [
    !tableRows(key, 'brief.md', '### Control surface', '## Decided').length && !/no dynamic|none/i.test(added(key, 'brief.md', '### Control surface', '## Decided').join(' '))
      && 'fill brief.md § Decided → Control surface (one row per value, or say "none")',
    ...staysInCodeProblems(key),
    !filled(key, 'brief.md', '### Questions and answers', '## Decided', 10) && 'record the questions and the dev\'s answers in brief.md § Decided',
    tableRows(key, 'brief.md', '### Questions and answers', '## Decided').some((r) => NO_RECOMMENDED.test(cells(r)[2] || ''))
      && 'brief.md § Questions and answers: record the dev\'s choice without the "(Recommended)" tag; how you apply it goes in "Applied as"',
  ],
  plan: (key, st) => {
    const minCriteria = st.lane === 'small' ? 2 : 3;
    return [
      ...glanceProblems(key),
      ...(st.lane === 'small' ? smallLaneProblems(key, st) : []),
      !tableRows(key, 'plan.md', '## Files').length && 'fill plan.md § Files (builder detail): one table row per file',
      tableRows(key, 'plan.md', '## QA criteria').length < minCriteria && `write at least ${minCriteria} QA criteria rows in plan.md § QA criteria`,
    ];
  },
  build: (key, st) => {
    if (!st.branch || !st.base) return ['record branch and base: kit.mjs set <KEY> branch=... base=<sha>'];
    const dirty = git(['status', '--porcelain', '--', ...existingThemeDirs()], { allowFail: true });
    const ahead = Number(git(['rev-list', '--count', `${effectiveBase(st, readConfig({ required: false }))}..HEAD`], { allowFail: true }) || 0);
    return [
      currentBranch() !== st.branch && `check out the task branch ${st.branch}`,
      dirty && 'commit the theme changes on the task branch',
      ahead === 0 && 'the branch has no commits beyond its base yet',
    ];
  },
  draft: (key, st) => {
    if (!st.draft?.themeId) return ['create the draft: shopify.mjs draft <KEY>'];
    const head = ref(`refs/heads/${st.branch}`);
    if (st.draft.route === 'github') {
      return [
        !branchPushed(st) && 'a GitHub-connected draft updates from the branch: git push -u origin <branch>',
        branchPushed(st) && st.draft.verifiedCommit !== head && 'check that Shopify synced the branch: shopify.mjs verify <KEY>',
      ];
    }
    return [st.draft.verifiedCommit !== head && st.draft.lastPushedCommit !== head && 'push the current commit: shopify.mjs push <KEY>'];
  },
  qa: (key, st) => {
    const stale = staleFails(st.qa?.rows, st.draft?.verifiedCommit || st.draft?.lastPushedCommit);
    const rows = tableRows(key, 'report.md', '## Criteria').filter((l) => /\|\s*\**(PASS|FAIL|NOT TESTED|BLOCKED)\b/.test(l));
    const planned = tableRows(key, 'plan.md', '## QA criteria').length;
    const open = rows.filter((l) => /\|\s*\**(BLOCKED|NOT TESTED)\b/.test(l)).length;
    return [
      rows.length === 0 && 'write report.md § Criteria with a verdict on every row',
      rows.length < planned && `report.md has ${rows.length} rows with a verdict but the plan has ${planned} QA criteria`,
      stale.length && `rows ${stale.join(', ')} failed on an earlier commit and weren't measured again on the current draft: re-measure them and record each with kit.mjs qa-row`,
      !filled(key, 'report.md', '## Summary') && 'write report.md § Summary',
      open && !filled(key, 'report.md', '## You must still do', undefined, 10) && `${open} rows are BLOCKED or NOT TESTED: list what the dev must do for each in report.md § You must still do`,
    ];
  },
  handoff: (key, st) => [
    !filled(key, 'report.md', '## Handoff', undefined, 80) && 'write report.md § Handoff',
    !st.test && !branchPushed(st) && `push the task branch: git push -u origin ${st.branch}`,
    !retroDone(st) && 'run kit.mjs retro <KEY>, then record what the kit made harder (kit.mjs note <KEY> "...") or kit.mjs note <KEY> --none',
  ],
  // Investigation stages.
  frame: (key, st) => [
    !st.type && 'record the kind of investigation: kit.mjs set <KEY> type=feasibility|debug|question',
    !filled(key, 'investigation.md', '## Question', undefined, 40) && 'write the precise question and what counts as answered in investigation.md § Question',
  ],
  gather: (key, st) => {
    const labelled = tableRows(key, 'investigation.md', '## Evidence').filter((l) => /\b(Confirmed|Inferred|Assumed|Unknown)\b/.test(l));
    return [
      !labelled.some((l) => /\bConfirmed\b/.test(l)) && 'no Confirmed evidence yet: read or observe something that settles a claim',
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
      !filled(key, 'investigation.md', '## Could not determine', undefined, 10) && 'fill investigation.md § Could not determine ("Nothing material" only if that is true)',
      !filled(key, 'investigation.md', '## Next step') && 'write investigation.md § Next step',
      !filled(key, 'investigation.md', '## Review') && 'run the evidence-checker agent and record its result in investigation.md § Review',
      changed.length && `theme files changed since the investigation started (${changed.join(', ')}). Investigations are read-only: undo your own edits; edits the dev made are theirs to keep, so ask`,
      !retroDone(st) && 'run kit.mjs retro <KEY>, then record what the kit made harder (kit.mjs note <KEY> "...") or kit.mjs note <KEY> --none',
    ];
  },
};

// ── Git and theme state ──

// Raw output: git() trims, which would cut the leading space of the first " M path" line.
const themeStatus = () => run('git', ['status', '--porcelain', '--', ...existingThemeDirs()]).stdout.split(/\r?\n/).filter(Boolean);

/** Theme files whose git status differs from when the investigation started. */
function themeChanges(st) {
  const before = new Set(st.readonly?.themeStatus || []);
  const current = themeStatus();
  const differ = [...current.filter((l) => !before.has(l)), ...[...before].filter((l) => !current.includes(l))];
  return [...new Set(differ.map((l) => l.slice(3)))];
}

function existingThemeDirs() {
  return THEME_DIRS.filter((d) => existsSync(join(ROOT, d)));
}

// Pushed means origin has the local branch's current commit, not just a branch of that name.
function branchPushed(st) {
  const local = ref(`refs/heads/${st.branch}`);
  return Boolean(local) && local === ref(`refs/remotes/origin/${st.branch}`);
}

// ── Status and summary output ──

/** What start, status, done, back and lane print: the stage, the skill to load next, and the task's facts. */
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
  }
  const done = stages.filter((_, j) => j < (i === -1 ? stages.length : i)).map((s) => {
    const g = st.gates?.[s.name];
    return g ? `${s.name} ✓ ("${g.answer.slice(0, 60)}${g.answer.length > 60 ? '…' : ''}")` : `${s.name} ✓`;
  });
  if (done.length) lines.push(`Done: ${done.join(' · ')}`);
  if (kindOf(st) === 'investigation') {
    lines.push('Read-only: no theme edits, no store changes, no draft theme. A fix becomes /shopify-implement on this key afterwards.');
    lines.push(`Logs: .claude/logs/${key}/investigation.md`);
    if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
    return lines.join('\n');
  }
  if (st.investigation) lines.push(`Investigated first (${st.investigation.type}): intake reads .claude/logs/${key}/investigation.md.`);
  if (st.lane === 'small') lines.push(`Small lane: no separate clarify gate. Ask any open questions at the start of the plan stage; done plan refuses work that needs Gate 1 (then: kit.mjs lane ${key} full).`);
  if (st.test) lines.push(`TEST RUN of the kit: the branch and the draft are named ${key}${TEST_SUFFIX}, and the branch is never pushed (the guard blocks it). The draft is a CLI copy of live, whatever draftRoute says. Handoff writes the report but pushes nothing.`);
  lines.push(`Branch: ${st.branch || `${branchFor(cfg, key, st)} (not created yet)`} · base: ${st.base ? st.base.slice(0, 7) : '—'} · protected: ${protectedBranches(cfg).join(', ')}`);
  if (cfg?.adminApi === false) lines.push('Admin API: off in this repo. Definitions and QA values are admin steps for the dev; read store data from admin pages in Chrome (look only).');
  if (cfg?.commitPattern) lines.push(`Commit messages: ${cfg.commitPattern.replace('{KEY}', key).replace('{key}', key.toLowerCase())}`);
  if (st.stage === 'build') lines.push(`Stage with: git add -- ${existingThemeDirs().join(' ')}`);
  if (st.draft?.themeId) {
    lines.push(`Draft: ${st.draft.name || st.draft.themeId} (id ${st.draft.themeId}, ${st.draft.route})${st.draft.deletedAt ? ' — deleted' : ''}`);
    if (st.draft.previewUrl) lines.push(`Preview: ${st.draft.previewUrl}`);
    if (st.draft.editorUrl) lines.push(`Editor: ${st.draft.editorUrl}`);
  }
  if (st.type === 'abtest') lines.push(`A/B: variation ${st.abtest?.variation || '?'} · code ${st.abtest?.path || '?'} · tool ${st.abtest?.tool || '?'} · running ${st.abtest?.running || '?'}${st.abtest?.reference ? ` · force link ${st.abtest.reference}` : ''}`);
  if (hasDesign(st)) lines.push(`Design: Figma ${st.design.figma} (values in design.md)`);
  if (cfg?.draftRoute === 'github' && !st.test && !st.draft?.themeId) lines.push('Draft route: GitHub-connected (draftRoute in shopify-kit.json). The dev connects the task branch; the kit adopts it with shopify.mjs draft <KEY> --github.');
  if (st.mutations?.length) lines.push(`Store mutations run: ${st.mutations.length} (ids: kit.mjs status ${key} --json)`);
  lines.push(`Logs: .claude/logs/${key}/ (brief.md, plan.md, report.md)`);
  if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
  return lines.join('\n');
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
    key, kind: kindOf(st), type: st.type, lane: kindOf(st) === 'implement' ? st.lane || 'full' : undefined, stage: st.stage, owner: st.owner?.name, kitVersion: st.kitVersion,
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
  eq('parseArgs values', parseArgs(['done', 'ABC-1', 'clarify', '--answer', 'use a block']), { _: ['done', 'ABC-1', 'clarify'], flags: { answer: 'use a block' } });
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
  eq('stages implement', stagesFor({}).map((x) => x.name).slice(0, 2), ['intake', 'analyze']);
  eq('stages investigation', stagesFor({ kind: 'investigation' }).map((x) => x.name), ['frame', 'gather', 'conclude']);
  eq('stages small lane', stagesFor({ lane: 'small' }).map((x) => x.name), ['intake', 'analyze', 'plan', 'approve', 'build', 'draft', 'qa', 'accept', 'handoff']);
  eq('small lane keeps one gate', stagesFor({ lane: 'small' }).filter((x) => x.gate).map((x) => x.name), ['approve', 'accept']);
  eq('design set', hasDesign({ design: { figma: 'https://www.figma.com/design/abc/x' } }), true);
  eq('design none or unset', [hasDesign({ design: { figma: 'none' } }), hasDesign({})], [false, false]);
  eq('cells', cells('| 3 | a \\| b | PASS |'), ['3', 'a \\| b', 'PASS']);
  eq('cells empty last', cells('| Icons | AC 18 | winner SVGs | |'), ['Icons', 'AC 18', 'winner SVGs', '']);
  const theme = new Map([
    ['layout/theme.liquid', "{{ 'base.css' | asset_url | stylesheet_tag }}\n{% sections 'header-group' %}"],
    ['sections/header-group.json', '{"sections":{"h":{"type":"header"}}}'],
    ['sections/a.liquid', "{% render 'icon' %}"], ['sections/b.liquid', "{% render 'icon', name: 'cart' %}\n{% render 'mnav-list' %}"],
    ['snippets/icon.liquid', ''], ['snippets/mnav-list.liquid', ''], ['sections/header.liquid', ''], ['sections/mnav.liquid', ''],
  ]);
  eq('reach shared snippet', reachOf('snippets/icon.liquid', theme), 'rendered from 2 files');
  eq('reach own snippet', reachOf('snippets/mnav-list.liquid', theme), null);
  eq('reach layout asset', reachOf('assets/base.css', theme), 'loaded on every page (layout)');
  eq('reach section group member', reachOf('sections/header.liquid', theme), 'in the layout or a section group, so on every page');
  eq('reach unused section', reachOf('sections/mnav.liquid', theme), null);
  eq('reach merchant JSON', reachOf('sections/header-group.json', theme).startsWith('merchant-owned'), true);
  eq('retroDone needs a note after retro', [retroDone({ history: [{ event: 'note' }, { event: 'retro' }] }), retroDone({ history: [{ event: 'retro' }, { event: 'note', none: true }] })], [false, true]);
  eq('staleFails: a FAIL measured on an older commit', staleFails({ 3: { verdict: 'FAIL', commit: 'a1' }, 4: { verdict: 'PASS', commit: 'a1' }, 5: { verdict: 'FAIL', commit: 'b2' }, 6: { verdict: 'FAIL', commit: null } }, 'b2'), ['3']);
  eq('staleFails: nothing recorded', [staleFails(undefined, 'b2'), staleFails({ 1: { verdict: 'FAIL', commit: 'a1' } }, undefined)], [[], []]);
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  print(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

// ── Verbs ──
// One case per verb; HELP at the top describes each.
const { _: [verb, rawKey, ...rest], flags } = parseArgs(process.argv.slice(2));

if (process.argv.includes('--selftest')) selftest();

switch (verb) {
  case 'list': {
    const keys = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'state.json'))) : [];
    if (!keys.length) print('No tasks yet. Start one with /shopify-implement <KEY>.');
    for (const k of keys) {
      const st = readState(k);
      const draft = st.draft?.themeId && !st.draft.deletedAt ? ` · draft ${st.draft.name || st.draft.themeId} still exists` : '';
      const type = kindOf(st) === 'investigation' ? `investigation:${st.type || '-'}` : `${st.type || '-'}${st.lane === 'small' ? ' (small)' : ''}`;
      print(`${k}\t${type}${st.test ? ' (test run)' : ''}\t${st.stage}\t${st.updatedAt.slice(0, 10)}\t${st.owner?.name || ''}${draft}`);
    }
    break;
  }

  case 'start': {
    const key = normKey(rawKey);
    const cfg = readConfig();
    const existing = readState(key, { required: false });
    if (flags.small && flags.investigate) fail('Investigations have no lanes; --small is for /shopify-implement.');
    const implementFields = {
      kind: 'implement', type: null, lane: flags.small ? 'small' : 'full', stage: STAGES[0].name, gates: {},
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
          schemaVersion: 1, kitVersion: KIT_VERSION, key, kind: 'investigation', type: null, tickets: [key],
          createdAt: now(), owner: owner(), stage: stagesFor({ kind: 'investigation' })[0].name, gates: {},
          history: [{ at: now(), event: 'start' }],
          // conclude compares against this, so an investigation can't end with theme files changed.
          readonly: { head: git(['rev-parse', 'HEAD'], { allowFail: true }), themeStatus: themeStatus() },
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
        schemaVersion: 1, kitVersion: KIT_VERSION, key, tickets: [key], createdAt: now(), owner: owner(),
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
    if (!st) { print(`${key} not started. Run: node .claude/kit/kit.mjs start ${key}`); break; }
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
    const missing = (EXIT_CHECKS[stage]?.(key, st) || []).filter(Boolean);
    if (missing.length) {
      // Kept for the retro: repeated refusals at one stage point at a skill that doesn't say what the check wants.
      st.history.push({ at: now(), event: 'refused', stage, missing: missing.map((m) => m.slice(0, 160)) });
      writeState(key, st);
      fail(`"${stage}" isn't finished:\n${missing.map((m) => `- ${m.replaceAll('<KEY>', key)}`).join('\n')}`);
    }
    if (def.gate) st.gates[stage] = { answer, at: now() };
    st.history.push({ at: now(), event: 'done', stage, answer: answer || undefined, note: flags.note || undefined });
    const next = stages[stageIndex(stage, st) + 1];
    st.stage = next ? next.name : 'done';
    writeState(key, st);
    print(summaryLines(key, st, readConfig({ required: false })));
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
      const value = SETTABLE[name](pair.slice(eq + 1).trim());
      if (name === 'type' && !TYPES[kindOf(st)].includes(value)) fail(`The type of ${kindOf(st) === 'investigation' ? 'an investigation' : 'an implementation'} is one of: ${TYPES[kindOf(st)].join(', ')}`);
      const [head, sub] = name.split('.');
      if (sub) st[head] = { ...(st[head] || {}), [sub]: value };
      else st[head] = value;
      if (name === 'draft.themeId') { st.draft.createdAt ||= now(); st.draft.route ||= 'manual'; delete st.draft.deletedAt; }
    }
    st.history.push({ at: now(), event: 'set', values: rest });
    writeState(key, st);
    print(`Recorded: ${rest.join(' ')}`);
    break;
  }

  case 'lane': {
    const key = normKey(rawKey);
    const st = readState(key);
    if (kindOf(st) === 'investigation') fail('Investigations have no lanes.');
    const to = oneOf('small', 'full')(rest[0]);
    const from = st.lane === 'small' ? 'small' : 'full';
    if (to === from) { print(`${key} is already in the ${to} lane.`); break; }
    const order = STAGES.map((s) => s.name);
    const at = order.indexOf(st.stage);
    if (at === -1 || at > order.indexOf('approve')) fail(`${key} is past the plan's approval (stage ${st.stage}), so its lane is fixed.`);
    st.lane = to;
    // Into the small lane at clarify: the questions move into the plan stage.
    // Into the full lane after it: Gate 1 comes first.
    if (to === 'small' && st.stage === 'clarify') st.stage = 'plan';
    if (to === 'full' && at > order.indexOf('clarify')) st.stage = 'clarify';
    st.history.push({ at: now(), event: 'lane', from, to, stage: st.stage });
    writeState(key, st);
    print(summaryLines(key, st, readConfig({ required: false })));
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

  case 'qa-row': {
    const key = normKey(rawKey);
    const st = readState(key);
    const n = rest[0];
    if (!/^\d+$/.test(n || '')) fail('Usage: qa-row <KEY> <#> [--measured T] [--how T] [--verdict V] [--expected T]');
    if (flags.verdict && !['PASS', 'FAIL', 'NOT TESTED', 'BLOCKED'].includes(flags.verdict)) fail('--verdict is one of: PASS, FAIL, NOT TESTED, BLOCKED');
    const p = join(LOGS, key, 'report.md');
    const lines = read(p).split(/\r?\n/);
    const start = lines.findIndex((l) => /^## Criteria\b/.test(l.trim()));
    const header = lines.findIndex((l, i) => i > start && l.trim().startsWith('|'));
    if (start === -1 || header === -1) fail('report.md has no § Criteria table yet. Copy the plan\'s QA criteria into it first.');
    const names = cells(lines[header]).map((c) => c.toLowerCase());
    const row = lines.findIndex((l, i) => i > header && l.trim().startsWith('|') && cells(l)[0].replace(/\*/g, '') === n);
    if (row === -1) fail(`No row #${n} in report.md § Criteria.`);
    const c = cells(lines[row]);
    const set = (name, value) => {
      const i = names.findIndex((h) => h.startsWith(name));
      if (i === -1) fail(`The § Criteria table has no "${name}" column.`);
      c[i] = String(value).replace(/\r?\n/g, ' ').replace(/(?<!\\)\|/g, '\\|');
    };
    for (const f of ['measured', 'how', 'verdict', 'expected']) if (typeof flags[f] === 'string') set(f, flags[f]);
    lines[row] = `| ${c.join(' | ')} |`;
    writeFileSync(p, lines.join('\n'));
    const cell = c[names.findIndex((h) => h.startsWith('verdict'))] || '';
    // The commit a verdict was measured on: done qa uses it to tell that a failed row's fix was never measured again.
    st.qa = { ...st.qa, rows: { ...st.qa?.rows, [n]: { verdict: (cell.match(/PASS|FAIL|NOT TESTED|BLOCKED/) || [''])[0], commit: st.draft?.verifiedCommit || st.draft?.lastPushedCommit || null } } };
    writeState(key, st);
    print(`row ${n}: ${cell || '(no verdict yet)'}`);
    break;
  }

  case 'note': {
    const key = normKey(rawKey);
    const st = readState(key);
    if (flags.none) {
      if (!(st.history || []).some((e) => e.event === 'retro')) fail(`Run kit.mjs retro ${key} first and look at what it lists.`);
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
    print({
      ...signals,
      ask: 'For each signal, decide whether the kit caused it (an instruction that misled, a missing verb, a check that wanted something unclear, a guard block on a harmless command) or the ticket did. '
        + 'Also count what the dev had to correct and anything you worked around. Record each kit cause: kit.mjs note <KEY> "<what happened> → <what would have prevented it>" --kind <kind>. '
        + 'Nothing kit-caused: kit.mjs note <KEY> --none.',
    });
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
    st.history.push({ at: now(), event: 'abandon', from: st.stage, reason: flags.reason.trim() });
    st.stage = 'abandoned';
    writeState(key, st);
    const cleanup = [];
    if (st.draft?.themeId && !st.draft.deletedAt) {
      cleanup.push(st.draft.route === 'cli'
        ? `Draft theme ${st.draft.name || st.draft.themeId} (made by the kit) still exists: ask the dev, then shopify.mjs delete-draft ${key}`
        : `Theme ${st.draft.name || st.draft.themeId} was set up by the dev (${st.draft.route} route); the kit doesn't delete it. The dev decides.`);
    }
    for (const m of st.mutations || []) cleanup.push(`Store change from ${m.file} created ${m.ids.join(', ') || 'no ids'}: ask the dev whether to keep or remove it`);
    if (st.branch) cleanup.push(`Branch ${st.branch} stays; deleting it is the dev's call.`);
    print({ abandoned: key, cleanup: cleanup.length ? cleanup : ['Nothing left on the store.'] });
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
    // navigation re-injects it with a one-line eval instead of resending ~6k tokens.
    const source = read(join(KIT_DIR, 'probe.js'));
    const loader = `// Generated by: node .claude/kit/kit.mjs build-probe. Edit probe.js, not this file.\n`
      + `sessionStorage.setItem('__qaSrc', ${JSON.stringify(source)});\n(0, eval)(sessionStorage.getItem('__qaSrc'));\n`;
    writeFileSync(join(KIT_DIR, 'probe.inject.js'), loader);
    // For the kit-browser (Playwright) server: run once per session, and every page loads the probe
    // before its own scripts, so errors() and shift() also see what happens during load.
    const init = `// Generated by: node .claude/kit/kit.mjs build-probe. Edit probe.js, not this file.\n`
      + `async (page) => {\n  await page.context().addInitScript({ content: ${JSON.stringify(source)} });\n  return 'probe loads on every page from the next navigation on';\n}\n`;
    writeFileSync(join(KIT_DIR, 'probe.init.js'), init);
    print(`Wrote kit/probe.inject.js (${Math.round(loader.length / 1024)} KB) and kit/probe.init.js.`);
    break;
  }

  default:
    print(HELP.replace('{SETTABLE}', Object.keys(SETTABLE).join(', ')));
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
