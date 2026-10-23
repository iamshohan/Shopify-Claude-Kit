---
description: One-time setup of the Shopify Implementation Kit in this repo, per person. Checks tools and logins, writes .claude/shopify-kit.json, and proves the safety guard is live.
disable-model-invocation: true
---

# /shopify-setup

Work through these checks in order. Report each one as ✓ or ✗ with the exact fix. Never skip a ✗ silently. Don't print secrets.

1. **The guard works.**
   - Run `node .claude/hooks/guard.mjs --selftest`. It must print "all N passed".
   - Then prove the hook is live in this Claude Code: run `shopify version` with the Bash tool. **It must be blocked** with a message about `.claude/kit/shopify.mjs`.

   If it runs instead, stop. The hook isn't active: Claude Code may be too old for the hook format in `.claude/settings.json` (it needs 2.1.295 or newer for `onFailure`; check with `claude --version`), or the folder isn't trusted yet. The kit isn't safe to use until this is ✓.
2. **Tools.** Run `node --version` (needs 20 or newer) and `git --version`.

   Then run `node .claude/kit/shopify.mjs cli-check --force` (about a minute). It confirms that the installed Shopify CLI and plugin still offer every command, flag and output field the kit uses. Any problem it lists means: run `/shopify-update` before going on.

   Then run `node .claude/kit/shopify.mjs auth-check` and report each line it prints.
3. **Repo facts.** Run `node .claude/kit/recon.mjs`. Use its output to propose the config in step 4.
4. **Config** (`.claude/shopify-kit.json`). If it exists, show it and ask whether it's still right. Otherwise propose these values and confirm them with the dev in one AskUserQuestion round:
   - `store`: the store's `*.myshopify.com` domain (from auth-check)
   - `storefrontUrl`: the primary domain, from auth-check's `shop.primaryDomain` once the Admin login works. Optional.
   - `jiraBaseUrl`: e.g. `https://driperium.atlassian.net`
   - `ticketPrefixes`: e.g. `["ABC"]`
   - `baseBranch`: the branch the live theme follows (recon `defaultBranch`, and the branch with "Update from Shopify" commits)
   - `protectedBranches`: the base branch, plus any branch a CI workflow deploys from (recon `deploy.workflows`) and any branch a published theme is connected to through Shopify's GitHub app (pushing to it changes that theme). Then check each one on GitHub: `gh api repos/<owner>/<repo>/branches/<branch> --jq .protected`. `false` is a ✗: the guard is then the only thing between the agent and that branch. The fix is a branch protection rule requiring PRs, set by a repo admin. Without `gh`, ask the dev to check Settings → Branches.
   - `branchPattern`: from recon's recent branches, e.g. `{KEY}` → `ABC-123`, or `{key}__dev`
   - `commitPattern`: from recon's commit subjects, e.g. `{key}__dev: <what changed>`
   - `adminApiVersion`: `2026-07` unless the dev says otherwise. Shopify supports each version for about a year.
   - `adminApi`: `true` if the Admin API login works (step 6), else `false`. See step 6.
   - `draftRoute`: how the task's draft theme is made.
     - `"github"`: recon shows "Update from Shopify" commits, so the store's themes are connected to this repo through Shopify's GitHub app. Each task's draft is then a theme the dev connects to the task branch (Online Store → Themes → Add theme → Connect from GitHub, about a minute per task). The draft always equals the branch, and customizer saves on it come back as commits.
     - `"cli"`: the kit copies the live theme with the CLI and uploads the branch's files. Use this when the repo isn't connected, or the dev can't connect branches.

     Recommend `"github"` when recon shows the sync commits. Confirm it with the dev: connecting needs the Themes permission and write access to the repo on GitHub.

   Write the file with the Write tool. The guard asks the dev first and lists each setting that changes, because these settings decide which store the kit acts on, which branches it protects and where the Jira token goes:
   ```json
   { "store": "", "storefrontUrl": "", "jiraBaseUrl": "", "ticketPrefixes": [], "baseBranch": "main",
     "protectedBranches": ["main"], "branchPattern": "{KEY}", "commitPattern": "{key}__dev: <what changed>",
     "adminApiVersion": "2026-07", "adminApi": false, "draftRoute": "cli" }
   ```
5. **Jira.** Run `node .claude/kit/jira.mjs --check`.
   - **`envLocalIgnoredByGit` is false (exit 2):** stop here. A token written into `.claude/.env.local` could be committed. The fix is to re-run the kit installer, which writes `.claude/.gitignore`, or to add `.claude/` to the repo's `.gitignore`. Then check again.
   - **Credentials are missing:** tell the dev to create `.claude/.env.local` with these two lines, and never to paste the token into chat:
   ```
   JIRA_USER=<their Atlassian email>
   JIRA_API_TOKEN=<API token from id.atlassian.com → Security → API tokens>
   ```
   Without a token the kit still works if they paste the ticket text.
6. **Shopify logins.** These are browser logins, so the dev runs them with the `!` prefix (the guard blocks the agent from running them):
   - Theme login missing → `! shopify theme list --store <store>`
   - **Admin API login (optional).** `shopify store auth` installs Shopify's CLI app on the store, then stores a token for this dev.
     - It needs someone allowed to install apps, and it has to be done once per store. On a client store, the client may need to agree first.
     - Ask the dev which they want:

     | Choice | Command | Config |
     | --- | --- | --- |
     | Full: the kit reads store data and creates definitions after the dev approves each one | the `adminLoginFix` command from auth-check | `adminApi: true` |
     | Read-only: the kit reads store data; the dev creates definitions in the admin | the same command with only the `read_…` scopes | `adminApi: true` |
     | None: nothing is installed. Definitions are made by hand in the admin, and the kit reads admin pages in Chrome. | none | `adminApi: false` |

     - With the login in place, `adminScopesFix` and `investigateScopesFix` list missing scopes. Re-running the command adds scopes: the CLI merges them with the ones already granted. Removing a scope means uninstalling the app in Settings → Apps and logging in again.
     - Without it, everything theme-related works the same. Store data gets slower and less exact.

   The login command can be typed in Claude Code with the `!` prefix (the output lands in the chat), or run in any terminal without the `!`.

   The dev also needs a staff account on the store with theme permissions, and the right to manage metafields and metaobjects (or someone who has it, for the manual path). Re-run auth-check afterwards, and make sure `adminApi` in the config matches the result.
7. **Shopify plugin.**
   - Check that the `shopify-plugin:shopify` skill is in your skill list. Listing it in `.claude/settings.json` doesn't install it. If it's missing, the dev runs `! claude plugin install shopify-ai-toolkit@claude-plugins-official` and restarts Claude Code.
   - Then run `node .claude/kit/kit.mjs optout`, telling the dev it creates an empty opt-out file for this machine. The plugin otherwise reports prompts and code to shopify.dev.
8. **Browsers.** The kit uses two, and keeps them apart: the storefront in an isolated browser that is logged in nowhere, the admin and theme editor in the dev's Chrome.
   - **Storefront: `kit-browser`.** Check that the `mcp__kit-browser__*` tools are available. If not, the dev adds the server once per machine (it serves every theme repo), then restarts Claude Code:
     ```
     ! claude mcp add kit-browser --scope user -- npx -y @playwright/mcp@0.0.83 --isolated --headless
     ```
     Don't substitute the dev's own Playwright server: it may drive their logged-in Chrome (`--extension`). Without `kit-browser`, storefront QA runs in Chrome and the dev sets each viewport by hand.
   - **Admin and theme editor: Claude in Chrome.** Check that the `mcp__claude-in-chrome__*` tools are available.
   - The dev must be logged into the store admin in that Chrome profile.
   - The extension needs site access to the storefront domain and `admin.shopify.com`.

   Without Chrome, customizer checks are BLOCKED.
9. **Summary.** List what works and what's missing. If everything is ✓, end with: "Ready. Start a task with /implement <KEY>, or investigate with /shopify-investigate <KEY or question>."
