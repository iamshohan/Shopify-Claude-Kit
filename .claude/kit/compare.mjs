#!/usr/bin/env node
// Regression check: fetches pages from the live theme and from this task's draft and compares what Shopify
// rendered. The draft is a copy of live plus this branch's files, so on pages the change shouldn't touch,
// the section list should match and the feature's class (featurePrefix) should be absent. Sections whose HTML
// differs are listed for a look, not counted: per-request content (stock, recommendations, dates) differs too.
// Writes nothing.
//   node .claude/kit/compare.mjs <KEY> [path ...]     e.g. home cart products/x (defaults: qa.paths, else home and cart)
import { createHash } from 'node:crypto';
import { print, fail, normKey, readConfig, readState, storefrontPath, storefrontGet as get, renderedTheme as themeOf } from './lib.mjs';

// Section ids carry a per-theme template id (template--1234__main); keep the stable suffix.
const stableId = (id) => id.replace(/^template--\d+__/, 'template__').replace(/^sections--\d+__/, 'sections__');
const sections = (html) => [...html.matchAll(/id="shopify-section-([^"]+)"/g)].map((m) => stableId(m[1]));

/**
 * Each section's HTML, from its wrapper to the next section's: not exact around the edges, but cut the same way
 * on both pages. Normalised for what differs between two copies of one theme without being a change:
 * the theme's ids and asset paths, cache-busting versions, nonces and tokens, and whitespace.
 */
function sectionHtml(html) {
  const marks = [...html.matchAll(/id="shopify-section-([^"]+)"/g)];
  const out = new Map();
  marks.forEach((m, i) => {
    const chunk = html.slice(m.index, i + 1 < marks.length ? marks[i + 1].index : html.length);
    const norm = chunk
      .replace(/(template|sections)--\d+__/g, '$1__')
      .replace(/\/cdn\/shop\/t\/\d+\//g, '/cdn/shop/t/N/')
      .replace(/([?&])(v|preview_theme_id|_pos|_sid|_ss|_psq|_fid)=[^&"'\s]*/g, '$1$2=')
      .replace(/\b(nonce|data-nonce|value)="[A-Za-z0-9+/=_-]{20,}"/g, '$1=""')
      .replace(/\s+/g, ' ');
    out.set(stableId(m[1]), norm);
  });
  return out;
}

const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Sections on both pages whose normalised HTML differs, each with the first place it differs. */
function changedSections(liveHtml, draftHtml) {
  const a = sectionHtml(liveHtml);
  const b = sectionHtml(draftHtml);
  const out = [];
  for (const [id, l] of a) {
    const d = b.get(id);
    if (d === undefined || digest(l) === digest(d)) continue;
    let i = 0;
    while (i < l.length && l[i] === d[i]) i++;
    out.push({ id, live: l.slice(Math.max(0, i - 40), i + 80), draft: d.slice(Math.max(0, i - 40), i + 80) });
  }
  return out;
}

const count = (html, needle) => (needle ? html.split(needle).length - 1 : null);

function selftest() {
  const page = (theme, body) => `<div id="shopify-section-template--${theme}__main" class="s"><img src="/cdn/shop/t/${theme}/assets/a.png?v=${theme}9">${body}</div>\n`
    + `<div id="shopify-section-sections--${theme}__footer">footer</div>`;
  const same = changedSections(page(11, 'Hello'), page(22, 'Hello'));
  const diff = changedSections(page(11, 'Hello'), page(22, 'Hello <b>new</b>'));
  const checks = [
    ['two copies of one theme compare equal', same.length === 0],
    ['a changed section is reported by its stable id', diff.length === 1 && diff[0].id === 'template__main' && diff[0].draft.includes('new')],
    ['section ids are stable across themes', sections(page(11, '')).join() === 'template__main,sections__footer'],
  ];
  for (const [name, ok] of checks) if (!ok) print(`FAIL ${name}`);
  const failed = checks.filter(([, ok]) => !ok).length;
  print(failed ? `${failed} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

const [rawKey, ...paths] = process.argv.slice(2);
if (rawKey === '--selftest') selftest();
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
  // BLOCKED, not DIFFERS, when either side isn't the page we meant to compare: a password page,
  // no theme on live, or a draft request that Shopify served from another theme.
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
    // Same section, different markup: on a page the change shouldn't touch, the place to look first.
    htmlDiffers: changedSections(live.html, draft.html),
  };
  if (prefix) row.featureHits = { live: count(live.html, prefix), draft: count(draft.html, prefix) };
  row.verdict = row.sections.onlyLive.length || row.sections.onlyDraft.length || !row.sections.sameOrder
    || (prefix && row.featureHits.draft > row.featureHits.live)
    ? 'DIFFERS' : 'SAME';
  results.push(row);
}

print({
  draftTheme: draftId,
  featurePrefix: prefix,
  note: 'DIFFERS on a page the change should not touch is a regression only after ruling out live edits made since the draft was copied (draft.createdAt). '
    + 'htmlDiffers doesn\'t decide the verdict: it shows where each section first differs, which is often content that changes per request (recommendations, stock, dates). Look at it for sections the branch touches.',
  draftCreatedAt: st.draft.createdAt || null,
  results,
});
