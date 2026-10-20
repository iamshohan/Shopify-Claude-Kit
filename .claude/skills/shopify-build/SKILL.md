---
name: shopify-build
description: Stages 6–7 of /implement. Create the task branch, have the theme-builder agent implement the approved plan, review the diff, commit, create the planned store definitions, and push the result to the task's draft theme. Use only when /implement's status says the stage is build or draft.
user-invocable: false
---

# Build and draft

## Stage: build

1. **Branch.** Theme changes go on the task branch.
   - Run `git status --porcelain`. If it shows uncommitted changes to theme files, ask the dev what to do with them. Never stash or discard anything without asking.
   - **The branch exists in status** (fix loops, resume): `git switch <branch>`.
   - **No branch yet:**
     1. Run `git fetch origin`, then `git branch --list` and `git ls-remote --heads origin`. Look for a local or remote branch matching the key, ignoring case (e.g. `abc-123` for ABC-123). If one exists, ask the dev:
        - **"Reuse it"** → `git switch <it>`, and the base is `git merge-base origin/<baseBranch> HEAD`
        - **"New branch <KEY>-kit"** → create it as below

        Never create a second branch whose name differs only by case.
     2. Otherwise run `git switch --no-track -c <branch> origin/<baseBranch>`, with the name from status. `--no-track` keeps the task branch from tracking the base branch.
     3. Record the branch and base: `kit.mjs set <KEY> branch=<branch> base=<sha>`. Get the sha from `git rev-parse origin/<baseBranch>`, or from the merge-base when reusing a branch.
     4. While the tree is untouched, record the theme-check baseline: `node .claude/kit/shopify.mjs check <KEY> --baseline` (about a minute; run it with a 10-minute timeout).
2. **Implement.** Spawn `theme-builder` with the key and `mode: build`. In a fix loop, use `mode: fix` and paste the failing QA rows or review findings into the prompt. Wait for its "As built" report.
3. Append the report to `plan.md` § As built.
4. **Review.** Use fresh eyes; the builder doesn't review its own work.
   1. Run the `code-review` skill with the argument `high`. It reviews the uncommitted diff, which is exactly the builder's change. Before acting on its findings, drop the ones that restate a § Decided choice or a winner value from the plan, and list them once as "intentional" instead of re-arguing them.
   2. Then check the diff against this list yourself:
      - It follows `plan.md`: the files, setting ids and defaults, and anchors.
      - `render`, not `include`. No loops over all products or collections. No metafield lookups repeated inside loops.
      - No hardcoded storefront copy, URLs or product IDs. Every string is in settings or locale files, in every locale.
      - Schema:
        - presets present if the merchant places the section or block
        - setting ids unique
        - defaults equal the winner for A/B ports
        - ranges bounded
        - `visible_if` correct
      - Empty states handled: blank metafield, no blocks, missing image.
      - JS:
        - no globals
        - uses the theme's own events
        - re-initialises when the section reloads in the theme editor (`shopify:section:load`)
        - no console errors
      - CSS is scoped to the feature prefix. No `!important` unless the neighbouring code uses it.
      - No edits to minified vendor files. Merchant JSON is touched only where the plan says so.
      - Nothing unrelated changed.
   3. Send real problems back to `theme-builder` in `mode: fix`, with the list. After two rounds, if problems remain, show them to the dev and ask how to proceed.
5. **Commit** on the task branch:
   - Use the "Stage with:" line from `kit.mjs status <KEY>`. It lists only the theme folders this repo has; `git add` fails on a missing folder.
   - Commit with the repo's pattern from status, e.g. `git commit -m "abc-123__dev: add USP row block"`.
   - Never push here.

**Done when:** the review list passes, `check` shows no introduced errors, and the change is committed. Then run `kit.mjs done <KEY> build`.

## Stage: draft

1. **Store setup.** Do this only if `plan.md` § Store setup lists definitions or QA test data that don't exist yet.

   **`adminApi: false` (no Admin API login):**
   - Give the dev the plan's admin steps, and ask them to create the definitions and set the QA values on the named products.
   - Wait for them to confirm. Then check in Chrome that each definition exists with the planned namespace, key and type (Settings → Custom data, look only).
   - Record what was created as an Amendment in `plan.md` ("created by the dev in the admin"), so handoff and cleanup know about it.
   - Skip steps 1–6 below.

   **With the Admin API:**
   1. Re-check what exists: `node .claude/kit/shopify.mjs query definitions --owner <OWNER>`. If something now fits, use it, and add an Amendment to the plan.
   2. Run the files the plan validated (`.claude/logs/<KEY>/mutations/`). Re-validate only a file you changed.
   3. Run each one with `node .claude/kit/shopify.mjs mutate <KEY> <file> --vars <file>`. The guard shows the dev the mutation and its variables, and the dev approves or declines it. The created IDs are recorded in the task state.
   4. **Create-only:** never update or delete an existing definition.
   5. QA test values go only on the products the dev named (`qa.products`), through the same `mutate` path.
   6. A scope error gives you the exact `! shopify store auth …` command. Pass it to the dev, then retry.
2. **Draft theme.** The route comes from `draftRoute` in `.claude/shopify-kit.json`. Ask the dev only if it isn't set and recon shows "Update from Shopify" commits.

   **`draftRoute: "github"`** (the store's themes are connected to this repo). The draft is a theme connected to the task branch, so it always equals the branch, and customizer saves on it come back as commits.
   1. `git push -u origin <branch>`.
   2. Ask the dev to connect it, with the steps `shopify.mjs draft <KEY> --github` prints: Online Store → Themes → Add theme → Connect from GitHub → this repo → the task branch. Connecting is admin-only; the CLI can't do it. Then run the command again to adopt the theme.
   3. `node .claude/kit/shopify.mjs verify <KEY>` waits for Shopify's sync and checks that every file the branch touched matches HEAD. It also refuses when live has edited one of the branch's JSON files since the base; merge `origin/<baseBranch>`, commit, push and verify again.
   4. **Every later commit:** `git push -u origin <branch>`, then `verify`. A rejected push means Shopify committed a save from the admin: `git pull --no-rebase origin <branch>`, then push. Never save in this theme's editor yourself. If the dev saves there, tell them the change lands on the branch and in the PR.
   5. Skip steps 3–4 below; `push` refuses a connected draft.

   **`draftRoute: "cli"`** (the default): `node .claude/kit/shopify.mjs draft <KEY>`, run with a 10-minute timeout. It reuses this task's draft, or copies the live theme into a new unpublished theme named `<KEY>` and waits until Shopify finishes processing it. If an unpublished theme with that name already exists, it adopts it and says so; tell the dev, because a teammate may be using it.
   - **The command timed out.** Run it again; it adopts the copy it already started.
   - **"The theme library is full".** Show the dev the listed themes. Ask which to remove: kit drafts of finished tasks via `shopify.mjs delete-draft <THAT-KEY>`, anything else in the admin.
   - **The CLI can't do it** (no access, or the store's permissions forbid it). Offer the GitHub route above if the repo is connected. Otherwise tell the dev exactly what to create: an unpublished copy of the live theme with `<KEY>` in its name. Then record it: `kit.mjs set <KEY> draft.themeId=<id> draft.name=<name> draft.route=manual`. A manual draft is pushed with `shopify.mjs push` like a normal one.
3. **Build outputs.** If the builder reported build outputs (e.g. compiled Tailwind CSS, which is gitignored), record them: `kit.mjs set <KEY> buildOutputs=<path,path>`.
4. **Push:** `node .claude/kit/shopify.mjs push <KEY>`. It uploads every theme file the branch's commits touched (including files reverted to their base content), then pulls them back and compares them with HEAD. It refuses when:
   - **The draft doesn't match after the upload.** It lists the files. Push once more; if the same files differ again, stop and show the dev.
   - **Live changed a JSON file after the branch's base.** Merge `origin/<baseBranch>` into the task branch; Shopify syncs live edits there. Resolve conflicts, commit, and push again. If the repo doesn't sync live edits into git, ask the dev how to reconcile.
   - **Shopify rejected a file**, for example a Liquid error. Fix it in fix mode, commit, and push again.
   - **`.shopifyignore` excludes a changed file.** Ask the dev how that file reaches the store.
5. **Check the page, not the request.** To see what the draft renders, use `node .claude/kit/shopify.mjs fetch <KEY> <path> --find <text>`. Never `curl` a `?preview_theme_id` URL: without the cookie the redirect sets, it returns the live theme without any error, which looks exactly like a broken draft.
6. Give the dev the preview URL and the editor URL.

**Done when:** `push` (or, on a connected draft, `verify`) reports that the draft matches the current commit. Then run `kit.mjs done <KEY> draft`.
