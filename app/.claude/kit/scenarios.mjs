// A change's scenarios: the table in proposal.md § Scenarios, one row per behaviour, each bound to the check that proves it.
//   | ID | GIVEN | WHEN | THEN | Check |
// Check is one of:  test: <file> › <vitest full name>   (› or > separates the name)
//                   qa: <the expected result on the dev store>
//                   manual: <what the reviewer checks by hand>
//   node .claude/kit/scenarios.mjs --selftest
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Markdown ──

export const stripComments = (md) => String(md ?? '').replace(/<!--[\s\S]*?-->/g, '');

/** Cells of a markdown table row; "\|" stays inside its cell. */
export const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (l) => /^\s*\|[\s:|-]+\|?\s*$/.test(l);

/** Rows of the first table under a heading (matched by its start), as objects keyed by lower-case header. */
export function tableUnder(md, heading) {
  const lines = stripComments(md).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase().startsWith(heading.toLowerCase()));
  if (start === -1) return [];
  const level = heading.match(/^#+/)[0].length;
  const out = [];
  let header = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#+\s/.test(l) && l.match(/^#+/)[0].length <= level) break;
    if (!l.trim().startsWith('|')) { if (header && out.length) break; continue; }
    if (isRule(l)) continue;
    if (!header) { header = cells(l).map((c) => c.toLowerCase()); continue; }
    const c = cells(l);
    out.push(Object.fromEntries(header.map((h, j) => [h, c[j] ?? ''])));
  }
  return out;
}

/** Lines under a heading (matched by its start), up to the next heading of the same or higher level. */
export function sectionLines(md, heading) {
  const level = heading.match(/^#+/)[0].length;
  const lines = stripComments(md).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading || l.trim().startsWith(`${heading} `));
  if (start === -1) return [];
  let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).map((l) => l.trim()).filter(Boolean);
}

/** "none", "n/a" or a dash, optionally followed by the reason. */
export const saysNone = (lines) => /^(none|n\/a|—|-)(\b|$)/i.test(lines.join(' ').replace(/^[-*]\s*/, '').trim());

// ── Checks ──

/** Parses a Check cell. */
export function parseCheck(text) {
  const t = String(text || '').replace(/`/g, '').trim();
  let m = t.match(/^test:\s*(.+?)\s*(?:›|>|::)\s*(.+)$/i);
  if (m) return { kind: 'test', file: m[1].replaceAll('\\', '/').replace(/^\.\//, ''), name: m[2].trim() };
  m = t.match(/^qa:\s*(.*)$/i);
  if (m) return { kind: 'qa', expected: m[1].trim() };
  m = t.match(/^manual:\s*(.*)$/i);
  if (m) return { kind: 'manual', what: m[1].trim() };
  return { kind: 'invalid', text: t };
}

/** A check in one canonical spelling (› for >, single spaces), so two spellings of one check compare equal. */
export function checkKey(c) {
  const t = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  if (c.kind === 'test') return `test: ${t(c.file)} › ${t(c.name)}`;
  if (c.kind === 'qa') return `qa: ${t(c.expected)}`;
  if (c.kind === 'manual') return `manual: ${t(c.what)}`;
  return `invalid: ${t(c.text)}`;
}

// ── Scenarios ──

/** The rows of proposal.md § Scenarios: [{ id, given, when, then, check, checkText }]. */
export function scenariosFrom(md) {
  return tableUnder(md, '## Scenarios').filter((r) => Object.values(r).some((v) => v.trim())).map((r) => ({
    id: (r.id || '').replace(/[`*]/g, '').trim(), given: r.given || '', when: r.when || '', then: r.then || '',
    check: parseCheck(r.check), checkText: (r.check || '').replace(/`/g, '').trim(),
  }));
}

/** Problems with the rows themselves, independent of whether their checks pass. */
export function scenarioProblems(rows) {
  const out = [];
  const seen = new Set();
  for (const s of rows) {
    const at = `§ Scenarios → ${s.id || '(no ID)'}`;
    if (!/^[A-Za-z0-9][\w.-]*$/.test(s.id)) out.push(`${at}: give the row an ID (S1, S2, …)`);
    else if (seen.has(s.id.toLowerCase())) out.push(`${at}: two rows have this ID`);
    seen.add(s.id.toLowerCase());
    if (!s.when.trim() || !s.then.trim()) out.push(`${at}: fill WHEN and THEN (GIVEN when there is a starting state)`);
    if (s.check.kind === 'invalid') out.push(`${at}: Check "${s.check.text || '(empty)'}" isn't "test: <file> › <test name>", "qa: <expected result>" or "manual: <what the reviewer checks>"`);
    if (s.check.kind === 'qa' && !s.check.expected) out.push(`${at}: a qa: check says what is expected on the dev store (qa: the gift line shows "Free")`);
    if (s.check.kind === 'manual' && !s.check.what) out.push(`${at}: a manual: check says what the reviewer checks`);
  }
  return out;
}

/** One line per scenario, with its values, for the gate questions. */
export const scenarioLine = (s) => `${s.id}: ${[s.given && `GIVEN ${s.given}`, `WHEN ${s.when}`, `THEN ${s.then}`].filter(Boolean).join(' · ')} → ${checkKey(s.check)}`;

/** A scenario as Gate 1 approved it, to list what changed since. */
export const scenarioRecord = (s) => [s.given, s.when, s.then, checkKey(s.check)].map((x) => String(x).trim().replace(/\s+/g, ' ')).join(' | ');

/** What differs from the scenarios Gate 1 approved: ["S2 added", "S1 changed: <before> → <now>", "S3 removed"]. */
export function changedSince(approved, rows) {
  if (!approved) return [];
  const now = Object.fromEntries(rows.map((s) => [s.id, scenarioRecord(s)]));
  return [
    ...Object.entries(now).filter(([id]) => !(id in approved)).map(([id, r]) => `${id} added: ${r}`),
    ...Object.entries(now).filter(([id, r]) => id in approved && approved[id] !== r).map(([id, r]) => `${id} changed: "${approved[id]}" → "${r}"`),
    ...Object.keys(approved).filter((id) => !(id in now)).map((id) => `${id} removed: ${approved[id]}`),
  ];
}

/** proposal.md § Retires: ledgered tests this change deletes or renames, "- test: <file> › <name>: why" per line. */
export function retiresFrom(md) {
  return sectionLines(md, '## Retires').map((l) => l.replace(/^[-*]\s*/, '')).filter((l) => /^`?test:/i.test(l))
    // The reason after the name: the last ": " with no › after it.
    .map((l) => parseCheck(l.replace(/:\s+[^:›>]*$/, '')))
    .filter((c) => c.kind === 'test');
}

// ── Self-test ──

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), got, want]);
  const md = [
    '## Scenarios', '', '<!-- hint | not | a | row -->', '',
    '| ID | GIVEN | WHEN | THEN | Check |', '| --- | --- | --- | --- | --- |',
    '| S1 | a cart of 50 EUR | the transform runs | the gift is added | `test: ./extensions/gift/tests/gift.test.js › gift added at 50` |',
    '| S2 | the gift in the cart | the buyer opens checkout | the line says "Free" | qa: the gift line shows "Free" |',
    '| S3 | | a real card is charged | the gift ships | manual: the order in the admin has the gift |',
    '', '## Surfaces',
  ].join('\n');
  const rows = scenariosFrom(md);
  eq('three rows, comments skipped', rows.map((r) => r.id), ['S1', 'S2', 'S3']);
  eq('test check', rows[0].check, { kind: 'test', file: 'extensions/gift/tests/gift.test.js', name: 'gift added at 50' });
  eq('qa check carries the expected result', rows[1].check, { kind: 'qa', expected: 'the gift line shows "Free"' });
  eq('no problems', scenarioProblems(rows), []);
  eq('problems: id, WHEN/THEN, check, empty qa', scenarioProblems([
    { id: '', given: '', when: 'x', then: 'y', check: parseCheck('test: a.js › b') },
    { id: 'S1', given: '', when: '', then: 'y', check: parseCheck('tested') },
    { id: 'S2', given: '', when: 'x', then: 'y', check: parseCheck('qa:') },
  ]).length, 4);
  eq('duplicate IDs', scenarioProblems([rows[0], rows[0]]).some((p) => /two rows/.test(p)), true);
  eq('check keys compare spellings, not text', [checkKey(parseCheck('test: ./a.test.js > gift  added')), checkKey(parseCheck('`test: a.test.js › gift added`')), checkKey(parseCheck('qa:  shows  Free'))],
    ['test: a.test.js › gift added', 'test: a.test.js › gift added', 'qa: shows Free']);
  eq('scenario line', scenarioLine(rows[0]), 'S1: GIVEN a cart of 50 EUR · WHEN the transform runs · THEN the gift is added → test: extensions/gift/tests/gift.test.js › gift added at 50');
  const approved = Object.fromEntries(rows.map((s) => [s.id, scenarioRecord(s)]));
  const later = [{ ...rows[0], check: parseCheck('test: extensions/gift/tests/gift.test.js › gift added') }, rows[2], { ...rows[1], id: 'S4' }];
  eq('changed since Gate 1', changedSince(approved, later).map((l) => l.split(':')[0]), ['S4 added', 'S1 changed', 'S2 removed']);
  eq('nothing changed', changedSince(approved, rows), []);
  eq('retires', retiresFrom('## Retires\n\n- test: a.test.js › old name: renamed to new name\n- none of the others\n').map(checkKey), ['test: a.test.js › old name']);
  eq('says none', [saysNone(['none: new files only']), saysNone(['None']), saysNone(['nonetheless'])], [true, true, false]);
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain && process.argv.includes('--selftest')) selftest();
