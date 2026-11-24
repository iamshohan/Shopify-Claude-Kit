# Shopify App Kit · team guide

You approve **behaviour** as concrete scenarios, each bound to a check; Claude writes the code and proves every scenario before the change lands. Version: `.claude/VERSION`.

| ID | GIVEN | WHEN | THEN | Check |
| --- | --- | --- | --- | --- |
| S1 | a cart subtotal of 50 EUR | the cart transform runs | the gift is added | `test: extensions/gift/tests/gift.test.js › gift added at threshold` |
| S2 | the gift in the cart | the buyer opens checkout | the gift's line shows "Free" | `qa: gift line says Free` |

## Commands

Type these commands in Claude Code's prompt. Pasting their text as a message doesn't start them: they only run when typed as a slash command.

| Command | For |
| --- | --- |
| `/app-setup` | Once per repo and person: CLI check, `.claude/app-kit.json` (dev store, app config, verify commands, Jira URL) |
| `/app-implement <KEY>` | Implement a ticket. The agent picks the type: a new or changed behaviour, a bug fix (failing test first), an A/B-gated extension (with the test's own variation and control code in `abtest/<ID>/`, and how the test ends), or maintenance (no behaviour change) |
| `/app-investigate <KEY or question>` | Read-only: how does X work, or is a ticket feasible and how long would it take |

Run a command again with the same ID to continue.

## Stages

1. **propose:** `proposal.md` with the scenarios, the surfaces it adds (scopes, webhooks, extensions, models, dependencies), § Design for heavy surfaces, what needs your attention, what it decided for you without asking (change any of it at Gate 1), and the tasks. It asks you only the real calls: a departure from the ticket, a new scope or something the merchant maintains, money, real alternatives, a contradiction, something hard to undo. A new extension: the kit generates it first (`shopify.mjs generate-extension`). **Gate 1:** you review it, then approve or ask for changes in your own words.
2. **build:** Claude implements; app code is editable only now.
3. **verify:** surfaces vs proposal, each scenario's test, every test an archived change bound (the ledger), your verify commands, Function fixtures, bundle size, `shopify app security check`; `qa:` scenarios measured on the dev store. When QA needs the app running, start it with the `appDev` command the agent gives you, in a separate terminal (it keeps running, so not with `!` in Claude Code) (`shopify app dev` with the dev app's config and the dev store; the bare command uses whatever the CLI last used).
4. **accept:** the measured result and anything changed since Gate 1 (scenarios, surfaces, retired tests). **Gate 2.**
5. **handoff:** the change moves to `appspec/archive/` with `handoff.md`: PR text and deploy checklist. You open the PR, merge and deploy.

Checks: `test:` a vitest test (new or changed on the branch, or its fixture), `qa:` measured on the dev store, `manual:` checked by the reviewer. Security findings in `appspec/security-baseline.json` only warn; new medium or high ones fail (before a baseline exists, a medium one only warns); a check that can't run warns (`"securityCheck": false` turns it off).

## What the guard does

The guard is for honest mistakes, not for an agent working around it on purpose.
- **Asks** (hard to undo): store mutations, database migrations, a change to the dev store, the app config, the protected branches, the verify commands or the Jira URL in `app-kit.json`, Claude Code's or git's settings (`.claude/settings*.json`, hooks, `.mcp.json`, `.git/config`), git commands that would discard uncommitted work.
- **Refuses with the reason:** deploys and releases, the CLI outside `shopify.mjs` (also a script that runs it), any store but `devStore`, secrets (`.env*`, SQLite, the Session table), pushes to main, app code before Gate 1.
- **Logs** (`.claude/logs/_guard.jsonl`): new dependencies, code edits with no change open or after the build stage (verify refuses results measured on other code), other settings changes. Gate answers pass without a second prompt (you answered in the skill) and are recorded in the change's `change.json`.
- **Bypass mode works:** mutations, migrations, safety settings and the guard's own files stay refused (switch with Shift+Tab to auto for those steps); a kit skill edited here passes and is logged.

It catches a well-meaning agent's mistakes; branch protection, Partner Dashboard roles and code review are the real limits.

## Files

`appspec/` is in git: `project.md`, `surfaces.json`, `security-baseline.json`, `changes/<ID>/` (open: `proposal.md`, `change.json`), `archive/<date>-<ID>/` (done, with `handoff.md`; the ledger is read from here). Yours, not in git: `.claude/app-kit.json`, `.claude/.env.local` (Jira credentials for this repo only, when it needs another account), `.claude/logs/`.

## Handover

Commit `appspec/changes/<ID>/` with the work and `git push -u origin <branch>`. A teammate runs `git switch <branch>`, then `/app-implement <ID>`, and continues at the same stage.

## Install, Jira, feedback

- Install from the kit repo: `node install.mjs <path-to-app-repo> --app`. It never touches `appspec/` or `app-kit.json`.
- Update every kit repo on your machine (theme and app): `node update.mjs` from the kit repo. Repos installed before it existed: `node update.mjs --scan <folder>` once. Every 15 days, a session mentions it once when a newer kit is out.
- Jira: put `JIRA_USER` and `JIRA_API_TOKEN` in `~/.claude/.env` once per machine (unreadable to Claude; it covers every kit repo). `.claude/.env.local` (git-ignored, also unreadable) overrides it for one repo; keep `JIRA_BASE_URL` there, not in `~/.claude/.env`, where it would apply to every repo. Without credentials, paste the ticket text.
- Kit problems: the agent notes them in `kit-notes.md`; `node Shopify-Claude-Kit/export-logs.mjs` shares every repo's task logs, notes included, with the kit maintainer.
