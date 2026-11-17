// Generic helpers for the app kit's scripts: output, argv, processes, CLI output, state files, GraphQL reading.
// Zero dependencies and no repo paths. run, parseCliJson and the GraphQL scanner are copied from the theme kit
// (shopify-claude-kit 1.0.0, kit/lib.mjs), where they are battle-tested; a bug fixed in one kit likely needs fixing in the other.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const WIN = process.platform === 'win32';

// ── Output and arguments ──

export const now = () => new Date().toISOString();

export function print(value) {
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n');
}

export function fail(message, code = 1) {
  process.stderr.write(String(message).trimEnd() + '\n');
  process.exit(code);
}

/**
 * An argv parser. Flags in `booleans` never take a value. Any other --flag swallows the next argument unless that
 * looks like a flag (--name or --name=…), so a new boolean flag must be listed in its flavour's set. A value can start
 * with "--" (qa-row --measured "--gap: 16px").
 */
const looksLikeFlag = (a) => /^--[A-Za-z][\w-]*(=|$)/.test(a);
export function parseArgsWith(booleans) {
  return (argv) => {
    const out = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        if (eq !== -1) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        else if (!booleans.has(a.slice(2)) && i + 1 < argv.length && !looksLikeFlag(argv[i + 1])) out.flags[a.slice(2)] = argv[++i];
        else out.flags[a.slice(2)] = true;
      } else out._.push(a);
    }
    return out;
  };
}

// ── Processes and CLI output ──

/** Why an argument can't go through cmd.exe (it would read " % ^ & | < > ! as its own syntax), or null. */
export function cmdExeProblem(args) {
  const bad = args.find((a) => /["%^&|<>!\r\n]/.test(a));
  return bad === undefined ? null : `Refusing to pass ${JSON.stringify(bad)} through cmd.exe, which reads " % ^ & | < > ! as its own syntax. Rename the file or folder without those characters, or ask the dev to run the command with the ! prefix.`;
}

/**
 * Runs a program. Real executables are spawned directly. The Shopify CLI is a .cmd shim
 * on Windows, which Node can only start through a shell, so those arguments are quoted
 * here and characters cmd.exe would interpret are refused (as a failed run, so callers report it like any CLI error).
 * dropEnv: inherited variables to leave out (the app kit drops SHOPIFY_FLAG_*, which would silently pick the store or config).
 */
export function run(cmd, args = [], { cwd = process.cwd(), env = {}, input, timeout = 600000, shell = false, dropEnv = null } = {}) {
  const base = dropEnv ? Object.fromEntries(Object.entries(process.env).filter(([k]) => !dropEnv.test(k))) : process.env;
  const opts = { cwd, env: { ...base, ...env }, input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 };
  let res;
  if (shell && WIN) {
    const refused = cmdExeProblem(args);
    if (refused) return { code: 1, stdout: '', stderr: refused };
    const line = [cmd, ...args].map((a) => (a === '' || /[\s*?]/.test(a) ? `"${a}"` : a)).join(' ');
    // Otherwise cmd.exe runs a shopify.cmd from the repo root before the one on PATH.
    res = spawnSync(line, { ...opts, env: { ...opts.env, NoDefaultCurrentDirectoryInExePath: '1' }, shell: true });
  } else {
    res = spawnSync(cmd, args, opts);
  }
  return {
    code: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: (res.stderr || '') + (res.error ? `\n${res.error.message}` : ''),
  };
}

/**
 * The CLI can print hint lines and NDJSON progress events before the result,
 * so take the last top-level JSON value that isn't a progress event.
 */
export function parseCliJson(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^[[{]/.test(lines[i])) continue;
    try {
      const value = JSON.parse(lines.slice(i).join('\n'));
      if (value && value.type === 'progress') continue;
      return value;
    } catch { /* not a complete value from here; keep scanning upward */ }
  }
  return null;
}


// ── State files ──

/** Write to a temp file and rename, so a crash never leaves half a file. */
export function writeJsonAtomic(p, value) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, p);
}

// ── GraphQL reading ──
// Safety code: the guard and the wrapper decide what a store write is from these. Every new rule or bypass gets a self-test.

/** Tokens with comments dropped and strings blanked, so neither can hide a field; code keeps strings (they hold ids). */
export function gqlScan(text) {
  const tokens = [];
  let code = '';
  const word = /[A-Za-z_]\w*|-?\d[\w.+-]*/y;
  let i = 0;
  while (i < text.length) {
    const start = i;
    // A lone CR ends a comment or a string too, as GraphQL servers read it; "#\rmutation" is a mutation.
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++; continue; }
    if (text.startsWith('"""', i)) {
      i += 3;
      while (i < text.length && !text.startsWith('"""', i)) i += text.startsWith('\\"""', i) ? 4 : 1;
      i += 3;
      tokens.push('""');
    } else if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== '\n' && text[i] !== '\r') i += text[i] === '\\' ? 2 : 1;
      i++;
      tokens.push('""');
    } else if (text.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else {
      word.lastIndex = i;
      const m = word.exec(text);
      if (m) { tokens.push(m[0]); i += m[0].length; } else { if (!/[\s,]/.test(text[i])) tokens.push(text[i]); i++; }
    }
    code += text.slice(start, i);
  }
  return { tokens, code };
}

/**
 * The operations in a GraphQL document and the top-level fields each selects (aliases resolved to the real field).
 * { ops: [{ type, fields }] } or { problem } when it can't be read, or uses fragments, which could hide a field.
 */
export function gqlOperations(text) {
  const { tokens: t, code } = gqlScan(text);
  const isName = (x) => /^[A-Za-z_]\w*$/.test(x || '');
  let i = 0;
  const skip = (open, close) => { let depth = 0; do { if (t[i] === open) depth++; else if (t[i] === close) depth--; i++; } while (depth > 0 && i < t.length); };
  const skipDirectives = () => { while (t[i] === '@') { i += 2; if (t[i] === '(') skip('(', ')'); } };
  const unparsed = () => ({ problem: `Couldn't parse the file near "${t[i] ?? 'the end'}", so the kit won't run it.` });
  const ops = [];
  while (i < t.length) {
    if (t[i] === 'fragment') return { problem: 'Fragments aren\'t allowed in a mutation file: write the fields out.' };
    let type = 'query';
    if (['query', 'mutation', 'subscription'].includes(t[i])) {
      type = t[i++];
      if (isName(t[i])) i++;
      if (t[i] === '(') skip('(', ')');
      skipDirectives();
    }
    if (t[i] !== '{') return unparsed();
    i++;
    const fields = [];
    while (i < t.length && t[i] !== '}') {
      if (t[i] === '...') return { problem: 'Fragment spreads aren\'t allowed at the top of a mutation.' };
      if (!isName(t[i])) return unparsed();
      let field = t[i++];
      // An alias names the result, not the mutation: check the real name.
      if (t[i] === ':') { field = t[++i]; if (!isName(field)) return unparsed(); i++; }
      fields.push(field);
      if (t[i] === '(') skip('(', ')');
      skipDirectives();
      if (t[i] === '{') skip('{', '}');
    }
    if (t[i] !== '}') return unparsed();
    i++;
    ops.push({ type, fields });
  }
  return { ops, code };
}

// The guard records what it showed the dev; the wrapper runs only that, once.
export const sealDigest = (text, varsText = '') => createHash('sha256').update(`${text}\0${varsText}`).digest('hex');
