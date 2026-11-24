---
description: Implement a ticket in this Shopify app, scenarios first - a new or changed behaviour, a bug fix, an A/B-gated extension, or maintenance. From a Jira key or a description to an archived, verified change with a PR text and a deploy checklist. Resumable. Run it again with the same ID to continue.
argument-hint: <JIRA-KEY or short-kebab-id> [description] [--test]
disable-model-invocation: true
---

# /app-implement $ARGUMENTS

You are running the Shopify App Kit for one change. A script keeps track of where the change is, so you never have to remember it.

**The type comes from the ticket**, not from the dev picking a command. Decide it, say it in one line ("Type: ab, because the ticket gates a checkout block on an A/B test"), and go on; the dev can correct it, and `start <ID> --type …` again changes it before anything is built.

| Type | When |
| --- | --- |
| `fix` | something behaves wrongly: reproduce it first |
| `ab` | an extension or Function that acts only for an A/B test's variation (a cart attribute or line item property the test code writes) |
| `maintain` | no behaviour change: an API version bump, dependency updates, a refactor |
| `change` | anything else: new or changed behaviour |

## Every time, before anything else

1. No ID given → run `node .claude/kit/app.mjs list`, ask the dev which change to continue or what to start, and stop until they answer. A description without an ID: pick a short kebab-case ID (e.g. `gift-label`), say it in one line, and go on; the dev can rename it before the first commit. A Jira key is the ID itself.
2. `.claude/app-kit.json` missing → tell the dev to run `/app-setup`, and stop. `app.mjs start` tells a repo that was never onboarded (→ `/app-setup`) from one whose onboarding isn't merged yet (the change stacks on it).
3. Once per session: `node .claude/kit/shopify.mjs cli-check`. If it reports problems, show them and stop: the kit may no longer match the CLI.
4. Run `node .claude/kit/app.mjs status <ID>`.
   - **Archived:** status says what's left (commit, push, the handoff). Do that. Only if the dev says the ticket was reopened, start it again below.
   - **Not started:** status names the branch to create.
     1. Run `git status --porcelain`. Uncommitted app changes → ask the dev what to do with them. Never stash or discard without asking.
     2. `git fetch origin`, then the `git switch -c <branch> --no-track …` status printed (from `origin/kit-onboard` while the onboarding isn't merged: the change stacks on it, and its PR follows the onboarding's) (`--no-track`: a branch that tracks the base can send a push there). If the branch exists locally or on origin: reuse it when it holds only this change's own commits (named for the ID, nothing merged in from elsewhere), and say so; ask the dev only otherwise.
     3. `node .claude/kit/app.mjs start <ID> --type <type> --title "<one line>"`, adding `--test` when the arguments include it or the dev calls it a test run (the branch is then `<ID>-kit-test`).
5. The status names the current stage and the skill that owns it. **Load that skill with the Skill tool and do only that stage.**
6. When the stage's "Done when" holds, run `node .claude/kit/app.mjs done <ID> <stage>`. Gate stages also need `--answer "<the dev's words>"`. The script refuses while the stage's output is missing: read its message, fix the gap, and run it again.
7. `done` (and `back`) print the new status: continue from it with the next stage the same way. Tell the dev in one line each time the stage changes, e.g. `✓ propose → build · nothing needed from you`.

Also:

- **After a compaction or in a new session:** run status first and continue from what it says, not from memory. Never redo a gate the dev already answered.
- **Going back:** a QA failure or a review finding in verify goes back to build (`app.mjs back <ID> build --reason "…"`). A scenario that turns out wrong goes back to propose, and Gate 1 is asked again.
- **The dev wants to stop:** `app.mjs abandon <ID> --reason "…"`, walk them through the cleanup list it prints, and if its signals show the kit got in the way, record `app.mjs note <ID> "…"`. `start <ID> --type …` restarts an abandoned change, keeping its documents.
- **Commit `appspec/changes/<ID>/` with the work**, so a teammate who pulls the branch sees the same stage.

## The stages

**propose** (Gate 1) → build → verify → **accept** (Gate 2) → handoff, for every type. Status names each stage's skill.

## Rules for the whole run

The rules every run shares (gates, `--answer`, talking to the dev, kit notes) are in `.claude/rules/runs.md` and `app-runs.md`; they load once you touch `appspec/`. These are the run's own:

- **Only the kit's skills run inside a change:** the stage skill status names, `shopify-plugin:shopify` for docs and GraphQL validation, `node .claude/kit/jira.mjs <KEY>` for the ticket, `code-review` and `security-review`, and `claude-in-chrome` for QA in the admin and checkout (a Playwright browser for viewport rows: see app-verify). Don't load other dev, QA or investigate skills, even when a hook suggests them.
- **Scope is the change.** Other problems go in proposal.md § Out of scope or the handoff, not into the code.
