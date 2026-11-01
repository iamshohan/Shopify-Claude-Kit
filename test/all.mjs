#!/usr/bin/env node
// Every check both kits have, in one run: the shared-code drift check, then the theme kit's and the app kit's suites.
//   node test/all.mjs        (about a minute: the suites run side by side; each e2e works in its own temp folder)
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(REPO, 'app');
const SUITES = [
  ['shared code in step', REPO, 'scripts/sync-shared.mjs', '--check'],
  ['theme guard', REPO, '.claude/hooks/guard.mjs', '--selftest'],
  ['theme kit', REPO, '.claude/kit/kit.mjs', '--selftest'],
  ['theme probe built', REPO, '.claude/kit/kit.mjs', 'build-probe', '--check'],
  ['theme e2e', REPO, 'test/e2e.mjs'],
  ['app guard', APP, '.claude/hooks/guard.mjs', '--selftest'],
  ['app kit', APP, '.claude/kit/app.mjs', '--selftest'],
  ['app scenarios', APP, '.claude/kit/scenarios.mjs', '--selftest'],
  ['app surfaces', APP, '.claude/kit/surfaces.mjs', '--selftest'],
  ['app toml', APP, '.claude/kit/toml.mjs', '--selftest'],
  ['app e2e', APP, 'test/e2e.mjs'],
];

const run = ([name, cwd, script, ...args]) => new Promise((done) => {
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...args], { cwd, timeout: 600000 });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (status) => done({ name, ok: status === 0, out: out.trim(), secs: (Date.now() - started) / 1000 }));
});

const results = await Promise.all(SUITES.map(run));
for (const { name, ok, out, secs } of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(20)} ${out.split('\n').pop()} (${secs.toFixed(1)}s)`);
  // A failing suite shows its own FAIL lines, so the run says what broke without a rerun.
  if (!ok) console.log(out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 20).map((l) => `      ${l}`).join('\n'));
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `${failed} of ${SUITES.length} suites failed` : `all ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
