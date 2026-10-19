#!/usr/bin/env node
// Regression check: fetches pages from the live theme and from this task's draft and compares
// what Shopify rendered. The draft is a copy of live plus this branch's files, so on pages the
// change shouldn't touch, the section list should match and the feature's class should be absent.
//   node .claude/kit/compare.mjs <KEY> [path ...]     e.g. home cart products/x (defaults: qa.paths, else home and cart)
import { print, fail, normKey, readConfig, readState, storefrontPath } from './lib.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function get(url, jar) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let current = url;
    let res;
    // Follow redirects by hand so the preview cookie survives them.
    for (let hop = 0; hop < 8; hop++) {
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': UA, 'accept-language': 'en', ...(cookie ? { cookie } : {}) } });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue;
      }
      break;
    }
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * attempt)); continue; }
    return { status: res.status, url: current, html: await res.text() };
  }
  return { status: 429, url, html: '' };
}

function themeOf(html) {
  const m = html.match(/Shopify\.theme\s*=\s*(\{[^;]*?\})\s*;/);
  if (!m) return null;
  try { const t = JSON.parse(m[1]); return { id: t.id, name: t.name, role: t.role }; } catch { return null; }
}

// Section ids carry a per-theme template id (template--1234__main); keep the stable suffix.
const sections = (html) => [...html.matchAll(/id="shopify-section-([^"]+)"/g)]
  .map((m) => m[1].replace(/^template--\d+__/, 'template__').replace(/^sections--\d+__/, 'sections__'));

const count = (html, needle) => (needle ? html.split(needle).length - 1 : null);

const [rawKey, ...paths] = process.argv.slice(2);
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
