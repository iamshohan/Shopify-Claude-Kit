---
description: Set up the Shopify App Kit in this app repo and onboard the app - check the CLI and the guard, make an untouched app template extension-only if that's what the app is, write .claude/app-kit.json, and record the app's surfaces in appspec/. Run again any time for a health check (surfaces changed outside the kit, ledgered tests gone, stale changes).
argument-hint: [--regression]
disable-model-invocation: true
---

# /app-setup $ARGUMENTS

**At most three things from the dev:** confirming the settings (the guard's prompt on `app-kit.json`), the logins, and creating a dev app when there isn't one. Decide everything else and say what you decided.

**Already set up** (`.claude/app-kit.json` and `appspec/surfaces.json` exist): this is a health check. Run step 0 and step 9 only.

0. **The guard works** (the kit's promises rest on it): `node .claude/hooks/guard.mjs --selftest` prints "all N passed", and `shopify version` run with the Bash tool **is blocked** with a message about `.claude/kit/shopify.mjs`. If it runs instead, stop: the hook isn't active (Claude Code older than 2.1.295, which `onFailure` needs, or the folder isn't trusted yet). Node must be 20 or newer.
1. **CLI and plugin.** `node .claude/kit/shopify.mjs cli-check --force`. No CLI → the dev installs it (`npm install -g @shopify/cli`). Problems listed → show them. The `shopify-plugin:shopify` skill must be available; if it isn't, the dev enables `shopify-ai-toolkit@claude-plugins-official`. Then `node .claude/kit/app.mjs optout` (stops the plugin reporting prompts and code to shopify.dev) and `node .claude/kit/app.mjs detect`.
2. **The app's config: dev and production.** A lone `shopify.app.toml` is the **production** app's config until shown otherwise. The dev creates a dev app: `! shopify app config link`, "Create a new app", named "<app name> (dev)". The new `shopify.app.<name>.toml` holds little more than `client_id`, `name` and scopes: copy the production toml's other sections into it with the Edit tool (keep the new `client_id`, `name` and `handle`), show the dev the diff, and run `node .claude/kit/shopify.mjs validate`.
3. **Extension-only, before onboarding.** An app with no backend of its own (only checkout or theme extensions, Functions) is **extension-only**. `detect` says `untouchedTemplate: true` for Shopify's app template with only the scaffold commit. Untouched template, and the ticket or the dev says extension-only → strip it here, before onboarding, without a change or a gate (onboarding the template first recorded 43 surfaces in the first real run, and removing them took a change with two gates):
   - delete `app/`, `prisma/`, `Dockerfile`, `.dockerignore`, `shopify.web.toml`, `vite.config.*`, `tsconfig.json` if only the backend used it, and the backend's `package.json` scripts and dependencies (keep the workspace and what the extensions need), then reinstall to regenerate the lockfile;
   - make both tomls match `.claude/kit/templates/extension-only.app.toml` outside `client_id`, `name` and `handle`;
   - `node .claude/kit/shopify.mjs validate`, then commit on `kit-onboard` ("Make the app extension-only").
   Tell the dev in one line what you removed.
4. **Settings: decide them, then write `.claude/app-kit.json` with the Write tool.** The guard shows the dev every value before it's written; that prompt is the confirmation, so don't ask first.
   - `devStore`: `drip-dev-eho-store.myshopify.com` unless the repo names another dev store. Never a client store.
   - `appConfig`: the dev app's config from step 2, so no CLI call can target production.
   - `baseBranch`: the remote's default branch. `verify`: what `detect` suggests (lint, typecheck, build, the repo's tests; never deploy or migrate).
   - `jiraBaseUrl`: `https://driperium.atlassian.net` unless the repo or the ticket names another. `securityCheck`: leave it out.
5. **Onboard.** On `kit-onboard` (`git switch -c kit-onboard --no-track origin/<baseBranch>`, or the branch step 3 committed on; carry the dev toml along):
   - `node .claude/kit/app.mjs onboard`. A wrong baseline (the dev toml still empty): fix the cause, then `onboard --redo` while `appspec/` isn't committed.
   - Fill `appspec/project.md`, a few factual lines per section, from the repo's own `README.md`, `CLAUDE.md`, `AGENTS.md` and configs ("unknown" rather than a guess).
   - Commit `appspec/` and `git push -u origin kit-onboard`. Give the dev the merge link onboard prints. The first change doesn't wait for that merge: it stacks on `kit-onboard`.
6. **Branch protection.** `gh api repos/<owner>/<repo>/branches/<base> --jq .protected`. `false`, or unknown without `gh`, is a ✗ under "Needs you": a rule on the base branch requiring a PR (GitHub → Settings → Branches). In the first real run, a direct push to `main` went through.
7. **Mode and logins.** `node .claude/hooks/guard.mjs --mode-probe`: blocked means the session's mode hides the kit's prompts (bypass, dontAsk, plan); not a stop. Say in the summary that mutations, migrations and settings changes are refused until the dev switches with Shift+Tab to auto (recommended), default or accept edits. `node .claude/kit/shopify.mjs info` fails on a login → the dev runs `! shopify auth login`. `git ls-files .playwright-mcp` shows files → the dev runs `! git rm -r --cached .playwright-mcp` on a branch.
8. **Jira** (when `jiraBaseUrl` is set): `node .claude/kit/jira.mjs --check`. `envLocalIgnoredByGit` false (exit 2): stop; re-run the installer, or add `.claude/` to the repo's `.gitignore`. Credentials missing: the dev creates `~/.claude/.env` once per machine with `JIRA_USER=<their Atlassian email>` and `JIRA_API_TOKEN=<from id.atlassian.com → Security → API tokens>`, never pasted into chat (`.claude/.env.local` only for a repo that needs another Jira account).
9. **Health check** (every run, and the whole job on a re-run): `node .claude/kit/app.mjs drift` (`--regression` when the arguments include it, or before a release: it runs every ledgered test). Report surfaces changed outside the kit, ledgered tests that fail or are gone (a `/app-implement` fixes or retires them), a missing security baseline, and open changes untouched for two weeks (continue or abandon each: the dev's call).

Report in at most 8 lines: what was set and decided, what the dev still has to do, and that `/app-implement <KEY>` is next.
