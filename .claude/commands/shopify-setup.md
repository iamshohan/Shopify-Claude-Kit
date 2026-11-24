---
description: One-time setup of the Shopify Implementation Kit in this repo, per person. Checks tools and logins, writes .claude/shopify-kit.json, installs what this machine is missing, and proves the safety guard is live.
disable-model-invocation: true
---

# /shopify-setup

Setup has two moments that need the dev: confirming the repo's config, and one go-ahead for everything this machine is missing. Everything else runs without questions. Don't report each check as it passes: collect the results and show them once, in the summary. Don't print secrets.

Start with one line: "Checking this repo and machine, then I'll confirm the config with you and list what I'll install."

## 1. Check (no questions)

Run these and keep the results for later steps:

1. **The guard works.** This is the one check that stops setup.
   - `node .claude/hooks/guard.mjs --selftest` must print "all N passed".
   - Prove the hook is live in this Claude Code: run `shopify version` with the Bash tool. **It must be blocked** with a message about `.claude/kit/shopify.mjs`. If it runs instead, stop: the hook isn't active. Claude Code may be too old for the hook format in `.claude/settings.json` (it needs 2.1.295 or newer for `onFailure`; check with `claude --version`), or the folder isn't trusted yet. The kit isn't safe to use until this passes.
   - `node .claude/hooks/guard.mjs --mode-probe` must print "ok". If it's blocked, this session's permission mode hides the kit's confirmation prompts: the dev presses Shift+Tab until the mode is auto (recommended), default or accept edits, and you run it again.
2. **Tools.** `node --version` (20 or newer) and `git --version`. Then `node .claude/kit/shopify.mjs cli-check` (about a minute the first time). It confirms the installed Shopify CLI and plugin still offer everything the kit uses. A missing Shopify plugin is installed in step 3; any other problem it lists means `/shopify-update` before going on.
3. **Logins.** `node .claude/kit/shopify.mjs auth-check`. No store set yet → it can't check; the store is asked in step 2 and auth-check runs again with `--store <it>`.
4. **Repo facts.** `node .claude/kit/recon.mjs`, for the config proposal. Also `git ls-files .playwright-mcp`: any output means Playwright's output folder (page text, console logs, preview URLs) is already in git. The installer only keeps new files out (`.git/info/exclude`), so that's a ✗ for the summary.
5. **Jira.** `node .claude/kit/jira.mjs --check`. **`envLocalIgnoredByGit` false (exit 2):** a token written into `.claude/.env.local` could be committed. That's a ✗ to fix before the dev creates the file: re-run the kit installer (it writes `.claude/.gitignore`), or add `.claude/` to the repo's `.gitignore`.
6. **This machine** (each is shared by every theme repo on it):
   - **Shopify plugin:** is the `shopify-plugin:shopify` skill in your skill list? Listing it in `.claude/settings.json` doesn't install it.
   - **Telemetry opt-out:** does `kit.mjs optout` still need to run? (It's cheap: just run it in step 3.)
   - **`kit-browser`** (the storefront browser, isolated and logged in nowhere): are the `mcp__kit-browser__*` tools available?
   - **Claude in Chrome** (the admin and theme editor, in the dev's own Chrome): are the `mcp__claude-in-chrome__*` tools available? This one can't be installed from here.
   - **Video tools:** `node .claude/kit/video.mjs check`.

## 2. Config (`.claude/shopify-kit.json`): the dev confirms

If the file exists, show it and ask once whether it's still right. Otherwise propose every value and confirm them in **one** AskUserQuestion round (up to 4 questions: the values as a whole, plus only what you can't decide: the store when nothing names it, the draft route, the Admin API login).

- `store`: the store's `*.myshopify.com` domain. **Ask the dev; never take it from the CLI.** auth-check's `cliLastStore` is only the store the CLI was last used with, often the previous project's. Show it as a hint, next to any store this repo names itself (`shopify.theme.toml`, `package.json` scripts with `--store`), and say so when they differ.
- `storefrontUrl`: the primary domain, from auth-check's `shop.primaryDomain` once the Admin login works. Optional.
- `jiraBaseUrl`: e.g. `https://driperium.atlassian.net`
- `ticketPrefixes`: e.g. `["ABC"]`
- `baseBranch`: the branch the live theme follows (recon `defaultBranch`, and the branch with "Update from Shopify" commits)
- `protectedBranches`: the base branch, plus any branch a CI workflow deploys from (recon `deploy.workflows`) and any branch a published theme is connected to through Shopify's GitHub app (pushing to it changes that theme). Check each one on GitHub: `gh api repos/<owner>/<repo>/branches/<branch> --jq .protected`. `false` is a ✗ for the summary: the guard is then the only thing between the agent and that branch; the fix is a branch protection rule requiring PRs, set by a repo admin. Without `gh`, list it as something for the dev to check (Settings → Branches).
- `branchPattern`: from recon's recent branches, e.g. `{KEY}` → `ABC-123`, or `{key}__dev`
- `commitPattern`: from recon's commit subjects, e.g. `{key}__dev: <what changed>`
- `adminApiVersion`: `2026-07` unless the dev says otherwise. Shopify supports each version for about a year.
- `draftRoute`: how the task's draft theme is made.
  - `"github"`: recon shows "Update from Shopify" commits, so the store's themes are connected to this repo through Shopify's GitHub app. Each task's draft is a theme the dev connects to the task branch (Online Store → Themes → Add theme → Connect from GitHub, about a minute per task). The draft always equals the branch, and customizer saves on it come back as commits. Recommend it when recon shows the sync commits; it needs the Themes permission and write access to the repo on GitHub.
  - `"cli"`: the kit copies the live theme with the CLI and uploads the branch's files. For a repo that isn't connected, or a dev who can't connect branches.
- `chromeWithoutAsking`: admin steps the agent does in the dev's Chrome without asking each time (the standing yes). `"connect-draft"` when `draftRoute` is `"github"`, `"definitions"` when `adminApi` is `false`; otherwise `[]`. Only these two can be listed: Gate 1 already approved the branch and the definitions. The checkout copy always asks.
- `adminApi`: whether the kit gets an Admin API login. This is a real choice, because `shopify store auth` installs Shopify's CLI app on the store (once per store, by someone allowed to install apps; on a client store the client may need to agree first):

  | Choice | Login command (the dev runs it, see step 4) | Config |
  | --- | --- | --- |
  | Full: the kit reads store data and creates definitions after the dev approves each one | the `adminLoginFix` command from auth-check | `adminApi: true` |
  | Read-only: the kit reads store data; the dev creates definitions in the admin | the same command with only the `read_…` scopes | `adminApi: true` |
  | None: nothing is installed. Definitions are made by hand in the admin, and the kit reads admin pages in Chrome. | none | `adminApi: false` |

  Already logged in (auth-check) → `true`, no question. Re-running the command adds scopes (`adminScopesFix` and `investigateScopesFix` list missing ones); removing one means uninstalling the app in Settings → Apps and logging in again. Without it, everything theme-related works the same; store data gets slower and less exact.

Write the file with the Write tool. The guard asks the dev first and lists each setting that changes, because these settings decide which store the kit acts on, which branches it protects and where the Jira token goes:
```json
{ "store": "", "storefrontUrl": "", "jiraBaseUrl": "", "ticketPrefixes": [], "baseBranch": "main",
  "protectedBranches": ["main"], "branchPattern": "{KEY}", "commitPattern": "{key}__dev: <what changed>",
  "adminApiVersion": "2026-07", "adminApi": false, "draftRoute": "cli", "chromeWithoutAsking": ["definitions"] }
```
Then run `auth-check` again if the store was new, for the summary. A `storeMismatch` in its output (the storefront belongs to another store than `store`) stops setup: show it to the dev and fix whichever value is wrong before going on.

## 3. Install what this machine is missing: one go-ahead

Collect everything step 1.6 found missing, from this list, in this order:

| Missing | Command (run it yourself) |
| --- | --- |
| Shopify plugin | `claude plugin install shopify-ai-toolkit@claude-plugins-official` |
| Telemetry opt-out (always) | `node .claude/kit/kit.mjs optout`: an empty file that stops the plugin reporting prompts and code to shopify.dev |
| `kit-browser` | `claude mcp add kit-browser --scope user -- npx -y @playwright/mcp@0.0.83 --isolated --headless --snapshot-mode none` |
| Video tools (for `/shopify-video`, about 100 MB outside the repo) | `node .claude/kit/video.mjs setup` |

`--snapshot-mode none` stops a full page snapshot (about 4k tokens on a product page) after every click and resize, which QA never reads. Don't substitute the dev's own Playwright server: it may drive their logged-in Chrome (`--extension`), and storefront QA needs `kit-browser`.

Show the list as one short message, a line per item with what it's for, e.g. "I'll install on this machine (for every theme repo): the Shopify plugin (Shopify docs and validation); kit-browser (the isolated storefront browser QA uses); the video tools (~100 MB, for /shopify-video); plus the telemetry opt-out. Say if you don't want any of them." Then one AskUserQuestion: **Install all (Recommended)** / **Leave some out**. Leave some out → the dev names them in the "Other" box or in chat; install the rest.

Run the commands one by one and check each one's output. Verify without a restart: `claude plugin list` shows the plugin, `claude mcp get kit-browser` shows the args, `video.mjs check` shows the tools. A command that fails or is refused → keep going with the rest, and put that command, with `!` in front, in the summary.

Nothing to install → skip this step without a question.

## 4. Summary

One compact block:

- **Ready** (✓, one line each): the guard, CLI, logins, config, and what was installed.
- **Needs you** (only what can't be done for the dev, each with its exact command; leave out the section when it's empty):
  - **Restart Claude Code** once, if step 3 installed the plugin or `kit-browser`: new tools load at startup. No need to run `/shopify-setup` again.
  - **Theme login** missing → `! shopify theme list --store <store>` (a browser login: the guard blocks the agent from running it). The `!` prefix runs it here; any terminal works without it.
  - **Admin API login**, if the dev chose Full or Read-only and it's missing → the command from step 2, with `!`. Afterwards `auth-check` confirms it.
  - **Jira**, when credentials are missing: create `~/.claude/.env` once (it covers every kit repo on this machine) with these two lines, and never paste the token into chat (without a token the kit still works from pasted ticket text):
    ```
    JIRA_USER=<their Atlassian email>
    JIRA_API_TOKEN=<API token from id.atlassian.com → Security → API tokens>
    ```
    `.claude/.env.local` holds the same lines when this repo needs another Jira account; it wins over `~/.claude/.env`. Leave `JIRA_BASE_URL` out of `~/.claude/.env`: there it would override `jiraBaseUrl` in every repo.
  - **Claude in Chrome** missing → install the extension; the dev logs into the store admin in that Chrome profile and gives it site access to the storefront domain and `admin.shopify.com`. Without it, customizer checks are BLOCKED.
  - **`.playwright-mcp/` in git** → `! git rm -r --cached .playwright-mcp`, then commit that on a branch and merge it the usual way (the files stay on disk).
  - A protected branch GitHub doesn't protect, an install that failed, anything else that's ✗.
- End with: "Ready. Start a task with /shopify-implement <KEY>, or investigate with /shopify-investigate <KEY or question>. If anything above looks wrong, or you don't want something I set up, tell me." When something under Needs you blocks tasks (the theme login, a restart), say "Ready once you've done the steps above".
