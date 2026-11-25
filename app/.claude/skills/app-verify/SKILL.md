---
name: app-verify
description: The verify and accept stages of the App Kit. Run every automated check (surfaces, the scenarios' tests, the test ledger, the repo's verify commands, Function fixtures and instruction counts, bundle size, security check), measure the qa scenarios on the dev store, record the security review, then take the result to Gate 2. Use only when app.mjs status says the stage is verify or accept.
user-invocable: false
---

# Verify and accept

## Stage: verify

1. **Automated.** Run `node .claude/kit/app.mjs verify <ID>`. It runs every automated check and records the result against the current app code.
   - Any FAIL → back to build with the failing lines: `app.mjs back <ID> build --reason "<check>: <one line>"`.
   - **ledger: gone** → a test an earlier change bound was deleted or renamed. Restore it, or, if the change means it, go back to propose, list it under § Retires and ask Gate 1 again.
   - **surfaces: changed outside the kit** and **security check didn't run** are WARNs: tell the dev in one line (the security check is often a login: `! shopify auth login`; run verify again once it can). Other WARNs: read them; a real problem goes back to build.
2. **QA** (every `qa:` scenario), on the dev store, on the current code:
   - **The app running:** ask the dev to run the `appDev` command `node .claude/kit/shopify.mjs info` prints, in a separate terminal (it keeps running, so not with `!`; a bare `shopify app dev` may target production). Say its `devStoreWarning` if any. Admin pages: claude-in-chrome in the dev's Chrome; never handle their credentials (a login page: ask the dev to log in to the dev store). Checkout UI extensions and Functions reach the dev store only through that `app dev` (it reloads changes itself; ask for a restart only when you still see old code).
   - **Storefront:** password-protected on a dev store: ask the dev for the password (Online Store → Preferences), enter it on `/password`, never store it.
   - **The A/B code** (`abtest/<ID>/`), before the checkout rows: run `variation.js` with the javascript tool after adding a product, then check `/cart.js`: the right values; nothing on an empty cart; no second `/cart/update.js` on a rerun; no update loop when the drawer opens and a quantity changes (count requests); other attributes kept; the device value at a mobile width, if any. Then `control.js`: the attributes are gone. A `qa:` row each.
   - **An A/B gate:** with the attribute and without, set **by running the variation file unchanged** (only that proves code and extension agree on key and value). Measure "absent" in the same checkout session right after, so it isn't empty only because the block isn't placed or `app dev` isn't running.
   - **Checkout traps:** the checkout editor preview is a cross-origin iframe (measure on the checkout itself); a cleared text setting arrives as `undefined`, so a code default fills it back in (test clearing one); an admin "Preview" checkout loses its cart when you step back (start each step from a fresh cart). A cart attribute from the storefront tab: `await fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { _ab_gift: 'B' } }) })`, checked with `/cart.js`, cleared with `''`.
   - **Editor setup on the dev store is yours, without asking:** reading what's placed and how it's set, turning on the app embed, adding the app block, changing its settings, in the theme editor and the checkout editor. Say in one line what you're doing; don't ask the dev to check the setup or tell you what it is. Add blocks with the editor's add-block picker (drags don't take). Saving is fine on the dev store; publishing a theme or checkout configuration stays the dev's. After a change, check it in the preview and say what you changed. Still stuck after 2 tries: ask the dev.
   - **Viewport rows:** claude-in-chrome's resize changes the window, not the viewport, and stalls near 650px. Read `window.innerWidth` back after each resize and put it in `--how`; prefer a Playwright browser for a mobile width.
   - **Text:** `innerText` is CSS-transformed (`uppercase` reads "FREE"); compare `textContent` when the wording is the point.
   - **Store setup for QA** (a test product, a Function's activation): write the mutation to `.claude/logs/<ID>/<name>.graphql` and run `node .claude/kit/shopify.mjs mutate <ID> <file>`; the guard shows it to the dev first. Reads: `shopify.mjs query <file>`.
   - Record each: `node .claude/kit/app.mjs qa-row <ID> <S#> --measured "<what you saw>" --how "<where and how>" --verdict PASS|FAIL|BLOCKED`. Measured means observed (a screenshot, a DOM value, a response), never assumed from the code.
   - A FAIL whose fix stays inside the approved scenarios goes back to build on its own: fix, verify again, at most 2 rounds, then come to Gate 2 with 0 FAIL and one line per fix. Ask when the scenario itself looks wrong, the fix touches money, or after 2 rounds. A scenario that truly can't be measured on a dev store: ask the dev; with their agreement, `app.mjs waive <ID> <S#> --reason "…" --answer "<the dev's words>"`.
3. **Reviews.** verify's `reviews` says whether build's code review still covers this code. If not (a fix loop changed it), run `code-review` (`high`) on what changed and record it: `app.mjs review <ID> code --found "…"`. Run `security-review` on the change's diff and record it: `app.mjs review <ID> security --found "<what it found and what was done>"`. A real finding goes back to build.
4. Commit the change folder on the branch.

**Done when:** verify passed on the current code, every `qa:` scenario is PASS (or waived), and both reviews are recorded on it. Run `app.mjs done <ID> verify`.

## Stage: accept (Gate 2)

Run `node .claude/kit/app.mjs gate <ID>`. Ask the dev with AskUserQuestion, built from it, in at most 20 lines:
- the result: each check's verdict, the scenarios with their results (QA as measured, and how); a WARN in a line each
- **changed since Gate 1**, if any: each scenario, § Surfaces or § Retires change from what they approved
- the surfaces that need attention, and the deploy steps they imply
- the manual checks left for the reviewer, and any waived scenario
- anything you are unsure of
Options: "Accept" and "Not yet" (the dev says what). On accept: `node .claude/kit/app.mjs done <ID> accept --answer "<the dev's words>"`. On "Not yet": go back to the stage that fixes it.

**Done when:** the dev accepted.
