#!/usr/bin/env node
// Regression check: fetches pages from the live theme and from this task's draft and compares
// what Shopify rendered. The draft is a copy of live plus this branch's files, so on pages the
// change shouldn't touch, the section list should match and the feature's class should be absent.
//   node .claude/kit/compare.mjs <KEY> [path ...]     e.g. home cart products/x (defaults: qa.paths, else home and cart)
import { print, fail, normKey, readConfig, readState, storefrontPath, storefrontGet as get, renderedTheme as themeOf } from './lib.mjs';

// Section ids carry a per-theme template id (template--1234__main); keep the stable suffix.
const sections = (html) => [...html.matchAll(/id="shopify-section-([^"]+)"/g)]
  .map((m) => m[1].replace(/^template--\d+__/, 'template__').replace(/^sections--\d+__/, 'sections__'));

const count = (html, needle) => (needle ? html.split(needle).length - 1 : null);

const [rawKey, ...paths] = process.argv.slice(2);
if (!rawKey || rawKey === '--help' || rawKey === 'help') { print('Usage: node .claude/kit/compare.mjs <KEY> [path ...]   e.g. home cart products/x (defaults: qa.paths, else home and cart)'); process.exit(rawKey ? 0 : 1); }
const key = normKey(rawKey);
const cfg = readConfig();
const st = readState(key);
const draftId = st.draft?.themeId || fail(`No draft for ${key} yet.`);
const origin = (cfg.storefrontUrl || `https://${cfg.store}`).replace(/\/+$/, '');
const list = (paths.length ? paths : (st.qa?.paths?.length ? st.qa.paths : ['/', '/cart'])).map(storefrontPath);
const prefix = st.featurePrefix || null;

const results = [];
for (const path of list) {
  const liveJar = new Map();
  const draftJar = new Map();
  const liveUrl = origin + path;
  const draftUrl = `${liveUrl}${liveUrl.includes('?') ? '&' : '?'}preview_theme_id=${draftId}`;
  const [live, draft] = await Promise.all([get(liveUrl, liveJar), get(draftUrl, draftJar)]);
  const lt = themeOf(live.html);
  const dt = themeOf(draft.html);
  const row = { path, live: { status: live.status, theme: lt }, draft: { status: draft.status, theme: dt } };
  if (/\/password/.test(live.url) || /\/password/.test(draft.url)) { row.verdict = 'BLOCKED'; row.why = 'storefront is password-protected'; results.push(row); continue; }
  if (!lt || live.status >= 400) { row.verdict = 'BLOCKED'; row.why = `the live page didn't render a theme (HTTP ${live.status}; bot protection or a redirect?)`; results.push(row); continue; }
  if (dt?.id !== draftId) { row.verdict = 'BLOCKED'; row.why = `the draft request rendered theme ${dt?.id ?? 'unknown'}, not ${draftId}`; results.push(row); continue; }
  const a = sections(live.html);
  const b = sections(draft.html);
  row.sections = {
    live: a.length,
    draft: b.length,
    onlyLive: a.filter((s) => !b.includes(s)),
    onlyDraft: b.filter((s) => !a.includes(s)),
    sameOrder: a.length === b.length && a.every((s, i) => s === b[i]),
  };
  if (prefix) row.featureHits = { live: count(live.html, prefix), draft: count(draft.html, prefix) };
  row.verdict = row.sections.onlyLive.length || row.sections.onlyDraft.length || !row.sections.sameOrder || (prefix && row.featureHits.draft > row.featureHits.live)
    ? 'DIFFERS' : 'SAME';
  results.push(row);
}

print({
  draftTheme: draftId,
  featurePrefix: prefix,
  note: 'DIFFERS on a page the change should not touch is a regression only after ruling out live edits made since the draft was copied (draft.createdAt).',
  draftCreatedAt: st.draft.createdAt || null,
  results,
});
