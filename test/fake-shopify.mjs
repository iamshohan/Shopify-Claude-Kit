#!/usr/bin/env node
// A stand-in for the Shopify CLI, for test/e2e.mjs. It serves themes from folders under
// $FAKE_SHOPIFY_DIR (themes.json + themes/<id>/...), logs every call to calls.jsonl, and
// refuses, and records in violations.jsonl, any write to the live theme.
// It mimics only the output shapes the kit's wrapper reads.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const DIR = process.env.FAKE_SHOPIFY_DIR;
if (!DIR) { process.stderr.write('FAKE_SHOPIFY_DIR is not set\n'); process.exit(1); }

// Flags that take a value; --only may repeat. Any other --flag is a boolean.
const VALUE_FLAGS = new Set(['store', 'theme', 'name', 'path', 'only', 'output', 'role', 'query-file', 'variable-file', 'version', 'overrides', 'preview-id']);
const words = [];
const flags = { only: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) { words.push(a); continue; }
  const name = a.slice(2);
  if (!VALUE_FLAGS.has(name)) { flags[name] = true; continue; }
  if (name === 'only') flags.only.push(argv[++i]); else flags[name] = argv[++i];
}
const cmd = words.join(' ');
appendFileSync(join(DIR, 'calls.jsonl'), `${JSON.stringify({ cmd, flags })}\n`);

const themesPath = join(DIR, 'themes.json');
const themes = () => JSON.parse(readFileSync(themesPath, 'utf8'));
const themeDir = (id) => join(DIR, 'themes', String(id));
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const die = (msg) => { process.stderr.write(`${msg}\n`); process.exit(1); };

function target() {
  const list = themes();
  const t = flags.live ? list.find((x) => x.role === 'live') : list.find((x) => String(x.id) === String(flags.theme));
  return t || die(`No theme ${flags.theme ?? '(live)'}`);
}

function refuseLive(t, what) {
  if (t.role !== 'live') return;
  appendFileSync(join(DIR, 'violations.jsonl'), `${JSON.stringify({ what, cmd, flags })}\n`);
  die(`FAKE: refused to ${what} the live theme`);
}

function copyFiles(from, to, files) {
  for (const f of files) {
    if (!existsSync(join(from, f))) continue;
    mkdirSync(dirname(join(to, f)), { recursive: true });
    cpSync(join(from, f), join(to, f));
  }
}

function walk(dir, base = dir, acc = []) {
  for (const n of readdirSync(dir)) {
    if (n === '.claude' || n === '.git' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, base, acc); else acc.push(p);
  }
  return acc;
}

// Reads (list, info, pull, check) are allowed on live; push and delete go through refuseLive().
switch (cmd) {
  case 'version': out('3.99.0-fake'); break;
  case 'theme list': {
    // CLI 5's shape ({ themes: [...] }); FAKE_LEGACY_LIST prints CLI 4's bare array, FAKE_THEME_LIST_RAW any text.
    const list = themes().filter((t) => !flags.role || t.role === flags.role).map((t) => ({ ...t, processing: false }));
    if (process.env.FAKE_THEME_LIST_RAW) process.stdout.write(`${process.env.FAKE_THEME_LIST_RAW}\n`);
    else out(process.env.FAKE_LEGACY_LIST ? list : { themes: list });
    break;
  }
  case 'theme info': out({ store: 'fake-store.myshopify.com' }); break;
  case 'theme duplicate': {
    const src = target();
    const list = themes();
    const theme = { id: Math.max(...list.map((t) => t.id)) + 1, name: flags.name, role: 'unpublished' };
    cpSync(themeDir(src.id), themeDir(theme.id), { recursive: true });
    writeFileSync(themesPath, JSON.stringify([...list, theme], null, 2));
    out({ theme });
    break;
  }
  case 'theme push': {
    const t = target();
    refuseLive(t, 'push to');
    // Like Shopify: no subfolders other than templates/customers and templates/metaobject.
    const nested = [flags.only || []].flat().filter((f) => f.split('/').length > 2 && !/^templates\/(customers|metaobject)\/[^/]+$/.test(f));
    if (nested.length) { process.stderr.write(`Error: ${nested.join(', ')}: subdirectories aren't supported\n`); process.exit(1); }
    copyFiles(process.cwd(), themeDir(t.id), flags.only);
    out({ theme: { ...t, preview_url: `https://fake-store.myshopify.com/?preview_theme_id=${t.id}`, editor_url: `https://admin.shopify.com/store/fake-store/themes/${t.id}/editor` } });
    break;
  }
  case 'theme pull': copyFiles(themeDir(target().id), flags.path, flags.only); break;
  case 'theme delete': {
    const t = target();
    refuseLive(t, 'delete');
    rmSync(themeDir(t.id), { recursive: true, force: true });
    writeFileSync(themesPath, JSON.stringify(themes().filter((x) => x.id !== t.id), null, 2));
    break;
  }
  case 'theme check': {
    // One offense per line that contains OFFENSE, so a test decides exactly where offenses are. The current CLI's shape
    // ({ valid, issues }, 1-based rows); FAKE_LEGACY_CHECK prints the older one ([{ path, offenses }], 0-based rows).
    // Like the real one, it can't run without a locales/ folder.
    if (!existsSync(join(flags.path, 'locales'))) { process.stderr.write(`Error: ENOENT: no such file or directory, scandir '${join(flags.path, 'locales')}'\n`); process.exit(1); }
    const files = walk(flags.path).filter((p) => p.endsWith('.liquid'));
    const hits = (p) => readFileSync(p, 'utf8').split('\n').flatMap((l, i) => (l.includes('OFFENSE') ? [i] : []));
    const message = (p) => `OFFENSE in ${relative(flags.path, p)}`;
    if (process.env.FAKE_LEGACY_CHECK) out(files.map((p) => ({ path: p, offenses: hits(p).map((i) => ({ check: 'FakeCheck', severity: 'error', start_row: i, message: message(p) })) })));
    else {
      const issues = files.flatMap((p) => hits(p).map((i) => ({ filePath: p, check: 'FakeCheck', severity: 'error', startRow: i + 1, startColumn: 1, message: message(p) })));
      issues.push({ filePath: files[0], check: 'TranslationKeyExists', severity: 'error', startRow: 1, startColumn: 1, message: 'missing translation' });
      out({ valid: false, issues });
    }
    break;
  }
  case 'store execute': {
    const text = readFileSync(flags['query-file'], 'utf8');
    if (/\bmutation\b/.test(text)) {
      if (!flags['allow-mutations']) die('Mutations need --allow-mutations');
      appendFileSync(join(DIR, 'mutations.jsonl'), `${JSON.stringify({ text })}\n`);
      // A nested reference: the kit must not record it as created by the task.
      out({ data: { metafieldDefinitionCreate: { createdDefinition: { id: 'gid://shopify/MetafieldDefinition/901', standardTemplate: { id: 'gid://shopify/Metaobject/77' } }, userErrors: [] } } });
    } else out({ data: {} });
    break;
  }
  default: die(`FAKE: unsupported command "${cmd}"`);
}
