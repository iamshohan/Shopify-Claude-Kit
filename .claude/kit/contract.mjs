#!/usr/bin/env node
// The customizer contract: what a merchant will see in the theme editor for the sections and
// blocks this task changed, read from their {% schema %}, the schema locale files and the
// templates. The editor itself can only be screenshotted, so most customizer criteria are
// decided here, deterministically.
//   node .claude/kit/contract.mjs <KEY> [--files sections/a.liquid,blocks/b.liquid]
// Writes .claude/logs/<KEY>/contract.json and contract.md; prints a summary.
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ROOT, LOGS, print, fail, parseArgs, normKey, git, readState } from './lib.mjs';

/** JSON with comments and trailing commas, which live themes do contain. */
function lenientJson(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[\]}])/g, '$1'));
}

const read = (rel) => { try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return null; } };
const schemaOf = (text) => (text?.match(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/) || [])[1] ?? null;
const ls = (dir) => (existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((n) => statSync(join(ROOT, dir, n)).isFile()) : []);

const { _: [rawKey], flags } = parseArgs(process.argv.slice(2));
const key = normKey(rawKey);
const st = readState(key);

// Files: the section/block files this branch changed (committed or not), unless named.
let files = typeof flags.files === 'string' ? flags.files.split(',').map((s) => s.trim()).filter(Boolean) : null;
if (!files) {
  if (!st.base) fail(`No base commit recorded for ${key}; pass --files sections/x.liquid,…`);
  const from = git(['merge-base', st.base, 'HEAD'], { allowFail: true }) || st.base;
  const changed = git(['diff', '--name-only', '--relative', from, '--', 'sections', 'blocks'], { allowFail: true }).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'sections', 'blocks'], { allowFail: true }).split('\n');
  files = [...new Set([...changed, ...untracked])].filter((f) => /^(sections|blocks)\/[^/]+\.liquid$/.test(f) && existsSync(join(ROOT, f)));
}
if (!files.length) { print({ files: 0, note: 'No changed section or block files; nothing appears in the customizer from this task.' }); process.exit(0); }

// Schema locales: t: keys resolve per admin language; a key missing from the default locale shows raw.
const locales = {};
let defaultLocale = null;
for (const n of ls('locales').filter((x) => x.endsWith('.schema.json'))) {
  const code = n.replace(/\.(default\.)?schema\.json$/, '');
  try { locales[code] = lenientJson(read(`locales/${n}`)); } catch { continue; }
  if (n.includes('.default.')) defaultLocale = code;
}
const lookup = (obj, path) => path.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);

const problems = [];
const untranslated = new Set();

function label(value, where) {
  if (typeof value !== 'string' || !value.startsWith('t:')) return value ?? null;
  const path = value.slice(2);
  if (!defaultLocale) return value;
  const shown = lookup(locales[defaultLocale], path);
  if (shown == null) problems.push(`${where}: "${value}" is missing from locales/${defaultLocale}.default.schema.json (the editor shows the raw key)`);
  for (const [code, data] of Object.entries(locales)) if (code !== defaultLocale && lookup(data, path) == null) untranslated.add(`${code}: ${path}`);
  return shown ?? value;
}

function settingsOf(list, where) {
  const ids = new Set();
  const rows = [];
  for (const s of list || []) {
    if (s.id) {
      if (ids.has(s.id)) problems.push(`${where}: duplicate setting id "${s.id}"`);
      ids.add(s.id);
    }
    const row = {
      id: s.id || null, type: s.type, label: label(s.label ?? s.content, `${where} ${s.id || s.type}`),
      info: label(s.info, `${where} ${s.id} info`), default: s.default ?? null,
      options: s.options?.map((o) => ({ value: o.value, label: label(o.label, `${where} ${s.id} option`) })),
      min: s.min, max: s.max, step: s.step, unit: label(s.unit, `${where} ${s.id} unit`), visible_if: s.visible_if || null, placeholder: label(s.placeholder, `${where} ${s.id} placeholder`),
    };
    if (row.options && s.default !== undefined && !row.options.some((o) => o.value === s.default)) problems.push(`${where}: default "${s.default}" of "${s.id}" isn't one of its options`);
    if (s.type === 'range' && typeof s.default === 'number') {
      if (s.default < s.min || s.default > s.max) problems.push(`${where}: default ${s.default} of "${s.id}" is outside ${s.min}–${s.max}`);
      if (s.step && Math.abs(((s.default - s.min) / s.step) - Math.round((s.default - s.min) / s.step)) > 1e-9) problems.push(`${where}: default ${s.default} of "${s.id}" isn't on the ${s.step} step from ${s.min}`);
    }
    rows.push(row);
  }
  for (const r of rows) {
    for (const m of String(r.visible_if || '').matchAll(/settings\.(\w+)/g)) {
      if (!ids.has(m[1])) problems.push(`${where}: visible_if of "${r.id}" refers to unknown setting "${m[1]}"`);
    }
  }
  return { rows, ids };
}

// Where each section type is placed today, from the JSON templates and section groups.
const placements = {};
const templateFiles = [
  ...ls('templates').filter((n) => n.endsWith('.json')).map((n) => `templates/${n}`),
  ...ls('templates/customers').filter((n) => n.endsWith('.json')).map((n) => `templates/customers/${n}`),
  ...ls('sections').filter((n) => n.endsWith('.json')).map((n) => `sections/${n}`),
];
for (const f of templateFiles) {
  let data;
  try { data = lenientJson(read(f).replace(/^\s*\/\*[\s\S]*?\*\//, '')); } catch { continue; }
  for (const [id, section] of Object.entries(data.sections || {})) (placements[section.type] ||= []).push({ file: f, sectionKey: id, disabled: Boolean(section.disabled) });
}

const entries = [];
for (const file of files) {
  const where = file;
  const text = read(file);
  const raw = schemaOf(text);
  if (raw == null) { problems.push(`${where}: no {% schema %} (nothing for the merchant to edit)`); continue; }
  let schema;
  try { schema = lenientJson(raw); } catch (e) { problems.push(`${where}: schema isn't valid JSON (${e.message})`); continue; }
  const kind = file.startsWith('blocks/') ? 'theme block' : 'section';
  const type = basename(file, '.liquid');
  const own = settingsOf(schema.settings, where);
  const blocks = (schema.blocks || []).map((b) => {
    if (b.type?.startsWith('@')) return { type: b.type, note: b.type === '@app' ? 'accepts app blocks' : 'accepts theme blocks' };
    const bs = settingsOf(b.settings, `${where} block "${b.type}"`);
    return { type: b.type, name: label(b.name, `${where} block ${b.type}`), limit: b.limit ?? null, settings: bs.rows, ids: bs.ids };
  });
  const blockTypes = new Set(blocks.map((b) => b.type));
  const presets = (schema.presets || []).map((p) => {
    for (const id of Object.keys(p.settings || {})) if (!own.ids.has(id)) problems.push(`${where}: preset "${p.name}" sets unknown setting "${id}"`);
    const pBlocks = Array.isArray(p.blocks) ? p.blocks : Object.values(p.blocks || {});
    for (const b of pBlocks) if (b.type && !blockTypes.has(b.type) && !blockTypes.has('@theme') && !blockTypes.has('@app')) problems.push(`${where}: preset "${p.name}" adds unknown block type "${b.type}"`);
    return { name: label(p.name, `${where} preset`), category: label(p.category, `${where} preset category`), blocks: pBlocks.map((b) => b.type) };
  });
  const placedIn = kind === 'section' ? (placements[type] || []) : [];
  if (kind === 'section' && !presets.length && !placedIn.length) problems.push(`${where}: no presets and not placed in any template, so the merchant can't add it and it renders nowhere`);
  entries.push({
    file, kind, type, name: label(schema.name, `${where} name`), tag: schema.tag ?? null, class: schema.class ?? null,
    limit: schema.limit ?? null, max_blocks: schema.max_blocks ?? null,
    addable: presets.length > 0, presets, enabled_on: schema.enabled_on ?? null, disabled_on: schema.disabled_on ?? null, templates: schema.templates ?? null,
    placedIn, settings: own.rows, blocks: blocks.map(({ ids, ...b }) => b),
  });
}

const cell = (v) => (v == null || v === '' ? '' : String(typeof v === 'object' ? JSON.stringify(v) : v).replace(/\|/g, '\\|').replace(/\n/g, ' '));
const md = [`# ${key} · Customizer contract`, '', `Read from the schemas at ${git(['rev-parse', '--short', 'HEAD'], { allowFail: true })}. Labels in ${defaultLocale || 'the schema (no schema locale files)'}.`, ''];
for (const e of entries) {
  md.push(`## ${e.name} (${e.kind}, ${e.file})`, '');
  md.push(`- Can be added by the merchant: ${e.addable ? `yes, as ${e.presets.map((p) => `"${p.name}"`).join(', ')}` : 'no (no presets)'}`);
  if (e.enabled_on) md.push(`- enabled_on: ${cell(e.enabled_on)}`);
  if (e.disabled_on) md.push(`- disabled_on: ${cell(e.disabled_on)}`);
  if (e.placedIn.length) md.push(`- Placed today in: ${e.placedIn.slice(0, 12).map((p) => `${p.file} (${p.sectionKey})`).join(', ')}${e.placedIn.length > 12 ? `, +${e.placedIn.length - 12} more` : ''}`);
  md.push('', '| Setting | Type | Label | Default | Options / range | Info | visible_if | Seen in editor |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  const row = (prefix, s) => md.push(`| ${prefix}${cell(s.id)} | ${cell(s.type)} | ${cell(s.label)} | ${cell(s.default)} | ${cell(s.options ? s.options.map((o) => `${o.value}=${o.label}`).join(', ') : s.type === 'range' ? `${s.min}–${s.max} step ${s.step ?? 1}${s.unit ? ` ${s.unit}` : ''}` : '')} | ${cell(s.info)} | ${cell(s.visible_if)} | |`);
  for (const s of e.settings) row('', s);
  for (const b of e.blocks) {
    if (b.note) { md.push(`| block ${cell(b.type)} | | ${b.note} | | | | | |`); continue; }
    md.push(`| **block ${cell(b.type)}** | | ${cell(b.name)} | | ${b.limit ? `limit ${b.limit}` : ''} | | | |`);
    for (const s of b.settings) row(`${b.type}.`, s);
  }
  md.push('');
}
md.push('## Problems', '', ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none']), '');
if (untranslated.size) md.push('## Not translated in every schema locale (falls back to the default)', '', `- ${[...untranslated].slice(0, 40).join('\n- ')}${untranslated.size > 40 ? `\n- …and ${untranslated.size - 40} more` : ''}`, '');

writeFileSync(join(LOGS, key, 'contract.json'), JSON.stringify({ key, defaultLocale, locales: Object.keys(locales), entries, problems, untranslated: [...untranslated] }, null, 2));
writeFileSync(join(LOGS, key, 'contract.md'), md.join('\n'));
print({
  files: entries.map((e) => `${e.file} → "${e.name}"`),
  problems,
  untranslatedKeys: untranslated.size,
  written: [`.claude/logs/${key}/contract.md`, `.claude/logs/${key}/contract.json`],
});
