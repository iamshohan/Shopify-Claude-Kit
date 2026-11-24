---
name: shopify-build
description: Stages 5–6 of /shopify-implement. Create the task branch, have the theme-builder agent implement the approved plan, review the diff, commit, create the planned store definitions, and push the result to the task's draft theme. Use only when /shopify-implement's status says the stage is build or draft.
user-invocable: false
---

# Build and draft

## Stage: build

1. **Branch.** Theme changes go on the task branch.
   - `git status --porcelain` shows uncommitted theme changes: ask the dev what to do with them. Never stash or discard anything without asking.
   - **The branch exists in status** (fix loops, resume): `git switch <branch>`.
   - **Test run** (status says TEST RUN): create the branch named in status (`<KEY>-kit-test`) as below, even when a teammate's branch for the key exists (a local one in another case: switch to it and record its exact name with `set branch=`). Never push it.
   - **No branch yet:**
     1. `git fetch origin`, `git branch --list` and `git ls-remote --heads origin`: a local or remote branch matching the key, ignoring case? Ask the dev: **"Reuse it"** → `git switch <it>`, base `git merge-base origin/<baseBranch> HEAD`; or **"New branch <KEY>-kit"**. Never create a second branch whose name differs only by case.
     2. Otherwise `git switch --no-track -c <branch> origin/<baseBranch>`, with the name from status.
     3. `kit.mjs set <KEY> branch=<branch> base=<sha>` (the sha from `git rev-parse origin/<baseBranch>`, or the merge-base when reusing).
2. **Implement.** Spawn `theme-builder` with the key and `mode: build` (a fix loop: `mode: fix`, with the failing QA rows or review findings in the prompt), and wait for its "As built" report. It runs theme check on its change; theme files you change after it (a review fix of your own) need `node .claude/kit/shopify.mjs check <KEY>` again.
3. Append the report to `plan.md` § As built.
4. **Review,** with fresh eyes (the builder doesn't review its own work).
   1. Stage first, with the "Stage with:" line from `kit.mjs status <KEY>`, so new files count. Run the `code-review` skill with `high`, or `medium` when the diff is under about 150 changed lines and touches no shared file (`git diff --cached --shortstat`; `reach` lists shared files). Drop findings that restate a § Decided choice or a winner value, and list them once as "intentional".
   2. Then check the diff yourself:
      - It follows `plan.md`: files, setting ids and defaults, anchors.
      - `render`, not `include`. No loops over all products or collections; no metafield lookups repeated inside loops.
      - No hardcoded storefront copy, URLs or product IDs: every string in settings or locale files, in the locales § Decided names (all, if it names none).
      - Schema: presets when the merchant places it; unique setting ids; defaults equal the winner for A/B ports; ranges bounded; `visible_if` correct.
      - Empty states handled: blank metafield, no blocks, missing image.
      - JS: no globals; the theme's own events; re-initialises on `shopify:section:load`; no console errors.
      - CSS scoped to the feature prefix; no `!important` unless the neighbouring code uses it.
      - No edits to minified vendor files; merchant JSON only where the plan says so; nothing unrelated changed.
      - Comments short and only the why; no task history, ticket keys, AC or Q numbers.
   3. Send real problems back to `theme-builder` in `mode: fix`. After two rounds with problems left, show them to the dev and ask how to proceed.
5. **Commit** on the task branch with the "Stage with:" line from status (it lists only the theme folders this repo has) and the repo's pattern, e.g. `git commit -m "abc-123__dev: add USP row block"`. Never push here.

A theme check that crashed is recorded and doesn't block: say so in the report. `done build` lists the shared files the branch changes, files `plan.md` § Files doesn't name, and plan changes since approval; if one reaches beyond the feature, tell the dev now.

**Done when:** the review list passes, the change is committed, and the builder's theme check shows no introduced errors. Then `kit.mjs done <KEY> build`.

## Stage: draft

1. **Store setup,** only if `plan.md` § Store setup lists definitions or QA test data that don't exist yet.

   **`adminApi: false`:** give the dev the plan's admin steps (definitions, QA values on the named products) and wait for them to confirm. Check in Chrome that each definition exists with the planned namespace, key and type (Settings → Custom data, look only), and record what was created as an Amendment in `plan.md` ("created by the dev in the admin") for handoff and cleanup.

   **With the Admin API:**
   1. Re-check what exists: `node .claude/kit/shopify.mjs query definitions --owner <OWNER>`. Something now fits: use it, and add an Amendment.
   2. Run each file the plan validated (`.claude/logs/<KEY>/mutations/`; re-validate only one you changed) with `node .claude/kit/shopify.mjs mutate <KEY> <file> --vars <file>`. The dev sees each one and approves or declines it; the created ids are recorded.
   3. QA test values go only on the products the dev named (plan.md § QA test data), through the same `mutate` path.
   4. A scope error prints the exact `! shopify store auth …` command: pass it to the dev, then retry.
2. **Draft theme.** The route is `draftRoute` in `.claude/shopify-kit.json` (unset and recon shows "Update from Shopify" commits: ask the dev). A **test run** always takes the CLI route (the GitHub route needs a push); its draft is named `<KEY>-kit-test`.

   **`draftRoute: "github"`:** the draft is a theme connected to the task branch, so it always equals the branch, and customizer saves on it come back as commits.
   1. `git push -u origin <branch>`.
   2. The dev connects it with the steps `shopify.mjs draft <KEY> --github` prints (Online Store → Themes → Add theme → Connect from GitHub → this repo → the task branch; admin-only). Offer to do it in their Chrome (`.claude/rules/kit-runs.md` → admin steps you can offer). Then run the command again to adopt the theme, every 30 seconds for up to two minutes, instead of asking the dev to come back.
   3. `node .claude/kit/shopify.mjs verify <KEY>` waits for Shopify's sync and checks every file the branch touched matches HEAD.
   4. **Every later commit:** `git push -u origin <branch>`, then `verify`. A rejected push means Shopify committed a save from the admin: show the dev what came in first (`git fetch origin`, `git log HEAD..origin/<branch> --stat`), so test content saved in the editor doesn't reach the PR unseen; on their word, `git pull --no-rebase origin <branch>` and push, or drop what isn't meant to ship. Never save in this theme's editor yourself; if the dev saves there, tell them it lands on the branch and in the PR.
   5. Skip steps 3–4 below.

   **`draftRoute: "cli"`** (the default): `node .claude/kit/shopify.mjs draft <KEY>` reuses this task's draft, or copies the live theme into a new unpublished theme named `<KEY>` and waits until it's ready. Never `--adopt` without the dev's yes.
   - **Timed out:** run it again; the next run adopts the copy it started (within 6 hours).
   - **The CLI can't do it** (no access, store permissions): offer the GitHub route if the repo is connected; otherwise the dev creates an unpublished copy of the live theme with `<KEY>` in its name, and you record it: `kit.mjs set <KEY> draft.themeId=<id> draft.name=<name> draft.route=manual` (pushed with `shopify.mjs push` like a normal one).
3. **Build outputs** the builder reported (e.g. compiled Tailwind CSS, gitignored): `kit.mjs set <KEY> buildOutputs=<path,path>`.
4. **Push:** `node .claude/kit/shopify.mjs push <KEY>` uploads every theme file the branch's commits touched, pulls them back and compares them with HEAD. When it refuses, its message says what to do. Three that need more:
   - **Live changed merchant JSON the branch changes:** `--reconciled` only after the dev confirms the branch holds live's edits. Other files live changed (`liveEditedSinceBase`) aren't refused: tell the dev; QA lists them in the report.
   - **Shopify rejected a file** (e.g. a Liquid error): fix it in fix mode, commit, push again.
   - **`.shopifyignore` excludes a file the branch changes:** ask the dev how it reaches the store ("upload to the draft theme", not "push": devs read push as git push). Only with their yes, `push <KEY> --skip-ignored`; the file then goes into report.md § You must still do.
5. **Check the page:** `node .claude/kit/shopify.mjs fetch <KEY> <path> --find <text>`, and give the dev the preview URL and the editor URL.

**Done when:** `push` (or, on a connected draft, `verify`) reports that the draft matches the current commit. Then `kit.mjs done <KEY> draft`.
