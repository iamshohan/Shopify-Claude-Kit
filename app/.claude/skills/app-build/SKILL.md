---
name: app-build
description: The build stage of the App Kit. Have the app-builder agent implement the approved tasks and tests, review the diff, keep the surfaces exactly as declared, commit on the change branch and record the code review. Use only when app.mjs status says the stage is build.
user-invocable: false
---

# Build

1. **Branch.** `git rev-parse --abbrev-ref HEAD` must equal the branch in status; if not, `git switch <branch>`. Uncommitted changes you didn't make → ask the dev, except the folder of an extension § Surfaces declares (`+ extension:`), which propose generated: commit it as the first build commit.
2. **Implement.** Spawn `app-builder` with the ID (in a fix loop, with the failing checks or findings pasted into the prompt). Wait for its "As built" report. A `--quick` change (a colour, a size, a text): make the edit yourself, no builder.
3. **Generated files.** After a Function's input query changes: `node .claude/kit/shopify.mjs function-typegen <fn>`. After a Prisma schema change: `npx prisma migrate dev --name <change-id>` (the guard asks: it touches the database DATABASE_URL points at) and `npx prisma generate`.
4. **Run the tests yourself.** `npx vitest run <file>` in the package that owns each scenario's test; Function fixtures with `shopify.mjs function-build <fn>` then `function-run <fn>`. Every test § Scenarios names must exist with that exact name and pass.
5. **Surfaces.** `node .claude/kit/app.mjs surfaces <ID>`: `undeclared` and `unhappened` must both be empty. Something undeclared is a mistake (undo it) or a missing declaration: go back to propose (`app.mjs back <ID> propose --reason "…"`), declare it, and take Gate 1 again. Never edit the declaration without the dev: a surface is exactly what Gate 1 is for.
6. **Commit** on the change branch with the repo's pattern, ticking the done tasks in § Tasks. Never push here. QA scripts and probes stay out of app code: they live in `.claude/logs/<ID>/` (verify fails on `debugger`, `PROBE` or qa/debug logging the branch adds). To drop uncommitted experiments in app files: `node .claude/kit/app.mjs revert <ID> <file…>` (it keeps a patch first).
7. **Review the diff** with fresh eyes (the builder doesn't review its own work):
   1. Run `code-review` with `high` (`medium` for a diff under about 150 changed lines that declares no surface, `low` for a `--quick` change) on the branch's diff against the base `app.mjs status <ID>` names.
   2. Then check yourself: every new route calls the right `authenticate.*` (`authenticate.webhook`, `authenticate.public.appProxy`) and trusts no shop domain from the request; every Admin GraphQL operation is validated, handles `userErrors`, paginates growing lists, and isn't called in a loop; Functions have no network, randomness or unbounded loops, and query only what they read; checkout UI uses the extension's API version's components, ships no secrets and nothing heavy (64 KB bundle limit); no secrets in code, logs or errors; no undeclared dependency; the code does what the scenarios say at their boundaries, and nothing unrelated changed.
   3. Real problems go back to `app-builder` in fix mode; commit the fixes. After two rounds, show what remains to the dev and ask.
   4. Record it on the committed code: `node .claude/kit/app.mjs review <ID> code --found "<what it found and what was done>"`. Only a `code-review` run on this code counts; a read-through "inline" or a review carried over from an earlier commit is refused.

**Done when:** the scenario tests pass locally, `surfaces` shows no mismatch, the work is committed and the code review is recorded. Run `app.mjs done <ID> build`.
