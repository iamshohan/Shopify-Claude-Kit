---
name: app-build
description: The build stage of the App Kit. Have the app-builder agent implement the approved tasks and tests, review the diff, keep the surfaces exactly as declared, commit on the change branch and record the code review. Use only when app.mjs status says the stage is build.
user-invocable: false
---

# Build

1. **Branch.** `git rev-parse --abbrev-ref HEAD` must equal the branch in status. If not, `git switch <branch>`. Uncommitted changes you didn't make → ask the dev, except the folder of an extension § Surfaces declares (`+ extension:`), which propose generated: commit it as the first build commit.
2. **Implement.** Spawn `app-builder` with the ID (and in a fix loop, the failing checks or findings pasted into the prompt). Wait for its "As built" report.
3. **Generated files.** After a Function's input query changes: `node .claude/kit/shopify.mjs function-typegen <fn>`. After a Prisma schema change: `npx prisma migrate dev --name <change-id>` (the guard asks: it touches the database DATABASE_URL points at) and `npx prisma generate`.
4. **Run the tests yourself.** `npx vitest run <file>` in the package that owns each scenario's test. Function fixtures: `node .claude/kit/shopify.mjs function-build <fn>` then `function-run <fn>`. Every test named in § Scenarios must exist with that name, match only one test, and pass. No test an archived change bound may be gone unless § Retires names it.
5. **Surfaces.** Run `node .claude/kit/app.mjs surfaces <ID>`. `undeclared` and `unhappened` must both be empty. Something undeclared is either a mistake (undo it) or a missing declaration: then go back to propose (`app.mjs back <ID> propose --reason "…"`), declare it, and take Gate 1 again. Never "fix" this by editing the declaration without the dev: a surface is exactly what Gate 1 is for.
6. **Commit** on the change branch with the repo's pattern, ticking the done tasks in proposal.md § Tasks. Never push here.
7. **Review the diff** with fresh eyes (the builder doesn't review its own work):
   1. Run the `code-review` skill with the argument `high` (or `medium` for a diff under about 150 changed lines that declares no surface) on the branch's diff against its base (`app.mjs status <ID>` names the diff base).
   2. Then check yourself:
      - Every new route calls the right `authenticate.*`; webhook routes use `authenticate.webhook`; app proxy routes `authenticate.public.appProxy`. No route trusts a shop domain from the request.
      - Admin GraphQL: every operation validated with `shopify-plugin:shopify` against the app's API version; `userErrors` handled; pagination where lists can grow; no query inside a loop.
      - Functions: no network, no randomness, bounded loops; input query asks only for what the code reads (instruction counts).
      - Checkout UI: components from the extension's API version; no secrets in the bundle; nothing heavy imported (64 KB bundle limit).
      - No secrets or tokens in code, logs or errors. No new dependency that § Surfaces doesn't declare.
      - The code does what the scenarios say, at the boundaries the scenarios name. Nothing unrelated changed.
   3. Real problems go back to `app-builder` in fix mode; commit the fixes. After two rounds, show what remains to the dev and ask.
   4. Record it on the committed code: `node .claude/kit/app.mjs review <ID> code --found "<what it found and what was done>"`. A later code change needs a new review of what changed.

**Done when:** the scenario tests pass locally, `surfaces` shows no mismatch, the work is committed and the code review is recorded. Run `app.mjs done <ID> build`.
