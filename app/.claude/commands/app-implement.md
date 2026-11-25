---
description: Implement a ticket in this Shopify app, scenarios first - a new or changed behaviour, a bug fix, an A/B-gated extension, or maintenance. From a Jira key or a description to an archived, verified change with a PR text and a deploy checklist. Resumable. Run it again with the same ID to continue.
argument-hint: <JIRA-KEY or short-kebab-id> [description] [--test]
disable-model-invocation: true
---

# /app-implement $ARGUMENTS

You are running the Shopify App Kit for one change.

**The type comes from the ticket**, not from the dev picking a command. Decide it, say it in one line ("Type: ab, because the ticket gates a checkout block on an A/B test"), and go on; the dev can correct it before anything is built: `app.mjs abandon <ID> --reason "wrong type"`, then `start <ID> --type <type>` again (the documents stay).

| Type | When |
| --- | --- |
| `fix` | something behaves wrongly: reproduce it first |
| `ab` | an extension or Function that acts only for an A/B test's variation (a cart attribute or line item property the test code writes) |
| `maintain` | no behaviour change: an API version bump, dependency updates, a refactor |
| `change` | anything else: new or changed behaviour |

## Every time, before anything else

1. No ID given → run `node .claude/kit/app.mjs list`, ask the dev which change to continue or what to start, and stop until they answer. A description without an ID: pick a short kebab-case ID (e.g. `gift-label`), say it in one line, and go on. A Jira key is the ID itself.
2. `.claude/app-kit.json` missing → tell the dev to run `/app-setup`, and stop.
3. Once per session: `node .claude/kit/shopify.mjs cli-check`. Problems → show them and stop: the kit may no longer match the CLI.
4. Run `node .claude/kit/app.mjs status <ID>`.
   - **Archived:** status says what's left (commit, push, the handoff). Do that. Only if the dev says the ticket was reopened, start it again below.
   - **Not started:**
     1. `git status --porcelain`. Uncommitted app changes → ask the dev what to do with them. Never stash or discard without asking.
     2. `git fetch origin`, then the `git switch -c <branch> --no-track …` status printed (`--no-track`: a branch that tracks the base can send a push there). A branch that already exists: reuse it when it holds only this change's own commits, and say so; ask the dev only otherwise. **A small fix to a change whose PR is still open** (`--quick`, below): don't cut a branch; stay on, or `git switch` to, that change's branch, so the fix lands in the same PR.
     3. `node .claude/kit/app.mjs start <ID> --type <type> --title "<one line>"`, adding `--test` when the arguments include it or the dev calls it a test run, and `--quick` for a small fix with no surfaces (a colour, a size, a text: often right after a handoff).
5. Status names the current stage and its skill. **Load that skill with the Skill tool and do only that stage.**
6. When the stage's "Done when" holds, run `node .claude/kit/app.mjs done <ID> <stage>` (gates also need `--answer "<the dev's words>"`). If it refuses, its message says what's missing.
7. `done` and `back` print the new status: continue from it. Tell the dev in one line each time the stage changes, e.g. `✓ propose → build · nothing needed from you`.

Stages: **propose** (Gate 1) → build → verify → **accept** (Gate 2) → handoff, for every type.

- **After a compaction or in a new session:** status first, not memory. Never redo a gate the dev already answered.
- **Going back:** a QA failure or review finding → build (`app.mjs back <ID> build --reason "…"`); a wrong scenario → propose, and Gate 1 again.
- **The dev wants to stop:** `app.mjs abandon <ID> --reason "…"`, then walk them through the cleanup list it prints.
- **Commit `appspec/changes/<ID>/` with the work**, so a teammate who pulls the branch sees the same stage.

## Rules for the whole run

Besides `rules/runs.md` and `app-runs.md`:

- **Only the kit's skills and agents run inside a change:** the stage skill status names (and `app-qa`, which verify loads), `shopify-plugin:shopify` for docs and GraphQL validation, `app.mjs ticket` / `jira.mjs` for the ticket, the Figma tools through the `design-extractor` agent, `code-review` and `security-review`, the kit's agents (`app-recon`, `app-builder`, `design-extractor`, `outcome-checker`, `blind-qa`), kit-browser for the storefront and checkout, and `claude-in-chrome` for the admin and editors. Don't load other dev, QA or investigate skills, even when a hook suggests them.
- **Scope is the change.** Other problems go in proposal.md § Out of scope or the handoff, not into the code.
