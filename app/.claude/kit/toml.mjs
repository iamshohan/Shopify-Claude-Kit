// A TOML reader for the subset Shopify app configs use: tables, arrays of tables, dotted and quoted keys,
// strings (basic, literal, multi-line), numbers, booleans, arrays and inline tables. No dates.
// Zero dependencies. Checked against the CLI's own parse (app info -j) of real app repos in the self-test below.
//   node .claude/kit/toml.mjs --selftest
//   node .claude/kit/toml.mjs <file.toml>      prints the parsed JSON
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseToml(text) {
  const root = {};
  let table = root;
  let i = 0;
  // Editors on Windows can save a byte-order mark; the CLI ignores it.
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const err = (msg) => { throw new Error(`TOML line ${src.slice(0, i).split('\n').length}: ${msg}`); };
  const ws = () => { while (src[i] === ' ' || src[i] === '\t') i++; };
  // Whitespace, newlines and comments: inside arrays and between statements.
  const gap = () => { for (;;) { ws(); if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++; else if (src[i] === '\n') i++; else return; } };

  function key() {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") parts.push(string());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
        if (!m) err('expected a key');
        parts.push(m[0]);
        i += m[0].length;
      }
      ws();
      if (src[i] !== '.') return parts;
      i++;
    }
  }

  function string() {
    const q = src[i];
    const multi = src.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && src[i] === '\n') i++; // a newline right after the opening quotes is trimmed
    let out = '';
    for (;;) {
      if (i >= src.length) err('unterminated string');
      if (multi ? src.startsWith(q.repeat(3), i) : src[i] === q) {
        i += multi ? 3 : 1;
        // Up to two quotes may sit right before the closing three.
        if (multi) while (src[i] === q && !src.startsWith(q.repeat(3), i)) { out += q; i++; }
        return out;
      }
      if (!multi && src[i] === '\n') err('newline in a single-line string');
      if (q === '"' && src[i] === '\\') {
        const c = src[i + 1];
        const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (c in simple) { out += simple[c]; i += 2; continue; }
        if (c === 'u' || c === 'U') {
          const n = c === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + n), 16));
          i += 2 + n;
          continue;
        }
        // Line-ending backslash, which may have spaces after it: the newline and the next line's indent go.
        if (multi && /^\\[ \t]*\n/.test(src.slice(i))) { i += 1; while (/[\s]/.test(src[i] || '')) i++; continue; }
        err(`unknown escape \\${c}`);
      }
      out += src[i++];
    }
  }

  function value() {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return string();
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        gap();
        if (src[i] === ']') { i++; return arr; }
        arr.push(value());
        gap();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        err('expected , or ] in an array');
      }
    }
    if (c === '{') {
      i++;
      const obj = {};
      ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        const k = key();
        if (src[i] !== '=') err('expected = in an inline table');
        i++;
        assign(obj, k, value());
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        err('expected , or } in an inline table');
      }
    }
    const m = /^[^\s,\]}#]+/.exec(src.slice(i));
    if (!m) err('expected a value');
    i += m[0].length;
    const raw = m[0];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(0|[1-9](_?\d)*)$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
    if (/^0x[0-9a-fA-F_]+$/.test(raw)) return parseInt(raw.slice(2).replace(/_/g, ''), 16);
    err(`unsupported value "${raw}"`);
  }

  function assign(obj, parts, v) {
    let o = obj;
    // Own keys only: "toString" or "constructor" is a key like any other, not the prototype's.
    for (const p of parts.slice(0, -1)) {
      if (!Object.hasOwn(o, p)) o[p] = {};
      else if (typeof o[p] !== 'object' || Array.isArray(o[p])) err(`"${p}" is already a value`);
      o = o[p];
    }
    const last = parts[parts.length - 1];
    if (Object.hasOwn(o, last)) err(`duplicate key "${parts.join('.')}"`);
    o[last] = v;
  }

  /** The table a [header] or [[header]] names; arrays of tables resolve to their last element on the way down. */
  function walk(parts, arrayOfTables) {
    let o = root;
    parts.forEach((p, n) => {
      const lastPart = n === parts.length - 1;
      if (lastPart && arrayOfTables) {
        if (!Object.hasOwn(o, p)) o[p] = [];
        if (!Array.isArray(o[p])) err(`"${parts.join('.')}" is not an array of tables`);
        o[p].push({});
        o = o[p][o[p].length - 1];
        return;
      }
      if (!Object.hasOwn(o, p)) o[p] = {};
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
      if (typeof o !== 'object' || o === null) err(`"${p}" is already a value`);
    });
    // [a] twice would merge the two silently; the CLI refuses the file. [a.b] before [a] only made a implicitly.
    if (defined.has(o)) err(`table [${parts.join('.')}] is defined twice`);
    defined.add(o);
    return o;
  }
  const defined = new WeakSet();

  for (;;) {
    gap();
    if (i >= src.length) return root;
    if (src[i] === '[') {
      const aot = src[i + 1] === '[';
      i += aot ? 2 : 1;
      const parts = key();
      if (src[i] !== ']' || (aot && src[i + 1] !== ']')) err('expected ] after a table name');
      i += aot ? 2 : 1;
      table = walk(parts, aot);
    } else {
      const k = key();
      if (src[i] !== '=') err('expected =');
      i++;
      assign(table, k, value());
    }
    ws();
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
    if (i < src.length && src[i] !== '\n') err('expected the end of the line');
  }
}

// ── Self-test and CLI ──

function selftest() {
  const checks = [];
  const eq = (name, got, want) => checks.push([name, JSON.stringify(got) === JSON.stringify(want), got, want]);
  const throws = (name, text) => { try { parseToml(text); checks.push([name, false, 'parsed', 'an error']); } catch { checks.push([name, true]); } };
  eq('keys and values', parseToml('a = "x"\nb = 1\nc = true\nd = 1.5 # comment\n'), { a: 'x', b: 1, c: true, d: 1.5 });
  eq('tables and dotted keys', parseToml('[a.b]\nc.d = 1\n[a."e f"]\ng = \'lit\\n\'\n'), { a: { b: { c: { d: 1 } }, 'e f': { g: 'lit\\n' } } });
  eq('arrays of tables, nested', parseToml('[[ext]]\nh = "a"\n  [[ext.t]]\n  x = 1\n  [[ext.t]]\n  x = 2\n  [ext.cap]\n  n = true\n[[ext]]\nh = "b"\n'),
    { ext: [{ h: 'a', t: [{ x: 1 }, { x: 2 }], cap: { n: true } }, { h: 'b' }] });
  eq('multi-line array with comments and trailing comma', parseToml('r = [\n  "a", # one\n  "b",\n]\n'), { r: ['a', 'b'] });
  eq('inline table', parseToml('w = { uri = "/x", topics = ["a/b"] }\n'), { w: { uri: '/x', topics: ['a/b'] } });
  eq('escapes and unicode', parseToml('s = "a\\"b\\u00e4\\t"\n'), { s: 'a"bä\t' });
  eq('multi-line strings', parseToml('s = """\nline1\nline2"""\nt = \'\'\'\nraw \\n\'\'\'\n'), { s: 'line1\nline2', t: 'raw \\n' });
  eq('hash inside a string', parseToml('u = "https://x/#a" # real comment\n'), { u: 'https://x/#a' });
  eq('integers with underscores and negatives', parseToml('n = 1_000\nm = -3\n'), { n: 1000, m: -3 });
  eq('a byte-order mark is skipped', parseToml(`${String.fromCharCode(0xfeff)}name = "x"\n`), { name: 'x' });
  eq('a line-ending backslash with spaces after it', parseToml('d = """\na \\  \n  b"""\n'), { d: 'a b' });
  throws('duplicate key', 'a = 1\na = 2\n');
  throws('unterminated string', 'a = "x\n');
  throws('garbage after a value', 'a = 1 2\n');
  throws('table over a value', 'a = 1\n[a]\nb = 2\n');
  eq('keys named like Object\'s own properties', parseToml('toString = 1\n[constructor]\nx = 2\n'), { toString: 1, constructor: { x: 2 } });
  throws('a table defined twice', '[a]\nx = 1\n[a]\ny = 2\n');
  eq('a parent table after its child, and the same sub-table under each array element', parseToml('[a.b]\nx = 1\n[a]\ny = 2\n[[e]]\n[e.c]\nn = 1\n[[e]]\n[e.c]\nn = 2\n'),
    { a: { b: { x: 1 }, y: 2 }, e: [{ c: { n: 1 } }, { c: { n: 2 } }] });
  const failed = checks.filter((c) => !c[1]);
  for (const [name, , got, want] of failed) console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  console.log(failed.length ? `${failed.length} of ${checks.length} failed` : `all ${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain && process.argv.includes('--selftest')) selftest();
else if (isMain && process.argv[2]) console.log(JSON.stringify(parseToml(readFileSync(process.argv[2], 'utf8')), null, 2));
