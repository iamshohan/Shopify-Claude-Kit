# Shopify App Kit · team guide

You approve **behaviour** as concrete scenarios, each bound to a check; Claude writes the code and proves every scenario before the change lands. Version: `.claude/VERSION`.

| ID | GIVEN | WHEN | THEN | Check |
| --- | --- | --- | --- | --- |
| S1 | a cart subtotal of 50 EUR | the cart transform runs | the gift is added | `test: extensions/gift/tests/gift.test.js › gift added at threshold` |
| S2 | the gift in the cart | the buyer opens checkout | the gift's line shows "Free" | `qa: gift line says Free` |

## Commands

Type them in Claude Code's prompt; pasted as text they don't start.

| Command | For |
| --- | --- |
| `/app-setup` | Once per repo and person: checks the CLI and the guard, writes `.claude/app-kit.json` (dev store, app config, verify commands, Jira URL), onboards the app. Run it again for a health check. |
| `/app-implement <KEY>` | Implement a ticket. The agent picks the type: a new or changed behaviour, a bug fix (failing test first), an A/B-gated extension (with the test's own variation and control code in `abtest/<ID>/`), or maintenance (no behaviour change). Run it again with the same ID to continue. |
| `/app-investigate <KEY or question>` | Read-only: how does X work, or is a ticket feasible and how long would it take. |

## What you're asked, and when

1. **propose → Gate 1.** You get `proposal.md`: the scenarios, the surfaces it adds (scopes, webhooks, extensions, models, dependencies), the design for heavy ones, what needs your attention and what it decided for you without asking. Before writing it, it asks you only the real calls: a departure from the ticket, a new scope or something the merchant maintains, money, real alternatives, a contradiction, something hard to undo. You review it, then approve or say what to change, in your own words.
2. **build:** Claude implements the approved tasks; app code waits for Gate 1.
3. **verify:** every automated check and the `qa:` scenarios on the dev store. When QA needs the app running, the agent gives you an `appDev` command for a separate terminal (it targets the dev app and store; a bare `shopify app dev` may not). Placing a checkout block is yours too.
4. **accept → Gate 2:** the measured result and anything changed since Gate 1.
5. **handoff:** the change moves to `appspec/archive/` with `handoff.md`: PR text and deploy checklist. You open the PR (or take the merge commands), merge and deploy.

Checks: `test:` a vitest test, `qa:` measured on the dev store, `manual:` checked by the reviewer. Security findings already in `appspec/security-baseline.json` only warn; new medium or high ones fail.

## What the guard does

It's for honest mistakes, not an agent working around it on purpose; branch protection, Partner Dashboard roles and code review are the real limits.
- **Asks** (hard to undo): store mutations, database migrations, the safety settings in `app-kit.json` (dev store, app config, branches, verify commands, Jira URL), Claude Code's or git's settings, git commands that would discard uncommitted work.
- **Refuses with the reason:** deploys and releases, the CLI outside `shopify.mjs` (or a script that runs it), any store but `devStore`, secrets (`.env*`, SQLite, the Session table), pushes to main, app code before Gate 1.
- **Logs** (`.claude/logs/_guard.jsonl`): new dependencies, code edits outside a change or after build, other settings changes.
- **Bypass mode works:** what asks stays refused there (switch with Shift+Tab to auto for that step); a kit skill edited here passes and is logged.

## Files and handover

`appspec/` is in git: `project.md`, `surfaces.json`, `security-baseline.json`, `changes/<ID>/` (open), `archive/<date>-<ID>/` (done, with `handoff.md`). Yours, not in git: `.claude/app-kit.json`, `.claude/.env.local`, `.claude/logs/`.

A teammate continues your change with `git switch <branch>`, then `/app-implement <ID>`: the branch carries `appspec/changes/<ID>/`.

## Install, update, Jira

- Install from the kit repo: `node install.mjs <path-to-app-repo> --app`. It never touches `appspec/` or `app-kit.json`.
- Update every kit repo on your machine: `node update.mjs` from the kit repo (on main, clean). A session mentions a newer kit every 15 days.
- Jira: `JIRA_USER` and `JIRA_API_TOKEN` in `~/.claude/.env` once per machine (Claude can't read it). `.claude/.env.local` overrides it for one repo, and is where `JIRA_BASE_URL` goes if you need it. Without credentials, paste the ticket text.
- Kit problems the agent hit are in each change's kit notes; `node export-logs.mjs` in the kit repo shares them with the maintainer.
