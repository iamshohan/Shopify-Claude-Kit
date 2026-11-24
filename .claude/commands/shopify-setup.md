---
description: One-time setup of the Shopify Implementation Kit in this repo, per person. Checks tools and logins, writes .claude/shopify-kit.json, installs what this machine is missing, and proves the safety guard is live.
disable-model-invocation: true
---

# /shopify-setup

Setup has two moments that need the dev: confirming the repo's config, and one go-ahead for everything this machine is missing. Everything else runs without questions. Don't report each check as it passes: show the results once, in the summary. Don't print secrets.

Start with one line: "Checking this repo and machine, then I'll confirm the config with you and list what I'll install."

## 1. Check (no questions)

1. **The guard works.** This is the one check that stops setup.
   - `node .claude/hooks/guard.mjs --selftest` must print "all N passed".
   - Run `shopify version` with the Bash tool: **it must be blocked** with a message about `.claude/kit/shopify.mjs`. If it runs, stop: the hook isn't active (Claude Code too old for the hook format, it needs 2.1.295 or newer for `onFailure`; or the folder isn't trusted yet). The kit isn't safe to use until this passes.
   - `node .claude/hooks/guard.mjs --mode-probe`: "ok" means the kit's prompts show. Blocked means this session's mode hides them (bypass, dontAsk, plan). That doesn't stop setup: put one line in the summary's Ready block, "Bypass mode: store writes, deleting the draft and picking a theme are refused until you switch with Shift+Tab to auto (recommended), default or accept edits; everything else runs."
2. **Tools.** `node --version` (20 or newer), `git --version`, then `node .claude/kit/shopify.mjs cli-check` (about a minute the first time): the installed CLI and plugin still offer what the kit uses. A missing plugin is installed in step 3; any other problem it lists means `/shopify-update` first.
3. **Logins.** `node .claude/kit/shopify.mjs auth-check` (no store yet: run it again with `--store <it>` after step 2).
4. **Repo facts.** `node .claude/kit/recon.mjs`, for the config proposal. `git ls-files .playwright-mcp`: any output means Playwright's output (page text, preview URLs) is already in git, a ✗ for the summary.
5. **Jira.** `node .claude/kit/jira.mjs --check`. `envLocalIgnoredByGit` false (exit 2): a token in `.claude/.env.local` could be committed, a ✗ to fix before the dev creates it (re-run the installer, or add `.claude/` to `.gitignore`).
6. **This machine** (shared by every theme repo on it):
   - **Shopify plugin:** is the `shopify-plugin:shopify` skill in your skill list? (Listing it in settings.json doesn't install it.)
   - **Telemetry opt-out:** run `kit.mjs optout` in step 3 (it's cheap).
   - **`kit-browser`:** are the `mcp__kit-browser__*` tools available?
   - **Claude in Chrome:** are the `mcp__claude-in-chrome__*` tools available? It can't be installed from here.
   - **Video tools:** `node .claude/kit/video.mjs check`.

## 2. Config (`.claude/shopify-kit.json`): the dev confirms

If the file exists, show it and ask once whether it's still right (add `chromeWithoutAsking` if it's missing, without asking). Otherwise propose every value and confirm them in **one** AskUserQuestion round (up to 4 questions: the values as a whole, plus only what you can't decide: the store when nothing names it, the draft route, the Admin API login).

- `store`: the `*.myshopify.com` domain. **Ask the dev; never take it from the CLI.** auth-check's `cliLastStore` is only the store the CLI last used, often the previous project's: show it as a hint next to any store this repo names (`shopify.theme.toml`, `--store` in `package.json` scripts), and say when they differ.
- `storefrontUrl`: the primary domain, from auth-check's `shop.primaryDomain` once the Admin login works. Optional.
- `jiraBaseUrl`: e.g. `https://driperium.atlassian.net`
- `ticketPrefixes`: e.g. `["ABC"]`
- `baseBranch`: the branch the live theme follows (recon `defaultBranch`, the branch with "Update from Shopify" commits)
- `protectedBranches`: the base branch, plus any branch a CI workflow deploys from (recon `deploy.workflows`) and any branch a published theme is connected to through Shopify's GitHub app. Check each on GitHub: `gh api repos/<owner>/<repo>/branches/<branch> --jq .protected`. `false` is a ✗ (the fix: a branch protection rule requiring PRs, set by a repo admin); without `gh`, list it for the dev to check (Settings → Branches).
- `branchPattern`: from recon's recent branches, e.g. `{KEY}` → `ABC-123`, or `{key}__dev`
- `commitPattern`: from recon's commit subjects, e.g. `{key}__dev: <what changed>`
- `adminApiVersion`: `2026-07` unless the dev says otherwise (each version is supported for about a year).
- `draftRoute`: how the task's draft is made.
  - `"github"`: recon shows "Update from Shopify" commits (the themes are connected to this repo through Shopify's GitHub app). Each task's draft is a theme the dev connects to the task branch (about a minute per task); it always equals the branch, and customizer saves come back as commits. Recommend it when recon shows the sync commits; it needs the Themes permission and write access on GitHub.
  - `"cli"`: the kit copies the live theme and uploads the branch's files. For a repo that isn't connected.
- `chromeWithoutAsking`: always `["connect-draft", "definitions"]`, the admin steps the agent does in the dev's Chrome without asking each time (Gate 1 already approved them). Don't ask about it: set it, also when a re-run finds it missing, and say so in the summary. Only these two can be listed; the checkout copy always asks.
- `adminApi`: a real choice, because `shopify store auth` installs Shopify's CLI app on the store (once per store, by someone allowed to install apps; on a client store the client may need to agree):

  | Choice | Login command (the dev runs it, see step 4) | Config |
  | --- | --- | --- |
  | Full: the kit reads store data and creates definitions after the dev approves each one | the `adminLoginFix` command from auth-check | `adminApi: true` |
  | Read-only: the kit reads store data; the dev creates definitions in the admin | the same command with only the `read_…` scopes | `adminApi: true` |
  | None: nothing is installed. Definitions are made by hand, and the kit reads admin pages in Chrome. | none | `adminApi: false` |

  Already logged in (auth-check) → `true`, no question. Re-running the command adds scopes (`adminScopesFix` and `investigateScopesFix` list missing ones). Without it, everything theme-related works the same; store data gets slower and less exact.

Write the file with the Write tool (the guard shows the dev the store, branch and Jira settings before it's written):
```json
{ "store": "", "storefrontUrl": "", "jiraBaseUrl": "", "ticketPrefixes": [], "baseBranch": "main",
  "protectedBranches": ["main"], "branchPattern": "{KEY}", "commitPattern": "{key}__dev: <what changed>",
  "adminApiVersion": "2026-07", "adminApi": false, "draftRoute": "cli", "chromeWithoutAsking": ["connect-draft", "definitions"] }
```
Run `auth-check` again if the store was new. A `storeMismatch` (the storefront belongs to another store than `store`) stops setup: show it and fix whichever value is wrong.

## 3. Install what this machine is missing: one go-ahead

Collect everything step 1.6 found missing, in this order:

| Missing | Command (run it yourself) |
| --- | --- |
| Shopify plugin | `claude plugin install shopify-ai-toolkit@claude-plugins-official` |
| Telemetry opt-out (always) | `node .claude/kit/kit.mjs optout`: stops the plugin reporting prompts and code to shopify.dev |
| `kit-browser` | `claude mcp add kit-browser --scope user -- npx -y @playwright/mcp@0.0.83 --isolated --headless --snapshot-mode none` |
| Video tools (for `/shopify-video`, about 100 MB outside the repo) | `node .claude/kit/video.mjs setup` |

(`--snapshot-mode none` stops a full page snapshot after every click, which QA never reads. Don't substitute the dev's own Playwright server: it may drive their logged-in Chrome.)

Show the list as one short message, a line per item with what it's for ("I'll install on this machine (for every theme repo): the Shopify plugin (Shopify docs and validation); kit-browser (the isolated storefront browser QA uses); the video tools (~100 MB, for /shopify-video); plus the telemetry opt-out. Say if you don't want any of them."), then one AskUserQuestion: **Install all (Recommended)** / **Leave some out** (the dev names them; install the rest).

Run the commands one by one and check each output; verify without a restart (`claude plugin list`, `claude mcp get kit-browser`, `video.mjs check`). A command that fails or is refused: keep going, and put it, with `!` in front, in the summary. Nothing to install: skip this step without a question.

## 4. Summary

One compact block:

- **Ready** (✓, one line each): the guard, CLI, logins, config, and what was installed.
- **Applied for you** (one line): "In your Chrome without asking each time: connecting the draft theme to the task branch, and creating the plan's definitions (both approved at Gate 1). Remove `chromeWithoutAsking` from `.claude/shopify-kit.json` to be asked again."
- **Needs you** (only what can't be done for the dev, each with its exact command; leave it out when empty):
  - **Restart Claude Code** once, if step 3 installed the plugin or `kit-browser` (no need to run `/shopify-setup` again).
  - **Theme login** missing → `! shopify theme list --store <store>` (a browser login the guard blocks the agent from running).
  - **Admin API login**, if the dev chose Full or Read-only and it's missing → the command from step 2, with `!`; `auth-check` confirms it afterwards.
  - **Jira**, when credentials are missing: create `~/.claude/.env` once (it covers every kit repo on this machine) with these two lines, and never paste the token into chat (without one the kit still works from pasted ticket text):
    ```
    JIRA_USER=<their Atlassian email>
    JIRA_API_TOKEN=<API token from id.atlassian.com → Security → API tokens>
    ```
    `.claude/.env.local` holds the same lines when this repo needs another Jira account, and wins. Leave `JIRA_BASE_URL` out of `~/.claude/.env`: there it overrides `jiraBaseUrl` in every repo.
  - **Claude in Chrome** missing → install the extension, log into the store admin in that Chrome profile, and give it site access to the storefront and `admin.shopify.com`. Without it, customizer checks are BLOCKED.
  - **`.playwright-mcp/` in git** → `! git rm -r --cached .playwright-mcp`, committed on a branch and merged the usual way.
  - A protected branch GitHub doesn't protect, an install that failed, anything else that's ✗.
- End with: "Ready. Start a task with /shopify-implement <KEY>, or investigate with /shopify-investigate <KEY or question>. If anything above looks wrong, or you don't want something I set up, tell me." When something under Needs you blocks tasks (the theme login, a restart), say "Ready once you've done the steps above".
