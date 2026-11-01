// Generated from shared/guard-core.mjs by scripts/sync-shared.mjs: edit that file, then run node scripts/sync-shared.mjs.
// Shell reading and hook plumbing for both kits' hooks/guard.mjs: splitting a command into segments, finding the program
// each runs, git subcommands and push routing, cd targets, bash -c bodies, package scripts, the files a command writes,
// secrets, gh merges and releases, the repo's git state, the log, and the permission-mode rule. Both guards' self-tests
// exercise it. The source is shared/guard-core.mjs in the kit repo; scripts/sync-shared.mjs copies it into each kit.
// Threat model: a well-meaning agent's mistakes, not an agent working around the guard on purpose. A rule that only stops
// a deliberate disguise (quote-joined names, $(which …), env-var routing) costs false positives and doesn't belong here.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Reading a shell command ──
// Close enough to a shell's own parsing to find the program each segment runs and its arguments.

// Files that run as code: a heredoc written into one is scanned like a command; into anything else it's data.
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|[cm]?[jt]sx?|py|rb|pl|ya?ml)$/i;
const QUOTED_HEREDOC = /<<-?\s*(['"])[A-Za-z_]\w*\1/;

/** cat > notes.md <<'EOF' (or tee): a quoted delimiter expands nothing, so the body is text when the target isn't a script. */
function dataHeredoc(line) {
  if (!QUOTED_HEREDOC.test(line)) return false;
  // Only the command holding the <<: in "mkdir -p d && cat > d/notes.md <<'EOF'" that's the cat, not the mkdir.
  const seg = (segments(line.replace(QUOTED_HEREDOC, '\u0000')).find((s) => s.includes('\u0000')) || '').replace('\u0000', ' ');
  const { w, i } = program(seg);
  const prog = (w[i] || '').toLowerCase();
  const target = prog === 'cat' ? (seg.match(/>>?\s*["']?([^\s"'<>;&|]+)/) || [])[1] : prog === 'tee' ? w.slice(i + 1).find((a) => !a.startsWith('-')) : null;
  return Boolean(target) && /\.\w+$/.test(target) && !SCRIPT_EXT.test(target);
}

/** Drop the body of a heredoc or PowerShell here-string when it is a git commit/tag message or a data file's text. */
export function stripMessageBodies(cmd) {
  const lines = cmd.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!/\bgit(\.exe)?\b.*\b(commit|tag)\b/.test(lines[i]) && !dataHeredoc(lines[i])) continue;
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
export function segments(cmd) {
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

export const stripRedirects = (s) => s.replace(/\s\d*>&\d+/g, ' ').replace(/\s\d*>>?\s*[^\s;&|]+/g, ' ');

export function words(segment) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Prefixes that run the next word as the program: "env git push" is a git push.
const PREFIXES = /^(env|command|builtin|exec|time|nice|nohup|timeout|stdbuf|sudo)$/i;
// Prefix options that take a value, so the value isn't read as the program.
const PREFIX_VALUE_FLAGS = new Set(['-u', '-n', '-g', '-C', '-s', '-k', '-S', '--unset', '--chdir', '--user', '--group', '--signal', '--kill-after', '--adjustment']);

/** The program's name as the shell finds it: \git, /usr/bin/git and "C:/…/git.exe" all run git. */
export const programName = (word) => String(word ?? '').replace(/^\\/, '').replace(/^.*[\\/]/, '');

/** Env assignments, PowerShell's call operator and prefixes (env, time, sudo…) don't change which program runs; w[i] is its bare name. */
export function program(segment) {
  const w = words(segment);
  let i = 0;
  while (i < w.length) {
    if (/^[A-Za-z_]\w*=/.test(w[i]) || w[i] === '&') { i++; continue; }
    const name = programName(w[i]).replace(/\.exe$/i, '');
    if (!PREFIXES.test(name) || i + 1 >= w.length) break;
    i++;
    while (i < w.length && w[i].startsWith('-')) i += PREFIX_VALUE_FLAGS.has(w[i]) ? 2 : 1;
    if (/^timeout$/i.test(name) && /^\d/.test(w[i] || '')) i++;
  }
  if (i < w.length) w[i] = programName(w[i]);
  return { w, i };
}

/** The lower-case program name of a segment, without .exe/.cmd. */
const progOf = (segment) => { const { w, i } = program(stripRedirects(segment)); return (w[i] || '').replace(/\.(exe|cmd)$/i, '').toLowerCase(); };

/** git's subcommand, skipping global options such as -C <dir> or -c key=value (returned as globals). */
export function gitCommand(segment) {
  const { w, i: start } = program(stripRedirects(segment));
  let i = start;
  if (!/^git(\.exe)?$/i.test(w[i] || '')) return null;
  i++;
  while (i < w.length && w[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w[i]) ? 2 : 1;
  return { sub: w[i] || '', args: w.slice(i + 1), globals: w.slice(start + 1, i) };
}

/** The argument of a cd, pushd or Set-Location segment ({ arg: undefined } means home), or null for any other segment. */
export function cdArg(segment) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^(cd|pushd|chdir|Set-Location|sl)$/i.test(w[i] || '')) return null;
  return { arg: w.slice(i + 1).find((x) => !/^-(L|P|e|@|Path|LiteralPath)$/i.test(x) && !/^\/d$/i.test(x)) };
}

/** The folder a cd or git -C leads to, or null when the guard can't tell (a variable, cd -, an unknown start). */
export function dirAfter(arg, from) {
  if (arg === undefined) return homedir();
  if (!arg || arg === '-' || /[$`%*?]/.test(arg)) return null;
  let p = arg.replace(/^~(?=$|[\\/])/, homedir());
  if (process.platform === 'win32') p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d) => `${d.toUpperCase()}:`);
  if (isAbsolute(p)) return resolve(p);
  return from === null ? null : resolve(from, p);
}

/** The long, real spelling of a path, even where its end doesn't exist yet: C:/Users/ECHOLO~1/… is C:/Users/ECHOLOGYX/…. */
export function realPath(p) {
  let head = p;
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return p;
    tail.unshift(basename(head));
    head = up;
  }
  try { return join(realpathSync.native(head), ...tail); } catch { return p; }
}

/** True if the segment redirects output into a file (2>&1 and >/dev/null don't count); quoted text is ignored. */
export const redirects = (segment) => /\d*>>?\s*(?!&|\/dev\/null\b|\$null\b|NUL\b)\S/i.test(segment.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""'));

/** True if the segment substitutes a command: $(…) or backticks. $(cat <<'EOF' … EOF) only reads its heredoc, so it's text. */
export const substitutes = (segment) => /`|\$\((?!cat\s+<<)/.test(segment);

/** The command string inside bash -c "...", bash -lc, env bash -c, cmd /c ..., powershell -NoProfile -Command "...". */
export function innerCommand(segment) {
  const { w, i } = program(segment);
  const shell = (w[i] || '').replace(/\.exe$/i, '').toLowerCase();
  const runs = { bash: /^-[a-z]*c$/, sh: /^-[a-z]*c$/, zsh: /^-[a-z]*c$/, dash: /^-[a-z]*c$/, cmd: /^\/c$/i, powershell: /^-c(ommand)?$/i, pwsh: /^-c(ommand)?$/i }[shell];
  if (!runs) return null;
  let j = i + 1;
  while (j < w.length && /^[-/]/.test(w[j]) && !runs.test(w[j])) j++;
  if (!runs.test(w[j] || '') || j + 1 >= w.length) return null;
  return w.slice(j + 1).join(' ');
}

// Programs that only print or search text: the words they're given ("shopify theme push" in a grep) run nothing.
const READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'findstr', 'select-string', 'sls', 'echo', 'printf', 'write-host', 'write-output']);

/**
 * True for a segment that only reads or prints text: grep "shopify theme push" docs/, echo "app deploy", git log --grep.
 * Not when it substitutes a command or writes its output to a file.
 */
export function onlyReadsText(segment) {
  if (substitutes(segment) || redirects(segment)) return false;
  const g = gitCommand(segment);
  if (g) return ['grep', 'log', 'show', 'diff', 'blame'].includes(g.sub);
  // npm ls @shopify/cli, npm view @shopify/cli version: package metadata, nothing runs.
  const { w, i } = program(stripRedirects(segment));
  if (/^(npm|pnpm|yarn)(\.cmd)?$/i.test(w[i] || '') && ['ls', 'list', 'view', 'info', 'outdated', 'why'].includes(w[i + 1])) return true;
  return READERS.has(progOf(segment));
}

// ── The Shopify CLI however it's reached ──

// The wrapper path itself contains "shopify"; mask it before looking for real CLI calls.
export const WRAPPER_PATH = /(?:[\w:.~-]*[\\/])?\.claude[\\/]kit[\\/]shopify\.mjs/gi;
const CLI_TOPICS = 'theme|store|app|auth|hydrogen|organization|config|upgrade|version|commands|search|help|plugins|webhook|login|logout|kitchen-sink|demo';
// Case-sensitive: the CLI is typed "shopify"; "Shopify app blocks" in a comment or a PR body is a sentence.
export const CLI_WORD = new RegExp(`(^|[\\s;&|(\`'"=])shopify(\\.cmd|\\.ps1|\\.exe)?['"]?\\s+(${CLI_TOPICS}|-)`);
export const CLI_PATH = new RegExp(`[\\\\/]shopify(\\.cmd|\\.ps1|\\.exe)?['"]?\\s+(${CLI_TOPICS})\\b`);
/** The CLI's own npm packages by exact name: @shopify/app-bridge-react and @shopify/theme-check-node are libraries. */
export const cliPackage = (names) => new RegExp(`@shopify\\/(${names})(?=$|[\\s@'"\`/;&|)])`, 'i');

/** The Shopify CLI as the program a segment runs (shopify, npx shopify, pnpm dlx @shopify/cli, a full path), whatever follows. */
export function runsShopifyCli(segment) {
  const { w, i } = program(stripRedirects(segment));
  const name = (x) => /^shopify(\.cmd|\.exe|\.ps1)?$/i.test(programName(x || '')) || /^@shopify\/cli(@\S*)?$/i.test(x || '');
  if (name(w[i])) return true;
  const runner = (w[i] || '').replace(/\.(cmd|exe)$/i, '').toLowerCase();
  if (['npx', 'pnpx', 'bunx'].includes(runner)) return name(w.slice(i + 1).find((a) => !a.startsWith('-')));
  if (['pnpm', 'yarn', 'npm'].includes(runner) && ['dlx', 'exec', 'x'].includes(w[i + 1])) return name(w.slice(i + 2).find((a) => !a.startsWith('-')));
  return false;
}

// ── git push, gh merges, workflows and releases ──

/** Why this git push is refused, or null for the one allowed form: git push -u origin <task-branch>. extra(ref) adds a flavour's own rule. */
export function checkPush(args, prot, extra = null) {
  const flags = args.filter((a) => a.startsWith('-'));
  const pos = args.filter((a) => !a.startsWith('-'));
  const allowed = 'Allowed form: git push -u origin <task-branch>.';
  const bad = flags.filter((f) => !['-u', '--set-upstream'].includes(f));
  if (bad.length) return `git push ${bad.join(' ')} is blocked (no force, delete, mirror, all or tags). ${allowed}`;
  if (pos.length !== 2) return `Name the remote and the branch. ${allowed}`;
  if (/[$`(]/.test(pos.join(' '))) return `Push the branch by its literal name, not a variable or $(…). ${allowed}`;
  // <branch>:<branch> names the same branch on both sides: it pushes there whatever push.default or a refspec says.
  const same = pos[1].match(/^(?:refs\/heads\/)?([^:+*^~]+):(?:refs\/heads\/)?([^:+*^~]+)$/i);
  const full = same && same[1] === same[2] ? same[1] : pos[1];
  if (/^(HEAD|@)$/i.test(full) || /[:+*^~]/.test(full)) return `Push the branch by name, not a refspec like HEAD:main or +branch. ${allowed}`;
  // Only refs/heads/<name> is a branch; refs/tags/…, refs/remotes/… and the like are not what this push is for.
  if (/^refs\//i.test(full) && !/^refs\/heads\//i.test(full)) return `Push the branch by its plain name. ${allowed}`;
  // git resolves heads/main and refs/heads/main to main. origin/main and remotes/… are refused too, to be safe.
  const ref = full.replace(/^refs\/heads\//i, '').replace(/^heads\//i, '');
  const names = [ref, ref.replace(/^remotes\/[^/]+\//i, '')];
  if (ref.toLowerCase().startsWith(`${pos[0].toLowerCase()}/`)) names.push(ref.slice(pos[0].length + 1));
  const hit = names.find((n) => prot.some((p) => p.toLowerCase() === n.toLowerCase()));
  if (hit) return `"${hit}" is protected. It changes only through a reviewed PR that the dev merges.`;
  return extra ? extra(ref) : null;
}

/** A pushed name that is a tag, not a branch: tag pushes commonly start a release workflow. */
export const tagPush = (args, isTag) => {
  const pos = args.filter((a) => !a.startsWith('-'));
  const name = pos.length === 2 ? pos[1].split(':')[0].replace(/^refs\/heads\//i, '') : '';
  return name && !/^refs\//i.test(name) && isTag(name) ? `"${name}" is a tag, and pushing a tag often starts a release or deploy workflow. Tags are the dev's step; push the task branch.` : null;
};

/** gh's words after the program (gh -R owner/repo pr merge), or null when the segment isn't gh. */
function ghArgs(segment) {
  const { w, i } = program(stripRedirects(segment));
  return /^gh(\.exe)?$/i.test(w[i] || '') ? w.slice(i + 1) : null;
}

/** gh pr merge, or a gh api call that merges a PR or moves a ref. */
export function ghMerges(segment) {
  const rest = ghArgs(segment);
  if (!rest) return false;
  const at = rest.findIndex((x) => x === 'pr' || x === 'api');
  if (at === -1 || at > 4) return false;
  if (rest[at] === 'pr') return rest[at + 1] === 'merge';
  return rest.slice(at + 1).some((x) => /\/merges?\b|\/pulls\/\d+\/merge|git\/refs|mergePullRequest/.test(x));
}

/** gh calls that start or re-run a workflow (often a deploy pipeline): like merging, the dev's step. */
export function ghRunsWorkflow(segment) {
  const rest = ghArgs(segment);
  if (!rest) return false;
  const at = rest.findIndex((x) => ['workflow', 'run', 'api'].includes(x));
  if (at === -1 || at > 4) return false;
  if (rest[at] === 'workflow') return ['run', 'enable'].includes(rest[at + 1]);
  if (rest[at] === 'run') return rest[at + 1] === 'rerun';
  return rest.slice(at + 1).some((x) => /\/dispatches\b|\/actions\/runs\/\d+\/(rerun|approve)/.test(x));
}

/** gh release create/edit/upload/delete, or a gh api call that writes a release or a deployment: both commonly start a deploy. */
export function ghReleases(segment) {
  const rest = ghArgs(segment);
  if (!rest) return false;
  const at = rest.findIndex((x) => x === 'release' || x === 'api');
  if (at === -1 || at > 4) return false;
  if (rest[at] === 'release') return ['create', 'edit', 'upload', 'delete'].includes(rest[at + 1]);
  // gh api sends a POST as soon as it has a field (-f/-F), or with -X/--method other than GET.
  const writes = rest.some((x, k) => /^(-[fF]|--field|--raw-field|--input)$/.test(x) || (/^(-X|--method)$/.test(x) && !/^get$/i.test(rest[k + 1] || '')) || /^--method=(?!get$)/i.test(x));
  return writes && rest.slice(at + 1).some((x) => /\/(releases|deployments)\b/.test(x));
}

// ── git: settings that route a push or run a program ──

// git config's subcommand words (git 2.46+: git config set <key> <value>) and the options that take a value.
const CONFIG_SUBS = new Set(['set', 'unset', 'get', 'list', 'rename-section', 'remove-section', 'edit', 'get-color', 'get-colorbool']);
const CONFIG_VALUE_FLAGS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);

/**
 * What a git config write does: 'push' when it routes pushes (an alias, a push refspec, push.default, a branch's upstream,
 * an include that can carry any of these), 'program' when it makes git run a program, else null. Reads are null.
 */
export function gitConfigRisk(args) {
  if (args.some((a) => /^(--get(-all|-regexp|-urlmatch|-color)?|-l|--list|--show-origin|--show-scope)$/.test(a))) return null;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    if (CONFIG_VALUE_FLAGS.has(args[k])) k++;
    else if (!args[k].startsWith('-')) pos.push(args[k]);
  }
  if (CONFIG_SUBS.has(pos[0]) && !['set', 'unset'].includes(pos[0])) return null;
  const key = (CONFIG_SUBS.has(pos[0]) ? pos[1] : pos[0]) || '';
  if (/^(alias\.|remote\.[^.]+\.(push|pushurl)$|push\.default$|remote\.pushdefault$|branch\.[^.]+\.(merge|remote|pushremote)$|include\.|includeif\.|url\.)/i.test(key)) return 'push';
  if (/^(core\.(hookspath|fsmonitor|pager|sshcommand|editor|askpass|gitproxy)$|filter\.|diff\.|merge\.|credential\.|sequence\.editor$|gpg\.|ssh\.|uploadpack\.|receive\.)/i.test(key)) return 'program';
  return null;
}

/**
 * Why git would send "git push <remote> <branch>" somewhere other than <branch>: a push refspec in the config, or
 * push.default upstream/tracking with the branch's upstream elsewhere (git switch -c X origin/main sets it to main).
 * config(key) returns git's values for key. An explicit <branch>:<branch> ignores both.
 */
export function pushRouting(args, config) {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos.length !== 2 || pos[1].includes(':')) return null;
  const [remote, ref] = pos;
  const name = ref.replace(/^refs\/heads\//i, '');
  if (config(`remote.${remote}.push`).length) return `git's config has remote.${remote}.push, so this push goes where that refspec says, not to "${name}". Push the explicit form: git push -u ${remote} ${name}:${name}`;
  const mode = String(config('push.default')[0] || '').toLowerCase();
  const upstream = String(config(`branch.${name}.merge`)[0] || '').replace(/^refs\/heads\//, '');
  if (['upstream', 'tracking'].includes(mode) && upstream && upstream.toLowerCase() !== name.toLowerCase()) {
    return `push.default is "${mode}" and ${name} tracks ${upstream}, so this push would update ${upstream}. Push the explicit form: git push -u ${remote} ${name}:${name}`;
  }
  return null;
}

/**
 * git checkout/switch/reset/clean/restore/stash/branch forms that throw away uncommitted work or a branch, and the ones
 * that overwrite a branch where it stands (git branch -M x main, git update-ref refs/heads/main).
 */
export function discardsWork(g, isPath) {
  const a = g.args;
  return (g.sub === 'reset' && a.includes('--hard'))
    || (g.sub === 'clean' && a.some((x) => x === '--force' || /^-[a-z]*f/i.test(x)))
    || (g.sub === 'checkout' && (['--', '.', '-B', '-f', '--force'].some((f) => a.includes(f)) || a.some((x) => !x.startsWith('-') && isPath(x))))
    || (g.sub === 'switch' && ['-C', '--force-create', '--discard-changes', '-f', '--force'].some((f) => a.includes(f)))
    || (g.sub === 'restore' && !a.includes('--staged'))
    || (g.sub === 'stash' && ['drop', 'clear'].includes(a[0]))
    || (g.sub === 'branch' && a.some((x) => ['-D', '-f', '--force', '-M', '-C'].includes(x)))
    || g.sub === 'update-ref';
}

// ── The repo's git state ──

/**
 * Lazy git reads for one hook call. The branch comes from .git/HEAD without starting git; the config and the staged list
 * start git once each, and only for the commands that need them (push, commit). branch() is null when nothing can read
 * it: callers treat that as unknown, never as "not protected".
 */
export function repoGit(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  let branch;
  let config;
  let staged;
  return {
    branch() {
      if (branch !== undefined) return branch;
      branch = headBranch(root);
      if (branch === null) { try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null; } catch { branch = null; } }
      return branch;
    },
    config(key) {
      if (!config) {
        config = new Map();
        try {
          for (const entry of git(['config', '-z', '--list']).split('\0')) {
            const nl = entry.indexOf('\n');
            const k = (nl === -1 ? entry : entry.slice(0, nl)).toLowerCase();
            if (k) config.set(k, [...(config.get(k) || []), nl === -1 ? '' : entry.slice(nl + 1)]);
          }
        } catch { /* no git: nothing configured */ }
      }
      return config.get(key.toLowerCase()) || [];
    },
    staged() {
      if (!staged) { try { staged = git(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean); } catch { staged = []; } }
      return staged;
    },
    isTag(name) {
      try { git(['show-ref', '--verify', '--quiet', `refs/tags/${name}`]); return true; } catch { return false; }
    },
  };
}

/** The checked-out branch read from .git/HEAD ('HEAD' when detached), or null when it can't be read that way. */
export function headBranch(root) {
  try {
    let dir = resolve(root);
    while (!existsSync(join(dir, '.git'))) { const up = dirname(dir); if (up === dir) return null; dir = up; }
    let gitDir = join(dir, '.git');
    // A worktree or submodule: .git is a file naming the real folder.
    if (statSync(gitDir).isFile()) gitDir = resolve(dir, readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    // The reftable format keeps a placeholder here; git itself answers then.
    if (ref) return ref[1] === '.invalid' ? null : ref[1];
    return /^[0-9a-f]{40,64}$/i.test(head) ? 'HEAD' : null;
  } catch { return null; }
}

// ── Package scripts ──

// npm's own commands. test, start, restart and stop aren't here: they run the package script of that name.
export const NPM_BUILTINS = new Set(['install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'init', 'create', 'exec', 'x', 'dlx',
  'outdated', 'ls', 'list', 'view', 'info', 'audit', 'link', 'config', 'cache', 'why', 'pack', 'prune', 'dedupe', 'help', 'version', '-v', '--version']);
// npm, pnpm and yarn options that take a value, so the value isn't read as the script name.
const PM_VALUE_FLAGS = new Set(['--prefix', '-C', '--cwd', '--dir', '--filter', '-F', '-w', '--workspace']);
// Install-time scripts npm and pnpm run on install and ci.
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'];

/**
 * The package scripts a segment runs: npm run x, npm --silent run x, yarn x, npm test, node --run x, (npx) npm-run-all x,
 * (npx) concurrently "npm run x", and the install-time scripts of npm install/ci. Each name's pre- and post-script run too.
 */
export function scriptRuns(segment, depth = 0) {
  const { w, i } = program(stripRedirects(segment));
  const prog = (w[i] || '').replace(/\.(cmd|exe)$/i, '').toLowerCase();
  const args = w.slice(i + 1);
  const firstArg = (from) => { let j = from; while (j < args.length && args[j].startsWith('-')) j += PM_VALUE_FLAGS.has(args[j]) ? 2 : 1; return j; };
  const names = [];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) {
    const j = firstArg(0);
    const cmd = args[j];
    if (cmd === 'run' || cmd === 'run-script') { const k = firstArg(j + 1); if (args[k]) names.push(args[k]); }
    else if (['install', 'i', 'ci'].includes(cmd) || (prog === 'yarn' && cmd === undefined)) names.push(...INSTALL_SCRIPTS);
    else if (cmd === 't' || cmd === 'tst') names.push('test');
    else if (['exec', 'x', 'dlx'].includes(cmd) && depth < 2) names.push(...scriptRuns(args.slice(j + 1).join(' '), depth + 1));
    else if (cmd && !NPM_BUILTINS.has(cmd)) names.push(cmd);
  } else if (prog === 'node' && args.includes('--run')) {
    names.push(args[args.indexOf('--run') + 1]);
  } else if (['npx', 'pnpx', 'bunx', 'npm-run-all', 'npm-run-all2', 'run-s', 'run-p', 'concurrently'].includes(prog)) {
    // Inside a package script these run as the program itself ("release": "run-s build deploy"), as they do behind npx.
    const j = ['npx', 'pnpx', 'bunx'].includes(prog) ? firstArg(0) : -1;
    const tool = j === -1 ? prog : programName(args[j] || '');
    if (/^(npm-run-all2?|run-s|run-p)$/.test(tool)) names.push(...args.slice(j + 1).filter((a) => !a.startsWith('-')));
    // concurrently "npm run x" "npm run y": each argument is a command of its own.
    else if (depth < 2) for (const a of args.slice(j + 1).filter((x) => /\s/.test(x))) names.push(...scriptRuns(a, depth + 1));
  }
  return [...new Set(names.filter(Boolean).flatMap((n) => [`pre${n}`, n, `post${n}`]))];
}

/**
 * The first script problem(body) flags among the scripts a segment runs (each with its pre/post script) and the scripts
 * those run one level down ("ship": "npm run deploy"): { name, body, why }. Deeper chains aren't followed.
 */
export function scriptProblem(segment, scripts, problem) {
  for (const name of scriptRuns(segment)) {
    const body = scripts[name];
    if (!body) continue;
    for (const b of [body, ...segments(body).flatMap((s) => scriptRuns(s)).map((n) => scripts[n]).filter(Boolean)]) {
      const why = problem(b);
      if (why) return { name, body: b, why };
    }
  }
  return null;
}

/**
 * The folder whose package.json holds the scripts a segment runs: npm --prefix web, --workspace web, yarn --cwd web, or
 * dir (where the command runs after any cd). null when the guard can't tell; callers then read the repo root's.
 */
export function scriptDir(segment, dir) {
  const { w, i } = program(stripRedirects(segment));
  if (!/^(npm|pnpm|yarn|bun)(\.cmd)?$/i.test(w[i] || '')) return dir;
  for (let k = i + 1; k < w.length; k++) {
    const m = w[k].match(/^(--prefix|-C|--cwd|--dir|--workspace|-w)(?:=(.*))?$/);
    if (m) return m[2] === undefined && w[k + 1] === undefined ? dir : dirAfter(m[2] ?? w[k + 1], dir);
  }
  return dir;
}

// ── The files a command writes ──

export const WRITE_VERBS = /\b(writeFileSync|appendFileSync|writeFile|renameSync|rmSync|unlinkSync|write_text|Set-Content|Out-File|Add-Content|tee|cp|mv|rm|rmdir|Copy-Item|Move-Item|Remove-Item|del|truncate|touch|New-Item|patch|install|rsync|ln)\b|\bopen\s*\(|\bFile\.write|\bsed\s+-i|\bperl\s+-[a-z]*i|\bgit\s+apply\b|\bdd\b[^\n]*\bof=/i;
// What an inline script (node -e, python -c) calls when it writes or deletes a file. Reading (readFileSync, open(f)) isn't here.
export const INLINE_WRITE = /\b(write|append)File(Sync)?\b|\b(copyFile|cp|rename|rm|rmdir|unlink|mkdir|truncate)Sync\b|\bfs\.(promises\.)?(rm|rmdir|unlink|rename|copyFile|cp|truncate)\s*\(|createWriteStream|\bwrite_(text|bytes)\b|\bos\.(remove|unlink|rename|replace|makedirs|rmdir)\b|\bshutil\.|\b(WriteAll|AppendAll)(Text|Bytes|Lines)\b|\bopen\s*\([^)]*,\s*['"][^'"]*[wax+]/;
// PowerShell parameters that name the file, and options that take a value (so the value isn't read as a file).
const PS_PATH = ['-path', '-literalpath', '-filepath'];
const VALUE_FLAGS = new Set([...PS_PATH, '-destination', '-value', '-itemtype', '-encoding', '-name', '-newname', '-t', '--target-directory', '-m', '--mode', '-o', '--owner']);

/**
 * Where a command writes or deletes, as absolute paths ('?': files the guard can't name, as with git apply, an archive
 * extract or an inline script's write). Redirects, sed -i / perl -i, tee, cp/mv/install/rsync/ln targets (into a folder:
 * the file it lands as), rm and mv sources, dd of=, New-Item and friends (-Path too), followed through cd from root (or
 * the hook's cwd). A target in a variable is skipped.
 */
export function shellWrites(segs, cwd, root) {
  const out = [];
  let dir = cwd ? dirAfter(cwd, null) : root;
  // A glob (spec?, *.json) stays as written, so the caller can see it's a pattern; a variable can't be resolved at all.
  const at = (p) => (dir === null && !isAbsolute(p) ? null : /[*?[]/.test(p) && !/[$`%]/.test(p) ? resolve(dir, p) : dirAfter(p, dir));
  const isDir = (p, raw) => /[\\/]$/.test(raw) || (() => { try { return statSync(p).isDirectory(); } catch { return false; } })();
  const push = (...ps) => out.push(...ps.filter(Boolean));
  for (const seg of segs) {
    const cd = cdArg(seg);
    if (cd) { dir = dirAfter(cd.arg, dir); continue; }
    const plain = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => q.replace(/>/g, ' '));
    for (const m of plain.matchAll(/(?:^|[^\d&>-])\d*>>?\s*([^\s;&|>]+)/g)) {
      if (!/^(&\d|\/dev\/null$|\$null$|NUL$)/i.test(m[1])) push(at(m[1].replace(/^["']|["']$/g, '')));
    }
    const { w, i } = program(stripRedirects(seg));
    const prog = (w[i] || '').replace(/\.exe$/i, '').toLowerCase();
    const args = w.slice(i + 1);
    const named = (...flags) => { const k = args.findIndex((a) => flags.includes(a.toLowerCase())); return k === -1 ? undefined : args[k + 1]; };
    const files = [];
    for (let k = 0; k < args.length; k++) {
      if (VALUE_FLAGS.has(args[k].toLowerCase())) k++;
      else if (!args[k].startsWith('-')) files.push(args[k]);
    }
    const psPath = named(...PS_PATH);
    if (['sed', 'perl'].includes(prog) && args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith('--in-place'))) push(...files.slice(1).map(at));
    else if (prog === 'tee') push(...files.map(at));
    else if (['cp', 'mv', 'copy-item', 'move-item', 'copy', 'move', 'install', 'rsync', 'ln', 'cpi', 'mi'].includes(prog)) {
      const intoDir = named('-t', '--target-directory');
      const target = intoDir ?? named('-destination') ?? (files.length > 1 ? files[files.length - 1] : undefined);
      const sources = [...(psPath ? [psPath] : []), ...files.filter((f) => f !== target)];
      if (target) {
        const t = at(target);
        // cp x .claude/ writes .claude/x: name the file it lands as, so the rules see settings.json, not a folder.
        if (t && (intoDir || isDir(t, target)) && sources.length) push(...sources.map((s) => join(t, basename(s))));
        else push(t);
      }
      if (['mv', 'move-item', 'move', 'mi'].includes(prog)) push(...sources.map(at));
    } else if (['rm', 'rmdir', 'del', 'erase', 'unlink', 'remove-item', 'ri', 'rd'].includes(prog)) push(...[...(psPath ? [psPath] : []), ...files].map(at));
    else if (['rename-item', 'rni', 'ren', 'touch', 'truncate', 'new-item', 'set-content', 'add-content', 'out-file', 'ni', 'sc', 'ac'].includes(prog)) push(...[psPath ?? files[0]].filter(Boolean).map(at));
    else if (prog === 'dd') push(...args.filter((a) => a.startsWith('of=')).map((a) => at(a.slice(3))));
    // git rm and git mv delete or move files like rm and mv do.
    else if (prog === 'git' && ['rm', 'mv'].includes(args[0])) push(...files.slice(1).map(at));
    else if ((prog === 'git' && args[0] === 'apply') || prog === 'patch' || prog === 'unzip' || (prog === 'tar' && args.some((a) => /^-?[a-z]*x/.test(a)))) out.push('?');
    else if (/^(node|python3?|py|ruby|deno|bun)$/.test(prog) && args.some((a) => /^(-e|-c|-p|--eval|--print)$/.test(a)) && INLINE_WRITE.test(seg)) out.push('?');
  }
  return out;
}

/** A repo-relative write target spelled with a glob (spec?, *.json): the guard can't tell which file it reaches. */
export const isGlob = (rel) => /[*?[]/.test(rel);

/** ~/.claude/settings.json or settings.local.json: the dev's own Claude Code settings, which can switch every hook off. */
export const userSettings = (p) => /^settings[\w.-]*\.json$/i.test(relative(realPath(join(homedir(), '.claude')), realPath(p)));

/**
 * Why a git push in a script's text is refused (check is the guard's checkPush), or null. A git hook or a workflow
 * runs later without the guard, so its pushes are read when it's written. A workflow's "- run: git push …" counts too.
 */
export function pushIn(text, check) {
  for (const s of segments(String(text).replace(/^\s*(-\s*)?(run:\s*[|>]?-?)?/gm, ''))) {
    const g = gitCommand(s);
    const why = g?.sub === 'push' ? check(g.args) : null;
    if (why) return why;
  }
  return null;
}

/** True if folder t is s or holds it. */
const holds = (t, s) => { const rel = relative(t, s); return !rel.startsWith('..') && !isAbsolute(rel); };

/**
 * grep -r, rg --hidden/--no-ignore, findstr /s, find -exec grep, Get-ChildItem -Recurse | Select-String over a folder that holds a secret
 * file: the repo root (its .env), .claude/ (.env.local), ~ or ~/.claude (the global .env), or a parent of these. dir is
 * where the command runs after any cd (null: unknown, so only absolute paths are judged). --include, rg -g/-t and
 * --exclude=.env* keep the secrets out.
 */
export function searchesSecrets(w, i, root, dir, segs = []) {
  const prog = (w[i] || '').replace(/\.exe$/i, '').toLowerCase();
  const args = w.slice(i + 1);
  const flags = args.filter((a) => a.startsWith('-') || (prog === 'findstr' && a.startsWith('/')));
  // Only an exclude of .env* keeps .claude/.env.local out (--exclude-dir=.venv doesn't), and --include=* narrows nothing.
  if (args.some((a) => /^--exclude=['"]?\*?\.env\*/i.test(a) || (/^--include=/.test(a) && !/env/i.test(a) && !/^--include=['"]?\*['"]?$/.test(a)))) return false;
  if (prog === 'rg' && args.some((a) => /^(-g|--glob|-t|--type)(=|$)/.test(a))) return false;
  const pwshRecurse = ['get-childitem', 'gci', 'dir', 'ls'].includes(prog) && flags.some((f) => /^-r(ecurse)?$/i.test(f))
    && !flags.some((f) => /^-(include|filter)$/i.test(f)) && segs.some((s) => /^(select-string|sls)$/.test(progOf(s)));
  // find . -type f -exec grep … {} + reads every file it finds, unless -name or -path narrows them.
  const findReads = prog === 'find' && args.some((a, k) => /^-exec(dir)?$/.test(a) && /^(e|f)?grep$|^(rg|cat|head|tail|strings)$/i.test(programName(args[k + 1] || '')))
    && !args.some((a) => /^-i?(name|path|wholename|regex)$/.test(a));
  const recursive = (['grep', 'egrep', 'fgrep'].includes(prog) && flags.some((f) => /^-[a-zA-Z]*[rR]|^--(recursive|dereference-recursive)$/.test(f)))
    || (prog === 'rg' && flags.some((f) => /^(--hidden|--no-ignore|-u+|-[a-zA-Z]*u)$/.test(f)))
    || (prog === 'findstr' && flags.some((f) => /^\/s$/i.test(f)))
    || pwshRecurse || findReads;
  if (!recursive) return false;
  const rest = args.filter((a) => !flags.includes(a));
  let paths = findReads ? args.slice(0, args.findIndex((a) => /^[-(!]/.test(a)))
    : pwshRecurse || flags.some((f) => /^(-e|--regexp|-f)/.test(f)) ? rest : rest.slice(1);
  if (!paths.length) paths = ['.'];
  const secrets = [join(root, '.claude'), join(homedir(), '.claude')];
  return paths.some((p) => { const t = dirAfter(p, dir); return t !== null && secrets.some((s) => holds(t, s)); });
}

// ── Secrets ──

// .env, .env.local and .envrc by name (also quoted, as find -name ".env*" gives it), git show HEAD:.env, *.env*.
// Examples and templates (.env.example) hold no secrets.
// After .env comes rc, a separator or the end: .environment.ts is code, not a secret.
const ENV_NAME = /(^|[\s'"=\\/:])\.env(?!\.(example|sample|template|dist)(?=$|[\s'"`;&|)]))(rc|[.*?[_-][\w.*?[\]-]*)?(?=$|[\s'"`;&|)])|\*\.env\b/i;
// Globs that reach them (cat .e*, cat .en?, cat .*, .claude/.en?.local), only outside quotes, where the shell expands them:
// in grep -n "done .*--answer" the .* is a regex.
const ENV_GLOB = /(^|\s)\.(e[\w.-]*)?[*?[][^\s'"`;&|)]*|(^|[\s=\\/:])\.e[\w.-]*[*?[]/i;
// The Shopify CLI's login folders (shopify-cli-kit-nodejs and friends), with or without a path after them.
export const CLI_LOGIN = /shopify-cli-[\w-]+/i;
// Loading .env into a process the agent runs prints it as surely as cat.
export const DOTENV = /\brequire\(\s*['"]dotenv\b|\bdotenv\/config\b|--env-file\b|\bload_dotenv\b|\b(npx|bunx|dlx)\s+dotenv\b/i;
// Environment variables that hold a token or secret.
const SECRET_VARS = String.raw`JIRA_API_TOKEN|JIRA_USER|DATABASE_URL|SHOPIFY_\w*(?:TOKEN|SECRET|PASSWORD|KEY)\w*|\w*API_SECRET\w*`;
// A token or secret printed from the environment.
export const SECRET_VAR = new RegExp(String.raw`\$\{?(env:)?(${SECRET_VARS})\b`, 'i');
// The same read by name in code: console.log(process.env.JIRA_API_TOKEN), os.environ['…'], GetEnvironmentVariable('…'),
// %NAME%. Boolean(…), !!… and bool(…) only say whether it's set, as the guard's own hint suggests.
export const SECRET_READ = new RegExp(String.raw`(?<!Boolean\(\s*|!!\s*|bool\(\s*)(?:process\.env(?:\.|\[\s*['"])|os\.environ(?:\.get\(\s*|\[\s*)['"]|os\.getenv\(\s*['"]|GetEnvironmentVariable\(\s*['"])(?:${SECRET_VARS})\b|%(?:${SECRET_VARS})%`, 'i');
// Secret file names, for git add/commit checks on staged paths.
export const SECRET_PATH = /(^|\/)\.env(?!\.(example|sample|template|dist)$)(rc|[._-][^/]*)?$|^config\.yml$|\.(sqlite3?|db)(-journal|-wal|-shm)?$|(^|\/)shopify-cli-[\w-]+\//i;
// Variable names whose value is a secret.
const SECRET_NAME = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE_KEY|DATABASE_URL|^JIRA_/i;

// Programs that list names or sizes without reading contents. find counts only without an action that runs or deletes.
const LISTERS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'tree', 'stat', 'test', '[', 'du']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls']);

/**
 * The part of these segments that can read a secret file. A listing (ls .claude/*, find . -name ".env*", git ls-files) reads no
 * contents and a search's pattern (grep -n "\.env" app/) names no file, so both are left out. A segment that
 * substitutes a command stays whole.
 */
export function secretText(segs) {
  return segs.map((s) => {
    if (substitutes(s)) return s;
    const prog = progOf(s);
    if (LISTERS.has(prog) && !/\benv:/i.test(s)) return '';
    if (prog === 'find' && !/\s-(exec|execdir|ok|okdir|delete|fprint\w*|fls)\b/.test(s)) return '';
    // echo .env >> .gitignore names the file without reading it; a redirect into one still counts (echo x > .env).
    if (['echo', 'printf', 'write-output', 'write-host'].includes(prog)) {
      return [...words(stripRedirects(s)).filter((a) => !/^\.env[\w.\\-]*$/i.test(a)), ...(s.match(/\d*>>?\s*\S+/g) || [])].join(' ');
    }
    const g = gitCommand(s);
    // .env hygiene reads no contents: git check-ignore .env, git ls-files .env, git rm --cached .env.
    if (g && (['check-ignore', 'ls-files'].includes(g.sub) || (g.sub === 'rm' && g.args.includes('--cached')))) return '';
    let args;
    let head;
    if (g && ['grep', 'log'].includes(g.sub)) { args = g.args.filter((a) => !/^--grep=/.test(a)); head = `git ${g.sub}`; }
    else if (SEARCHERS.has(prog)) { const { w, i } = program(stripRedirects(s)); args = w.slice(i + 1); head = prog; }
    else return s;
    // The pattern: the value of -e/--regexp/-Pattern/--grep, else (grep, rg, findstr) the first plain word.
    const e = args.findIndex((a) => /^(-e|--regexp|-pattern|--grep|-S|-G)$/i.test(a));
    const drop = e !== -1 ? e + 1 : g?.sub === 'log' ? -1 : args.findIndex((a) => !a.startsWith('-') && !(prog === 'findstr' && a.startsWith('/')));
    // --exclude='.env*' keeps a secret out; whether a recursive search is narrowed is searchesSecrets' call.
    return [head, ...args.filter((a, k) => k !== drop && !/^--(exclude|include)(-dir)?=/.test(a))].join(' ');
  }).join(' ; ');
}

/** True if the text names a secret .env file, or (outside quotes) a glob that reaches one. */
export const envFileIn = (text) => ENV_NAME.test(text) || ENV_GLOB.test(text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""'));

/**
 * A command that prints the whole environment, or a secret variable by name: env, printenv, set, export -p,
 * Get-ChildItem env:, console.log(process.env), node -p process.env, print(os.environ), printenv JIRA_API_TOKEN.
 */
export function dumpsEnv(segment) {
  const s = stripRedirects(segment);
  if (/^\s*(Get-ChildItem|gci|dir|ls|Get-Item|gi)\s+(-Path\s+)?env:/i.test(s) || /\[(System\.)?Environment\]::GetEnvironmentVariables\(/i.test(s)) return true;
  if (/\bconsole\.(log|dir|table)\(\s*process\.env\s*\)|JSON\.stringify\(\s*process\.env\s*[,)]|\bnode(\.exe)?\s+(-p|--print)\s+["']?process\.env["']?(?=\s|$)|\bp?print\(\s*(dict\()?os\.environ\s*\)?\s*\)/.test(s)) return true;
  // Only assignments before the program are prefixes: `export FOO=bar` sets a variable, it doesn't print them.
  const assign = (x) => /^[A-Za-z_]\w*=/.test(x);
  const all = words(s);
  const w = all.slice(all.findIndex((x) => !assign(x)) >>> 0);
  const name = programName(w[0] || '').replace(/\.exe$/i, '').toLowerCase();
  if (name === 'printenv') return w.slice(1).every((a) => a.startsWith('-')) || w.slice(1).some((a) => SECRET_NAME.test(a));
  if (name === 'env') return w.slice(1).filter((a) => !assign(a)).every((a) => a.startsWith('-'));
  if (name === 'set') return w.length === 1;
  if (['export', 'declare', 'typeset'].includes(name)) return w.length === 1 || (w.length === 2 && /^-[px]+$/.test(w[1]));
  return false;
}

export const ENV_DUMP_WHY = 'That prints the environment, which holds tokens (Jira, Shopify, DATABASE_URL). To check that one variable is set without printing it: node -e "console.log(Boolean(process.env.NAME))". jira.mjs --check and shopify.mjs check the logins the kit needs.';

/**
 * Text with tokens blanked, for the guard log: it reaches retro output and the kit-feedback file sent to the maintainer.
 * Atlassian, Shopify, GitHub, npm, Stripe and Slack tokens, Bearer/Basic/token headers, user:pass in -u or a URL,
 * --token/--password values, NAME_TOKEN=… assignments and "token": "…" in JSON.
 */
export const redact = (text) => String(text ?? '')
  .replace(/\bATATT[\w=-]+/g, '[redacted]')
  .replace(/\bshp(at|ca|ss|pa|ua|tka)_[0-9a-fA-F]+/g, '[redacted]')
  .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w+|npm_[A-Za-z0-9]{20,}|[sr]k_(live|test)_\w+|xox[abposr]-[\w-]+)/g, '[redacted]')
  .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]')
  .replace(/(Authorization:\s*token\s+)\S+/gi, '$1[redacted]')
  .replace(/(-u\s+|--user[=\s]+)("[^"]*:[^"]*"|'[^']*:[^']*'|[^\s:'"]+:\S+)/g, '$1[redacted]')
  .replace(/(\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@')
  .replace(/(--(token|password|passwd|pass|secret|api-key|auth-token)[=\s]+)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
  .replace(/(["']\w*(token|secret|password|passwd|api_?key)\w*["']\s*:\s*)("[^"]*"|'[^']*')/gi, '$1"[redacted]"')
  .replace(/\b(\w*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY)\w*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1$3[redacted]');

/** git add -f/--force: it stages files .gitignore keeps out, which in a kit repo means .claude/.env.local. */
export function forceAdd(g) {
  return g?.sub === 'add' && g.args.some((a) => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a));
}

// ── The guard log ──

/** A path as the log shows it: repo-relative inside the repo (no user name in the feedback file), as given outside it. */
export function logPath(p, root) {
  const s = String(p ?? '');
  if (!s) return s;
  const rel = relative(realPath(root), realPath(resolve(root, s.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`))));
  return !rel || rel.startsWith('..') || isAbsolute(rel) ? s : rel.replaceAll('\\', '/');
}

// ── Permission mode and the hook's answer ──

// Modes in which a hook's "ask" reaches the dev. bypassPermissions was seen to approve it silently; dontAsk denies
// every prompt and plan can skip them. acceptEdits only auto-approves file edits, so mutate, gates and git still prompt.
// A mode that isn't listed (including a future one) is treated like bypassPermissions.
export const ASK_SHOWN = new Set(['default', 'auto', 'acceptEdits']);

/** In a mode that hides prompts, an "ask" is a silent allow. Turn it into a deny that says how to get the prompt back. */
export function enforceMode(result, input) {
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

/** The PreToolUse answer on stdout. No output means allow. */
export function emit(result) {
  if (!result) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason },
  }));
  process.exit(0);
}
