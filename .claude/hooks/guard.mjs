#!/usr/bin/env node
// PreToolUse guard for the Shopify kit. A seatbelt against a well-meaning agent's realistic mistakes (calling the
// Shopify CLI directly, pushing to main, hand-editing task state, reading secrets), not a security boundary and not a
// defence against an agent hiding a command on purpose: GitHub branch protection and store staff permissions are the
// real limits. Three tiers: ask only for what's hard to undo, deny with a pointer where there's an alternative, log the rest.
// Flow: Claude Code sends the tool call as JSON on stdin → decide() → enforceMode() → emit() allow, ask or deny.
// Self-test: node .claude/hooks/guard.mjs --selftest · Mode check: node .claude/hooks/guard.mjs --mode-probe
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
// The wrapper's own argv parser and mutation check: the guard must read a command exactly as the wrapper will run it.
import { parseArgs, mutationProblems, sealDigest, SEAL_FILE, TEST_SUFFIX, MERCHANT_JSON, protectedBranches as branchesFrom } from '../kit/lib.mjs';
// The shell reader and the rules both kits share: kit/guard-core.mjs, generated from shared/ in the kit repo.
import {
  stripMessageBodies, segments, stripRedirects, program, redirects, substitutes, realPath, gitCommand, cdArg, dirAfter, innerCommand, onlyReadsText,
  WRITE_VERBS, scriptProblem, shellWrites, isGlob, searchesSecrets, pushRouting, discardsWork, checkPush as checkPushCore,
  tagPush, ghMerges, textFromFile, ghRunsWorkflow, ghReleases, runsShopifyCli, repoGit, WRAPPER_PATH, CLI_WORD, CLI_PATH, cliPackage, envFileIn, secretText, dumpsEnv,
  ENV_DUMP_WHY, CLI_LOGIN, SECRET_VAR, SECRET_READ, SECRET_PATH, redact, logPath, enforceMode, emit, scriptDir, userSettings, pushIn, runGuard,
  scriptRun, runCodeDecision, RUN_CODE_TOOL, claudeGlobReachesSecret, secretFiles,
} from '../kit/guard-core.mjs';

// ── Rules: patterns, verb lists and messages ──

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_ROOT = realPath(ROOT);
// The kit's master repo: its installers and tests sit beside .claude/, and the installer (which writes the manifest) never
// ran here. The guard denies writing or deleting the manifest, so a theme repo can't turn this on.
const MASTER = ['install.mjs', 'app/install.mjs', 'test/e2e.mjs'].every((f) => existsSync(join(ROOT, f))) && !existsSync(join(ROOT, '.claude', '.kit-manifest.json'));

const USE_WRAPPER = 'Shopify CLI calls go through the kit: node .claude/kit/shopify.mjs <verb> (run it with --help for the verbs). '
  + 'If the wrapper has no verb for what you need, ask the dev to run the command themselves with the ! prefix. '
  + 'If you only mentioned "shopify" in text, use the Grep tool or rephrase.';
const CLI_PKG = cliPackage('cli|theme|app|create-app');
// Writing to or publishing over the live theme has no protection on Shopify's side, so these words are blocked whatever
// runs them (a script's argument list, a helper). Not --live: the wrapper's read-only fetch uses it.
// --allow-mutations lets store execute write anything (themePublish included), past the wrapper and its seal.
const LIVE_THEME = /\btheme\b[\s'",\]]+(publish|push|delete)\b|--allow-live\b|--allow-mutations\b/i;
const THEMEKIT = /^theme(\.exe)?\s+(deploy|watch|open|replace|upload|remove|download|get|new|configure|publish|update)\b/;
// Theme Kit's config.yml holds a password. (.env files, a .claude/ pattern that reaches .env.local and the Shopify CLI's
// login folders are envFileIn, claudeGlobReachesSecret and CLI_LOGIN in the shared core.)
// Only at the repo root, where Theme Kit keeps it: .circleci/config.yml is CI settings.
const CONFIG_YML = /(^|[\s'"=:])(\.[\\/])?config\.yml(?=$|[\s'"`;&|)])/i;
const STATE_FILE = /logs[\\/][^\\/\s'"]+[\\/]state\.json/i;
// The seal: only the guard writes it (checked by path; reading it is fine).
const SEAL = /guard-seal/i;
// Direct Admin API calls with a token skip the wrapper, its store check and the seal.
const ADMIN_HTTP = /X-Shopify-Access-Token|\/admin\/api\/(\d{4}-\d{2}|unstable)\//i;
// Files that can switch the guard or git's safety off: settings.local.json can disable hooks, .mcp.json adds servers,
// .git/config can hold an alias or a push refspec, .git/hooks run on commit. Writing them asks (.git/info/exclude doesn't).
const GUARD_OFF = /^(\.claude\/[^/]+\.json|\.mcp\.json|\.git\/(config$|hooks(\/|$))|\.git$)/i;
// Files that run on their own later (a workflow, a git hook, npm's shell): real tickets edit them, so they're allowed and logged.
const RUNS_LATER = /^(\.github\/|\.husky\/|\.githooks\/|\.npmrc$|\.yarnrc(\.yml)?$|\.gitattributes$|Makefile$)/i;
// Files the agent might run later, or that run on their own: the guard reads what they will do when they're written.
const SCRIPT_FILE = /\.(sh|bash|ps1|psm1|bat|cmd|[cm]?[jt]sx?|py|rb|ya?ml)$|(^|[\\/])(\.husky|\.githooks)[\\/]|(^|[\\/])Makefile$/i;
const CONFIG_REL = '.claude/shopify-kit.json';
// What each setting controls, named in the prompt when it changes.
const CONFIG_KEYS = {
  store: 'the store every kit command acts on', storefrontUrl: 'the site fetch and compare request', jiraBaseUrl: 'where jira.mjs sends the Jira token',
  baseBranch: 'a branch the guard protects', protectedBranches: 'the branches the guard protects', adminApi: 'whether the kit uses the Admin API',
  draftRoute: 'how the draft theme is made', chromeWithoutAsking: 'admin steps the agent does in your Chrome without asking each time',
};
// The settings whose change asks: which store, which branches are protected, where the token goes, what runs unasked.
// The rest (draftRoute, adminApi, patterns) are logged: the wrapper's own-draft check holds whatever they say.
const SAFETY_KEYS = new Set(['store', 'baseBranch', 'protectedBranches', 'jiraBaseUrl', 'chromeWithoutAsking']);
const STORE_VERBS = new Set(['mutate', 'delete-draft']);
// Wrapper verbs that run without asking. Anything else, including verbs added later, asks the dev.
const SAFE_VERBS = new Set(['cli-check', 'auth-check', 'query', 'pull-live', 'check', 'draft', 'push', 'preview', 'fetch', 'verify', 'help', '--help']);
// Without the cookie the redirect sets, ?preview_theme_id silently serves the live theme.
const FETCHERS = /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(\.exe)?$/i;
// Kit files a theme repo gets from the installer; edits belong in the kit's own repo.
const KIT_FILE = /^\.claude\/(settings\.json|CLAUDE\.md|VERSION|hooks\/|kit\/|commands\/|agents\/|skills\/|rules\/)/i;
// In the master repo only the guard's own wiring asks.
// lib.mjs (theme) and core.mjs/repo.mjs (app) hold checks the guards import: mutation rules, protected branches.
const GUARD_WIRING = /^(\.claude|app\/\.claude)\/(settings\.json|hooks\/|kit\/(guard-core|lib|core|repo)\.mjs)|^shared\/guard-core\.mjs$/i;

// ── Repo context ──
// Read fresh on every call; the self-test swaps these for fakes through ctx.

function protectedBranches() {
  try { return branchesFrom(JSON.parse(readFileSync(join(ROOT, '.claude', 'shopify-kit.json'), 'utf8'))); } catch { return branchesFrom(null); }
}

/** The scripts of the package.json in dir (cd web && npm run x, npm --prefix web …), else the repo root's. */
function packageScripts(dir) {
  for (const d of [dir, ROOT]) {
    try { if (d) return JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).scripts || {}; } catch { /* none there: the root's */ }
  }
  return {};
}

const outsideRepo = (dir) => { const rel = relative(ROOT, dir); return rel.startsWith('..') || isAbsolute(rel); };

// ── git push, npm scripts and gh merges ──

/** Why this git push is refused, or null for the one allowed form: git push -u origin <task-branch>. A test run's branch is never pushed. */
const checkPush = (args, prot) => checkPushCore(args, prot, (ref) => (ref.toLowerCase().endsWith(TEST_SUFFIX)
  ? `"${ref}" belongs to a test run of the kit, which is never pushed. The draft gets the files through shopify.mjs push; handoff skips the push.` : null));

/** True if a package script's body runs the Shopify CLI or Theme Kit. */
function scriptRunsCli(body) {
  const masked = body.replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  return CLI_WORD.test(masked) || CLI_PATH.test(masked) || CLI_PKG.test(masked) || LIVE_THEME.test(masked)
    || segments(masked).some((s) => THEMEKIT.test(s.replace(/^&\s*/, '')) || runsShopifyCli(s));
}

// ── Kit wrapper calls, gates and config ──

/** A wrapper call in one segment, with its arguments parsed the way the wrapper parses them. */
function wrapperCall(segment) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^node(\.exe)?$/i.test(w[i] || '') || !/(^|[\\/])shopify\.mjs$/i.test(w[i + 1] || '')) return null;
  return parseArgs(w.slice(i + 2));
}

/** Read-only verbs pass; mutate and delete-draft ask and seal what the dev saw; any other verb asks. */
function wrapperDecision(segs, ctx) {
  for (const seg of segs) {
    const call = wrapperCall(seg);
    if (!call) {
      // node -e, node options, another script or runtime: the guard can't read the arguments.
      const { w, i } = program(seg);
      // Also the flags that ask on a plain call: adopting a theme, picking one by id, reconciled live edits.
      if (/^(node|bun|deno|tsx|npx)(\.exe|\.cmd)?$/i.test(w[i] || '') && /shopify\.mjs/i.test(seg) && /\b(mutate|delete-draft)\b|--(adopt|theme|reconciled)\b/.test(seg)) {
        return { decision: 'ask', reason: `This runs a kit verb that changes the store or picks a theme, in a way the guard can't read. Run it as node .claude/kit/shopify.mjs <verb> … instead, or allow it as is? (${seg.slice(0, 300)})` };
      }
      continue;
    }
    const verb = call._[0];
    if (['push', 'verify'].includes(verb) && call.flags.reconciled !== undefined) {
      return { decision: 'ask', reason: `The dev confirms that live's admin edits to ${call.flags.reconciled} (merchant JSON) are already in the task branch. The draft, and live after the merge, get the branch's version. Allow?` };
    }
    // Taking over an existing theme could be a teammate's draft: every later push overwrites its files.
    if (verb === 'draft' && (call.flags.adopt || call.flags.theme !== undefined)) {
      return { decision: 'ask', reason: `Use an existing theme as ${call._[1] ?? 'this task'}'s draft${call.flags.theme !== undefined ? ` (theme ${call.flags.theme})` : ''}? Later pushes overwrite its files, so check it isn't a teammate's draft. (${seg.trim()})` };
    }
    if (!verb || SAFE_VERBS.has(verb)) continue;
    // The whole command, so a prompt for the verb can't hide what else runs with it.
    if (!STORE_VERBS.has(verb)) return { decision: 'ask', reason: `The kit command "${verb}" isn't on the read-only list. Allow it? (${segs.join(' ; ').slice(0, 300)})` };
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

/**
 * kit.mjs set <KEY> draft.themeId=N: every later push goes to that theme, so the dev confirms it's this task's.
 * Gate answers (done <KEY> approve --answer …) pass: the skill asked the dev, and state.json records the answer.
 */
function themePickDecision(segs) {
  for (const seg of segs) {
    const { w, i } = program(stripRedirects(seg));
    if (!/^node(\.exe)?$/i.test(w[i] || '') || !/(^|[\\/])kit\.mjs$/i.test(w[i + 1] || '')) {
      // node --no-warnings kit.mjs set … draft.themeId=: the guard can't read which theme, and every push goes there.
      if (/kit\.mjs/i.test(seg) && /(draft\.themeId|baseTheme)=/.test(seg)) {
        return { decision: 'ask', reason: `This picks the draft theme in a form the guard can't read. Run it as node .claude/kit/kit.mjs set <KEY> draft.themeId=<id> so you see the id, or allow it as is? (${seg.slice(0, 300)})` };
      }
      continue;
    }
    const call = parseArgs(w.slice(i + 2));
    const themeId = call._[0] === 'set' && call._.find((a) => /^draft\.themeId=/.test(a));
    if (themeId) return { decision: 'ask', reason: `Record theme ${themeId.split('=')[1]} as ${call._[1]}'s draft? Every later push writes to it, so check it isn't a teammate's draft.` };
    // baseTheme replaces live as what the drift check protects, so a wrong id would let a merchant's live edits through.
    const baseTheme = call._[0] === 'set' && call._.find((a) => /^baseTheme=/.test(a));
    if (baseTheme) return { decision: 'ask', reason: `Use theme ${baseTheme.split('=')[1]} instead of live as ${call._[1]}'s base theme (the theme that follows the base branch, when live is a campaign theme)? The drift check, the draft copy and QA's comparison then use it, so check it's the right one.` };
  }
  return null;
}

/** A change to shopify-kit.json asks, naming which settings change and what each controls. */
function configChange(ti, ctx) {
  const before = ctx.read(CONFIG_REL);
  let after = null;
  if (typeof ti.content === 'string') after = ti.content;
  else if (before !== null && typeof ti.old_string === 'string') {
    after = ti.replace_all ? before.split(ti.old_string).join(ti.new_string) : before.replace(ti.old_string, () => ti.new_string);
  }
  // Unreadable settings leave the guard protecting only main and master, whatever baseBranch says.
  if (typeof after === 'string') {
    try { JSON.parse(after); } catch { return { decision: 'deny', reason: `That would leave ${CONFIG_REL} unreadable (not valid JSON), and the guard would then protect only main and master. Write valid JSON.` }; }
  }
  let lines = null;
  let safety = true; // unknown counts as a safety change
  try {
    const a = JSON.parse(before ?? '{}');
    const b = JSON.parse(after);
    const short = (v) => (v === undefined ? '(unset)' : JSON.stringify(v).slice(0, 80));
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    safety = changed.some((k) => SAFETY_KEYS.has(k));
    lines = changed.map((k) => `- ${k}: ${short(a[k])} → ${short(b[k])}${CONFIG_KEYS[k] ? ` (${CONFIG_KEYS[k]})` : ''}`);
  } catch { /* unreadable: say so */ }
  if (!safety) return { decision: 'log', reason: `settings changed in ${CONFIG_REL}: ${lines.join(' ').slice(0, 160) || 'none'}` };
  return { decision: 'ask', reason: `This changes the kit's settings for this repo (${CONFIG_REL}):\n${lines ? lines.join('\n') || '- no setting changes' : '- the guard couldn\'t tell which settings change'}\nAllow it?` };
}

// ── Bash and PowerShell ──

/**
 * Inner bash -c commands first, then the denies (CLI, secrets, state, seal, branches, pushes), then the asks
 * (wrapper verbs, gates, config writes, git that discards work). A deny returns at once; an ask or a log is held and
 * returned only when no later rule denies, so a prompt never stands in for a command the guard would refuse.
 */
function decideCommand(raw, ctx, depth = 0, cwd = null) {
  const cmd = stripMessageBodies(raw);
  const segs = segments(cmd);
  const prot = ctx.protected();
  let held = null;
  let note = null;
  // The first ask is kept, but one that must stay refused in bypass mode wins over a soft one.
  const hold = (r) => { if (r?.decision === 'ask') { if (!held || (held.soft && !r.soft)) held = r; } else if (r?.decision === 'log') note ||= r; };

  for (const seg of segs) {
    const inner = depth < 2 ? innerCommand(seg) : null;
    if (inner) {
      const r = decideCommand(inner, ctx, depth + 1, cwd);
      if (r?.decision === 'deny') return r;
      hold(r);
    }
  }

  // Commit and tag messages, PR and issue text, and the text a kit.mjs call records (notes, gate answers) are text;
  // everything else is scanned. A $( or a backtick in that text runs something, and a redirect writes a file: those stay scanned.
  const isText = (s) => {
    if (substitutes(s) || redirects(s) || textFromFile(s)) return false;
    if (['commit', 'tag'].includes(gitCommand(s)?.sub)) return true;
    const { w, i } = program(stripRedirects(s));
    if (/^gh(\.exe)?$/i.test(w[i] || '') && /^(pr|issue)$/.test(w[i + 1] || '') && /^(create|edit|comment)$/.test(w[i + 2] || '')) return true;
    return /^node(\.exe)?$/i.test(w[i] || '') && /(^|[\\/])\.claude[\\/]kit[\\/]kit\.mjs$/i.test(w[i + 1] || '');
  };
  const live = segs.filter((s) => !isText(s));
  const scanned = live.join(' ; ').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  // grep "shopify theme push" docs/ and echo "…" run nothing: the CLI's words count only where something could run them.
  // Reading the CLI's own files (cd into its folder, ls or find there, its path in a variable) runs nothing, but only
  // when every segment only reads; node or npx on a path in there is still a CLI call (runsShopifyCli below).
  const filters = (s) => {
    const { w, i } = program(stripRedirects(s));
    const p = w[i] || '';
    return !substitutes(s) && (/^(head|tail|sort|uniq|wc|cut|cat|ls|dir)(\.exe)?$/i.test(p)
      || (/^find(\.exe)?$/i.test(p) && !w.slice(i + 1).some((a) => /^-(exec|execdir|delete|ok|okdir|fprint\w*)$/.test(a))));
  };
  const assignOnly = (s) => /^\s*[A-Za-z_]\w*=("[^"]*"|'[^']*'|\S*)\s*$/.test(stripRedirects(s));
  const readsOnly = live.every((s) => onlyReadsText(s) || cdArg(s) || filters(s) || assignOnly(s));
  const runnable = live.filter((s) => !onlyReadsText(s)).join(' ; ').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  // Only for the CLI check: the reads still count for the seal, state and manifest checks below.
  const cliRunnable = live.filter((s) => !onlyReadsText(s) && !(readsOnly && (cdArg(s) || filters(s) || assignOnly(s)))).join(' ; ').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  // The CLI's words where something runs them. Its package name or a path into its folder alone is reading
  // (node -e reading a file there, CLI=$(npm root -g)/@shopify/cli); running it is runsShopifyCli below.
  if (CLI_WORD.test(cliRunnable) || CLI_PATH.test(cliRunnable) || LIVE_THEME.test(cliRunnable)) return { decision: 'deny', reason: USE_WRAPPER };
  if (segs.some((s) => { const { w, i } = program(s); return THEMEKIT.test(w.slice(i).join(' ')); })) {
    return { decision: 'deny', reason: 'Theme Kit (the "theme" command) can deploy to live themes. Use node .claude/kit/shopify.mjs, or ask the dev to run it.' };
  }
  // The CLI as the program itself, whatever follows it: npx shopify version, a full path to shopify.cmd.
  if (segs.some(runsShopifyCli)) return { decision: 'deny', reason: USE_WRAPPER };
  // node on a file inside the CLI's own package (…/@shopify/cli/bin/run.js) runs it too.
  if (segs.some((s) => CLI_PKG.test(scriptRun(s) || ''))) return { decision: 'deny', reason: USE_WRAPPER };
  // A listing (ls .claude/*) and a search's pattern read no secret; the rest of the command is checked for one.
  const secrets = secretText(live);
  const unquoted = secrets.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  if (envFileIn(secrets) || CONFIG_YML.test(secrets) || claudeGlobReachesSecret(unquoted) || CLI_LOGIN.test(secrets) || SECRET_VAR.test(scanned)) {
    return { decision: 'deny', reason: 'Credential files (.env*, .claude/.env.local, Theme Kit config.yml, the Shopify CLI\'s shopify-cli-* folders) and tokens are never read or written by Claude. jira.mjs --check reports whether Jira credentials are set; shopify.mjs auth-check reports the Shopify logins.' };
  }
  // env | cut -d= -f1 prints the variables' names, not their values.
  const namesOnly = /\b(env|printenv)(\.exe)?\s*\|\s*cut\s+-d\s*['"]?=['"]?\s*-f\s*1\b/.test(cmd);
  if (segs.some((s) => dumpsEnv(s) && !(namesOnly && /^\s*(env|printenv)(\.exe)?\s*$/.test(s))) || SECRET_READ.test(secrets)) return { decision: 'deny', reason: ENV_DUMP_WHY };
  if (ADMIN_HTTP.test(scanned)) return { decision: 'deny', reason: 'Admin API calls go through node .claude/kit/shopify.mjs query or mutate, which reach only the configured store and show every write to the dev first.' };
  // Where the command writes or deletes ('?': an inline script or git apply, whose targets the guard can't name).
  const writes = shellWrites(segs, cwd, ROOT);
  // By name only for an inline script's write; reads (cat, git diff) are fine and named targets are checked by path below.
  // No kit.mjs exemption: real kit.mjs calls are already out of `scanned` (isText), and a bare mention must not unlock a write.
  if (writes.includes('?') && STATE_FILE.test(scanned)) {
    return { decision: 'deny', reason: 'Task state goes through node .claude/kit/kit.mjs: status --json to read it; set, done, back to change it.' };
  }
  // Only when a fetcher is the program run: prose that mentions curl (commit messages, heredoc text) stays allowed.
  // Not a *.shopifypreview.com link: its host already picks the theme.
  if (segs.some((s) => { const { w, i } = program(stripRedirects(s)); return FETCHERS.test(w[i] || '') && /preview_theme_id/i.test(s) && !/\.shopifypreview\.com\b/i.test(s); })) {
    return { decision: 'deny', reason: 'A plain request with ?preview_theme_id can be served the live theme without any error. Use node .claude/kit/shopify.mjs fetch <KEY> <path> [--find TEXT]: it keeps the preview cookie and checks which theme rendered the page.' };
  }

  // Walk the segments in order: "git switch main && git commit" commits on main. A cd or git -C into
  // another repository leaves this repo's branch behind; a folder the guard can't resolve counts as this repo.
  // The branch is read only when a command needs it.
  let branch;
  let dir = cwd ? dirAfter(cwd, null) : ROOT;
  for (const seg of segs) {
    const cd = cdArg(seg);
    if (cd) { dir = dirAfter(cd.arg, dir); continue; }
    // npm run x, npm --silent run x, npm test, node --run x, npm install's lifecycle scripts, each with its pre/post-script.
    const p = scriptProblem(seg, ctx.scripts(scriptDir(seg, dir)), scriptRunsCli);
    if (p) return { decision: 'deny', reason: `The package script "${p.name}" runs the Shopify CLI or Theme Kit ("${p.body}"). Use node .claude/kit/shopify.mjs, or ask the dev to run the script.` };
    // bash deploy.sh, node scripts/ship.mjs: a script file is read when it runs (writing one is only logged). Not the kit's own.
    const ran = !ctx.master() && scriptRun(seg);
    const ranAt = ran && dirAfter(ran, dir ?? ROOT);
    const ranRel = ranAt && relative(ROOT, ranAt).replaceAll('\\', '/');
    if (ranRel && !/^\.claude\/(kit|hooks)\//i.test(ranRel) && scriptRunsCli(ctx.read(ranRel) ?? '')) {
      return { decision: 'deny', reason: `${ranRel} runs the Shopify CLI or Theme Kit. Use node .claude/kit/shopify.mjs, or ask the dev to run the script.` };
    }
    // A deny, not a prompt: the Grep tool does the same search without the token, so the agent just switches.
    const { w, i } = program(stripRedirects(seg));
    // Only where a secret file really is (vetevo's Theme Kit config.yml, a .claude/.env.local) and the search doesn't skip it.
    if (searchesSecrets(w, i, ROOT, dir, segs, ctx.secrets())) {
      return { decision: 'deny', reason: 'This recursive search would read a secret file that exists here (a root .env or Theme Kit config.yml, .claude/.env.local, or ~/.claude/.env). Use the Grep tool (it skips git-ignored files), search a theme folder such as sections/, or add --include=<glob>, or --exclude=\'.env*\' --exclude=config.yml --exclude-dir=.claude.' };
    }

    const g = gitCommand(seg);
    if (!g) continue;
    const c = g.globals.indexOf('-C');
    const at = c === -1 ? dir : dirAfter(g.globals[c + 1], dir);
    const here = at === null || !outsideRepo(at);
    if (here && (g.sub === 'switch' || g.sub === 'checkout') && !g.args.includes('--')) {
      const create = g.args.findIndex((a) => ['-c', '-C', '-b', '-B', '--create', '--force-create'].includes(a));
      const target = create !== -1 ? g.args[create + 1] : g.args.find((a) => !a.startsWith('-'));
      // git switch - (or @{-1}) returns to a branch the guard can't see: unknown, so a commit or merge after it asks.
      if (g.args.some((a) => a === '-' || /^@\{-\d+\}$/.test(a))) branch = null;
      else if (target && !(g.sub === 'checkout' && ctx.isPath(target))) branch = target.replace(/^origin\//, '');
    }
    // A push refspec or push.default the repo already has is read (pushRouting): the agent wouldn't know about it.
    if (g.sub === 'push') {
      const why = checkPush(g.args, prot) || (here ? pushRouting(g.args, ctx.gitConfig) || tagPush(g.args, ctx.isTag) : null);
      if (why) return { decision: 'deny', reason: why };
    }
    // git pull origin X on main merges X into main; pulling the checked-out branch's own name only updates it.
    const pulled = g.sub === 'pull' ? g.args.filter((a) => !a.startsWith('-')).slice(1) : [];
    if (here && (['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(g.sub) || pulled.length)) {
      if (branch === undefined) branch = ctx.branch();
      if (pulled.length && (branch === null || pulled.every((b) => b.toLowerCase() === branch.toLowerCase()))) { /* its own upstream, or unknown */ }
      else if (branch === null) hold({ decision: 'ask', reason: `The guard couldn't read which branch is checked out, so it can't tell whether this ${g.sub} lands on a protected branch (${prot.join(', ')}). Allow it?` });
      else if (prot.some((b) => b.toLowerCase() === String(branch).toLowerCase())) {
        return { decision: 'deny', reason: `That runs on "${branch}", which is protected. Switch to the task branch first (the build stage creates it).` };
      }
    }
    // A secret staged by git add -f (which the allowlist lets run) would leave with the next push.
    if (here && g.sub === 'commit') {
      const secret = ctx.staged().find((s) => SECRET_PATH.test(s));
      if (secret) return { decision: 'deny', reason: `${secret} is staged, and it holds secrets. Unstage it (git restore --staged ${secret}) before committing.` };
    }
  }

  // gh takes global flags before the subcommand (gh -R owner/repo pr merge), and the API can merge or move a ref.
  if (segs.some(ghMerges)) return { decision: 'deny', reason: 'Merging, syncing a branch or committing through the GitHub API is the dev\'s step after handoff, not the agent\'s.' };
  if (segs.some(ghRunsWorkflow)) return { decision: 'deny', reason: 'Starting a GitHub workflow (often a deploy pipeline) is the dev\'s step, not the agent\'s.' };
  if (segs.some(ghReleases)) return { decision: 'deny', reason: 'Releases and deployments often start a deploy pipeline: they are the dev\'s step, not the agent\'s.' };

  // Where the command writes or deletes, after any cd: task state and the seal are kit-only, settings that turn the guard
  // off and kit files ask, files that run later are logged.
  let later = null;
  for (const p of writes) {
    if (p === '?') continue;
    if (userSettings(p)) hold({ decision: 'ask', reason: `This writes your own Claude Code settings (${p}), which can turn hooks off or allow any command in every project. Allow it?` });
    const rel = relative(REAL_ROOT, realPath(p)).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (/^\.claude\/logs\/[^/]+\/state\.json$/i.test(rel) || SEAL.test(rel)) return { decision: 'deny', reason: 'Task state and the guard\'s seal are written only by the kit.' };
    // rm -rf .claude/logs/<KEY>: its state.json holds the ids of the store objects the task created, which cleanup needs.
    // Soft: in bypass mode it passes and is logged (a test-run restart moves the folder on purpose).
    if (/^\.claude\/logs$/i.test(rel) || (/^\.claude\/logs\/[^/]+$/i.test(rel) && ctx.state(basename(rel)))) {
      hold({ decision: 'ask', soft: true, reason: `This removes or replaces ${rel}, which holds task state and the ids of the store objects each task created (cleanup deletes by them). It's git-ignored, so it can't be restored. Allow it?` });
    }
    // A pattern (guard-seal.jso?, .claude/*) could reach any of those: name the file instead.
    // Inside a named subfolder of a task (logs/<KEY>/abtest/*.md, video/scenes/*.mp4) a pattern can't reach state.json or
    // the seal, which sit one level up; intake itself copies A/B code there.
    const inTaskSubfolder = /^\.claude\/logs\/[^/*?[\]]+\/[^/*?[\]]+\//i.test(rel);
    if (isGlob(rel) && /^\.claude\//i.test(rel) && !inTaskSubfolder) return { decision: 'deny', reason: `${rel} is a pattern inside .claude/, which could reach task state, the seal or the kit. Name the file.` };
    // rm -rf .claude/hooks names a folder: test it as one too.
    const asDir = `${rel}/`;
    const kitFile = /^\.claude\/?$/i.test(rel) || (ctx.master() ? [rel, asDir].some((r) => GUARD_WIRING.test(r)) : [rel, asDir].some((r) => KIT_FILE.test(r)));
    // The guard's own wiring, git's and Claude Code's settings and the kit's settings stay asked in every mode; another kit
    // file (a skill, a command) is soft: the installer overwrites it on the next update.
    const wiring = ctx.master() || GUARD_OFF.test(rel) || rel.toLowerCase() === CONFIG_REL || /^\.claude\/?$/i.test(rel) || [rel, asDir].some((r) => /^\.claude\/(settings\.json|hooks\/)/i.test(r));
    if (kitFile || GUARD_OFF.test(rel) || rel.toLowerCase() === CONFIG_REL) {
      hold({ decision: 'ask', ...(wiring ? {} : { soft: true }), reason: `This writes or removes ${rel}, which changes the kit, its settings, or what git or Claude Code allow (a hook, an alias, a permission). Allow it? (${cmd.slice(0, 200)})` });
    }
    if (RUNS_LATER.test(rel)) later = rel;
  }
  if (/shopify-kit\.json/i.test(scanned) && (/>\s*["']?[^\s;&|]*shopify-kit\.json/i.test(scanned) || /\b(writeFileSync|Set-Content|Out-File|Add-Content|tee|cp|mv|Copy-Item|Move-Item|rm|Remove-Item|del)\b|\bsed\s+-i/i.test(scanned))) {
    hold({ decision: 'ask', reason: `This command may change ${CONFIG_REL}, which sets the store the kit acts on, the branches the guard protects and where the Jira token goes. Allow it? (${cmd.slice(0, 300)})` });
  }

  const kit = wrapperDecision(segs, ctx);
  if (kit?.decision === 'deny') return kit;
  hold(kit);
  hold(themePickDecision(segs));

  // A secret staged by git add -f is caught at the commit (the staged-secret check above), whatever staged it.
  let at = cwd ? dirAfter(cwd, null) : ROOT;
  for (const seg of segs) {
    const cd = cdArg(seg);
    if (cd) { at = dirAfter(cd.arg, at); continue; }
    const g = gitCommand(seg);
    if (!g) continue;
    // Only when there is something to lose: a stash or a branch always; otherwise uncommitted changes in what it overwrites
    // (git checkout <sha> -- a.liquid on a clean a.liquid loses nothing).
    const lost = discardsWork(g, ctx.isPath);
    if (lost === 'always' || (lost && ctx.dirty(lost === 'tree' ? [] : lost.paths, at))) hold({ decision: 'ask', reason: `This git command can discard uncommitted work: ${seg}` });
  }
  return held || note || (later ? { decision: 'log', reason: `wrote ${later}, which runs on its own later (a workflow, a git hook, npm's settings)` } : null);
}

// ── Edit and Write ──
// Only files inside the repo are checked; paths outside it are allowed.

function decideFile(ti, cwd, ctx) {
  const filePath = String(ti.file_path || ti.notebook_path || '');
  if (!filePath) return null;
  // Git Bash style /c/Users/... paths
  const native = filePath.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  const abs = isAbsolute(native) ? native : resolve(cwd || ROOT, native);
  // The real spelling: an 8.3 short name (ECHOLO~1) is the same file.
  const rel = relative(REAL_ROOT, realPath(abs)).replaceAll('\\', '/');
  const inRepo = rel && !rel.startsWith('..') && !isAbsolute(rel);
  const shown = inRepo ? rel : basename(abs);
  // A script written now runs later without the guard reading it again: read it here, wherever it goes.
  const content = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string) : [])]
    .filter((x) => typeof x === 'string').join('\n').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  // Logged, not asked: a ticket can legitimately add a deploy script. Only a note: every path rule below still applies
  // first (a kit file that mentions the CLI still asks), and the note is returned only when none does.
  const scriptNote = !ctx.master() && SCRIPT_FILE.test(abs) && (CLI_WORD.test(content) || CLI_PATH.test(content) || CLI_PKG.test(content) || LIVE_THEME.test(content) || /(^|[\s'"`(])theme(\.exe)?['"]?[\s,]+['"]?(deploy|replace|upload|publish)\b/.test(content))
    ? { decision: 'log', reason: `${shown} runs the Shopify CLI or Theme Kit when it's run` } : null;
  if (userSettings(abs)) return { decision: 'ask', reason: `This changes your own Claude Code settings (${abs}), which can turn hooks off or allow any command in every project. Allow it?` };
  if (!inRepo) return scriptNote;
  if (/^\.claude\/logs\/[^/]+\/state\.json$/i.test(rel)) return { decision: 'deny', reason: 'Task state changes go through node .claude/kit/kit.mjs (start, done, back, set).' };
  if (SEAL.test(rel)) return { decision: 'deny', reason: `Only the guard writes ${SEAL_FILE}.` };
  if (rel.toLowerCase() === CONFIG_REL) return configChange(ti, ctx);
  // .env.example and friends document the variables and hold no secrets.
  if (/^(\.claude\/\.env\.local|\.env(?!\.(example|sample|template|dist)$)(\.[^/]*)?|config\.yml)$/i.test(rel)) return { decision: 'deny', reason: 'Credential files are written by the dev, never by Claude.' };
  if (KIT_FILE.test(rel)) {
    // In the kit's master repo, editing the kit is the work; only the hook's own wiring still asks.
    // Soft, except the hook and its settings: a skill or command edited here is overwritten by the next update.
    if (!ctx.master()) return { decision: 'ask', ...(/^\.claude\/(settings\.json|hooks\/)/i.test(rel) ? {} : { soft: true }), reason: `This edits the kit itself (${rel}). Kit changes belong in the master copy so every repo gets them.` };
    if (GUARD_WIRING.test(rel)) return { decision: 'ask', reason: `This changes the guard that checks this session (${rel}). Allow it?` };
  }
  // The shared guard source and the app kit's guard, edited from a session at the master repo's root, where this guard runs.
  if (ctx.master() && GUARD_WIRING.test(rel)) return { decision: 'ask', reason: `This changes guard code a kit runs (${rel}). Allow it?` };
  if (GUARD_OFF.test(rel)) return { decision: 'ask', reason: `${rel} changes what git or Claude Code allow (an alias, a push refspec, a hook, a permission, a server). Allow it?` };
  // A workflow or git hook that publishes or pushes to a theme runs on the next push or commit, with no prompt then.
  if (RUNS_LATER.test(rel)) {
    if (LIVE_THEME.test(content)) return { decision: 'ask', reason: `${rel} runs on its own later (a workflow, a git hook) and pushes, publishes or deletes a theme. Publishing over live can't be undone. Allow it?` };
    const push = pushIn(content, (a) => checkPush(a, ctx.protected()));
    if (push) return { decision: 'ask', reason: `${rel} runs on its own later (a workflow, a git hook) and has a git push the guard would refuse here: ${push} Allow it?` };
    return { decision: 'log', reason: `${rel} runs on its own later (a workflow, a git hook, npm's settings)` };
  }
  // A file the approved plan names was already agreed at Gate 1.
  if (MERCHANT_JSON.test(rel) && !ctx.planned(rel)) {
    // Soft: done build lists files outside the plan and Gate 2 shows them.
    return { decision: 'ask', soft: true, reason: `${rel} is merchant-owned: Shopify writes admin edits into it (and syncs them into git). Edit it only if the approved plan says so.` };
  }
  return scriptNote;
}

// ── The decision ──
// decide() returns null (allow) or { decision, reason, seal?, gate? }. defaultCtx reads the real repo; the self-test passes fakes.

const git = repoGit(ROOT);
const defaultCtx = {
  protected: protectedBranches, branch: () => git.branch(), scripts: packageScripts, isPath: (p) => existsSync(join(ROOT, p)), master: () => MASTER,
  read: (p) => { try { return readFileSync(resolve(ROOT, p), 'utf8'); } catch { return null; } },
  state: (key) => { try { return JSON.parse(readFileSync(join(ROOT, '.claude', 'logs', key, 'state.json'), 'utf8')); } catch { return null; } },
  // Named in plan.md of an approved task whose branch is checked out.
  planned: (rel) => {
    try {
      const branch = git.branch();
      return readdirSync(join(ROOT, '.claude', 'logs')).some((k) => {
        const st = defaultCtx.state(k);
        return st?.gates?.approve && st.branch === branch && readFileSync(join(ROOT, '.claude', 'logs', k, 'plan.md'), 'utf8').includes(rel);
      });
    } catch { return false; }
  },
  gitConfig: (key) => git.config(key), staged: () => git.staged(), isTag: (name) => git.isTag(name),
  secrets: () => secretFiles(ROOT), dirty: (paths, dir) => git.dirty(paths, dir),
};

// The files kit-browser's run_code may run (it runs them in Node): the probe, and a task's design-audit file.
const RUN_CODE_FILES = /^\.claude\/kit\/probe\.init\.js$|^\.claude\/logs\/[^/]+\/design-audit-[\w-]+\.js$/i;

export function decide(input, ctx = defaultCtx) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return decideFile(ti, input.cwd, ctx);
  if (RUN_CODE_TOOL.test(tool)) return runCodeDecision(ti, input.cwd, ROOT, RUN_CODE_FILES);
  // Bash, PowerShell, Monitor, and any later tool that runs a command: all read the same way.
  if (typeof ti.command === 'string') return decideCommand(ti.command, ctx, 0, input.cwd || null);
  return null;
}

// ── Self-test ──
// cases: [tool input, expected decision]; checks: [condition, description]. Every rule and bypass gets one.

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
    'deploy.sh': 'shopify theme push --theme 1', 'scripts/ship.mjs': "spawnSync('shopify', ['theme', 'publish', '-t', '1'])", 'scripts/build.mjs': 'console.log(1)',
  };
  const STATE = { mutations: [{ ids: ['gid://shopify/MetafieldDefinition/7'] }], draft: { themeId: 5, name: K, route: 'cli' } };
  // Secret files present by default (.claude/.env.local and ~/.claude/.env), and every path dirty: the strict case.
  const SECRETS = [join(ROOT, '.claude', '.env.local'), join(homedir(), '.claude', '.env')];
  const ctx = (branch = K, scripts = {}, master = false, { gitConfig = {}, staged = [], secrets = SECRETS, dirty = () => true } = {}) => ({
    protected: () => ['main', 'master'], branch: () => branch, scripts: () => scripts, isPath: (p) => /[/\\]/.test(p) && /\.\w+$/.test(p), master: () => master,
    read: (p) => FILES[p.replaceAll('\\', '/')] ?? null, state: (key) => (key === K ? STATE : null),
    planned: (rel) => rel === 'templates/product.alternate.json',
    gitConfig: (k) => [].concat(gitConfig[k] ?? []), staged: () => staged, isTag: (n) => n === 'v1.2.0',
    secrets: () => secrets, dirty,
  });
  const kit = (args) => `node .claude/kit/shopify.mjs ${args}`;
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
  const file = (tool, p) => ({ tool_name: tool, tool_input: { file_path: join(ROOT, p) }, cwd: ROOT });
  const write = (p, content) => ({ tool_name: 'Write', tool_input: { file_path: join(ROOT, p), content }, cwd: ROOT });
  const msys = (p) => `/${ROOT[0].toLowerCase()}${ROOT.slice(2).replaceAll('\\', '/')}/${p}`;
  const OUT = resolve(ROOT, '..', 'kit-selftest-elsewhere').replaceAll('\\', '/');
  const cases = [
    // allowed
    [bash(`node .claude/kit/shopify.mjs push ${K}`), null],
    [bash(`node .claude/kit/shopify.mjs fetch ${K} cart --find mnav`), null],
    [bash(`node .claude/kit/shopify.mjs verify ${K}`), null],
    [bash('curl -s https://example.com/cart.js'), null],
    [bash("cat > notes.md <<'EOF'\n| Draft looks old | A `curl` with `?preview_theme_id` gets live. |\nEOF"), null],
    [bash(`node .claude/kit/shopify.mjs push ${K} --skip-ignored`), null], [bash(`node .claude/kit/shopify.mjs themes ${K}`), 'ask'],
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
    [bash(`git commit -m "$(cat <<'EOF'\nfix: never run shopify theme push; .env stays out\nEOF\n)"`), null],
    [ps("git commit -m @'\nshopify theme push notes\n'@"), null],
    [bash(`git fetch origin && git switch -c ${K} origin/main`), null],
    [bash(`node .claude/kit/kit.mjs set ${K} base=$(git rev-parse origin/main)`), null],
    // taking over an existing theme (maybe a teammate's draft) asks
    [bash(`node .claude/kit/shopify.mjs draft ${K}`), null],
    [bash(`node .claude/kit/shopify.mjs draft ${K} --adopt`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs draft ${K} --github --theme 5`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs draft ${K} --github`), null],
    [bash(`node .claude/kit/kit.mjs set ${K} draft.themeId=5 draft.route=manual`), 'ask'],
    [bash(`node .claude/kit/kit.mjs set ${K} draft.previewUrl=https://x`), null],
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
    [bash('shopify version'), 'deny'],
    [bash('npx @shopify/cli theme push -t 1'), 'deny'],
    [bash('npx shopify theme list'), 'deny'],
    [bash('pnpm dlx @shopify/cli@latest theme delete -t 1'), 'deny'],
    // a CLI flag in the environment of a script that doesn't run the CLI does nothing; the wrapper drops SHOPIFY_FLAG_*
    [bash('SHOPIFY_FLAG_LIVE=1 node build.js'), null],
    [bash('node node_modules/@shopify/cli/bin/run.js theme publish'), 'deny'],
    [bash('node -e "require(\'child_process\').execSync(\'shopify theme publish\')"'), 'deny'],
    [bash('node .claude/kit/shopify.mjs cli-check && shopify theme publish -t 1'), 'deny'],
    [bash('echo "<<EOF"\nshopify theme publish'), 'deny'],
    [bash("cat > d.sh <<'EOF'\nshopify theme publish\nEOF\nbash d.sh"), 'deny'],
    [ps('& shopify theme push -t 123'), 'deny'],
    [ps('& "C:\\Users\\x\\AppData\\Roaming\\npm\\shopify.cmd" theme delete -t 1'), 'deny'],
    [ps('cmd /c "shopify theme publish"'), 'deny'],
    // live-theme words, whatever runs them
    [bash(`python -c "import subprocess; subprocess.run(['shopify','theme','publish'])"`), 'deny'],
    [bash('x theme push -t 123 --allow-live'), 'deny'],
    [bash(`node .claude/kit/shopify.mjs fetch ${K} cart --live`), null],
    [bash(`git commit -m "docs: never run theme publish"`), null],
    [ps('$env:SHOPIFY_FLAG_ALLOW_LIVE = "1"; node x.js'), null],
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
    [bash('git push --tags origin'), 'deny'],
    [bash(`git push origin --delete ${K}`), 'deny'],
    [bash(`git push -u origin ${K}-kit-test`), 'deny'],
    [bash(`git push -u origin ${K}-KIT-TEST`), 'deny'],
    [bash('git -C . push origin master'), 'deny'],
    [bash('bash -c "git push origin main"'), 'deny'],
    [ps('cmd /c "git push origin main"'), 'deny'],
    [bash('git commit -m "x"'), 'deny', ctx('main')],
    [bash('git switch main && git commit -m "x"'), 'deny'],
    [bash(`git checkout main && git merge ${K}`), 'deny'],
    [bash(`git merge ${K}`), 'deny', ctx('master')],
    [bash('gh pr merge 21 --squash'), 'deny'],
    // the branch can't be read: a commit or merge asks instead of passing
    [bash('git commit -m x'), 'ask', ctx(null)], [bash(`git merge origin/${K}`), 'ask', ctx(null)], [bash('git status'), null, ctx(null)],
    [bash(`git switch ${K} && git commit -m x`), null, ctx(null)],
    // denied: other routes to a protected branch (a ref written another way, an alias, gh)
    [bash('git push -u origin heads/main'), 'deny'],
    [bash('git push origin refs/heads/main'), 'deny'],
    [bash('git push origin Heads/MAIN'), 'deny'],
    [bash('git push origin origin/main'), 'deny'],
    [bash('git push origin refs/remotes/origin/main'), 'deny'],
    [bash('git push origin refs/tags/v1'), 'deny'],
    [bash('git push origin @'), 'deny'],
    [bash('gh -R owner/repo pr merge 3'), 'deny'],
    [bash('gh api -X PUT repos/owner/repo/pulls/3/merge'), 'deny'],
    [bash('gh api -X PATCH repos/owner/repo/git/refs/heads/main -f sha=abc'), 'deny'],
    // tags and releases often start a deploy pipeline
    [bash('git push -u origin v1.2.0'), 'deny'], [bash('gh release create v1.2.0'), 'deny'], [bash('gh api -X POST repos/o/r/deployments -f ref=main'), 'deny'],
    [bash('gh release view v1.2.0'), null], [bash('gh api repos/o/r/releases'), null], [bash('git tag v1.2.0'), null],
    // allowed: the same words used harmlessly
    [bash(`git push -u origin refs/heads/${K}`), null],
    [bash('git push origin feature/team-x'), null],
    [bash('git config user.name "Dev"'), null],
    [bash('git config --get alias.co'), null],
    [bash('git config get alias.co'), null],
    [bash('git -c core.autocrlf=false diff'), null],
    // setting an alias, a push refspec or push.default takes intent: not the guard's job (a refspec the repo already has is read)
    [bash('git config alias.pm "push origin main"'), null], [bash(`git -c push.default=upstream push -u origin ${K}`), null],
    // work thrown away asks first
    [bash('git stash drop'), 'ask'], [bash('git stash clear'), 'ask'], [bash('git stash list'), null],
    [bash('gh pr create --title "Add USP row" --body "merge after review"'), null],
    [bash('gh pr create --title "USP row" --body "Adds a block. Run shopify theme push only via the kit; .env untouched."'), null],
    [bash('gh pr view 3'), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "git push failed on main"`), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "docs say shopify theme push; cat .env; git push -u; -c is not needed"`), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "cost: $5 per .env lookup"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} qa --note "28 criteria, state.json untouched"`), null],
    [bash(`node .claude/kit/kit.mjs note ${K} --note "$(cat .env)"`), 'deny'],
    [bash(`echo ok; node .claude/kit/kit.mjs note ${K} --note x; cat .env`), 'deny'],
    [bash('git commit -m "$(cat .env)"'), 'deny'],
    // Gates: the skill asks the dev; the guard doesn't ask a second time
    [bash(`node .claude/kit/kit.mjs done ${K} approve --answer "Approve"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} approve --answer "Approve" 2>&1`), null],
    [bash(`bash -c "node .claude/kit/kit.mjs done ${K} approve --answer x"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} accept --answer "Accept"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} conclude --answer "Answered"`), null],
    [bash(`node .claude/kit/kit.mjs done ${K} approve --answer "Approved: $50 threshold, the shopify theme push goes after review"`), null],
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
    // a mention of kit.mjs doesn't unlock a state write
    [bash(`echo '{}' > .claude/logs/${K}/state.json # .claude/kit/kit.mjs`), 'deny'],
    [bash(`node -e "require('fs').writeFileSync('.claude/logs/${K}/state.json','{}')" .claude/kit/kit.mjs`), 'deny'],
    [bash(`node .claude/kit/kit.mjs status ${K} && echo '{}' > .claude/logs/${K}/state.json`), 'deny'],
    // denied: files
    [file('Write', `.claude/logs/${K}/state.json`), 'deny'],
    [file('Edit', '.claude/.env.local'), 'deny'],
    [file('Write', '.env'), 'deny'],
    [file('Write', 'config.yml'), 'deny'],
    [bash('cat "$APPDATA/shopify-cli-kit-nodejs/Config/config.json"'), 'deny'],
    [ps('Get-Content ~/.config/shopify-cli-store-nodejs/config.json'), 'deny'],
    [bash('cat ~/.claude/.env'), 'deny'],
    // denied: the environment printed whole, or a secret variable
    ...['env', 'printenv', 'env | grep -i token', 'printenv JIRA_API_TOKEN', 'set', 'export -p', 'node -e "console.log(process.env)"', 'echo $DATABASE_URL']
      .map((c) => [bash(c), 'deny']),
    [ps('Get-ChildItem env:'), 'deny'], [ps('Get-ChildItem env:*'), 'deny'], [ps('Get-ChildItem env:JIRA_API_TOKEN'), 'deny'], [ps('Get-ChildItem env:PATH'), null], [bash('printenv PATH'), null], [bash('set -euo pipefail; npm test'), null],
    // setting a variable isn't printing them; `env FOO=1` alone still prints the environment
    ...['export PATH="$HOME/bin:$PATH"', 'export NODE_ENV=test && npm test', 'declare -x FOO=1'].map((c) => [bash(c), null]), [bash('env FOO=1'), 'deny'], [bash('node -e "console.log(Boolean(process.env.JIRA_API_TOKEN))"'), null],
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
    [file('Edit', 'templates/product.alternate.json'), null],
    [file('Write', CONFIG_REL), 'ask'],
    [bash(`echo '{}' > ${CONFIG_REL}`), 'ask'],
    [bash(`node -e "require('fs').writeFileSync('${CONFIG_REL}','{}')"`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs future-verb ${K}`), 'ask'],
    // an ask is held: a deny later in the same command still wins
    [bash(`node .claude/kit/shopify.mjs future-verb ${K} && cat .env`), 'deny'], [bash(`git reset --hard && git push origin main`), 'deny'],
    [bash('git reset --hard origin/main'), 'ask'],
    [bash('git clean -fd'), 'ask'],
    [bash('git clean --force -d'), 'ask'],
    [bash('git checkout -- sections/x.liquid'), 'ask'],
    [bash('git checkout sections/header.liquid'), 'ask'],
    [bash(`git switch -C ${K} origin/main`), 'ask'],
    [bash(`git switch -f ${K}`), 'ask'], [bash(`git checkout -f ${K}`), 'ask'], [bash(`git checkout --force ${K}`), 'ask'],
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
    // files the guards import ask in maintainer mode too
    [file('Edit', '.claude/kit/lib.mjs'), 'ask', ctx(K, {}, true)],
    [file('Edit', 'app/.claude/kit/core.mjs'), 'ask', ctx(K, {}, true)],
    [file('Edit', 'app/.claude/kit/repo.mjs'), 'ask', ctx(K, {}, true)],
    // text commands whose text comes from a file are scanned like any other command
    [bash('git commit -F .claude/.env.local'), 'deny'],
    [bash('git tag -a v1 -F .env'), 'deny'],
    [bash('gh pr create --body-file .claude/.env.local'), 'deny'],
    [bash('gh pr comment 5 --body-file ~/.claude/.env'), 'deny'],
    [bash(`gh pr create --draft --title "${K}" --body-file .claude/logs/${K}/pr.md`), null],
    [bash('git commit -m "Document the -F flag"'), null],
    // git and GitHub credentials
    [bash('gh auth token'), 'deny'],
    [bash('gh auth status --show-token'), 'deny'],
    [bash('gh auth status'), null],
    [bash('printf "protocol=https\\nhost=github.com\\n" | git credential fill'), 'deny'],
    [bash('cat ~/.git-credentials'), 'deny'],
    [bash('cat ~/AppData/Roaming/shopify*/Config/config.json'), 'deny'],
    // a branch changed without git push
    [bash('gh api -X PUT repos/o/r/contents/a.txt -f branch=main -f message=x'), 'deny'],
    [bash('gh api repos/o/r/contents/a.txt'), null],
    [bash('gh repo sync --branch main'), 'deny'],
    // a quiet push is still the one allowed form; the plugin's docs search is text, whatever its query says
    [bash(`git push -q -u origin ${K}`), null],
    [bash('node C:/Users/x/.claude/plugins/cache/claude-plugins-official/shopify-ai-toolkit/2.1.2/skills/shopify/scripts/search_docs.mjs "theme push --only flag"'), null],
    [bash('node scripts/search_docs.mjs && shopify theme push'), 'deny'],
    // reading the installed CLI's files runs nothing (also through a variable or node -e); running its bin or its words is a CLI call
    [bash('cd /c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli 2>/dev/null && grep -rln "default-app-home" dist | head -5'), null],
    [bash('cd /c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli && node bin/run.js theme publish -t 1'), 'deny'],
    [bash('node "/c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli/bin/run.js" version'), 'deny'],
    [bash('ls "/c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli"'), null],
    [bash('find "/c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli" -iname "*schema*"'), null],
    [bash('CLI=$(npm root -g)/@shopify/cli; ls $CLI; find $CLI -maxdepth 4 -iname "*schema*"'), null],
    [bash(`node -e "console.log(require('fs').readFileSync('C:/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli/package.json','utf8').length)"`), null],
    [bash(`node -e "for (const n of ['SHOPIFY_CLI_THEME_TOKEN']) console.log(n, Boolean(process.env[n]))"`), null],
    [bash('F="/c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli/dist/x.js"; grep -n theme "$F"'), null],
    [bash('node "/c/Users/x/AppData/Roaming/npm/node_modules/@shopify/cli/bin/run.js" theme list'), 'deny'],
    // a pattern inside a task's named subfolder can't reach state.json or the seal one level up
    [bash(`cp /d/x/*.md .claude/logs/${K}/abtest/`), null],
    [bash(`rm -f .claude/logs/${K}/video/scenes/*.mp4`), null],
    [bash(`rm -f .claude/logs/${K}/*.json`), 'deny'],
    // kit-browser's run_code: only the kit's own files, and inline code without Node's APIs
    [{ tool_name: 'mcp__kit-browser__browser_run_code_unsafe', tool_input: { filename: '.claude/kit/probe.init.js' }, cwd: ROOT }, null],
    [{ tool_name: 'mcp__kit-browser__browser_run_code_unsafe', tool_input: { filename: `.claude/logs/${K}/design-audit-desktop.js` }, cwd: ROOT }, null],
    [{ tool_name: 'mcp__kit-browser__browser_run_code_unsafe', tool_input: { filename: 'tmp/read-secrets.js' }, cwd: ROOT }, 'deny'],
    [{ tool_name: 'mcp__kit-browser__browser_run_code_unsafe', tool_input: { code: 'async (page) => require("fs").readFileSync(".claude/.env.local", "utf8")' } }, 'deny'],
    [{ tool_name: 'mcp__kit-browser__browser_run_code_unsafe', tool_input: { code: 'async (page) => page.evaluate(() => document.title)' } }, null],
    [file('Write', `.claude/logs/${K}/state.json`), 'deny', ctx(K, {}, true)],
    [bash('cp x .claude/kit/kit.mjs'), null, ctx(K, {}, true)], [bash('cp x .claude/hooks/guard.mjs'), 'ask', ctx(K, {}, true)],
    // another repository: this repo's protected branch doesn't apply; pushes are checked wherever they run
    // Paths quoted: a kit repo under a folder with spaces split the unquoted cd (POP-1150 kit note).
    [bash(`cd "${OUT}" && git init -q && git commit -qm x`), null, ctx('main')],
    [bash(`git -C "${OUT}" commit -qm x`), null, ctx('main')],
    [{ tool_name: 'Bash', tool_input: { command: 'git commit -qm x' }, cwd: OUT }, null, ctx('main')],
    [bash('cd .claude && git commit -m x'), 'deny', ctx('main')],
    [bash('cd "$D" && git commit -m x'), 'deny', ctx('main')],
    [bash(`cd "${OUT}" && cd "${ROOT.replaceAll('\\', '/')}" && git commit -m x`), 'deny', ctx('main')],
    [bash(`cd "${OUT}" && git push origin main`), 'deny'],
    // git behind a prefix, a backslash or a full path is still git
    ...['env git push origin main', 'time git push origin main', 'command git push origin main', '\\git push origin main', '/usr/bin/git push origin main',
      '"C:/Program Files/Git/cmd/git.exe" push origin main', 'env bash -c "git push origin main"', 'bash -lc "git push origin main"', 'timeout 10 git push origin main']
      .map((c) => [bash(c), 'deny']),
    [bash('env git commit -m x'), 'deny', ctx('main')],
    // a gate in a form the guard can't read as a plain call passes too; a redirect on a kit.mjs call is scanned
    [bash(`node --no-warnings .claude/kit/kit.mjs done ${K} approve --answer "Approve"`), null], [bash(`env node .claude/kit/kit.mjs done ${K} approve --answer "Approve"`), null],
    [bash(`node --no-warnings .claude/kit/kit.mjs set ${K} draft.themeId=9`), 'ask'],
    [bash(`node .claude/kit/kit.mjs set ${K} baseTheme=9`), 'ask'],
    [bash(`node --no-warnings .claude/kit/kit.mjs set ${K} baseTheme=9`), 'ask'],
    [bash(`node .claude/kit/kit.mjs set ${K} featurePrefix=x`), null],
    [bash(`node .claude/kit/kit.mjs status ${K} --json > .claude/logs/${K}/state.json`), 'deny'], [bash('node scripts/kit.mjs .env'), 'deny'],
    [bash(`node .claude/kit/kit.mjs status ${K} > status.txt`), null],
    // the master repo: the app kit's guard asks like this one's
    [file('Edit', 'app/.claude/hooks/guard.mjs'), 'ask', ctx(K, {}, true)], [file('Edit', 'app/.claude/kit/guard-core.mjs'), 'ask', ctx(K, {}, true)],
    [file('Edit', 'app/.claude/settings.json'), 'ask', ctx(K, {}, true)], [file('Edit', 'app/.claude/kit/app.mjs'), null, ctx(K, {}, true)],
    [file('Edit', 'shared/guard-core.mjs'), 'ask', ctx(K, {}, true)], [file('Edit', '.claude/kit/guard-core.mjs'), 'ask', ctx(K, {}, true)],
    // Monitor runs commands too
    [{ tool_name: 'Monitor', tool_input: { command: 'shopify theme publish -t 1' } }, 'deny'], [{ tool_name: 'Monitor', tool_input: { command: 'npm run build' } }, null],
    // pushes routed elsewhere by settings the repo already has: read at push time (setting them isn't checked)
    [bash(`git branch -u origin/main ${K}`), null],
    [bash(`git push -u origin ${K}`), 'deny', ctx(K, {}, false, { gitConfig: { 'push.default': 'upstream', [`branch.${K}.merge`]: 'refs/heads/main' } })],
    [bash(`git push -u origin ${K}`), 'deny', ctx(K, {}, false, { gitConfig: { 'remote.origin.push': `refs/heads/${K}:refs/heads/main` } })],
    [bash(`git push -u origin ${K}:${K}`), null, ctx(K, {}, false, { gitConfig: { 'push.default': 'upstream', [`branch.${K}.merge`]: 'refs/heads/main' } })],
    [bash(`git push -u origin ${K}`), null, ctx(K, {}, false, { gitConfig: { 'push.default': 'simple', [`branch.${K}.merge`]: 'refs/heads/main' } })],
    // secrets staged and committed; secrets behind globs, other names, the environment
    // a staged secret is refused at the commit, however it was staged (git add -f included)
    [bash('git add -f .claude'), null], [bash('git add -f assets/built.css'), null], [bash('git add -A'), null],
    [bash('git commit -m x'), 'deny', ctx(K, {}, false, { staged: ['sections/x.liquid', '.claude/.env.local'] })], [bash('git commit -m x'), 'deny', ctx(K, {}, false, { staged: ['config.yml'] })],
    ...['cat .env*', 'cat .claude/.env.loc*', 'cat .envrc', 'cat .claude/*', 'echo $JIRA_API_TOKEN', 'find . -name ".env*" -exec cat {} +'].map((c) => [bash(c), 'deny']),
    // a .claude/ pattern that can't reach .env.local; JIRA_BASE_URL from the environment reaches only an atlassian.net site
    ...['grep -l x .claude/*.json', 'ls .claude/logs/*', `JIRA_BASE_URL=https://evil.example node .claude/kit/jira.mjs ${K}`].map((c) => [bash(c), null]),
    [bash('grep -r JIRA_API_TOKEN .'), 'deny'], [bash('grep -rn hero sections/'), null],
    // a recursive search where no secret file exists, or one that skips them
    [bash('grep -rn hero .'), null, ctx(K, {}, false, { secrets: [] })],
    [bash('grep -rn hero --exclude-dir=.claude .'), null, ctx(K, {}, false, { secrets: [join(ROOT, '.claude', '.env.local')] })],
    [bash('grep -rn hero --exclude-dir=.claude .'), 'deny', ctx(K, {}, false, { secrets: [join(ROOT, 'config.yml')] })],
    [bash('grep -rn hero --exclude=config.yml --exclude-dir=.claude .'), null, ctx(K, {}, false, { secrets: [join(ROOT, 'config.yml'), join(ROOT, '.claude', '.env.local')] })],
    // recursive searches that reach .claude/.env.local or ~/.claude/.env; ones that can't
    ...['grep -rn JIRA .claude', 'grep -rn JIRA ./.claude', 'grep -rn JIRA ~/.claude', 'rg -uu JIRA .claude', 'grep -rn x ..', 'cd .claude && grep -rn JIRA .'].map((c) => [bash(c), 'deny']),
    [ps('Get-ChildItem -Recurse | Select-String JIRA'), 'deny'],
    // findstr does its own globbing: * and *.* match .env.local in every folder /s walks; *.liquid can't
    ...['findstr /s /i JIRA *', 'findstr /s /i JIRA *.*', 'findstr /s JIRA .claude\\*'].map((c) => [bash(c), 'deny']),
    ...['findstr /s /i hero *.liquid', 'findstr /i hero sections\\*'].map((c) => [bash(c), null]), [bash('cat .eslintrc*'), null],
    ...['cd sections && grep -rn hero .', 'grep -rn hero --include=*.liquid .', 'grep -rn x .claude/kit', 'rg -uu -g "*.liquid" hero', 'rg hero'].map((c) => [bash(c), null]),
    // false positives: a regex isn't a glob, a listing reads no file, a search's pattern names none, reads aren't writes
    ...['grep -n "done .*--answer" .claude/kit/kit.mjs', 'ls .claude/*', 'find . -name ".env*"', 'ls -la ~/AppData/Roaming/shopify-cli-kit-nodejs', 'grep -rn "\\.env" sections/',
      'grep -rn "@shopify/cli" .claude/skills', 'grep -rn "shopify theme push" .claude/skills', 'npm i -D @shopify/theme-check-node', "sed 's/.*//' notes.txt",
      `node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts)"`, "cat > notes.md <<'EOF'\nRun shopify theme push --live; cat .env\nEOF",
    ].map((c) => [bash(c), null]),
    // package scripts: pre/post and install-time scripts, flags before the name, other runners, one level of npm run inside
    ...['npm run build', 'npm install', 'npm test', 'npm -s run deploy', 'npm --prefix . run deploy', 'node --run deploy']
      .map((c) => [bash(c), 'deny', ctx(K, { deploy: 'shopify theme push --live', postbuild: 'shopify theme push', postinstall: 'npm run deploy', pretest: 'shopify theme publish' })]),
    // the Admin API with a token; workflows
    ...['curl -H "X-Shopify-Access-Token: x" https://s.myshopify.com/admin/api/2026-07/graphql.json', 'gh workflow run deploy.yml'].map((c) => [bash(c), 'deny']),
    // the wrapper behind node flags still asks for the flags that pick a theme
    ...[`node --no-warnings .claude/kit/shopify.mjs draft ${K} --adopt`, `node --no-warnings .claude/kit/shopify.mjs push ${K} --reconciled templates/product.json`].map((c) => [bash(c), 'ask']),
    // shell writes to kit files, settings and git (also into a folder, by -Path, by removing them); .git/info/exclude is free
    ...["echo '{\"disableAllHooks\":true}' > .claude/settings.local.json", "printf '[alias]' >> .git/config", 'cp x .claude/kit/shopify.mjs', 'cp settings.local.json .claude/',
      'rm .claude/settings.json', 'rm -rf .claude/hooks', 'mv .claude/settings.json s.bak']
      .map((c) => [bash(c), 'ask']),
    [bash('echo ".playwright-mcp/" >> .git/info/exclude'), null],
    [ps("Set-Content -Value '{}' -Path .claude/settings.local.json"), 'ask'], [ps('Remove-Item .claude\\settings.json'), 'ask'],
    [bash(`rm -rf .claude/logs/${K}/mutations`), null], [bash('rm -rf node_modules'), null],
    // files that run later are real ticket work: logged, not asked; a pattern inside .claude/ is refused
    [bash('echo x > .github/workflows/d.yml'), 'log'], [file('Write', '.github/workflows/deploy.yml'), 'log'], [bash('cp x .claude/logs/ABC-123/*.json'), 'deny'],
    [write('.github/workflows/deploy.yml', 'on: push\njobs: { d: { steps: [ { run: "npx @shopify/cli theme push --live --allow-live" } ] } }'), 'ask'],
    [write('.husky/pre-commit', 'shopify theme publish -t 1'), 'ask'], [write('.github/workflows/check.yml', 'run: npx @shopify/cli theme check'), 'log'],
    [bash('rm .claude/.kit-manifest.json'), 'ask'], [file('Write', '.claude/settings.local.json'), 'ask'], [file('Edit', '.git/config'), 'ask'], [file('Write', '.git/info/exclude'), null],
    [write('tools/sync.mjs', "execSync('shopify theme push --theme 123 --allow-live')"), 'log'],
    [write('assets/x.js', 'export const a = 1;'), null], [write('assets/blocks.js', '// Shopify app blocks render inside this wrapper'), null],
    // a log never ends the scan: a later deny or ask in the same command still counts
    [bash('bash -c "git add -f assets/a.css"; shopify theme publish -t 1'), 'deny'], [bash('git add -f assets/a.css && git clean -fdx'), 'ask'],
    [bash(`node .claude/kit/kit.mjs done ${K} accept --answer "Accept" && grep -rn token .`), 'deny'],
    [bash(`node .claude/kit/kit.mjs done ${K} accept --answer "Accept"; git reset --hard`), 'ask'],
    [write('.claude/hooks/guard.mjs', '// shopify theme push --theme 1'), 'ask'],
    // a data heredoc after cd or mkdir is still data; into a script it's still scanned
    [bash("mkdir -p docs && cat > docs/notes.md <<'EOF'\nRun shopify theme push --live; cat .env\nEOF"), null], [bash("cd docs; cat > notes.md <<'EOF'\nshopify theme publish\nEOF"), null],
    [bash("cd tools && cat > run.sh <<'EOF'\nshopify theme publish\nEOF"), 'deny'], [bash("mkdir -p d && cat > d/notes.md <<'EOF' && shopify theme publish\nx\nEOF"), 'deny'],
    // one secret printed by name; Boolean and !! only say it's set; a search or a commit message only names it
    ...['node -e "console.log(process.env.JIRA_API_TOKEN)"', 'node -p process.env', `python -c "import os; print(os.environ['JIRA_API_TOKEN'])"`, 'echo %JIRA_API_TOKEN%',
      `python3 -c "import os; print(os.getenv('SHOPIFY_CLI_THEME_TOKEN'))"`].map((c) => [bash(c), 'deny']),
    [ps("[Environment]::GetEnvironmentVariable('JIRA_API_TOKEN')"), 'deny'], [bash('node -e "console.log(!!process.env.JIRA_API_TOKEN)"'), null],
    [bash('grep -rn "process.env.JIRA_API_TOKEN" .claude/kit'), null], [bash('git commit -m "read process.env.JIRA_API_TOKEN once"'), null],
    // npm-run-all, run-s, run-p and concurrently inside a script are followed; a clean one runs
    [bash('npm run release'), 'deny', ctx(K, { release: 'run-s build deploy', deploy: 'shopify theme push --live' })],
    [bash('npm run all'), 'deny', ctx(K, { all: 'concurrently "npm run watch" "npm run deploy"', deploy: 'shopify theme push --live' })],
    [bash('npm run release'), null, ctx(K, { release: 'run-p build lint', build: 'tailwindcss -o a.css', lint: 'eslint .' })],
    // find -exec grep and excludes that don't name .env reach .claude/.env.local; narrowed ones don't
    ...['find . -type f -exec grep -n JIRA {} +', 'grep -rn JIRA --exclude-dir=.venv .', 'grep -rn JIRA --include=* .'].map((c) => [bash(c), 'deny']),
    ...['find sections -type f -exec grep -l hero {} +', 'find . -name "*.liquid" -exec grep -l hero {} +', "grep -rn JIRA --exclude='.env*' ."].map((c) => [bash(c), null]),
    // the logs folder holds each task's state and created ids: removing it asks; a folder without state doesn't
    ...['rm -rf .claude/logs', `rm -rf .claude/logs/${K}`, `mv .claude/logs/${K} ${K}.bak`, `Remove-Item -Recurse .claude/logs/${K}`].map((c) => [bash(c), 'ask']),
    [bash('rm -rf .claude/logs/OTHER-9'), null],
    // package scripts come from the package the command runs in
    ...['cd web && npm run build', 'npm --prefix web run build', 'npm run build --workspace=web'].map((c) => [bash(c), 'deny', { ...ctx(), scripts: (d) => (d && /[\\/]web$/.test(d) ? { build: 'shopify theme push' } : { build: 'vite build' }) }]),
    [bash('npm run build'), null, { ...ctx(), scripts: (d) => (d && /[\\/]web$/.test(d) ? { build: 'shopify theme push' } : { build: 'vite build' }) }],
    // a protected branch moved locally: branch -M/-C and update-ref ask, a pull of another branch on main is a merge
    ...[`git branch -M ${K} main`, `git branch -C ${K} main`, 'git update-ref refs/heads/main HEAD'].map((c) => [bash(c), 'ask']),
    [bash(`git switch main && git pull --no-rebase origin ${K}`), 'deny'], [bash('git pull origin main'), null, ctx('main')], [bash(`git pull --no-rebase origin ${K}`), null, ctx(null)],
    // the dev's own Claude Code settings
    [{ tool_name: 'Write', tool_input: { file_path: join(homedir(), '.claude', 'settings.json'), content: '{}' }, cwd: ROOT }, 'ask'],
    [bash("echo '{}' > ~/.claude/settings.local.json"), 'ask'], [bash('cat ~/.claude/settings.json'), null],
    // a git hook or workflow that pushes a protected branch runs later, unseen
    [write('.husky/pre-push', 'git push origin main'), 'ask'], [write('.github/workflows/sync.yml', 'jobs:\n  s:\n    steps:\n      - run: git push origin main'), 'ask'],
    [write('.husky/pre-push', 'npx lint-staged'), 'log'], [write('.github/workflows/pages.yml', '- run: git push origin gh-pages'), 'log'],
    // false positives: .env hygiene, dotenv searches, notes that name the seal, npm reads, reading state, CI config, code names
    ...['echo .env >> .gitignore', "printf '.env\\n' >> .gitignore", 'git check-ignore -v .env', 'git ls-files --error-unmatch .env', 'git rm --cached .env',
      'grep -rn "dotenv/config" sections/', 'npm ls @shopify/cli', 'npm view @shopify/cli version', `cat .claude/logs/${K}/state.json`, `git diff -- .claude/logs/${K}/state.json`,
      'cat .circleci/config.yml', 'cat src/.environment.ts', 'grep -n guard-seal .claude/kit/shopify.mjs', 'grep -n kit-manifest install.mjs'].map((c) => [bash(c), null]),
    ...['echo x > .env', 'echo x >> .claude/.env.local', 'cat ./config.yml', 'cat .env-local'].map((c) => [bash(c), 'deny']),
    // installing the CLI and reading the seal reach neither a secret nor the store; the seal is written only by the guard (by path)
    ...['npm i -g @shopify/cli@latest', 'cat .claude/logs/X/guard-seal.json'].map((c) => [bash(c), null]), [bash('echo x > .claude/logs/X/guard-seal.json'), 'deny'],
    [write(`.claude/logs/${K}/notes.md`, 'the guard-seal and the kit-manifest'), null],
    [bash('git commit -m x'), null, ctx(K, {}, false, { staged: ['.circleci/config.yml', 'src/.environment.ts'] })],
    [bash('git commit -m x'), 'deny', ctx(K, {}, false, { staged: ['.env.production'] })],
    // a script file is read when it runs: written earlier, it would otherwise run the CLI unseen
    ...['bash deploy.sh', './deploy.sh', 'sh -x deploy.sh', 'bash -e deploy.sh', 'node scripts/ship.mjs', 'cd scripts && node ship.mjs'].map((c) => [bash(c), 'deny']),
    ...['node scripts/build.mjs', 'bash missing.sh', 'bash -c "echo hi"'].map((c) => [bash(c), null]), [bash('bash deploy.sh'), null, ctx(K, {}, true)],
    [bash('node -e "spawnSync(\'npm\', [\'test\'], { env: { ...process.env, CI: 1 } })"'), null],
    [bash('curl -s https://x.myshopify.com/admin/api/unstable/graphql.json -d @q.json'), 'deny'],
    // the environment's names only; a preview link whose host picks the theme
    [bash('env | cut -d= -f1 | grep -i shop'), null], [bash('env | grep -i shop'), 'deny'],
    [bash('curl -sL "https://abc-1.shopifypreview.com/?preview_theme_id=1" -o p.html'), null],
    // a discard asks only when there is something to lose: a stash always, files only with uncommitted changes
    [bash('git checkout a82a9ba -- layout/theme.liquid'), null, ctx(K, {}, false, { dirty: () => false })],
    [bash('git checkout a82a9ba -- layout/theme.liquid'), 'ask', ctx(K, {}, false, { dirty: (p) => p.includes('layout/theme.liquid') })],
    [bash('git reset --hard'), null, ctx(K, {}, false, { dirty: () => false })], [bash('git stash drop'), 'ask', ctx(K, {}, false, { dirty: () => false })],
    // settings: a safety key asks, the rest is logged
    [write(CONFIG_REL, '{"store":"a.myshopify.com","baseBranch":"main","draftRoute":"github"}'), 'log'],
    [write(CONFIG_REL, '{"store":"a.myshopify.com","baseBranch":"develop"}'), 'ask'],
    // back to the previous branch: unknown to the guard, so what lands on it asks
    [bash('git checkout - && git merge feature/x'), 'ask'], [bash('git switch @{-1} && git commit -m x'), 'ask'],
    // settings the guard can't read would leave only main and master protected
    [write(CONFIG_REL, '{"store":"a.myshopify.com",'), 'deny'],
    // the dev's own browser servers aren't the kit's to restrict
    [{ tool_name: 'mcp__playwright__browser_run_code_unsafe', tool_input: { code: 'async () => require("fs").readFileSync("data.json", "utf8")' } }, null],
  ];
  if (process.platform === 'win32') {
    cases.push([{ tool_name: 'Write', tool_input: { file_path: msys(`.claude/logs/${K}/state.json`) }, cwd: ROOT }, 'deny']);
  }
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
    [/store:.*→.*b\.myshopify\.com.*the store every kit command acts on/.test(decide(write(CONFIG_REL, '{"store":"b.myshopify.com","baseBranch":"main"}'), ctx()).reason), 'config prompt names the changed setting'],
    [/chromeWithoutAsking:.*definitions.*without asking each time/.test(decide(write(CONFIG_REL, '{"store":"b.myshopify.com","baseBranch":"main","chromeWithoutAsking":["definitions"]}'), ctx()).reason), 'config prompt names a standing yes for Chrome steps'],
    [/echo hi/.test(decide(bash(`node .claude/kit/shopify.mjs future-verb ${K} && echo hi`), ctx()).reason), 'an unknown-verb prompt shows the whole command'],
    [logPath(join(ROOT, 'sections', 'x.liquid'), ROOT) === 'sections/x.liquid' && logPath('/elsewhere/x', ROOT) === '/elsewhere/x', 'the log shows repo files by their repo path'],
    // permission modes that hide the prompt: an ask must become a deny, never a silent allow
    ...['bypassPermissions', 'plan', 'dontAsk', 'someFutureMode'].map((m) => [enforceMode({ decision: 'ask', reason: 'Run it?' }, { permission_mode: m }).decision === 'deny', `an ask becomes a deny in mode ${m}`]),
    ...['default', 'auto', 'acceptEdits', undefined].map((m) => [enforceMode({ decision: 'ask', reason: 'Run it?' }, { permission_mode: m }).decision === 'ask', `an ask stays an ask in mode ${m ?? '(no mode field)'}`]),
    [enforceMode({ decision: 'deny', reason: 'No.' }, { permission_mode: 'bypassPermissions' }).reason === 'No.', 'a deny keeps its own reason in bypass mode'],
    [enforceMode(null, { permission_mode: 'bypassPermissions' }) === null, 'an allowed command stays allowed in bypass mode'],
    // bypass mode: a soft ask passes and is logged; one that reaches the store, the draft or the guard stays refused
    [enforceMode(decide(file('Write', 'templates/product.json'), ctx()), { permission_mode: 'bypassPermissions' }).decision === 'log', 'merchant JSON outside the plan passes in bypass mode (Gate 2 shows it)'],
    [enforceMode(decide(file('Edit', '.claude/skills/shopify-qa/SKILL.md'), ctx()), { permission_mode: 'bypassPermissions' }).decision === 'log', 'a kit skill edited in a theme repo passes in bypass mode'],
    [enforceMode(decide(file('Edit', '.claude/settings.json'), ctx()), { permission_mode: 'bypassPermissions' }).decision === 'deny', 'the hook\'s settings stay refused in bypass mode'],
    [enforceMode(decide(bash(kit(`delete-draft ${K}`)), ctx()), { permission_mode: 'bypassPermissions' }).decision === 'deny', 'deleting the draft stays refused in bypass mode'],
    [enforceMode(decide(bash(`rm -rf .claude/logs/${K}`), ctx()), { permission_mode: 'bypassPermissions' }).decision === 'log', 'moving a task\'s logs passes in bypass mode (a test-run restart)'],
    [enforceMode(null, { permission_mode: 'bypassPermissions', tool_input: { command: 'node .claude/hooks/guard.mjs --mode-probe' } })?.decision === 'deny', 'the mode probe is refused in bypass mode'],
    [enforceMode(null, { permission_mode: 'default', tool_input: { command: 'node .claude/hooks/guard.mjs --mode-probe' } }) === null, 'the mode probe passes in default mode'],
    [enforceMode(decide(bash(kit(`mutate ${K} ${M}/ok.graphql --vars ${M}/ok.vars.json`)), ctx()), { permission_mode: 'bypassPermissions' }).seal === undefined, 'a mutation blocked by mode leaves no seal behind'],
    [mutationProblems(`#\r${FILES[`${M}/ok.graphql`]}`, FILES[`${M}/ok.vars.json`]).length === 0, 'a lone CR ends a GraphQL comment, as servers read it'],
    // deletes: an identifier beside an owned id, escaped ids, metafieldsDelete on an owner the task didn't create
    [mutationProblems('mutation { a: metafieldDefinitionDelete(id: "gid://shopify/MetafieldDefinition/7") { deletedDefinitionId } b: metafieldDefinitionDelete(identifier: {ownerType: PRODUCT, namespace: "custom", key: "badge"}, deleteAllAssociatedMetafields: true) { deletedDefinitionId } }', '', ['gid://shopify/MetafieldDefinition/7']).length > 0, 'a delete by identifier is refused even beside an owned id'],
    [mutationProblems('mutation D($id: ID!) { metaobjectDelete(id: $id) { deletedId } }', '{"note":"gid://shopify/Metaobject/7","id":"gid:\\/\\/shopify\\/Metaobject\\/999"}', ['gid://shopify/Metaobject/7']).some((p) => /Metaobject\/999/.test(p)), 'an id escaped in the variables is read as Shopify reads it'],
    [mutationProblems('mutation { metaobjectDelete(id: "gid:\\/\\/shopify\\/Metaobject\\/999") { deletedId } }', '', ['gid://shopify/Metaobject/7']).some((p) => /Metaobject\/999/.test(p)), 'an id escaped in the file is read as Shopify reads it'],
    [mutationProblems('mutation { metafieldsDelete(metafields: [{ownerId: "gid://shopify/Shop/1", namespace: "custom", key: "announcement"}]) { deletedMetafields { key } } }', '', []).length > 0, 'metafieldsDelete on an owner this task didn\'t create is refused'],
    [mutationProblems('mutation { metafieldsDelete(metafields: [{ownerId: "gid://shopify/Metaobject/7", namespace: "custom", key: "k"}]) { deletedMetafields { key } } }', '', ['gid://shopify/Metaobject/7']).length === 0, 'metafieldsDelete on an owner this task created runs'],
    [mutationProblems('mutation D($o: ID!) { metafieldsDelete(metafields: [{ownerId: "gid://shopify/Metaobject/7", namespace: "c", key: "k"}, {ownerId: $o, namespace: "c", key: "k"}]) { deletedMetafields { key } } }', '{"o":"gid://shopify/Shop/1"}', ['gid://shopify/Metaobject/7']).some((p) => /ownerId: \$variable/.test(p)), 'metafieldsDelete refuses ownerId: $variable beside an owned literal'],
    [branchesFrom({ protectedBranches: 'release' }).includes('release'), 'protectedBranches as a string still protects that branch'],
    [decide(file('Edit', '.env.example'), ctx()) === null && decide(bash('cat .env.example'), ctx()) === null, '.env.example holds no secrets and stays open'],
    [!/ATATT3x|abc123|p4ss/.test(redact('curl -u me@x.com:ATATT3xF https://x; X_TOKEN=abc123 y; git clone https://u:p4ss@h/x')) && redact('git push origin main') === 'git push origin main', 'the guard log blanks tokens and keeps ordinary commands'],
    [!/ghp_abcdefghijk|hunter2|s3cret|pa ss/.test(redact('-H "Authorization: token ghp_abcdefghijklmnop" --password hunter2 {"api_token": "s3cret"} --user "me:pa ss"')), 'the guard log blanks GitHub tokens, --password, JSON tokens and quoted user:pass'],
  ];
  for (const [ok, what] of checks) if (!ok) { failed++; console.log(`FAIL  ${what}`); }
  const total = cases.length + checks.length;
  console.log(failed ? `${failed} of ${total} failed` : `all ${total} passed`);
  process.exit(failed ? 1 : 0);
}

// ── Hook entry ──

runGuard({
  decide, selftest, root: ROOT, label: 'Kit guard', branch: () => git.branch(), sealKey: 'key',
  // Fail closed where a wrong allow could reach the store, a protected branch, a secret, or the kit and its state.
  failClosed: { text: /shopify|git\s+push|\btheme\s|\.env|credential/i, file: /\.claude|\.git[\\/]|\.mcp\.json/i },
});
