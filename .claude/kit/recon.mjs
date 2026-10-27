#!/usr/bin/env node
// Repo facts for one task, read fresh from the files and git (no network, nothing written).
// It reports what is there; the theme-recon agent decides what matters.
//   node .claude/kit/recon.mjs        (no arguments; prints JSON)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, THEME_DIRS, print, git, readConfig } from './lib.mjs';

const ls = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((n) => statSync(join(ROOT, dir, n)).isFile()) : []);
const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; } };
const top = (obj, n = 12) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
const bump = (obj, k, by = 1) => { obj[k] = (obj[k] || 0) + by; };

// ── Theme files ──

const files = {};
for (const d of THEME_DIRS) files[d] = ls(d);
files.templatesCustomers = ls('templates/customers');

const code = [];
for (const d of ['layout', 'sections', 'snippets', 'blocks']) for (const n of files[d]) if (n.endsWith('.liquid')) code.push(`${d}/${n}`);
const scripts = files.assets.filter((n) => /\.(js|js\.liquid)$/.test(n)).map((n) => `assets/${n}`);
const styles = files.assets.filter((n) => /\.(css|css\.liquid|scss\.liquid)$/.test(n)).map((n) => `assets/${n}`);

// Theme identity
let theme = null;
try {
  const schema = JSON.parse(read('config/settings_schema.json'));
  const info = schema.find((s) => s.name === 'theme_info') || {};
  theme = { name: info.theme_name || null, version: info.theme_version || null, author: info.theme_author || null };
} catch { theme = { error: 'config/settings_schema.json missing or not JSON' }; }

// What git tracks vs what exists on disk (a theme can keep JSON templates or locales only in the admin)
const tracked = new Set(git(['ls-files', '--', ...THEME_DIRS], { allowFail: true }).split('\n').filter(Boolean));
const onDisk = (pred) => THEME_DIRS.flatMap((d) => files[d].map((n) => `${d}/${n}`)).filter(pred);
const trackShare = (pred) => {
  const all = onDisk(pred);
  return { onDisk: all.length, tracked: all.filter((p) => tracked.has(p)).length };
};
const ignoredAssets = git(['status', '--ignored', '--porcelain', '--', 'assets'], { allowFail: true })
  .split('\n').filter((l) => l.startsWith('!!')).map((l) => l.slice(3));

// ── Deploy and build ──

// Deploy signals: Shopify's GitHub integration commits as "Update from Shopify for theme <name>"
const defaultBranch = readConfig({ required: false })?.baseBranch
  || (git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true }) || 'origin/main').replace(/^origin\//, '');
const subjects = git(['log', '--format=%s', '-300', `origin/${defaultBranch}`], { allowFail: true }).split('\n').filter(Boolean);
const syncThemes = {};
for (const s of subjects) { const m = s.match(/^Update from Shopify for theme (.+)$/); if (m) bump(syncThemes, m[1]); }
const ciFiles = [
  ...(existsSync(join(ROOT, '.github', 'workflows')) ? readdirSync(join(ROOT, '.github', 'workflows')).map((n) => `.github/workflows/${n}`) : []),
  ...['.gitlab-ci.yml', 'bitbucket-pipelines.yml', 'azure-pipelines.yml', '.circleci/config.yml'].filter((p) => existsSync(join(ROOT, p))),
];
const workflows = ciFiles.length
  ? ciFiles.map((file) => {
    const t = read(file);
    return {
      file,
      branches: [...new Set([...t.matchAll(/branches:\s*\[?\s*([\w\-/, ]+)\]?/g)].flatMap((m) => m[1].split(',').map((b) => b.trim())).filter(Boolean))],
      deploysTheme: /theme\s+(push|deploy)|shopify\s+theme|themekit|theme_id/i.test(t),
      mentionsLive: /--live|--allow-live|production/i.test(t),
    };
  })
  : [];

// Build pipeline
let pkg = null;
try { pkg = JSON.parse(read('package.json')); } catch { /* no package.json */ }
const build = {
  packageScripts: pkg?.scripts || null,
  tailwindConfig: ['tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts'].find((n) => existsSync(join(ROOT, n))) || null,
  ignoredFilesInAssets: ignoredAssets,
  shopifyignore: existsSync(join(ROOT, '.shopifyignore')) ? read('.shopifyignore').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')) : null,
};

// Assets that are minified vendor files (don't edit; add new files instead)
const minified = [];
for (const p of [...scripts, ...styles]) {
  const t = read(p);
  const lines = t.split('\n').length;
  if (t.length > 20000 && t.length / lines > 400) minified.push(`${p} (${Math.round(t.length / 1024)} KB, ${lines} lines)`);
}

// ── Code conventions ──

// JS and cart conventions, by counting real usages
const DOM_EVENTS = new Set(['click', 'change', 'input', 'submit', 'scroll', 'resize', 'load', 'unload', 'beforeunload', 'DOMContentLoaded',
  'keydown', 'keyup', 'keypress', 'focus', 'blur', 'focusin', 'focusout', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'mousedown',
  'mouseup', 'mousemove', 'touchstart', 'touchend', 'touchmove', 'pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave',
  'transitionend', 'animationend', 'error', 'message', 'popstate', 'hashchange', 'visibilitychange', 'orientationchange', 'wheel', 'dblclick',
  'contextmenu', 'toggle', 'play', 'pause', 'ended', 'loadedmetadata', 'canplay', 'timeupdate']);
const js = { customElements: [], cart: {}, eventNames: {}, other: {} };
const jsSources = [...scripts, ...code];
for (const p of jsSources) {
  const t = read(p);
  for (const m of t.matchAll(/customElements\.define\(\s*['"`]([\w-]+)['"`]/g)) js.customElements.push(m[1]);
  const count = (re) => (t.match(re) || []).length;
  bump(js.cart, '/cart/add.js or routes.cart_add_url', count(/\/cart\/add(\.js)?|cart_add_url/g));
  bump(js.cart, 'form action /cart/add', count(/<form[^>]+action=["'][^"']*cart\/add/g));
  bump(js.cart, 'Section Rendering API (sections=)', count(/[?&]sections=|sections:\s*[\[{'"]|section_id=/g));
  bump(js.cart, 'jQuery ajax', count(/\$\.(ajax|post|getJSON)\(|jQuery\.(ajax|post)\(/g));
  bump(js.cart, 'fetch(', count(/\bfetch\(/g));
  bump(js.other, 'subscribe( (pub/sub)', count(/\bsubscribe\(/g));
  bump(js.other, 'new CustomEvent(', count(/new CustomEvent\(/g));
  bump(js.other, 'Shopify.designMode', count(/Shopify\.designMode/g));
  bump(js.other, 'shopify:section:load listeners', count(/shopify:section:load/g));
  // Only names used at event call sites (class and tag names look the same otherwise), minus standard DOM events.
  for (const m of t.matchAll(/(?:addEventListener|removeEventListener|CustomEvent|subscribe|publish|trigger|\.on)\(\s*['"`]([\w:.-]{3,40})['"`]/g)) {
    if (!DOM_EVENTS.has(m[1])) bump(js.eventNames, m[1]);
  }
}
js.customElements = [...new Set(js.customElements)];
js.eventNames = top(js.eventNames, 20);

// CSS conventions inside sections/snippets/blocks
const css = { stylesheetTagCalls: 0, styleTags: 0, liquidStyleBlocks: 0 };
for (const p of code) {
  const t = read(p);
  css.stylesheetTagCalls += (t.match(/stylesheet_tag/g) || []).length;
  css.styleTags += (t.match(/<style[\s>]/g) || []).length;
  css.liquidStyleBlocks += (t.match(/\{%-?\s*style\s*-?%\}/g) || []).length;
}

// Data the code reads: metafield namespaces, metaobject types, schema setting types
const namespaces = {};
const metaobjects = {};
const settingTypes = {};
let sectionsWithPresets = 0;
let schemaParseErrors = 0;
for (const p of code) {
  const t = read(p);
  for (const m of t.matchAll(/metafields\.([a-z0-9_]+)\./g)) bump(namespaces, m[1]);
  for (const m of t.matchAll(/metaobjects\.([a-z0-9_]+)/g)) bump(metaobjects, m[1]);
  const s = t.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/);
  if (!s) continue;
  try {
    const schema = JSON.parse(s[1]);
    if (schema.presets?.length) sectionsWithPresets++;
    for (const set of [schema.settings || [], ...(schema.blocks || []).map((b) => b.settings || [])]) for (const x of set) if (x.type) bump(settingTypes, x.type);
  } catch { schemaParseErrors++; }
}

// Experiment tools present in the theme (a running test may target the same element)
const tools = { ablyft: /ablyft/i, intelligems: /intelligems/i, vwo: /\bvwo\b|visualwebsiteoptimizer/i, kameleoon: /kameleoon/i,
  abtasty: /abtasty/i, convert: /convert\.com|cdn-\d+\.convertexperiments/i, elevateab: /elevateab/i, optimizely: /optimizely/i };
const experimentTools = {};
for (const p of [...files.layout.map((n) => `layout/${n}`), ...files.snippets.map((n) => `snippets/${n}`)]) {
  const t = read(p);
  for (const [name, re] of Object.entries(tools)) if (re.test(t)) (experimentTools[name] ||= []).push(p);
}

// ── Git conventions ──
// Branch names, and commit subjects other than Shopify's sync commits.
const branches = git(['for-each-ref', '--sort=-committerdate', '--count=15', '--format=%(refname:short)', 'refs/remotes/origin'], { allowFail: true })
  .split('\n').filter((b) => b && b !== 'origin/HEAD' && b !== 'origin').map((b) => b.replace(/^origin\//, ''));
const ownCommits = git(['log', '--all', '--no-merges', '--format=%s', '-400'], { allowFail: true })
  .split('\n').filter((s) => s && !s.startsWith('Update from Shopify')).slice(0, 12);

// ── Output ──

print({
  commit: git(['rev-parse', '--short', 'HEAD'], { allowFail: true }),
  commitDate: git(['log', '-1', '--format=%cs'], { allowFail: true }),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }),
  defaultBranch,
  theme,
  counts: {
    sections: files.sections.filter((n) => n.endsWith('.liquid')).length,
    sectionGroups: files.sections.filter((n) => n.endsWith('.json')).length,
    snippets: files.snippets.length,
    themeBlocks: files.blocks.length,
    templatesJson: files.templates.filter((n) => n.endsWith('.json')).length,
    templatesLiquid: files.templates.filter((n) => n.endsWith('.liquid')).length + files.templatesCustomers.length,
    assets: files.assets.length,
    locales: files.locales.length,
  },
  git: {
    jsonTemplates: trackShare((p) => /^templates\/.+\.json$/.test(p)),
    locales: trackShare((p) => p.startsWith('locales/')),
    settingsData: trackShare((p) => p === 'config/settings_data.json'),
  },
  deploy: { shopifySyncCommitsInLast300: syncThemes, workflows },
  build,
  minifiedAssets: minified,
  js,
  css,
  data: { metafieldNamespacesInCode: top(namespaces), metaobjectTypesInCode: top(metaobjects), settingTypes: top(settingTypes, 25), sectionsWithPresets, schemaParseErrors },
  markets: { contextFiles: [...files.sections, ...files.templates].filter((n) => n.includes('.context.')) },
  locales: {
    default: files.locales.find((n) => /\.default\.json$/.test(n)) || null,
    schemaDefault: files.locales.find((n) => /\.default\.schema\.json$/.test(n)) || null,
    storefront: files.locales.filter((n) => !n.includes('.schema.')),
  },
  experimentTools,
  conventions: { recentRemoteBranches: branches, recentCommitSubjects: ownCommits },
});
