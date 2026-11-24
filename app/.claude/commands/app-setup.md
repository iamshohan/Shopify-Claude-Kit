---
description: Set up the Shopify App Kit in this app repo and onboard the app - check the CLI and the guard, make an untouched app template extension-only if that's what the app is, write .claude/app-kit.json, and record the app's surfaces in appspec/. Run again any time for a health check (surfaces changed outside the kit, ledgered tests gone, stale changes).
argument-hint: [--regression]
disable-model-invocation: true
---

# /app-setup $ARGUMENTS

**Aim: at most three things from the dev:** confirming the settings (the guard's prompt on `app-kit.json`), the logins, and creating a dev app when there isn't one. Decide everything else and say what you decided (`.claude/rules/app-runs.md`). The first real run took about 25 dev interactions; don't repeat that.

**Already set up** (`.claude/app-kit.json` and `appspec/surfaces.json` exist): this is a health check. Run step 0 and step 9 only.

0. **The guard works.** The kit's promises (scenarios first, no deploys, the dev store only) rest on it.
   - Run `node .claude/hooks/guard.mjs --selftest`. It must print "all N passed".
   - Then prove the hook is live in this Claude Code: run `shopify version` with the Bash tool. **It must be blocked** with a message about `.claude/kit/shopify.mjs`.

   If it runs instead, stop. The hook isn't active: Claude Code may be too old for the hook format in `.claude/settings.json` (it needs 2.1.295 or newer for `onFailure`; check with `claude --version`), or the folder isn't trusted yet. The kit isn't safe to use until this is ✓. Node must be 20 or newer (`node --version`).
1. **CLI and plugin.** Run `node .claude/kit/shopify.mjs cli-check --force`. No CLI → ask the dev to install it (`npm install -g @shopify/cli`). Problems listed → show them. The `shopify-plugin:shopify` skill must be available; if it isn't, tell the dev to enable `shopify-ai-toolkit@claude-plugins-official`. Run `node .claude/kit/app.mjs optout` (an empty opt-out file for this machine: the plugin otherwise reports prompts and code to shopify.dev) and `node .claude/kit/app.mjs detect`.
2. **The app's config: dev and production.** A lone `shopify.app.toml` is the **production** app's config until shown otherwise. The dev creates a dev app: `! shopify app config link`, "Create a new app", named "<app name> (dev)". The new `shopify.app.<name>.toml` holds little more than `client_id`, `name` and scopes: copy the production toml's other sections into it yourself with the Edit tool (keep the new `client_id`, `name` and `handle`), show the dev the diff, and run `node .claude/kit/shopify.mjs validate`.
3. **Extension-only, before onboarding.** An app with no backend of its own (only checkout or theme extensions, Functions) is **extension-only**. `detect` says `untouchedTemplate: true` when the repo is Shopify's app template with only the scaffold commit (`app/routes/`, `prisma/`, a `Dockerfile`). Untouched template, and the ticket or the dev says extension-only → strip it here, before onboarding, without a change or a gate (nothing is recorded yet, so nothing is lost):
   - delete `app/`, `prisma/`, `Dockerfile`, `.dockerignore`, `shopify.web.toml`, `vite.config.*`, `tsconfig.json` if only the backend used it, and the backend's `package.json` scripts and dependencies (keep the workspace and what the extensions need), then reinstall to regenerate the lockfile;
   - make both tomls match `.claude/kit/templates/extension-only.app.toml` outside `client_id`, `name` and `handle` (Shopify's default app home and `[auth]` redirect, no scopes, no webhook subscriptions);
   - `node .claude/kit/shopify.mjs validate`, then commit on `kit-onboard` ("Make the app extension-only").
   Tell the dev in one line what you removed. Onboarding the template instead recorded 43 surfaces in the first real run, and removing them took a full change with two gates.
4. **Settings: decide them, then write `.claude/app-kit.json` with the Write tool.** The guard shows the dev every value before it's written; that prompt is the confirmation, so don't ask first.
   - `devStore`: `drip-dev-eho-store.myshopify.com` unless the repo names another dev store. Never a client store.
   - `appConfig`: the dev app's config from step 2, so no CLI call can target production.
   - `baseBranch`: the remote's default branch. `verify`: what `detect` suggests (lint, typecheck, build, the repo's test suite; never deploy or migrate).
   - `jiraBaseUrl`: `https://driperium.atlassian.net` unless the repo or the ticket names another. `securityCheck`: leave it out.
5. **Onboard.** On `kit-onboard` (`git switch -c kit-onboard --no-track origin/<baseBranch>`, or the branch step 3 committed on; carry the dev toml and setup's own edits along, they're expected):
   - `node .claude/kit/app.mjs onboard`: it creates `appspec/`, `surfaces.json` from the configs and the security baseline. A wrong baseline (the dev toml still empty): fix the cause, then `onboard --redo` while `appspec/` isn't committed.
   - Fill `appspec/project.md`, a few factual lines per section, from the repo's own `README.md`, `CLAUDE.md`, `AGENTS.md` and configs ("unknown" rather than a guess).
   - Commit `appspec/` and push: `git push -u origin kit-onboard`. Give the dev the merge link onboard prints. **The first change doesn't wait for that merge**: it stacks on `kit-onboard` and is measured from it, and its PR follows the onboarding's.
6. **Branch protection.** `gh api repos/<owner>/<repo>/branches/<base> --jq .protected`. `false`, or unknown without `gh`, is a ✗ under "Needs you": GitHub → the repo → Settings → Branches → a rule on the base branch requiring a PR. In the first real run, a direct push to `main` went through.
7. **Mode and logins.** `node .claude/hooks/guard.mjs --mode-probe`: blocked means the session's mode hides the kit's prompts (bypass, dontAsk, plan); not a stop. Tell the dev in the summary that mutations, migrations and settings changes are refused until they switch with Shift+Tab to auto (recommended), default or accept edits. `node .claude/kit/shopify.mjs info` fails on a login → the dev runs `! shopify auth login`. `git ls-files .playwright-mcp` shows files → the dev runs `! git rm -r --cached .playwright-mcp` on a branch.
8. **Jira** (when `jiraBaseUrl` is set): `node .claude/kit/jira.mjs --check`.
   - **`envLocalIgnoredByGit` is false (exit 2):** stop. Re-run the kit installer (it writes `.claude/.gitignore`), or add `.claude/` to the repo's `.gitignore`.
   - **Credentials missing:** the dev creates `~/.claude/.env` once per machine with `JIRA_USER=<their Atlassian email>` and `JIRA_API_TOKEN=<token from id.atlassian.com → Security → API tokens>`, never pasted into chat. `.claude/.env.local` is only for a repo that needs another Jira account.
9. **Health check** (every run, and the whole job on a re-run): `node .claude/kit/app.mjs drift` (add `--regression` when the arguments include it, or before a release: it runs every ledgered test). Report surfaces changed outside the kit, ledgered tests that fail or are gone (a `/app-implement` fixes or retires them), a missing security baseline, and open changes untouched for two weeks (continue or abandon each: the dev's call).

Report in at most 8 lines: what was set and decided, what the dev still has to do, and that `/app-implement <KEY>` is next.
