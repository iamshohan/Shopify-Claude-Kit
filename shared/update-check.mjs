#!/usr/bin/env node
// SessionStart hook: once every 15 days, says when a newer kit is available. It only informs: updating stays the dev's call.
//   node .claude/kit/update-check.mjs --hook
// The clone this repo was installed from (the manifest's `source`) is checked: its remote (git fetch) and its own checkout
// (pulled but not installed here). The last check is remembered in the clone, so a machine gets one notice per 15 days,
// not one per repo. Never fails the session: any problem means no notice.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INTERVAL_DAYS = 15;

/** -1, 0 or 1 for dotted version numbers; text parts compare as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

/** Whether a check is due: never checked, an unreadable date, or INTERVAL_DAYS since the last one. */
export function due(checkedAt, now = Date.now()) {
  const last = Date.parse(checkedAt);
  return !Number.isFinite(last) || now - last >= INTERVAL_DAYS * 86400000;
}

/** The newest version seen anywhere if it's newer than the installed one, else null. */
export function newerVersion(installed, seen) {
  const newest = seen.filter(Boolean).sort((a, b) => compareVersions(b, a))[0];
  return newest && compareVersions(newest, installed) > 0 ? newest : null;
}

function main() {
  const claudeDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude');
  const manifest = JSON.parse(readFileSync(join(claudeDir, '.kit-manifest.json'), 'utf8'));
  const clone = manifest.source;
  if (!clone || !existsSync(join(clone, '.git'))) return;
  const statePath = process.env.SHOPIFY_KIT_UPDATE_STATE || join(clone, '.update-check.json');
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* first check */ }
  if (!due(state.checkedAt)) return;
  // Recorded before the network call, so an offline machine waits the full interval too instead of retrying every session.
  writeFileSync(statePath, JSON.stringify({ checkedAt: new Date().toISOString() }, null, 2) + '\n');

  const versionFile = manifest.kit === 'app' ? 'app/.claude/VERSION' : '.claude/VERSION';
  const git = (args) => execFileSync('git', args, { cwd: clone, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();
  const local = existsSync(join(clone, versionFile)) ? readFileSync(join(clone, versionFile), 'utf8').trim() : null;
  let remote = null;
  if (!process.env.SHOPIFY_KIT_NO_FETCH) {
    try { git(['fetch', '--quiet']); remote = git(['show', `@{upstream}:${versionFile}`]); } catch { /* offline or no upstream */ }
  }
  const newer = newerVersion(manifest.version, [local, remote]);
  if (!newer) return;
  const kitName = manifest.kit === 'app' ? 'App kit' : 'Shopify kit';
  const how = `node "${join(clone, 'update.mjs')}"`;
  const message = `${kitName} ${newer} is available (this repo has ${manifest.version}). To update every repo on this machine: ${how}. Next reminder in ${INTERVAL_DAYS} days.`;
  process.stdout.write(JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Kit update notice for the dev (mention it once, in one line, in your first reply; don't update the kit yourself): ${message}` },
  }));
}

// The hook passes --hook; a self-test importing the helpers doesn't. (Comparing argv[1] with this module's path fails on
// Windows when one side is an 8.3 short name.)
if (process.argv.includes('--hook')) {
  // No manifest, unreadable state, no git: no notice. SHOPIFY_KIT_DEBUG shows why.
  try { main(); } catch (e) { if (process.env.SHOPIFY_KIT_DEBUG) console.error(e); }
}
