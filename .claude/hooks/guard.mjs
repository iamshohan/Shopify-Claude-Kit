#!/usr/bin/env node
// PreToolUse guard for the Shopify kit. A seatbelt against realistic mistakes (calling the
// Shopify CLI directly, pushing to main, hand-editing task state, reading secrets), not a
// security boundary: GitHub branch protection and store staff permissions are the real limits.
// Self-test: node .claude/hooks/guard.mjs --selftest
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const SECRET_FILE = /(^|[\s'"=\\/])(\.env(\.[\w.-]+)?|config\.yml)(?=$|[\s'"`;&|)])/;
const STATE_FILE = /logs[\\/][^\\/\s'"]+[\\/]state\.json/i;
const MERCHANT_JSON = /^(templates\/.+\.json|sections\/[^/]+\.json|config\/settings_data\.json)$/i;
// Wrapper verbs that run without asking. Anything else, including verbs added later, asks the dev.
const SAFE_VERBS = new Set(['cli-check', 'auth-check', 'themes', 'query', 'pull-live', 'check', 'draft', 'push', 'preview', 'fetch', 'verify', 'help', '--help']);
// Without the cookie the redirect sets, ?preview_theme_id silently serves the live theme.
const FETCHERS = /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(\.exe)?$/i;
const NPM_BUILTINS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'init', 'create',
  'outdated', 'ls', 'list', 'view', 'info', 'audit', 'link', 'config', 'cache', 'why', 'pack', 'prune', 'dedupe', 'help', 'version', '-v', '--version']);

function protectedBranches() {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, '.claude', 'shopify-kit.json'), 'utf8'));
    return [...new Set(['main', 'master', cfg.baseBranch, ...(cfg.protectedBranches || [])].filter(Boolean))];
  } catch { return ['main', 'master']; }
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

/** Split on && || ; | and newlines, but not inside quotes. */
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

/** git's subcommand, skipping global options such as -C <dir> or -c key=value. */
function gitCommand(segment) {
  const { w, i: start } = program(stripRedirects(segment));
  let i = start;
  if (!/^git(\.exe)?$/i.test(w[i] || '')) return null;
  i++;
  while (i < w.length && w[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w[i]) ? 2 : 1;
  return { sub: w[i] || '', args: w.slice(i + 1) };
}

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
  const ref = pos[1].replace(/^refs\/heads\//, '');
  if (ref.toUpperCase() === 'HEAD' || /[:+*^~]/.test(ref)) return `Push the branch by name, not a refspec like HEAD:main or +branch. ${allowed}`;
  if (prot.some((p) => p.toLowerCase() === ref.toLowerCase())) return `"${ref}" is protected. It changes only through a reviewed PR that the dev merges.`;
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

function readKitFile(file) {
  try { return readFileSync(resolve(ROOT, file), 'utf8').slice(0, 1500); } catch { return '(file not found)'; }
}

function wrapperAsk(cmd) {
  for (const kit of cmd.matchAll(/\.claude[\\/]kit[\\/]shopify\.mjs["']?\s+([\w-]+)([^\n;&|]*)/gi)) {
    const [, verb, rest] = kit;
    if (SAFE_VERBS.has(verb) || /--dry-run/.test(rest)) continue;
    const w = words(rest);
    if (verb === 'mutate') {
      const query = w.find((x) => /\.graphql$/i.test(x));
      const vars = w.find((x) => /\.json$/i.test(x));
      return { decision: 'ask', reason: `Run this Admin GraphQL mutation on the store?\n${query || '(no file)'}\n---\n${query ? readKitFile(query) : ''}${vars ? `\n--- variables ${vars}\n${readKitFile(vars)}` : ''}` };
    }
    if (verb === 'delete-draft') {
      let draft = {};
      try { draft = JSON.parse(readFileSync(join(ROOT, '.claude', 'logs', String(w[0] || '').toUpperCase(), 'state.json'), 'utf8')).draft || {}; } catch { /* shown as unknown */ }
      return { decision: 'ask', reason: `Delete theme ${draft.themeId ?? '(unknown id)'} "${draft.name ?? '(unknown name)'}" (route ${draft.route ?? '?'}) from the store? This can't be undone.` };
    }
    return { decision: 'ask', reason: `The kit command "${verb}" isn't on the read-only list. Allow it? (${kit[0].trim()})` };
  }
  return null;
}

function decideCommand(raw, ctx, depth = 0) {
  const cmd = stripMessageBodies(raw);
  const segs = segments(cmd);
  const prot = ctx.protected();

  for (const seg of segs) {
    const inner = depth < 2 ? innerCommand(seg) : null;
    if (inner) {
      const r = decideCommand(inner, ctx, depth + 1);
      if (r) return r;
    }
  }

  // Commit and tag messages are text; everything else is scanned.
  const scanned = segs.filter((s) => !['commit', 'tag'].includes(gitCommand(s)?.sub)).join(' ; ').replace(WRAPPER_PATH, ' KIT_WRAPPER ');
  if (CLI_WORD.test(scanned) || CLI_PATH.test(scanned) || CLI_PKG.test(scanned)) return { decision: 'deny', reason: USE_WRAPPER };
  if (segs.some((s) => { const { w, i } = program(s); return THEMEKIT.test(w.slice(i).join(' ')); })) {
    return { decision: 'deny', reason: 'Theme Kit (the "theme" command) can deploy to live themes. Use node .claude/kit/shopify.mjs, or ask the dev to run it.' };
  }
  if (SECRET_FILE.test(scanned)) return { decision: 'deny', reason: 'Credential files (.env*, .claude/.env.local, Theme Kit config.yml) are never read or written by Claude. jira.mjs --check reports whether Jira credentials are set.' };
  if (STATE_FILE.test(scanned) && !/\.claude[\\/]kit[\\/]kit\.mjs/.test(scanned)) {
    return { decision: 'deny', reason: 'Task state goes through node .claude/kit/kit.mjs: status --json to read it; set, done, back to change it.' };
  }
  if (/Start-Process\b[^\n]*\bgit\b[^\n]*\bpush\b/i.test(cmd)) return { decision: 'deny', reason: 'Run git push directly so the guard can check it.' };
  // Only when a fetcher is the program run: prose that mentions curl (commit messages, heredoc text) stays allowed.
  if (segs.some((s) => { const { w, i } = program(stripRedirects(s)); return FETCHERS.test(w[i] || '') && /preview_theme_id/i.test(s); })) {
    return { decision: 'deny', reason: 'A plain request with ?preview_theme_id can be served the live theme without any error. Use node .claude/kit/shopify.mjs fetch <KEY> <path> [--find TEXT]: it keeps the preview cookie and checks which theme rendered the page.' };
  }

  // Walk the segments in order: "git switch main && git commit" commits on main.
  let branch = ctx.branch();
  for (const seg of segs) {
    const { w, i } = program(seg);
    const run = w[i] && /^(npm|pnpm|yarn|bun)(\.cmd)?$/.test(w[i]) ? w.slice(i + 1).filter((x) => x !== 'run' && x !== 'run-script')[0] : null;
    if (run && !NPM_BUILTINS.has(run)) {
      const body = scriptCallsCli(run, ctx.scripts());
      if (body) return { decision: 'deny', reason: `The package script "${run}" runs the Shopify CLI or Theme Kit ("${body}"). Use node .claude/kit/shopify.mjs, or ask the dev to run the script.` };
    }

    const g = gitCommand(seg);
    if (!g) continue;
    if (g.sub === 'switch' || g.sub === 'checkout') {
      if (!g.args.includes('--')) {
        const create = g.args.findIndex((a) => ['-c', '-C', '-b', '-B', '--create', '--force-create'].includes(a));
        const target = create !== -1 ? g.args[create + 1] : g.args.find((a) => !a.startsWith('-'));
        if (target && !(g.sub === 'checkout' && ctx.isPath(target))) branch = target.replace(/^origin\//, '');
      }
    }
    if (g.sub === 'push') {
      const why = checkPush(g.args, prot);
      if (why) return { decision: 'deny', reason: why };
    }
    if (['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am'].includes(g.sub) && prot.some((p) => p.toLowerCase() === String(branch).toLowerCase())) {
      return { decision: 'deny', reason: `That runs on "${branch}", which is protected. Switch to the task branch first (the build stage creates it).` };
    }
  }

  if (/(^|[\s;&|])gh\s+pr\s+merge\b/.test(cmd) || /(^|[\s;&|])gh\s+api\b[^\n]*\/merges?\b/.test(cmd)) {
    return { decision: 'deny', reason: 'Merging is the dev\'s step after handoff, not the agent\'s.' };
  }

  const ask = wrapperAsk(cmd);
  if (ask) return ask;

  for (const seg of segs) {
    const g = gitCommand(seg);
    if (!g) continue;
    const a = g.args;
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

function decideFile(filePath, cwd) {
  if (!filePath) return null;
  // Git Bash style /c/Users/... paths
  const native = filePath.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  const abs = isAbsolute(native) ? native : resolve(cwd || ROOT, native);
  const rel = relative(ROOT, abs).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (/^\.claude\/logs\/[^/]+\/state\.json$/i.test(rel)) return { decision: 'deny', reason: 'Task state changes go through node .claude/kit/kit.mjs (start, done, back, set).' };
  if (/^(\.claude\/\.env\.local|\.env(\.[^/]*)?|config\.yml)$/i.test(rel)) return { decision: 'deny', reason: 'Credential files are written by the dev, never by Claude.' };
  if (/^\.claude\/(settings\.json|CLAUDE\.md|VERSION|hooks\/|kit\/|commands\/|agents\/|skills\/)/i.test(rel)) {
    return { decision: 'ask', reason: `This edits the kit itself (${rel}). Kit changes belong in the master copy so every repo gets them.` };
  }
  if (MERCHANT_JSON.test(rel)) {
    return { decision: 'ask', reason: `${rel} is merchant-owned: Shopify writes admin edits into it (and syncs them into git). Edit it only if the approved plan says so.` };
  }
  return null;
}

const defaultCtx = { protected: protectedBranches, branch: currentBranch, scripts: packageScripts, isPath: (p) => existsSync(join(ROOT, p)) };

export function decide(input, ctx = defaultCtx) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (tool === 'Bash' || tool === 'PowerShell') return decideCommand(String(ti.command || ''), ctx);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return decideFile(String(ti.file_path || ti.notebook_path || ''), input.cwd);
  return null;
}

/** Blocks feed kit.mjs retro: a block on a harmless command is a guard bug worth reporting. */
function logBlock(input, result) {
  if (result?.decision !== 'deny') return;
  try {
    const ti = input.tool_input || {};
    const entry = { at: new Date().toISOString(), tool: input.tool_name, reason: result.reason.slice(0, 200), command: String(ti.command || ti.file_path || '').slice(0, 200) };
    mkdirSync(join(ROOT, '.claude', 'logs'), { recursive: true });
    appendFileSync(join(ROOT, '.claude', 'logs', '_guard.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch { /* logging never changes the decision */ }
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
  const ctx = (branch = K, scripts = {}) => ({ protected: () => ['main', 'master'], branch: () => branch, scripts: () => scripts, isPath: (p) => /[/\\]/.test(p) && /\.\w+$/.test(p) });
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
  const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
  const file = (tool, p) => ({ tool_name: tool, tool_input: { file_path: join(ROOT, p) }, cwd: ROOT });
  const msys = (p) => `/${ROOT[0].toLowerCase()}${ROOT.slice(2).replaceAll('\\', '/')}/${p}`;
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
    [file('Write', '.claude/shopify-kit.json'), null],
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
    [bash('git -C . push origin master'), 'deny'],
    [bash('bash -c "git push origin main"'), 'deny'],
    [ps('cmd /c "git push origin main"'), 'deny'],
    [ps("Start-Process git -ArgumentList 'push','origin','main'"), 'deny'],
    [bash('git commit -m "x"'), 'deny', ctx('main')],
    [bash('git switch main && git commit -m "x"'), 'deny'],
    [bash(`git checkout main && git merge ${K}`), 'deny'],
    [bash(`git merge ${K}`), 'deny', ctx('master')],
    [bash('gh pr merge 21 --squash'), 'deny'],
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
    // ask
    [bash(`node .claude/kit/shopify.mjs mutate ${K} .claude/logs/${K}/mutations/01-def.graphql --vars .claude/logs/${K}/mutations/01-def.vars.json`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs mutate ${K} a.graphql --dry-run && node .claude/kit/shopify.mjs mutate ${K} b.graphql`), 'ask'],
    [bash(`node .claude/kit/shopify.mjs delete-draft ${K}`), 'ask'],
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
  console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} passed`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();
else {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { process.exit(0); }
    try {
      const result = decide(input);
      logBlock(input, result);
      emit(result);
    } catch (e) {
      // Fail closed only where a wrong allow could reach the store or a protected branch.
      const text = JSON.stringify(input.tool_input || {});
      if (/shopify|git\s+push|\btheme\s/i.test(text)) emit({ decision: 'deny', reason: `Kit guard error (${e.message}); blocked to be safe.` });
      process.exit(0);
    }
  });
}
