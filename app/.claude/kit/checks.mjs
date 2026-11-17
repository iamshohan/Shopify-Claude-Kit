// The checks verify runs besides the surfaces: the bound vitest tests, the test ledger, and the repo's own commands.
// The ledger is every test an archived change bound; verify fails when one disappears unless a change retires it in
// proposal.md § Retires.
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { segments, scriptRuns, runsShopifyCli, CLI_WORD, cliPackage } from './guard-core.mjs';
import { scenariosFrom, retiresFrom } from './scenarios.mjs';

// ── Running vitest ──

/** The folder a test file belongs to (nearest package.json) and the vitest entry that runs it. */
export function vitestFor(root, file) {
  let dir = dirname(resolve(root, file));
  let pkgDir = null;
  while (true) {
    if (!pkgDir && existsSync(join(dir, 'package.json'))) pkgDir = dir;
    const entry = join(dir, 'node_modules', 'vitest', 'vitest.mjs');
    if (pkgDir && existsSync(entry)) return { pkgDir, entry };
    const up = dirname(dir);
    if (up === dir || relative(root, up).startsWith('..')) break;
    dir = up;
  }
  return pkgDir ? { pkgDir, entry: null } : null;
}

const firstLine = (s) => String(s || '').split('\n')[0];
// Shopify's Function test template compares instruction counts with a committed baseline; a new fixture has none yet.
export const baselineHint = (note) => (/baseline/i.test(note) ? `${note} (Shopify's Function template: run the test once with UPDATE_INSTRUCTION_BASELINE=1 and commit the baseline file)` : note);

/**
 * Runs named tests, one vitest run per package, with the JSON reporter. tests: [{ key, file, name }].
 * Returns Map(key → { verdict, note }): PASS, FAIL, MISSING (no test of that name in the file) or AMBIGUOUS (more than one).
 */
export function runTests(root, tests) {
  const out = new Map();
  const byPkg = new Map();
  for (const t of tests) {
    const abs = resolve(root, t.file);
    if (!existsSync(abs)) { out.set(t.key, { verdict: 'MISSING', note: `no file ${t.file}` }); continue; }
    const v = vitestFor(root, t.file);
    if (!v?.entry) { out.set(t.key, { verdict: 'FAIL', note: `vitest isn't installed for ${t.file} (npm install in ${v ? relative(root, v.pkgDir) || '.' : 'its package'})` }); continue; }
    if (!byPkg.has(v.pkgDir)) byPkg.set(v.pkgDir, { ...v, tests: [] });
    byPkg.get(v.pkgDir).tests.push({ ...t, abs });
  }
  let n = 0;
  for (const { pkgDir, entry, tests: list } of byPkg.values()) {
    const tmp = join(tmpdir(), `app-kit-vitest-${process.pid}-${n++}`);
    mkdirSync(tmp, { recursive: true });
    const report = join(tmp, 'report.json');
    const files = [...new Set(list.map((t) => relative(pkgDir, t.abs).split('\\').join('/')))];
    const r = spawnSync(process.execPath, [entry, 'run', ...files, '--reporter=json', `--outputFile=${report}`],
      { cwd: pkgDir, encoding: 'utf8', timeout: 600000, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    let json = null;
    try { json = JSON.parse(readFileSync(report, 'utf8')); } catch { /* no report: the run itself failed */ }
    rmSync(tmp, { recursive: true, force: true });
    for (const t of list) {
      // Only the bound file's results: vitest's file filter is a substring match, so tests/gift.test.js also runs
      // extensions/gift/tests/gift.test.js, whose same-named test must not stand in for this one.
      const results = (json?.testResults || []).filter((x) => !x.name || resolve(pkgDir, x.name).toLowerCase() === t.abs.toLowerCase()).flatMap((x) => x.assertionResults || []);
      // The full name (describe titles and the test title, joined by spaces) first; a bare title only when it names one test.
      const byFull = results.filter((a) => a.fullName === t.name);
      const hits = byFull.length ? byFull : results.filter((a) => a.title === t.name);
      const hit = hits[0];
      if (!json) out.set(t.key, { verdict: 'FAIL', note: `vitest didn't report (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300)}` });
      else if (!hit) out.set(t.key, { verdict: 'MISSING', note: `no test named "${t.name}" in ${t.file}. Names there: ${results.map((a) => a.title).slice(0, 6).join(' · ') || '(none)'}` });
      // Two tests with one name: whichever passes would stand in for the other.
      else if (hits.length > 1) out.set(t.key, { verdict: 'AMBIGUOUS', note: `${hits.length} tests in ${t.file} are named "${t.name}"; bind one by its full name (${hits.map((a) => `"${a.fullName}"`).slice(0, 3).join(', ')}) or rename one` });
      // ran: vitest reported this very test, so a FAIL is the test's own failure, not a setup problem.
      else out.set(t.key, { ran: true, verdict: hit.status === 'passed' ? 'PASS' : 'FAIL', note: hit.status === 'passed' ? undefined : baselineHint(firstLine((hit.failureMessages || []).join(' ')).slice(0, 300) || hit.status) });
    }
  }
  return out;
}

// ── The test ledger ──

/** A test's identity: its file and full name, in one spelling. */
export const testKey = (file, name) => `${String(file).replace(/^\.\//, '').split('\\').join('/').trim()} › ${String(name).trim().replace(/\s+/g, ' ')}`;

/**
 * The ledger, read from appspec/archive/: each archived change's bound tests, minus what a later one retired, in the order
 * they were archived (a test bound again keeps one entry, naming the later change). One folder per change, so parallel
 * archives never conflict. [{ file, name, change, scenario }]
 */
export function ledgerFrom(archiveDir) {
  const changes = (existsSync(archiveDir) ? readdirSync(archiveDir) : []).map((d) => {
    try { return { d, st: JSON.parse(readFileSync(join(archiveDir, d, 'change.json'), 'utf8')), md: readFileSync(join(archiveDir, d, 'proposal.md'), 'utf8') }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(a.st.archivedAt || '').localeCompare(String(b.st.archivedAt || '')) || a.d.localeCompare(b.d));
  const byKey = new Map();
  for (const { st, md } of changes) {
    for (const r of retiresFrom(md)) byKey.delete(testKey(r.file, r.name));
    for (const s of scenariosFrom(md).filter((x) => x.check.kind === 'test')) {
      byKey.set(testKey(s.check.file, s.check.name), { file: s.check.file, name: s.check.name, change: st.id, scenario: s.id });
    }
  }
  return [...byKey.values()];
}

// ── Running the repo's own checks ──

// A verify command may not deploy or reach a store; the kit runs these itself, outside the guard's view. So: any Shopify CLI
// call (the wrapper is the only door), a deploy, a store choice, and schema changes. Libraries like @shopify/polaris are fine.
// "deploy" as a command, a script name or a shell script (npm run deploy, deploy:prod, scripts/deploy.sh), not
// deploy-check.js or an ignored deploy/ folder.
const DEPLOYS = /(^|[\s;&|(/])deploy(?=$|[\s;&|):]|\.(sh|ps1|cmd|bat)\b)|--store\b|\bmigrate\s+(deploy|reset|dev)\b|\bdb\s+(push|execute|seed)\b/i;
const CLI_PKG = cliPackage('cli|app|create-app');
const unsafeLine = (line) => DEPLOYS.test(line) || CLI_WORD.test(line) || CLI_PKG.test(line) || segments(line).some(runsShopifyCli);

/**
 * The command, or a package script it runs, that deploys, migrates or runs the Shopify CLI; null when it's safe. Scripts
 * are found the way the guard finds them (flags before the name, node --run, npm-run-all, install-time scripts), with their
 * pre- and post-scripts and the scripts those run, 3 deep.
 */
export function unsafeCommand(root, line, depth = 0) {
  if (unsafeLine(line)) return line;
  if (depth > 3) return null;
  let scripts = {};
  try { scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json: nothing to follow */ }
  for (const seg of segments(line)) {
    for (const n of scriptRuns(seg)) {
      const hit = scripts[n] && unsafeCommand(root, scripts[n], depth + 1);
      if (hit) return `${line} → ${n}: ${hit}`;
    }
  }
  return null;
}

/** Runs one configured command (lint, typecheck, build, test) through the shell. */
export function runCommand(root, line) {
  const unsafe = unsafeCommand(root, line);
  if (unsafe) return { verdict: 'FAIL', note: `the kit won't run "${unsafe}" as a check (it could deploy, migrate or reach a store). Fix verify in .claude/app-kit.json` };
  const r = spawnSync(line, { cwd: root, shell: true, encoding: 'utf8', timeout: 900000, env: { ...process.env, CI: '1', FORCE_COLOR: '0' }, maxBuffer: 64 * 1024 * 1024 });
  const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
  return { verdict: r.status === 0 ? 'PASS' : 'FAIL', exit: r.status, note: r.status === 0 ? undefined : tail.slice(-1500) };
}
