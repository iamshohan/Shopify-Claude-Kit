---
description: Set up the Shopify App Kit in this app repo - check the Shopify CLI and plugin, write .claude/app-kit.json (dev store, base branch, app config, verify commands), and check the permission mode shows the kit's prompts. Run once per repo and person.
disable-model-invocation: true
---

# /app-setup

0. **The guard works.** The kit's promises (scenarios first, no deploys, the dev store only) rest on it.
   - Run `node .claude/hooks/guard.mjs --selftest`. It must print "all N passed".
   - Then prove the hook is live in this Claude Code: run `shopify version` with the Bash tool. **It must be blocked** with a message about `.claude/kit/shopify.mjs`.

   If it runs instead, stop. The hook isn't active: Claude Code may be too old for the hook format in `.claude/settings.json` (it needs 2.1.295 or newer for `onFailure`; check with `claude --version`), or the folder isn't trusted yet. The kit isn't safe to use until this is ✓. Node must be 20 or newer (`node --version`).
1. **CLI.** Run `node .claude/kit/shopify.mjs cli-check --force`. No CLI → ask the dev to install it (`npm install -g @shopify/cli`). Problems listed → show them; the kit may not match this CLI version.
2. **Plugin.** The `shopify-plugin:shopify` skill must be available (docs and GraphQL validation). If it isn't, tell the dev to enable `shopify-ai-toolkit@claude-plugins-official`. Then run `node .claude/kit/app.mjs optout`, telling the dev it creates an empty opt-out file for this machine: the plugin otherwise reports prompts and code to shopify.dev. Run `node .claude/kit/app.mjs detect` for the rest.
3. **Settings.** Show the dev `detect`'s suggestion and ask (one AskUserQuestion) about the values that matter:
   - `devStore`: the only store the kit acts on. Default `drip-dev-eho-store.myshopify.com`. Never a client store.
   - `appConfig`: with several `shopify.app.*.toml`, the **dev** app's config, so no CLI call can target production.
   - `baseBranch`, and `verify` (the commands verify runs: lint, typecheck, build and the repo's whole test suite, which is the regression; never deploy or migrate).
   - `securityCheck`: leave it out (verify runs `shopify app security check`); `false` only if the team decides to skip it.
   - `jiraBaseUrl`: e.g. `https://driperium.atlassian.net`. Leave it out if the team doesn't use Jira for this app.
   Then write `.claude/app-kit.json` with the Write tool. The guard shows the dev each setting before it is written.

   **Branch protection.** Check the base branch (and any branch in `protectedBranches`) on GitHub: `gh api repos/<owner>/<repo>/branches/<branch> --jq .protected`. `false` is a ✗: the guard is then the only thing between the agent and that branch. The fix is a branch protection rule requiring PRs, set by a repo admin. Without `gh`, ask the dev to check Settings → Branches.
4. **Mode.** Run `node .claude/hooks/guard.mjs --mode-probe`. If it's blocked, the session's permission mode hides the kit's prompts: ask the dev to switch to default or auto mode (Shift+Tab).
5. **Login.** If `node .claude/kit/shopify.mjs info` fails on a login, ask the dev to run `! shopify auth login`. Don't run it yourself.
6. **Jira** (when `jiraBaseUrl` is set). Run `node .claude/kit/jira.mjs --check`.
   - **`envLocalIgnoredByGit` is false (exit 2):** stop here. A token written into `.claude/.env.local` could be committed. Re-run the kit installer (it writes `.claude/.gitignore`), or add `.claude/` to the repo's `.gitignore`, then check again.
   - **Credentials are missing:** tell the dev to create `.claude/.env.local` with `JIRA_USER=<their Atlassian email>` and `JIRA_API_TOKEN=<API token from id.atlassian.com → Security → API tokens>`, and never to paste the token into chat.
7. **Next:** `appspec/surfaces.json` missing → `/app-onboard`. Otherwise `/app-change`.

Report in at most 6 lines: what was set, what the dev still has to do.
