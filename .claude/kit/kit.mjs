#!/usr/bin/env node
// Task state for /implement. One folder per ticket: .claude/logs/<KEY>/.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  ROOT, KIT_DIR, LOGS, KIT_VERSION, STAGES, THEME_DIRS, print, fail, parseArgs, normKey, now, git, currentBranch,
  readConfig, readState, writeState, owner, branchFor, protectedBranches, storefrontPath, parseCliJson, ignoreMatcher,
} from './lib.mjs';

const HELP = `Usage: node .claude/kit/kit.mjs <verb> ...
  list                                   all tasks in this repo and their stage
  start <KEY>                            create .claude/logs/<KEY>/ (state + brief.md, plan.md, report.md)
  status <KEY> [--json]                  current stage, the skill to load, gates, branch, draft
  done <KEY> <stage> [--answer "TEXT"] [--note "TEXT"]
                                         finish the current stage; gate stages need --answer with the dev's words
  back <KEY> <stage> --reason "TEXT"     reopen an earlier stage (plan changes, QA failures, client feedback)
  set <KEY> name=value [name=value ...]  record a fact: {SETTABLE}
  summary <KEY>                          time per stage, loops, gate answers, QA verdicts, store changes (for the PR)
  abandon <KEY> --reason "TEXT"          stop a task and list what to clean up (draft theme, store changes)
  optout                                 create the Shopify plugin's telemetry opt-out file for this machine
  build-probe                            maintainers: regenerate kit/probe.inject.js after changing kit/probe.js
  --selftest                             test the pure helpers`;

const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : fail(`Expected one of: ${allowed.join(', ')}`));
const SETTABLE = {
  type: oneOf('abtest', 'feature', 'bugfix'),
  tickets: list,
  branch: String,
  base: String,
  'abtest.variation': String,
  'abtest.path': String,
  'abtest.tool': String,
  'abtest.running': oneOf('yes', 'no', 'unknown'),
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

const TEMPLATES = ['brief.md', 'plan.md', 'report.md'];
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
const stageIndex = (name) => STAGES.findIndex((s) => s.name === name);
const ref = (r) => git(['rev-parse', '--verify', '--quiet', r], { allowFail: true });

// Each check proves the stage's output exists, so a stage can't be marked done on intent alone.
const EXIT_CHECKS = {
  intake: (key, st) => [
    !st.type && 'record the work type: kit.mjs set <KEY> type=abtest|feature|bugfix',
    !filled(key, 'brief.md', '### Acceptance criteria', '## Asked') && 'quote the acceptance criteria in brief.md § Asked → Acceptance criteria',
    st.type === 'abtest' && !st.abtest?.variation && 'record the winning variation: kit.mjs set <KEY> abtest.variation=<V>',
    st.type === 'abtest' && !st.abtest?.path && 'record where the A/B code is: kit.mjs set <KEY> abtest.path=<path>',
    st.type === 'abtest' && !st.abtest?.tool && 'record the testing tool (needed for the go-live order): kit.mjs set <KEY> abtest.tool=<tool>',
    st.type === 'abtest' && !st.abtest?.running && 'record whether the experiment still runs: kit.mjs set <KEY> abtest.running=yes|no|unknown',
  ],
  analyze: (key, st) => [
    !filled(key, 'brief.md', '### Render path', '## Found') && 'fill brief.md § Found → Render path',
    !filled(key, 'brief.md', '### Closest existing pattern', '## Found') && 'fill brief.md § Found → Closest existing pattern',
    st.type === 'abtest' && !filled(key, 'brief.md', '### A/B inventory', '## Found') && 'fill brief.md § Found → A/B inventory',
  ],
  clarify: (key) => [
    !tableRows(key, 'brief.md', '### Control surface', '## Decided').length && !/no dynamic|none/i.test(added(key, 'brief.md', '### Control surface', '## Decided').join(' '))
      && 'fill brief.md § Decided → Control surface (one row per value, or say "none")',
    !filled(key, 'brief.md', '### Questions and answers', '## Decided', 10) && 'record the questions and the dev\'s answers in brief.md § Decided',
  ],
  plan: (key) => [
    !tableRows(key, 'plan.md', '## Files').length && 'fill plan.md § Files (one table row per file)',
    tableRows(key, 'plan.md', '## QA criteria').length < 3 && 'write at least 3 QA criteria rows in plan.md § QA criteria',
  ],
  build: (key, st) => {
    if (!st.branch || !st.base) return ['record branch and base: kit.mjs set <KEY> branch=... base=<sha>'];
    const dirty = git(['status', '--porcelain', '--', ...existingThemeDirs()], { allowFail: true });
    const ahead = Number(git(['rev-list', '--count', `${st.base}..HEAD`], { allowFail: true }) || 0);
    return [
      currentBranch() !== st.branch && `check out the task branch ${st.branch}`,
      dirty && 'commit the theme changes on the task branch',
      ahead === 0 && 'the branch has no commits beyond its base yet',
    ];
  },
  draft: (key, st) => {
    if (!st.draft?.themeId) return ['create the draft: shopify.mjs draft <KEY>'];
    if (st.draft.route === 'github') return [!branchPushed(st) && 'a GitHub-connected draft updates from the branch: git push -u origin <branch>'];
    return [st.draft.lastPushedCommit !== ref(`refs/heads/${st.branch}`) && 'push the current commit: shopify.mjs push <KEY>'];
  },
  qa: (key) => {
    const rows = tableRows(key, 'report.md', '## Criteria').filter((l) => /\|\s*\**(PASS|FAIL|NOT TESTED|BLOCKED)\b/.test(l));
    const planned = tableRows(key, 'plan.md', '## QA criteria').length;
    return [
      rows.length === 0 && 'write report.md § Criteria with a verdict on every row',
      rows.length < planned && `report.md has ${rows.length} rows with a verdict but the plan has ${planned} QA criteria`,
      !filled(key, 'report.md', '## Summary') && 'write report.md § Summary',
    ];
  },
  handoff: (key, st) => [
    !filled(key, 'report.md', '## Handoff', undefined, 80) && 'write report.md § Handoff',
    !branchPushed(st) && `push the task branch: git push -u origin ${st.branch}`,
  ],
};

function existingThemeDirs() {
  return THEME_DIRS.filter((d) => existsSync(join(ROOT, d)));
}

function branchPushed(st) {
  const local = ref(`refs/heads/${st.branch}`);
  return Boolean(local) && local === ref(`refs/remotes/origin/${st.branch}`);
}

function summaryLines(key, st, cfg) {
  const i = stageIndex(st.stage);
  const lines = [];
  if (st.stage === 'done' || st.stage === 'abandoned') {
    lines.push(`${key} · ${st.type || 'type not set'} · ${st.stage === 'done' ? 'finished' : 'abandoned'}`);
  } else {
    const s = STAGES[i];
    lines.push(`${key} · ${st.type || 'type not set'} · stage ${i + 1}/${STAGES.length}: ${s.name}${s.gate ? ` (${s.gate})` : ''}`);
    lines.push(`Next: load the skill "${s.skill}" and do the "${s.name}" stage.`);
  }
  const done = STAGES.filter((_, j) => j < (i === -1 ? STAGES.length : i)).map((s) => {
    const g = st.gates?.[s.name];
    return g ? `${s.name} ✓ ("${g.answer.slice(0, 60)}${g.answer.length > 60 ? '…' : ''}")` : `${s.name} ✓`;
  });
  if (done.length) lines.push(`Done: ${done.join(' · ')}`);
  lines.push(`Branch: ${st.branch || `${branchFor(cfg, key)} (not created yet)`} · base: ${st.base ? st.base.slice(0, 7) : '—'} · protected: ${protectedBranches(cfg).join(', ')}`);
  if (cfg?.commitPattern) lines.push(`Commit messages: ${cfg.commitPattern.replace('{KEY}', key).replace('{key}', key.toLowerCase())}`);
  if (st.stage === 'build') lines.push(`Stage with: git add -- ${existingThemeDirs().join(' ')}`);
  if (st.draft?.themeId) {
    lines.push(`Draft: ${st.draft.name || st.draft.themeId} (id ${st.draft.themeId}, ${st.draft.route})${st.draft.deletedAt ? ' — deleted' : ''}`);
    if (st.draft.previewUrl) lines.push(`Preview: ${st.draft.previewUrl}`);
    if (st.draft.editorUrl) lines.push(`Editor: ${st.draft.editorUrl}`);
  }
  if (st.type === 'abtest') lines.push(`A/B: variation ${st.abtest?.variation || '?'} · code ${st.abtest?.path || '?'} · tool ${st.abtest?.tool || '?'} · running ${st.abtest?.running || '?'}`);
  if (st.mutations?.length) lines.push(`Store mutations run: ${st.mutations.length} (ids: kit.mjs status ${key} --json)`);
  lines.push(`Logs: .claude/logs/${key}/ (brief.md, plan.md, report.md)`);
  if (st.kitVersion !== KIT_VERSION) lines.push(`Note: started with kit ${st.kitVersion}, this is kit ${KIT_VERSION}.`);
  return lines.join('\n');
}

const minutes = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

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
    key, type: st.type, stage: st.stage, owner: st.owner?.name, kitVersion: st.kitVersion,
    startedAt: st.createdAt, lastUpdate: st.updatedAt, elapsedMinutes: minutes(st.createdAt, st.updatedAt),
    minutesPerStage: perStage,
    loopsBack: events.filter((e) => e.event === 'back').map((e) => `${e.from} → ${e.to}: ${e.reason}`),
    gates: Object.fromEntries(Object.entries(st.gates || {}).map(([g, v]) => [g, `${v.at.slice(0, 16)} "${v.answer}"`])),
    qaVerdicts: verdicts,
    storeChanges: (st.mutations || []).map((m) => `${m.at.slice(0, 16)} ${m.file} → ${m.ids.join(', ') || 'no ids'}${m.userErrors?.length ? ' (errors)' : ''}`),
    draft: st.draft?.themeId ? `${st.draft.name || st.draft.themeId}${st.draft.deletedAt ? ' (deleted)' : ''}` : null,
  };
}

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
  eq('sectionLines nested', sectionLines('## A\nx\n### B\ny\n## C\nz', '## A'), ['x', '### B', 'y']);
  eq('sectionLines suffix heading', sectionLines('## Found (analyze)\nfound it\n## Decided', '## Found'), ['found it']);
  const ignore = ignoreMatcher('*.json\n# comment\nassets/src/**\n/\\.map$/');
  eq('ignore glob any folder', ignore('templates/product.json'), true);
  eq('ignore folder glob', ignore('assets/src/theme.css'), true);
  eq('ignore regex', ignore('assets/theme.js.map'), true);
  eq('ignore miss', ignore('sections/header.liquid'), false);
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  print(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const { _: [verb, rawKey, ...rest], flags } = parseArgs(process.argv.slice(2));

if (process.argv.includes('--selftest')) selftest();

switch (verb) {
  case 'list': {
    const keys = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => existsSync(join(LOGS, d, 'state.json'))) : [];
    if (!keys.length) print('No tasks yet. Start one with /implement <KEY>.');
    for (const k of keys) {
      const st = readState(k);
      const draft = st.draft?.themeId && !st.draft.deletedAt ? ` · draft ${st.draft.name || st.draft.themeId} still exists` : '';
      print(`${k}\t${st.type || '-'}\t${st.stage}\t${st.updatedAt.slice(0, 10)}\t${st.owner?.name || ''}${draft}`);
    }
    break;
  }

  case 'start': {
    const key = normKey(rawKey);
    const cfg = readConfig();
    if (!readState(key, { required: false })) {
      mkdirSync(join(LOGS, key), { recursive: true });
      for (const f of TEMPLATES) if (!existsSync(join(LOGS, key, f))) writeFileSync(join(LOGS, key, f), tpl(key, f));
      writeState(key, {
        schemaVersion: 1, kitVersion: KIT_VERSION, key, type: null, tickets: [key],
        createdAt: now(), owner: owner(), stage: STAGES[0].name, gates: {}, history: [{ at: now(), event: 'start' }],
        branch: null, base: null, abtest: {}, featurePrefix: null, buildOutputs: [],
        draft: {}, mutations: [], previews: [], qa: {},
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
    const def = STAGES[stageIndex(stage)];
    const answer = typeof flags.answer === 'string' ? flags.answer.trim() : '';
    if (def.gate && !answer) fail(`"${stage}" is a gate (${def.gate}). Ask the dev, then record their words: --answer "..."`);
    const missing = (EXIT_CHECKS[stage]?.(key, st) || []).filter(Boolean);
    if (missing.length) fail(`"${stage}" isn't finished:\n${missing.map((m) => `- ${m.replace('<KEY>', key)}`).join('\n')}`);
    if (def.gate) st.gates[stage] = { answer, at: now() };
    st.history.push({ at: now(), event: 'done', stage, answer: answer || undefined, note: flags.note || undefined });
    const next = STAGES[stageIndex(stage) + 1];
    st.stage = next ? next.name : 'done';
    writeState(key, st);
    print(summaryLines(key, st, readConfig({ required: false })));
    break;
  }

  case 'back': {
    const key = normKey(rawKey);
    const target = rest[0];
    const st = readState(key);
    const to = stageIndex(target);
    const from = ['done', 'abandoned'].includes(st.stage) ? STAGES.length : stageIndex(st.stage);
    if (to === -1) fail(`Unknown stage "${target}". Stages: ${STAGES.map((s) => s.name).join(', ')}`);
    if (to >= from) fail(`"${target}" isn't earlier than the current stage "${st.stage}".`);
    if (typeof flags.reason !== 'string' || !flags.reason.trim()) fail('Say why: --reason "..."');
    for (const s of STAGES.slice(to)) delete st.gates[s.name];
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

  case 'summary': {
    const key = normKey(rawKey);
    print(runSummary(key, readState(key)));
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
    print(`Wrote kit/probe.inject.js (${Math.round(loader.length / 1024)} KB).`);
    break;
  }

  default:
    print(HELP.replace('{SETTABLE}', Object.keys(SETTABLE).join(', ')));
    if (verb && verb !== '--help' && verb !== 'help') process.exit(1);
}
