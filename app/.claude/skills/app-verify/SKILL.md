---
name: app-verify
description: The verify and accept stages of the App Kit. Run every automated check (surfaces, the scenarios' tests, the test ledger, the repo's verify commands, Function fixtures and instruction counts, bundle size, security check), measure the qa scenarios on the dev store, record the security review, then take the result to Gate 2. Use only when app.mjs status says the stage is verify or accept.
user-invocable: false
---

# Verify and accept

## Stage: verify

1. **Automated.** Run `node .claude/kit/app.mjs verify <ID>` (it runs each scenario's test and every ledgered test, the repo's verify commands, the changed Functions' fixtures, the bundle size of changed checkout UI, and `shopify app security check`). It records the result against the current app code.
   - Any FAIL → go back to build with the failing lines: `app.mjs back <ID> build --reason "<check>: <one line>"`, fix there, then return here.
   - **ledger: gone** → a test an earlier change bound was deleted or renamed. Restore it, or, if the change means it, go back to propose, list it under § Retires and ask Gate 1 again.
   - **surfaces: changed outside the kit** is a WARN: a surface changed on the base branch without a change. Tell the dev in one line; handoff records it.
   - **security check didn't run** is a WARN: tell the dev in one line (often a login: `! shopify auth login`), and run verify again once it can.
   - Other WARNs → read them; a real problem goes back to build.
2. **QA** (every `qa:` scenario). Measure each on the dev store, on the current code:
   - **Admin pages** need the app running. Run `node .claude/kit/shopify.mjs info` and ask the dev to run its `appDev` command exactly: it names the dev app's config and the dev store, where a bare `shopify app dev` (or `npm run dev`) uses whatever the CLI last used, possibly the production app or another project's store. Say its `devStoreWarning` if there is one. Then the dev opens the app in their browser. Use claude-in-chrome on that tab; the dev is logged in, you never handle their credentials.
   - **Checkout UI extensions and Functions reach the dev store only through the dev's running `app dev` (the `appDev` command above)** (it pushes a dev preview of the app to the dev store). Nothing the kit runs deploys them. Code changed since the session started → ask the dev whether `app dev` picked it up before measuring.
   - **Checkout and storefront**: the dev store's checkout. The dev store's storefront is password-protected: ask the dev for the storefront password (Online Store → Preferences), enter it on `/password`, never store it in a file.
   - **The A/B code** (`abtest/<ID>/`), on the dev store's storefront before the checkout rows: run `variation.js` with the javascript tool after adding a product, and check `/cart.js`: the attributes (or each line's properties) have the right values; an empty cart gets nothing; running it again sends no second `/cart/update.js`; opening the cart drawer and changing a quantity causes no update loop (count the requests); the cart's other attributes are kept; at a mobile width the device value changes, if there is one. Then run `control.js`: the attributes are gone. Record each as a `qa:` row.
   - **An A/B gate**: once with the attribute set (the variation) and once without (nothing happens). Set a cart attribute from the storefront tab before opening checkout: `await fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { _ab_gift: 'B' } }) })`, check it with `fetch('/cart.js')`, and clear it with the value `''`.
   - **Placing a checkout block is the dev's step**, even on the dev store: the checkout editor ignores synthetic drags. Ask the dev to place it, then measure.
   - **Viewport rows**: claude-in-chrome's resize changes the window, not the viewport, and stalls near 650px wide. Read `window.innerWidth` back after every resize and record it in `--how`; for a mobile width, prefer a Playwright browser (its resize sets the viewport).
   - **Text**: `innerText` returns CSS-transformed text (`text-transform: uppercase` reads "FREE"). Compare against `textContent` when the expected result is the wording.
   - **Store setup for QA** (a test product, a Function's activation on the dev store): write the mutation to `.claude/logs/<ID>/<name>.graphql` and run `node .claude/kit/shopify.mjs mutate <ID> <file>`; the guard shows it to the dev first. Reads: `shopify.mjs query <file>`.
   - Record each: `node .claude/kit/app.mjs qa-row <ID> <S#> --measured "<what you saw>" --how "<where and how>" --verdict PASS|FAIL|BLOCKED`. PASS and FAIL need both texts in the same call. Measured means observed (a screenshot, a DOM value, a response), never assumed from the code.
   - A FAIL goes back to build. A scenario that truly can't be measured on a dev store: ask the dev; with their agreement, `app.mjs waive <ID> <S#> --reason "…"` (the handoff lists it).
3. **Reviews.** verify's `reviews` says whether the code review recorded in build still covers this code. If not (a fix loop changed it), run `code-review` (`high`) on what changed and record it again: `app.mjs review <ID> code --found "…"`. Run the `security-review` skill on the change's diff and record it: `app.mjs review <ID> security --found "<what it found and what was done>"`. A real finding goes back to build.
4. Commit the change folder on the branch.

**Done when:** verify passed on the current code, every `qa:` scenario is PASS (or waived) on the current code, and both reviews are recorded on it. Run `app.mjs done <ID> verify`.

## Stage: accept (Gate 2)

Run `node .claude/kit/app.mjs gate <ID>`. Ask the dev with AskUserQuestion, built from it, in at most 20 lines:
- the result: each check's verdict, the scenarios with their results (QA as measured, and how); a WARN's note (a security finding that doesn't block, a surface changed outside the kit) in a line each
- **changed since Gate 1**, if any: each scenario, § Surfaces or § Retires change from what they approved
- the surfaces that need attention, and the deploy steps they imply
- the manual checks left for the reviewer, and any waived scenario
- anything you are unsure of
Options: "Accept" and "Not yet" (the dev says what). On accept: `node .claude/kit/app.mjs done <ID> accept --answer "<the dev's words>"`. On "Not yet": go back to the stage that fixes it.

**Done when:** the dev accepted.
