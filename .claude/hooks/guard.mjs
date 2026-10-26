#!/usr/bin/env node
// PreToolUse guard for the Shopify kit. A seatbelt against realistic mistakes (calling the
// Shopify CLI directly, pushing to main, hand-editing task state, reading secrets), not a
// security boundary: GitHub branch protection and store staff permissions are the real limits.
// Self-test: node .claude/hooks/guard.mjs --selftest
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
// The wrapper's own argv parser and mutation check: the guard must read a command exactly as the wrapper will run it.
import { parseArgs, mutationProblems, sealDigest, SEAL_FILE, TEST_SUFFIX, MERCHANT_JSON, protectedBranches as branchesFrom } from '../kit/lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
// The kit's master repo: install.mjs sits beside .claude/, and the installer (which writes the manifest) never ran here.
const MASTER = existsSync(join(ROOT, 'install.mjs')) && !existsSync(join(ROOT, '.claude', '.kit-manifest.json'));

const USE_WRAPPER = 'Shopify CLI calls go through the kit: node .claude/kit/shopify.mjs <verb> (run it with --help for the verbs). '
  + 'If the wrapper has no verb for what you need, ask the dev to run the command themselves with the ! prefix. '
  + 'If you only mentioned "shopify" in text, use the Grep tool or rephrase.';

// The wrapper path itself contains "shopify"; mask it before looking for real CLI calls.
const WRAPPER_PATH = /(?:[\w:.~-]*[\\/])?\.claude[\\/]kit[\\/]shopify\.mjs/gi;
const CLI_TOPICS = 'theme|store|app|auth|hydrogen|organization|config|upgrade|version|commands|search|help|plugins|webhook|login|logout|kitchen-sink|demo';
const CLI_WORD = new RegExp(`(^|[\\s;&|(\`'"=])shopify(\\.cmd|\\.ps1|\\.exe)?['"]?\\s+(${CLI_TOPICS}|-)`, 'i');
const CLI_PATH = new RegExp(`[\\\\/]shopify(\\.cmd|\\.ps1|\\.exe)?['"]?\\s+(${CLI_TOPICS})\\b`, 'i');
const CLI_PKG = /@shopify\/(cli|theme|app|create-app)\b|SHOPIFY_FLAG_|SHOPIFY_CLI_THEME_TOKEN|SHOPIFY_CLI_PARTNERS_TOKEN/i;
const THEMEKIT = /^theme(\.exe)?\s+(deploy|watch|open|replace|upload|remove|download|get|new|configure|publish|update)\b/;
// .env files, Theme Kit's config.yml, and the Shopify CLI's session folders (shopify-cli-kit-nodejs/…), whose tokens can publish themes.
const SECRET_FILE = /(^|[\s'"=\\/])(\.env(\.[\w.-]+)?|config\.yml)(?=$|[\s'"`;&|)])|shopify-cli-[\w-]+[\\/]/;
const STATE_FILE = /logs[\\/][^\\/\s'"]+[\\/]state\.json/i;
const SEAL = new RegExp(SEAL_FILE.replace('.', '\\.'), 'i');
const CONFIG_REL = '.claude/shopify-kit.json';
// What each setting controls, named in the prompt when it changes.
const CONFIG_KEYS = {
  store: 'the store every kit command acts on', storefrontUrl: 'the site fetch and compare request', jiraBaseUrl: 'where jira.mjs sends the Jira token',
  baseBranch: 'a branch the guard protects', protectedBranches: 'the branches the guard protects', adminApi: 'whether the kit uses the Admin API',
  draftRoute: 'how the draft theme is made',
};
const STORE_VERBS = new Set(['mutate', 'delete-draft']);
// Gate 2 approves the plan, which unlocks the build and the store writes in it. kit.mjs only checks that --answer is
// non-empty, so the dev sees what gets recorded. The other gates are reviewed again at Gate 2 or in the dev's PR review.
const GATE_STAGES = new Set(['approve']);
// Wrapper verbs that run without asking. Anything else, including verbs added later, asks the dev.
const SAFE_VERBS = new Set(['cli-check', 'auth-check', 'themes', 'query', 'pull-live', 'check', 'draft', 'push', 'preview', 'fetch', 'verify', 'help', '--help']);
// Without the cookie the redirect sets, ?preview_theme_id silently serves the live theme.
const FETCHERS = /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(\.exe)?$/i;
const NPM_BUILTINS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'init', 'create',
  'outdated', 'ls', 'list', 'view', 'info', 'audit', 'link', 'config', 'cache', 'why', 'pack', 'prune', 'dedupe', 'help', 'version', '-v', '--version']);

function protectedBranches() {
  try { return branchesFrom(JSON.parse(readFileSync(join(ROOT, '.claude', 'shopify-kit.json'), 'utf8'))); } catch { return branchesFrom(null); }
}

function currentBranch() {
  try { return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim(); }
  catch { return ''; }
}

function packageScripts() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts || {}; } catch { return {}; }
}

/** Drop the body of a heredoc or PowerShell here-string, but only when it is a git commit/tag message. */
function stripMessageBodies(cmd) {
  const lines = cmd.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!/\bgit(\.exe)?\b.*\b(commit|tag)\b/.test(lines[i])) continue;
    const here = lines[i].match(/<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    const ps = /@['"]\s*$/.test(lines[i]) ? (lines[i].trim().endsWith(`@'`) ? `'@` : `"@`) : null;
    const end = here ? here[1] : ps;
    if (!end) continue;
    const j = lines.findIndex((l, k) => k > i && l.trim().startsWith(end));
    if (j === -1) continue; // unterminated: keep everything visible
    out.push(lines[j]);
    i = j;
  }
  return out.join('\n');
}

/** Split on && || ; | & and newlines, but not inside quotes or redirects (2>&1, &>file). */
function segments(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { cur += c; if (c === quote && cmd[i - 1] !== '\\') quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n' || c === '\r') { out.push(cur); cur = ''; continue; }
    // A lone & runs the left side in the background (bash) or is PowerShell's call operator: both start a new command.
    if (c === '&' && !/[<>]/.test(cmd[i - 1] || '') && cmd[i + 1] !== '>') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const stripRedirects = (s) => s.replace(/\s\d*>&\d+/g, ' ').replace(/\s\d*>>?\s*[^\s;&|]+/g, ' ');

function words(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Leading env assignments and PowerShell's call operator don't change which program runs. */
function program(segment) {
  const w = words(segment);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_]\w*=/.test(w[i]) || w[i] === '&')) i++;
  return { w, i };
}

/** git's subcommand, skipping global options such as -C <dir> or -c key=value (returned as globals). */
function gitCommand(segment) {
  const { w, i: start } = program(stripRedirects(segment));
  let i = start;
  if (!/^git(\.exe)?$/i.test(w[i] || '')) return null;
  i++;
  while (i < w.length && w[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w[i]) ? 2 : 1;
  return { sub: w[i] || '', args: w.slice(i + 1), globals: w.slice(start + 1, i) };
}

/** The argument of a cd, pushd or Set-Location segment ({ arg: undefined } means home), or null for any other segment. */
function cdArg(segment) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^(cd|pushd|chdir|Set-Location|sl)$/i.test(w[i] || '')) return null;
  return { arg: w.slice(i + 1).find((x) => !/^-(L|P|e|@|Path|LiteralPath)$/i.test(x) && !/^\/d$/i.test(x)) };
}

/** The folder a cd or git -C leads to, or null when the guard can't tell (a variable, cd -, an unknown start). */
function dirAfter(arg, from) {
  if (arg === undefined) return homedir();
  if (!arg || arg === '-' || /[$`%*?]/.test(arg)) return null;
  let p = arg.replace(/^~(?=$|[\\/])/, homedir());
  if (WIN) p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`);
  if (isAbsolute(p)) return resolve(p);
  return from === null ? null : resolve(from, p);
}

const outsideRepo = (dir) => { const rel = relative(ROOT, dir); return rel.startsWith('..') || isAbsolute(rel); };

/** The command string inside bash -c "...", cmd /c ..., powershell -Command "...". */
function innerCommand(segment) {
  const m = segment.match(/^(?:[A-Za-z_]\w*=\S+\s+)*(?:&\s*)?(?:bash|sh|zsh|cmd|powershell|pwsh)(?:\.exe)?\s+(?:-c|\/c|-Command|-command)\s+([\s\S]+)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  const q = rest[0];
  return (q === '"' || q === "'") && rest.endsWith(q) ? rest.slice(1, -1) : rest;
}

function checkPush(args, prot) {
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a) => !a.startsWith('-'));
  const allowed = 'Allowed form: git push -u origin <task-branch>.';
  const bad = flags.filter((f) => !['-u', '--set-upstream'].includes(f));
  if (bad.length) return `git push ${bad.join(' ')} is blocked (no force, delete, mirror, all or tags). ${allowed}`;
  if (pos.length !== 2) return `Name the remote and the branch. ${allowed}`;
  if (/[$`(]/.test(pos.join(' '))) return `Push the branch by its literal name, not a variable or $(…). ${allowed}`;
  const full = pos[1];
  if (/^(HEAD|@)$/i.test(full) || /[:+*^~]/.test(full)) return `Push the branch by name, not a refspec like HEAD:main or +branch. ${allowed}`;
  // Only refs/heads/<name> is a branch; refs/tags/…, refs/remotes/… and the like are not what this push is for.
  if (/^refs\//i.test(full) && !/^refs\/heads\//i.test(full)) return `Push the branch by its plain name. ${allowed}`;
  // git resolves heads/main and refs/heads/main to main. origin/main and remotes/… are refused too, to be safe.
  const ref = full.replace(/^refs\/heads\//i, '').replace(/^heads\//i, '');
  const names = [ref, ref.replace(/^remotes\/[^/]+\//i, '')];
  if (ref.toLowerCase().startsWith(`${pos[0].toLowerCase()}/`)) names.push(ref.slice(pos[0].length + 1));
  const hit = names.find((n) => prot.some((p) => p.toLowerCase() === n.toLowerCase()));
  if (hit) return `"${hit}" is protected. It changes only through a reviewed PR that the dev merges.`;
  if (ref.toLowerCase().endsWith(TEST_SUFFIX)) return `"${ref}" belongs to a test run of the kit, which is never pushed. The draft gets the files through shopify.mjs push; handoff skips the push.`;
  return null;
}

function scriptCallsCli(name, scripts, depth = 0) {
  const body = scripts[name];
  if (!body || depth > 3) return null;
  const masked = body.replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  if (CLI_WORD.test(masked) || CLI_PATH.test(masked) || CLI_PKG.test(masked) || segments(masked).some((s) => THEMEKIT.test(s.replace(/^&\s*/, '')))) return body;
  for (const m of body.matchAll(/(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) {
    const inner = scriptCallsCli(m[1], scripts, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/** gh pr merge, or a gh api call that merges a PR or moves a ref. gh takes global flags (-R owner/repo) before its subcommand. */
function ghMerges(segment) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^gh(\.exe)?$/i.test(w[i] || '')) return false;
  const rest = w.slice(i + 1);
  const at = rest.findIndex((x) => x === 'pr' || x === 'api');
  if (at === -1 || at > 4) return false;
  if (rest[at] === 'pr') return rest[at + 1] === 'merge';
  return rest.slice(at + 1).some((x) => /\/merges?\b|\/pulls\/\d+\/merge|git\/refs|mergePullRequest/.test(x));
}

/** A wrapper call in one segment, with its arguments parsed the way the wrapper parses them. */
function wrapperCall(segment) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^node(\.exe)?$/i.test(w[i] || '') || !/(^|[\\/])shopify\.mjs$/i.test(w[i + 1] || '')) return null;
  return parseArgs(w.slice(i + 2));
}

function wrapperDecision(segs, ctx) {
  for (const seg of segs) {
    const call = wrapperCall(seg);
    if (!call) {
      // node -e, node options, another script or runtime: the guard can't read the arguments.
      const { w, i } = program(seg);
      if (/^(node|bun|deno|tsx|npx)(\.exe|\.cmd)?$/i.test(w[i] || '') && /shopify\.mjs/i.test(seg) && /\b(mutate|delete-draft)\b/.test(seg)) {
        return { decision: 'ask', reason: `This runs a store-changing kit verb in a way the guard can't read, and the wrapper will refuse it. Run it as node .claude/kit/shopify.mjs <verb> … instead. (${seg.slice(0, 300)})` };
      }
      continue;
    }
    const verb = call._[0];
    if (['push', 'verify'].includes(verb) && call.flags.reconciled !== undefined) {
      return { decision: 'ask', reason: `The dev confirms that live's edits to ${call.flags.reconciled} are already in the task branch (copied by hand: this repo doesn't sync live edits into git). The draft, and live after the merge, get the branch's version of these files. Allow?` };
    }
    if (!verb || SAFE_VERBS.has(verb)) continue;
    if (!STORE_VERBS.has(verb)) return { decision: 'ask', reason: `The kit command "${verb}" isn't on the read-only list. Allow it? (${seg.trim()})` };
    // The wrapper reads the same flag the same way, so this is a real dry run.
    if (call.flags['dry-run']) continue;
    // Anything else in the command could change the file between this prompt and the run.
    if (segs.length > 1 || /[$`]/.test(seg)) return { decision: 'deny', reason: `Run ${verb} as its own command, with literal values: then what the dev approves is exactly what runs.` };
    const key = String(call._[1] || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return { decision: 'ask', reason: `"${call._[1] ?? ''}" isn't a Jira key; the wrapper will refuse it. (${seg.trim()})` };
    if (verb === 'delete-draft') {
      const draft = ctx.state(key)?.draft || {};
      return {
        decision: 'ask',
        reason: `Delete theme ${draft.themeId ?? '(unknown id)'} "${draft.name ?? '(unknown name)'}" (route ${draft.route ?? '?'}) from the store? This can't be undone.`,
        seal: { key, verb, themeId: draft.themeId ?? null },
      };
    }
    const file = call._[2] || '';
    const vars = typeof call.flags.vars === 'string' ? call.flags.vars : null;
    if (!/\.graphql$/i.test(file) || (vars && !/\.json$/i.test(vars))) {
      return { decision: 'deny', reason: 'Usage: shopify.mjs mutate <KEY> <file.graphql> [--vars <file.json>], both files in the task\'s mutations folder.' };
    }
    const text = ctx.read(file);
    const varsText = vars ? ctx.read(vars) : '';
    if (text === null || varsText === null) return { decision: 'deny', reason: `No such file: ${text === null ? file : vars}` };
    const problems = mutationProblems(text, varsText, (ctx.state(key)?.mutations || []).flatMap((m) => m.ids || []));
    if (problems.length) return { decision: 'deny', reason: `The kit won't run this mutation:\n- ${problems.join('\n- ')}` };
    const shown = `${text}${vars ? `\n--- variables ${vars}\n${varsText}` : ''}`;
    if (shown.length > 8000) return { decision: 'deny', reason: 'This mutation and its variables are over 8,000 characters, too long to review in one prompt. Split it into smaller files.' };
    return { decision: 'ask', reason: `Run this Admin GraphQL mutation on the store?\n${file}\n---\n${shown}`, seal: { key, verb, sha: sealDigest(text, varsText) } };
  }
  return null;
}

/** kit.mjs done <KEY> <gate> --answer "…": the gate is the dev's decision, so the dev sees the words the kit will record as theirs. */
function gateDecision(segs) {
  for (const seg of segs) {
    const { w, i } = program(stripRedirects(seg));
    if (!/^node(\.exe)?$/i.test(w[i] || '') || !/(^|[\\/])kit\.mjs$/i.test(w[i + 1] || '')) continue;
    const call = parseArgs(w.slice(i + 2));
    const answer = typeof call.flags.answer === 'string' ? call.flags.answer : '';
    // Without --answer the kit refuses on its own.
    if (call._[0] !== 'done' || !GATE_STAGES.has(call._[2]) || !answer) continue;
    return { decision: 'ask', reason: `Record this as your answer to the "${call._[2]}" gate of ${call._[1]}? The kit logs these words as yours:\n"${answer}"` };
  }
  return null;
}

/** The prompt for a change to shopify-kit.json: which settings change, and what each controls. */
function configChange(ti, ctx) {
  const before = ctx.read(CONFIG_REL);
  let after = null;
  if (typeof ti.content === 'string') after = ti.content;
  else if (before !== null && typeof ti.old_string === 'string') {
    after = ti.replace_all ? before.split(ti.old_string).join(ti.new_string) : before.replace(ti.old_string, () => ti.new_string);
  }
  let lines = null;
  try {
    const a = JSON.parse(before ?? '{}');
    const b = JSON.parse(after);
    const short = (v) => (v === undefined ? '(unset)' : JSON.stringify(v).slice(0, 80));
    lines = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => `- ${k}: ${short(a[k])} → ${short(b[k])}${CONFIG_KEYS[k] ? ` (${CONFIG_KEYS[k]})` : ''}`);
  } catch { /* unreadable: say so */ }
  return `This changes the kit's settings for this repo (${CONFIG_REL}):\n${lines ? lines.join('\n') || '- no setting changes' : '- the guard couldn\'t tell which settings change'}\nAllow it?`;
}

function decideCommand(raw, ctx, depth = 0, cwd = null) {
  const cmd = stripMessageBodies(raw);
  const segs = segments(cmd);
  const prot = ctx.protected();

  for (const seg of segs) {
    const inner = depth < 2 ? innerCommand(seg) : null;
    if (inner) {
      const r = decideCommand(inner, ctx, depth + 1, cwd);
      if (r) return r;
    }
  }

  // Commit and tag messages, and the text a kit.mjs call records (notes, gate answers), are text; everything else is
  // scanned. A $( or a backtick in that text could still run something, so those segments stay scanned.
  const isText = (s) => {
    if (['commit', 'tag'].includes(gitCommand(s)?.sub)) return true;
    const { w, i } = program(stripRedirects(s));
    return /^node(\.exe)?$/i.test(w[i] || '') && /(^|[\\/])kit\.mjs$/i.test(w[i + 1] || '') && !/[$`]/.test(s);
  };
  const scanned = segs.filter((s) => !isText(s)).join(' ; ').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  if (CLI_WORD.test(scanned) || CLI_PATH.test(scanned) || CLI_PKG.test(scanned)) return { decision: 'deny', reason: USE_WRAPPER };
  if (segs.some((s) => { const { w, i } = program(s); return THEMEKIT.test(w.slice(i).join(' ')); })) {
    return { decision: 'deny', reason: 'Theme Kit (the "theme" command) can deploy to live themes. Use node .claude/kit/shopify.mjs, or ask the dev to run it.' };
  }
  if (SECRET_FILE.test(scanned)) return { decision: 'deny', reason: 'Credential files (.env*, .claude/.env.local, Theme Kit config.yml, the Shopify CLI\'s shopify-cli-* folders) are never read or written by Claude. jira.mjs --check reports whether Jira credentials are set; shopify.mjs auth-check reports the Shopify logins.' };
  if (SEAL.test(scanned)) return { decision: 'deny', reason: `Only the guard writes ${SEAL_FILE}: it records what the dev was shown for a mutate or delete-draft.` };
  if (STATE_FILE.test(scanned) && !/\.claude[\\/]kit[\\/]kit\.mjs/.test(scanned)) {
    return { decision: 'deny', reason: 'Task state goes through node .claude/kit/kit.mjs: status --json to read it; set, done, back to change it.' };
  }
  if (/Start-Process\b[^\n]*\bgit\b[^\n]*\bpush\b/i.test(cmd)) return { decision: 'deny', reason: 'Run git push directly so the guard can check it.' };
  // Only when a fetcher is the program run: prose that mentions curl (commit messages, heredoc text) stays allowed.
  if (segs.some((s) => { const { w, i } = program(stripRedirects(s)); return FETCHERS.test(w[i] || '') && /preview_theme_id/i.test(s); })) {
    return { decision: 'deny', reason: 'A plain request with ?preview_theme_id can be served the live theme without any error. Use node .claude/kit/shopify.mjs fetch <KEY> <path> [--find TEXT]: it keeps the preview cookie and checks which theme rendered the page.' };
  }

  // Walk the segments in order: "git switch main && git commit" commits on main. A cd or git -C into
  // another repository leaves this repo's branch behind; a folder the guard can't resolve counts as this repo.
  let branch = ctx.branch();
  let dir = cwd ? dirAfter(cwd, null) : ROOT;
  for (const seg of segs) {
    const cd = cdArg(seg);
    if (cd) { dir = dirAfter(cd.arg, dir); continue; }
    const { w, i } = program(seg);
    const run = w[i] && /^(npm|pnpm|yarn|bun)(\.cmd)?$/.test(w[i]) ? w.slice(i + 1).filter((x) => x !== 'run' && x !== 'run-script')[0] : null;
    if (run && !NPM_BUILTINS.has(run)) {
      const body = scriptCallsCli(run, ctx.scripts());
      if (body) return { decision: 'deny', reason: `The package script "${run}" runs the Shopify CLI or Theme Kit ("${body}"). Use node .claude/kit/shopify.mjs, or ask the dev to run the script.` };
    }

    const g = gitCommand(seg);
    if (!g) continue;
    const c = g.globals.indexOf('-C');
    const at = c === -1 ? dir : dirAfter(g.globals[c + 1], dir);
    const here = at === null || !outsideRepo(at);
    if (here && (g.sub === 'switch' || g.sub === 'checkout')) {
      if (!g.args.includes('--')) {
        const create = g.args.findIndex((a) => ['-c', '-C', '-b', '-B', '--create', '--force-create'].includes(a));
        const target = create !== -1 ? g.args[create + 1] : g.args.find((a) => !a.startsWith('-'));
        if (target && !(g.sub === 'checkout' && ctx.isPath(target))) branch = target.replace(/^origin\//, '');
      }
    }
    // An alias, or a remote's push refspec, hides "push origin main" behind a short command the guard can't read.
    if (g.sub === 'config' && g.args.some((a) => /^(alias\.|remote\.[^.]+\.push$)/i.test(a)) && !g.args.some((a) => /^(--get(-all|-regexp)?|-l|--list)$/.test(a))) {
      return { decision: 'deny', reason: 'git aliases and push refspecs can hide a push to a protected branch from the guard. Run the git command itself.' };
    }
    if (g.sub === 'push') {
      const why = checkPush(g.args, prot);
      if (why) return { decision: 'deny', reason: why };
    }
    if (here && ['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(g.sub) && prot.some((p) => p.toLowerCase() === String(branch).toLowerCase())) {
      return { decision: 'deny', reason: `That runs on "${branch}", which is protected. Switch to the task branch first (the build stage creates it).` };
    }
  }

  // gh takes global flags before the subcommand (gh -R owner/repo pr merge), and the API can merge or move a ref.
  if (segs.some(ghMerges)) {
    return { decision: 'deny', reason: 'Merging is the dev\'s step after handoff, not the agent\'s.' };
  }

  const kit = wrapperDecision(segs, ctx);
  if (kit) return kit;
  const gate = gateDecision(segs);
  if (gate) return gate;

  if (/shopify-kit\.json/i.test(scanned) && (/>\s*["']?[^\s;&|]*shopify-kit\.json/i.test(scanned) || /\b(writeFileSync|Set-Content|Out-File|Add-Content|tee|cp|mv|Copy-Item|Move-Item|rm|Remove-Item|del)\b|\bsed\s+-i/i.test(scanned))) {
    return { decision: 'ask', reason: `This command may change ${CONFIG_REL}, which sets the store the kit acts on, the branches the guard protects and where the Jira token goes. Allow it? (${cmd.slice(0, 300)})` };
  }

  for (const seg of segs) {
    const g = gitCommand(seg);
    if (!g) continue;
    const a = g.args;
    if (['fetch', 'pull', 'ls-remote'].includes(g.sub) && a.some((x) => /^--(upload-pack|exec)\b/.test(x))) {
      return { decision: 'ask', reason: `--upload-pack and --exec make git run a program. Allow it? ${seg}` };
    }
    if (g.globals.some((x) => /^(-c|--config-env|--exec-path)/.test(x))) return { decision: 'ask', reason: `git -c can make git run a program. Allow it? ${seg}` };
    const destructive = (g.sub === 'reset' && a.includes('--hard'))
      || (g.sub === 'clean' && a.some((x) => x === '--force' || /^-[a-z]*f/i.test(x)))
      || (g.sub === 'checkout' && (a.includes('--') || a.includes('.') || a.includes('-B') || a.some((x) => !x.startsWith('-') && ctx.isPath(x))))
      || (g.sub === 'switch' && (a.includes('-C') || a.includes('--force-create') || a.includes('--discard-changes')))
      || (g.sub === 'restore' && !a.includes('--staged'))
      || (g.sub === 'stash' && ['drop', 'clear'].includes(a[0]))
      || (g.sub === 'branch' && a.some((x) => ['-D', '-f', '--force'].includes(x)));
    if (destructive) return { decision: 'ask', reason: `This git command can discard work: ${seg}` };
  }
  return null;
}

function decideFile(ti, cwd, ctx) {
  const filePath = String(ti.file_path || ti.notebook_path || '');
  if (!filePath) return null;
  // Git Bash style /c/Users/... paths
  const native = filePath.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  const abs = isAbsolute(native) ? native : resolve(cwd || ROOT, native);
  const rel = relative(ROOT, abs).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (/^\.claude\/logs\/[^/]+\/state\.json$/i.test(rel)) return { decision: 'deny', reason: 'Task state changes go through node .claude/kit/kit.mjs (start, done, back, set).' };
  if (SEAL.test(rel)) return { decision: 'deny', reason: `Only the guard writes ${SEAL_FILE}.` };
  if (rel.toLowerCase() === CONFIG_REL) return { decision: 'ask', reason: configChange(ti, ctx) };
  if (/^(\.claude\/\.env\.local|\.env(\.[^/]*)?|config\.yml)$/i.test(rel)) return { decision: 'deny', reason: 'Credential files are written by the dev, never by Claude.' };
  if (/^\.claude\/(settings\.json|CLAUDE\.md|VERSION|hooks\/|kit\/|commands\/|agents\/|skills\/|rules\/)/i.test(rel)) {
    // In the kit's master repo, editing the kit is the work; only the hook's own wiring still asks.
    if (!ctx.master()) return { decision: 'ask', reason: `This edits the kit itself (${rel}). Kit changes belong in the master copy so every repo gets them.` };
    if (/^\.claude\/(settings\.json|hooks\/)/i.test(rel)) return { decision: 'ask', reason: `This changes the guard that checks this session (${rel}). Allow it?` };
  }
  // A file the approved plan names was already agreed at Gate 2.
  if (MERCHANT_JSON.test(rel) && !ctx.planned(rel)) {
    return { decision: 'ask', reason: `${rel} is merchant-owned: Shopify writes admin edits into it (and syncs them into git). Edit it only if the approved plan says so.` };
  }
  return null;
}

const defaultCtx = {
  protected: protectedBranches, branch: currentBranch, scripts: packageScripts, isPath: (p) => existsSync(join(ROOT, p)), master: () => MASTER,
  read: (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return null; } },
  state: (key) => { try { return JSON.parse(readFileSync(join(ROOT, '.claude', 'logs', key, 'state.json'), 'utf8')); } catch { return null; } },
  // Named in plan.md of an approved task whose branch is checked out.
  planned: (rel) => {
    try {
      const branch = currentBranch();
      return readdirSync(join(ROOT, '.claude', 'logs')).some((k) => {
        const st = defaultCtx.state(k);
        return st?.gates?.approve && st.branch === branch && readFileSync(join(ROOT, '.claude', 'logs', k, 'plan.md'), 'utf8').includes(rel);
      });
    } catch { return false; }
  },
};

export function decide(input, ctx = defaultCtx) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (tool === 'Bash' || tool === 'PowerShell') return decideCommand(String(ti.command || ''), ctx, 0, input.cwd || null);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return decideFile(ti, input.cwd, ctx);
  return null;
}

/** What the dev is about to be shown, for the wrapper to compare with what it runs. */
function writeSeal({ key, ...seal }) {
  try {
    mkdirSync(join(ROOT, '.claude', 'logs', key), { recursive: true });
    writeFileSync(join(ROOT, '.claude', 'logs', key, SEAL_FILE), JSON.stringify({ ...seal, at: new Date().toISOString() }));
  } catch { /* no seal: the wrapper refuses, which is the safe side */ }
}

/** Blocks feed kit.mjs retro: a block on a harmless command is a guard bug worth reporting. */
function logBlock(input, result) {
  if (result?.decision !== 'deny' || result.byMode) return; // a mode block is the dev's setup, not a guard bug
  try {
    const ti = input.tool_input || {};
    const entry = { at: new Date().toISOString(), tool: input.tool_name, reason: result.reason.slice(0, 200), command: String(ti.command || ti.file_path || '').slice(0, 200) };
    mkdirSync(join(ROOT, '.claude', 'logs'), { recursive: true });
    appendFileSync(join(ROOT, '.claude', 'logs', '_guard.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch { /* logging never changes the decision */ }
}

// Modes in which a hook's "ask" reaches the dev. bypassPermissions was seen to approve it silently; dontAsk denies
// every prompt and plan can skip them. acceptEdits only auto-approves file edits, so mutate, gates and git still prompt.
// A mode that isn't listed (including a future one) is treated like bypassPermissions.
const ASK_SHOWN = new Set(['default', 'auto', 'acceptEdits']);

/** In a mode that hides prompts, an "ask" is a silent allow. Turn it into a deny that says how to get the prompt back. */
function enforceMode(result, input) {
  const mode = input.permission_mode;
  if (typeof mode !== 'string' || ASK_SHOWN.has(mode)) return result; // no field: an older Claude Code, nothing to compare
  const probe = /guard\.mjs\s+--mode-probe\b/.test(String(input.tool_input?.command || ''));
  if (result?.decision !== 'ask' && !probe) return result;
  const would = result?.reason ? ` It would have asked: ${result.reason.slice(0, 300)}` : '';
  return {
    decision: 'deny',
    byMode: true,
    reason: `Permission mode "${mode}" doesn't show the kit's confirmation prompts, so this was blocked instead of approved silently. Stop and ask the dev to switch to default mode (Shift+Tab cycles modes), then run it again.${would}`,
  };
}

function emit(result) {
  if (!result) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason },
  }));
  process.exit(0);
}

function selftest() {
  const K = 'ABC-123'; // any non-protected task key/branch name works here
  const M = `.claude/logs/${K}/mutations`;
  const DEF = 'mutation Def($d: MetafieldDefinitionInput!) { metafieldDefinitionCreate(definition: $d) { createdDefinition { id } userErrors { message } } }';
  const FILES = {
    [`${M}/ok.graphql`]: DEF,
    [`${M}/ok.vars.json`]: '{"d":{"name":"Badge","namespace":"custom","key":"badge","type":"single_line_text_field","ownerType":"PRODUCT"}}',
    [`${M}/x--dry-run.graphql`]: DEF,
    [`${M}/product-delete.graphql`]: 'mutation { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    [`${M}/alias.graphql`]: 'mutation { ok: metafieldsSet(metafields: []) { userErrors { message } } fine: productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    [`${M}/two-ops.graphql`]: `${DEF}\nmutation B { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }`,
    [`${M}/in-string.graphql`]: 'mutation { metafieldsSet(metafields: [{value: "\\" } productDelete"}]) { userErrors { message } } productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    [`${M}/fragment.graphql`]: 'mutation { ...F } fragment F on Mutation { productDelete(input: {id: "gid://shopify/Product/1"}) { deletedProductId } }',
    [`${M}/del-own.graphql`]: 'mutation { metafieldDefinitionDelete(id: "gid://shopify/MetafieldDefinition/7", deleteAllAssociatedMetafields: true) { deletedDefinitionId } }',
    [`${M}/del-other.graphql`]: 'mutation { metafieldDefinitionDelete(id: "gid://shopify/MetafieldDefinition/8", deleteAllAssociatedMetafields: true) { deletedDefinitionId } }',
    [`${M}/del-by-comment.graphql`]: '# gid://shopify/MetafieldDefinition/7\nmutation { metafieldDefinitionDelete(identifier: {ownerType: PRODUCT, namespace: "custom", key: "x"}) { deletedDefinitionId } }',
    [CONFIG_REL]: '{"store":"a.myshopify.com","baseBranch":"main"}',
  };
  const STATE = { mutations: [{ ids: ['gid://shopify/MetafieldDefinition/7'] }], draft: { themeId: 5, name: K, route: 'cli' } };
  const ctx = (branch = K, scripts = {}, master = false) => ({
    protected: () => ['main', 'master'], branch: () => branch, scripts: () => scripts, isPath: (p) => /[/\\]/.test(p) && /\.\w+$/.test(p), master: () => master,
    read: (p) => FILES[p.replaceAll('\\', '/')] ?? null, state: (key) => (key === K ? STATE : null),
    planned: (rel) => rel === 'templates/product.alternate.json',
  });
  const kit = (args) => `node .claude/kit/shopify.mjs ${args}`;
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
  const file = (tool, p) => ({ tool_name: tool, tool_input: { file_path: join(ROOT, p) }, cwd: ROOT });
  const msys = (p) => `/${ROOT[0].toLowerCase()}${ROOT.slice(2).replaceAll('\\', '/')}/${p}`;
  const OUT = resolve(ROOT, '..', 'kit-selftest-elsewhere').replaceAll('\\', '/');
  const cases = [
    // allowed
    [bash(`node .claude/kit/shopify.mjs push ${K}`), null],
    [bash(`node .claude/kit/shopify.mjs fetch ${K} cart --find mnav`), null],
    [bash(`node .claude/kit/shopify.mjs verify ${K}`), null],
    [bash('curl -s https://example.com/cart.js'), null],
    [bash("cat > notes.md <<'EOF'\n| Draft looks old | A `curl` with `?preview_theme_id` gets live. |\nEOF"), null],
    [bash('node .claude/kit/shopify.mjs themes --name kit/'), null],
    [bash(`node "D:/repo/.claude/kit/shopify.mjs" check ${K}`), null],
    [bash('cd D:/work/shopify/my-theme && git status'), null],
    [bash('ls shopify-claude-kit'), null],
    [bash('cd shopify && ls'), null],
    [bash('echo "shopify"'), null],
    [bash('echo "theme update complete"'), null],
    [bash('git log --grep "theme update"'), null],
    [bash(`git push -u origin ${K}`), null],
    [bash(`git push -u origin ${K} 2>&1`), null],
    [bash(`git push -u origin ${K} > /dev/null 2>&1`), null],
    [bash('git push origin abc-123__dev'), null],
    [bash('git commit -m "abc-123__dev: add shopify USP block"'), null],
    [bash('git commit -m "fix shopify | theme update block"'), null],
    [bash("git commit -F - <<'EOF'\nfix: shopify theme section\nEOF"), null],
    [ps("git commit -m @'\nshopify theme push notes\n'@"), null],
    [bash(`git fetch origin && git switch -c ${K} origin/main`), null],
    [bash(`node .claude/kit/kit.mjs set ${K} base=$(git rev-parse origin/main)`), null],
    [bash('npm run build'), null, ctx(K, { build: 'tailwindcss -i assets/src/theme.css -o assets/theme.css.liquid' })],
    [bash('git log --oneline -5'), null],
    [bash(`node .claude/kit/shopify.mjs mutate ${K} x.graphql --dry-run`), null],
    [file('Edit', 'sections/usp-row.liquid'), null],
    [file('Write', `.claude/logs/${K}/brief.md`), null],
    [bash(`git fetch origin`), null],
    [bash('git ls-remote --heads origin'), null],
    [bash(`git pull --no-rebase origin ${K}`), null],
    [bash('cat .claude/shopify-kit.json'), null],
    [bash(`node .claude/kit/shopify.mjs delete-draft ${K} --dry-run`), null],
    // denied: Shopify CLI outside the wrapper
    [bash('shopify theme push --live'), 'deny'],
    [bash('shopify theme publish --theme 123'), 'deny'],
    [bash('npx @shopify/cli theme push -t 1'), 'deny'],
    [bash('npx shopify theme list'), 'deny'],
    [bash('pnpm dlx @shopify/cli@latest theme delete -t 1'), 'deny'],
    [bash('SHOPIFY_FLAG_LIVE=1 node build.js'), 'deny'],
    [bash('node node_modules/@shopify/cli/bin/run.js theme publish'), 'deny'],
    [bash('node -e "require(\'child_process\').execSync(\'shopify theme publish\')"'), 'deny'],
    [bash('node .claude/kit/shopify.mjs themes && shopify theme publish -t 1'), 'deny'],
    [bash('echo "<<EOF"\nshopify theme publish'), 'deny'],
    [bash("cat > d.sh <<'EOF'\nshopify theme publish\nEOF\nbash d.sh"), 'deny'],
    [ps('& shopify theme push -t 123'), 'deny'],
    [ps('& "C:\\Users\\x\\AppData\\Roaming\\npm\\shopify.cmd" theme delete -t 1'), 'deny'],
    [ps('cmd /c "shopify theme publish"'), 'deny'],
    [ps("Start-Process shopify -ArgumentList 'theme','publish'"), 'deny'],
    [ps('$env:SHOPIFY_FLAG_ALLOW_LIVE = "1"; node x.js'), 'deny'],
    [bash('theme deploy --env=production'), 'deny'],
    [bash('npm run deploy'), 'deny', ctx(K, { deploy: 'shopify theme push --live --allow-live' })],
    [bash('yarn dev'), 'deny', ctx(K, { dev: 'theme open & npm run watch', watch: 'theme watch' })],
    // denied: git
    [bash('git push origin main'), 'deny'],
    [bash('git push origin HEAD:main'), 'deny'],
    [bash('git push -u origin HEAD'), 'deny'],
    [bash('git push -u origin head'), 'deny'],
    [bash('git push -u origin Main'), 'deny'],
    [bash('git push -u origin "$(git rev-parse --abbrev-ref HEAD)"'), 'deny'],
    [bash('B=main; git push -u origin $B'), 'deny'],
    [ps('$b = "main"; git push -u origin $b'), 'deny'],
    [bash(`git push -f origin ${K}`), 'deny'],
    [bash(`git push --force-with-lease origin ${K}`), 'deny'],
    [bash('git push'), 'deny'],
    [bash(`git push origin +${K}`), 'deny'],
    [bash('git push --all origin'), 'deny'],
    [bash(`git push origin --delete ${K}`), 'deny'],
    [bash(`git push -u origin ${K}-kit-test`), 'deny'],
    [bash(`git push -u origin ${K}-KIT-TEST`), 'deny'],
    [bash('git -C . push origin master'), 'deny'],
    [bash('bash -c "git push origin main"'), 'deny'],
    [ps('cmd /c "git push origin main"'), 'deny'],
    [ps("Start-Process git -ArgumentList 'push','origin','main'"), 'deny'],
    [bash('git commit -m "x"'), 'deny', ctx('main')],
    [bash('git switch main && git commit -m "x"'), 'deny'],
    [bash(`git checkout main && git merge ${K}`), 'deny'],
    [bash(`git merge ${K}`), 'deny', ctx('master')],
    [bash('gh pr merge 21 --squash'), 'deny'],
    // denied: other routes to a protected branch (a ref written another way, an alias, a script, gh)
    [bash('git push -u origin heads/main'), 'deny'],
    [bash('git push origin refs/heads/main'), 'deny'],
    [bash('git push origin Heads/MAIN'), 'deny'],
    [bash('git push origin origin/main'), 'deny'],
    [bash('git push origin refs/remotes/origin/main'), 'deny'],
    [bash('git push origin refs/tags/v1'), 'deny'],
    [bash('git config alias.pm "push origin main"'), 'deny'],
    [bash('git config --global alias.pm "push origin main"'), 'deny'],
    [bash('git push origin @'), 'deny'],
    [bash('git config remote.origin.push refs/heads/ABC-123:refs/heads/main'), 'deny'],
    [bash('gh -R owner/repo pr merge 3'), 'deny'],
    [bash('gh api -X PUT repos/owner/repo/pulls/3/merge'), 'deny'],
    [bash('gh api -X PATCH repos/owner/repo/git/refs/heads/main -f sha=abc'), 'deny'],
    // allowed: the same words used harmlessly
    [bash(`git push -u origin refs/heads/${K}`), null],
    [bash('git push origin feature/team-x'), null],
    [bash('git config user.name "Dev"'), null],
    [bash('git config --get alias.co'), null],
    [bash('gh pr create --title "Add USP row" --body "merge after review"'), null],
    [bash('gh pr view 3'), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "git push failed on main"`), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "docs say shopify theme push; cat .env; git push -u; -c is not needed"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} qa --note "28 criteria, state.json untouched"`), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "$(cat .env)"`), 'deny'],
    [bash(`echo ok; node .claude/kit/kit.mjs note ${K} --note x; cat .env`), 'deny'],
    // Gate 2 approves the plan and the store writes in it: the dev sees the words the kit will record as theirs
    [bash(`node .claude/kit/kit.mjs done ${K} approve --answer "Approve"`), 'ask'],
    [bash(`node .claude/kit/kit.mjs done ${K} approve --answer "Approve" 2>&1`), 'ask'],
    [bash(`bash -c "node .claude/kit/kit.mjs done ${K} approve --answer x"`), 'ask'],
    [bash(`node .claude/kit/kit.mjs done ${K} clarify --answer "Mobile menu; seed all"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} accept --answer "Accept"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} build`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} qa --note "28 criteria"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} accept`), null],
    [bash(`node .claude/kit/kit.mjs status ${K}`), null],
    [bash('curl -sL "https://x.myshopify.com/?preview_theme_id=1" -o d.html'), 'deny'],
    [ps('Invoke-WebRequest "https://x.com/cart?preview_theme_id=1"'), 'deny'],
    // denied: secrets and state through the shell
    [bash('cat .claude/.env.local'), 'deny'],
    [ps('Get-Content .env'), 'deny'],
    [bash('cat config.yml'), 'deny'],
    [bash(`echo '{}' > .claude/logs/${K}/state.json`), 'deny'],
    [bash(`node -e "require('fs').writeFileSync('.claude/logs/${K}/state.json','{}')"`), 'deny'],
    // denied: files
    [file('Write', `.claude/logs/${K}/state.json`), 'deny'],
    [file('Edit', '.claude/.env.local'), 'deny'],
    [file('Write', '.env'), 'deny'],
    [file('Write', 'config.yml'), 'deny'],
    [bash('cat "$APPDATA/shopify-cli-kit-nodejs/Config/config.json"'), 'deny'],
    [ps('Get-Content ~/.config/shopify-cli-store-nodejs/config.json'), 'deny'],
    [bash('cat ~/.claude/.env'), 'deny'],
    // denied: the guard's seal
    [file('Write', `.claude/logs/${K}/guard-seal.json`), 'deny'],
    [bash(`echo '{}' > .claude/logs/${K}/guard-seal.json`), 'deny'],
    // denied: mutations the wrapper won't run, or that could change between the prompt and the run
    [bash(kit(`mutate ${K} ${M}/real.gql ${M}/ok.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/product-delete.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/alias.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/two-ops.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/in-string.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/fragment.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/del-other.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/del-by-comment.graphql`)), 'deny'],
    [bash(kit(`mutate ${K} ${M}/missing.graphql`)), 'deny'],
    [bash(`${kit(`mutate ${K} a.graphql --dry-run`)} && ${kit(`mutate ${K} ${M}/ok.graphql`)}`), 'deny'],
    [bash(`cp other.graphql ${M}/ok.graphql && ${kit(`mutate ${K} ${M}/ok.graphql`)}`), 'deny'],
    [bash(`cd .claude/kit && node shopify.mjs mutate ${K} ${M}/ok.graphql`), 'deny'],
    [bash(`true & ${kit(`mutate ${K} ${M}/ok.graphql`)}`), 'deny'],
    [bash(kit(`mutate ${K} $F`)), 'deny'],
    // ask
    [bash(kit(`mutate ${K} ${M}/ok.graphql --vars ${M}/ok.vars.json`)), 'ask'],
    [bash(`${kit(`mutate ${K} ${M}/ok.graphql`)} 2>&1`), 'ask'],
    [bash(kit(`mutate ${K} ${M}/x--dry-run.graphql`)), 'ask'],
    [bash(kit(`mutate ${K} ${M}/del-own.graphql`)), 'ask'],
    [bash(`node .claude/kit/./shopify.mjs mutate ${K} ${M}/ok.graphql`), 'ask'],
    [bash(`bash -c "${kit(`mutate ${K} ${M}/ok.graphql`)}"`), 'ask'],
    [bash(`node -e "require('child_process').execSync('node .claude/kit/shopify.mjs mutate ${K} x.graphql')"`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs delete-draft ${K}`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs delete-draft ${K} --dry-run-x`), 'ask'],
    [bash(kit(`push ${K} --reconciled templates/product.json`)), 'ask'],
    [bash(kit(`verify ${K} --reconciled templates/product.json`)), 'ask'],
    [bash('git fetch https://example.invalid/some-text'), null],
    [bash('git ls-remote https://example.invalid/x'), null],
    [bash('git fetch origin --upload-pack=x'), 'ask'],
    [bash('git ls-remote --exec=x https://example.invalid/x'), 'ask'],
    [file('Edit', 'templates/product.alternate.json'), null],
    [bash('git -c core.sshCommand=x fetch origin'), 'ask'],
    [file('Write', CONFIG_REL), 'ask'],
    [bash(`echo '{}' > ${CONFIG_REL}`), 'ask'],
    [bash(`node -e "require('fs').writeFileSync('${CONFIG_REL}','{}')"`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs future-verb ${K}`), 'ask'],
    [bash('git reset --hard origin/main'), 'ask'],
    [bash('git clean -fd'), 'ask'],
    [bash('git clean --force -d'), 'ask'],
    [bash('git checkout -- sections/x.liquid'), 'ask'],
    [bash('git checkout sections/header.liquid'), 'ask'],
    [bash(`git switch -C ${K} origin/main`), 'ask'],
    [bash('git branch -f feature HEAD'), 'ask'],
    [file('Edit', 'templates/product.json'), 'ask'],
    [file('Edit', 'sections/header-group.json'), 'ask'],
    [file('Write', 'config/settings_data.json'), 'ask'],
    [file('Edit', '.claude/hooks/guard.mjs'), 'ask'],
    [file('Edit', '.claude/settings.json'), 'ask'],
    [file('Edit', '.claude/rules/kit-runs.md'), 'ask'],
    // the kit's master repo: kit files are the work, the guard's own wiring still asks
    [file('Edit', '.claude/kit/kit.mjs'), null, ctx(K, {}, true)],
    [file('Edit', '.claude/skills/shopify-qa/SKILL.md'), null, ctx(K, {}, true)],
    [file('Edit', '.claude/hooks/guard.mjs'), 'ask', ctx(K, {}, true)],
    [file('Edit', '.claude/settings.json'), 'ask', ctx(K, {}, true)],
    [file('Write', `.claude/logs/${K}/state.json`), 'deny', ctx(K, {}, true)],
    // another repository: this repo's protected branch doesn't apply; pushes are checked wherever they run
    [bash(`cd ${OUT} && git init -q && git commit -qm x`), null, ctx('main')],
    [bash(`git -C ${OUT} commit -qm x`), null, ctx('main')],
    [{ tool_name: 'Bash', tool_input: { command: 'git commit -qm x' }, cwd: OUT }, null, ctx('main')],
    [bash('cd .claude && git commit -m x'), 'deny', ctx('main')],
    [bash('cd "$D" && git commit -m x'), 'deny', ctx('main')],
    [bash(`cd ${OUT} && cd ${ROOT.replaceAll('\\', '/')} && git commit -m x`), 'deny', ctx('main')],
    [bash(`cd ${OUT} && git push origin main`), 'deny'],
  ];
  if (process.platform === 'win32') cases.push([{ tool_name: 'Write', tool_input: { file_path: msys(`.claude/logs/${K}/state.json`) }, cwd: ROOT }, 'deny']);
  let failed = 0;
  for (const [input, expected, c] of cases) {
    const got = decide(input, c || ctx())?.decision ?? null;
    if (got !== expected) {
      failed++;
      console.log(`FAIL  expected ${expected ?? 'allow'}, got ${got ?? 'allow'}: ${input.tool_name} ${JSON.stringify(input.tool_input.command || input.tool_input.file_path)}`);
    }
  }
  // The seal carries what the dev was shown, in the form the wrapper compares.
  const checks = [
    [decide(bash(kit(`mutate ${K} ${M}/ok.graphql --vars ${M}/ok.vars.json`)), ctx()).seal?.sha === sealDigest(FILES[`${M}/ok.graphql`], FILES[`${M}/ok.vars.json`]), 'mutate seal holds the digest of file + variables'],
    [decide(bash(kit(`delete-draft ${K}`)), ctx()).seal?.themeId === 5, 'delete-draft seal holds the theme id shown'],
    [/store:.*→.*b\.myshopify\.com.*the store every kit command acts on/.test(decide({ tool_name: 'Write', tool_input: { file_path: join(ROOT, CONFIG_REL), content: '{"store":"b.myshopify.com","baseBranch":"main"}' }, cwd: ROOT }, ctx()).reason), 'config prompt names the changed setting'],
    // permission modes that hide the prompt: an ask must become a deny, never a silent allow
    ...['bypassPermissions', 'plan', 'dontAsk', 'someFutureMode'].map((m) => [enforceMode({ decision: 'ask', reason: 'Run it?' }, { permission_mode: m }).decision === 'deny', `an ask becomes a deny in mode ${m}`]),
    ...['default', 'auto', 'acceptEdits', undefined].map((m) => [enforceMode({ decision: 'ask', reason: 'Run it?' }, { permission_mode: m }).decision === 'ask', `an ask stays an ask in mode ${m ?? '(no mode field)'}`]),
    [enforceMode({ decision: 'deny', reason: 'No.' }, { permission_mode: 'bypassPermissions' }).reason === 'No.', 'a deny keeps its own reason in bypass mode'],
    [enforceMode(null, { permission_mode: 'bypassPermissions' }) === null, 'an allowed command stays allowed in bypass mode'],
    [enforceMode(null, { permission_mode: 'bypassPermissions', tool_input: { command: 'node .claude/hooks/guard.mjs --mode-probe' } })?.decision === 'deny', 'the mode probe is refused in bypass mode'],
    [enforceMode(null, { permission_mode: 'default', tool_input: { command: 'node .claude/hooks/guard.mjs --mode-probe' } }) === null, 'the mode probe passes in default mode'],
    [enforceMode(decide(bash(kit(`mutate ${K} ${M}/ok.graphql --vars ${M}/ok.vars.json`)), ctx()), { permission_mode: 'bypassPermissions' }).seal === undefined, 'a mutation blocked by mode leaves no seal behind'],
  ];
  for (const [ok, what] of checks) if (!ok) { failed++; console.log(`FAIL  ${what}`); }
  cases.push(...checks);
  console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
// Reaching this line means the hook let the call through, so the session's permission mode shows the kit's prompts.
else if (process.argv.includes('--mode-probe')) console.log('ok: this session\'s permission mode shows the kit\'s confirmation prompts.');
else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch {
      // Exit 2 blocks the call: input the guard can't read is input it can't vouch for.
      process.stderr.write('Kit guard: unreadable hook input; blocked to be safe.\n');
      process.exit(2);
    }
    try {
      const result = enforceMode(decide(input), input);
      logBlock(input, result);
      if (result?.seal) writeSeal(result.seal);
      emit(result);
    } catch (e) {
      // Fail closed only where a wrong allow could reach the store or a protected branch.
      const text = JSON.stringify(input.tool_input || {});
      if (/shopify|git\s+push|\btheme\s/i.test(text)) emit({ decision: 'deny', reason: `Kit guard error (${e.message}); blocked to be safe.` });
      process.exit(0);
    }
  });
}
