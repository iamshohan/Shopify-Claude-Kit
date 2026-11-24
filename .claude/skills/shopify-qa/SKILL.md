---
name: shopify-qa
description: Stages 7–8 of /shopify-implement. Check the task's draft theme against the plan's QA criteria with measured values (storefront, settings previews, customizer contract and editor, regression), write report.md, and get the dev's acceptance. QA failures go back to the builder. Use only when /shopify-implement's status says the stage is qa or accept.
user-invocable: false
---

# QA and accept

You measure; fixes go back to the builder (§ Fix what you can). A criterion is PASS only when a value measured on the running draft meets it. Use exactly these four verdicts:

| Verdict | Meaning |
| --- | --- |
| PASS | measured, and it meets the criterion |
| FAIL | measured, and it doesn't |
| NOT TESTED | checkable here but not checked; say why |
| BLOCKED | can't be checked here; say exactly what's missing, e.g. "dev checks by hand: …" |

Never write "QA passed" while any row is FAIL, NOT TESTED or BLOCKED.

## Stage: qa

### Setup

1. `node .claude/kit/kit.mjs status <KEY>` gives the draft theme id, the preview URL, the editor URL and the feature prefix.
2. Copy every row of `plan.md` § QA criteria into `report.md` § Criteria, Expected filled and Measured empty, before measuring anything, so results can't shape the expectations.
3. **Record each row as soon as it's measured** (a compaction then loses nothing): `kit.mjs qa-row <KEY> <#> --measured "…" --how "…" --verdict PASS`. Never type, edit or blank a verdict in the table yourself; a criterion changed in `plan.md` after it was measured gets measured again.
4. **Two browsers, each for what it's safe for.**
   - **Storefront (the draft, live for comparison): `kit-browser`** (`mcp__kit-browser__*`), isolated and logged in nowhere. Missing: stop and ask the dev to add it (the command is in `/shopify-setup`) and restart; the storefront isn't measured in Chrome, which can't set the viewport.
   - **Theme editor and admin: Chrome** (load the `claude-in-chrome` skill, open a new tab and keep it in front: background tabs freeze timers). It runs as the dev's admin account.
5. **Overlays first.** Shopify's preview bar (`#PBarNextFrameWrapper`), cookie banners and newsletter popups block clicks and hit tests: in kit-browser, accept only the necessary cookies, close popups and hide the preview bar before measuring. Never in the dev's Chrome.
6. **Viewports.** `browser_resize` to each size the criteria need, then read `innerWidth` back. `browser_click` takes a CSS selector or a ref from `browser_find`. Actions return no snapshot; take `browser_snapshot` only when you need the page's structure. Touch-only behaviour stays a by-hand row.
7. **Order.** Page by page, then viewport by viewport: measure every criterion for that page and width before navigating again.
8. **Plain HTML checks** (does the draft render X, which theme served it): `node .claude/kit/shopify.mjs fetch <KEY> <path> --find <text>`, no browser.

### On every page, before measuring

1. **Probe loaded.** Once per session, before the first storefront page, run `browser_run_code_unsafe` with `filename: ".claude/kit/probe.init.js"` (no `code`). Every page after that defines `window.__qa` before its own scripts (so `__qa.errors()` and `__qa.shift()` include the load); check with `browser_evaluate` `() => typeof __qa`, and measure with `browser_evaluate` too. If the init file is refused: on the first page run the contents of `.claude/kit/probe.inject.js` with `browser_evaluate`, and after every navigation or reload only this line:
   ```js
   sessionStorage.getItem('__qaSrc') ? ((0, eval)(sessionStorage.getItem('__qaSrc')), 'probe ready') : 'NO PROBE: inject probe.inject.js'
   ```
2. **Right theme.** `__qa.env()`'s `theme.id` must equal the draft id (a URL alone doesn't prove it: the preview cookie survives redirects). Comparing with live, `theme.role` must be `main`; with a base theme in status, "live" is `?preview_theme_id=<baseTheme>` and `theme.id` must equal it. Read it once `document.readyState` is `complete` (null before means "not loaded yet").
3. **Right width.** Read `window.innerWidth` after every reload. Not the viewport you asked for: ask the dev; never record a mobile result measured at desktop width.
4. **Change present.** `__qa.live('<prefix>')` must find the feature where it should render.

| The criterion is about | Call |
| --- | --- |
| visible / exists | `__qa.see(sel)`. A "partly clipped" or "partly covered" caveat means only the centre was checked. It can't see an overlay with `pointer-events:none`, a `clip-path`, or text the colour of its background: when a criterion depends on those, judge a screenshot. |
| copy (text) | `__qa.text(sel)`: compare `textContent` (`innerText` is CSS-uppercased under `text-transform`) |
| size, position, spacing | `__qa.gap(a, b)`, `__qa.pad(container, child)`, `__qa.gutter(sel)` |
| colours, fonts, values | `__qa.css(sel, ['color', 'font-size'])` |
| a style that isn't applying | `__qa.why(sel, prop)` |
| layout at a width | `__qa.overflow()`, then the checks above |
| a click or toggle | `__qa.snap()` → act → `__qa.diff()` |
| an animation | `await __qa.motion(sel, 600)` |
| JS errors | `__qa.errors()` |
| the How column | `__qa.report()` (copy the call verbatim) |

### Checks, cheapest first

1. **Storefront.** Each target page, at each viewport, in each locale in scope (`/de/…`), in each data state (metafield set and unset on the agreed products).
   - A/B ports: compare with the live winner through the force link in status (`abtest.reference`). Without one, a geo-targeted test is invisible from outside its markets: BLOCKED, never compared with control.
   - **Bug fixes:** measure the "Repro:" row on live too: it must fail there and pass on the draft, both in Measured ("live: …; draft: …").
   - The experiment mustn't be running on the draft (its body class or init attribute, from the A/B inventory): if it is, stop and ask the dev.
   - **Design audit rows (exact mode):** `node .claude/kit/kit.mjs design-audit <KEY> <viewport>` and do what it prints (resize, open the page in the default state, run the generated file with `browser_run_code_unsafe`). PASS only when its verdict is PASS; otherwise FAIL with the failures and missing selectors in Measured (long output in `.claude/logs/<KEY>/design-audit-<viewport>.txt`). A missing selector usually means the build named the class differently: a FAIL to fix, not a spec to edit.
   - **App widgets in a cross-origin iframe** (reviews, chat, upsells): the probe can't see inside, so a filled widget reads as empty. Check the iframe's size and the app's own data (e.g. a `loox.num_reviews` metafield), or BLOCKED for the dev.
   - **Design rows (reference mode):** layout only, at the Figma frame's width: what's present, the order, what shows and hides, sizes that fill or flex.
   - **A design check on request:** if the dev doubts the draft matches a Figma design that wasn't in the plan, run the `design-extractor` agent on the frames they name, write `design.md` and `design-checks.json` as analyze does, fill the selectors from the build, and add audit rows marked "(design)".
2. **Settings behaviour.** Defaults, each empty state, and up to two combinations, with virtual previews, not the editor.
   1. Copy `.claude/kit/templates/preview-overrides.example.json` to `.claude/logs/<KEY>/previews/NN-<case>.json` and change only the file, section key, block ids and values.
      - Use the template the test product actually renders with (often an alternate like `product.alternate.json`), and take section keys from it (`shopify.mjs pull-live <KEY> templates/<file>`, or the branch's copy if the branch changed it).
      - `merge` deep-merges objects but replaces arrays (send the full `block_order`), and can't remove a value: to test an empty image or url, use `source` with the whole template.
      - Section groups (`sections/*-group.json`) can't be previewed: measure header and footer settings in the theme editor (step 3).
   2. `node .claude/kit/shopify.mjs preview <KEY> <file>`, open the URL it returns, pass the gates above, and measure.
   3. After two failed previews for one case, measure it in the draft's theme editor (change, measure, reset as step 3 says). That fails too: NOT TESTED, with the CLI error.
3. **Customizer.** Skip when `contract.mjs` reports no changed section, block or settings files. The theme editor is one cross-origin iframe, so `read_page`, `find`, `get_page_text` and `javascript_tool` can't see inside it: work from screenshots and clicks.
   1. **Contract.** `node .claude/kit/contract.mjs <KEY>` writes `contract.md` from the changed schemas, locales and templates. Each mismatch with `plan.md` § Schema details, and each entry in its "Problems" list, is a FAIL.
   2. **Loads in the editor.** Open `<editorUrl>?previewPath=<a target page>`, wait about 30 seconds (it took 8–40 s in tests), screenshot: the draft's name with the **Draft** badge, a grey **Save**, and the feature in the preview. A login or 2FA page: BLOCKED, stop. Cite the screenshot in How.
   3. **In the editor, on the draft.** Check what this change touches, filling contract.md's "Seen in editor" column:
      - each changed section and block: select it and screenshot the settings panel (labels and defaults are contract.mjs's check)
      - "Add section" / "Add block": the new one is listed where the plan allows it, absent where it doesn't
      - a setting the plan says updates the preview: change it, wait 2 s, see the preview follow
      - each new image, colour, url or dynamic-source picker: open it, check it shows what it should, close it
      - blocks: add one with "Add block" and remove it; reorder only with the panel's controls, never by drag

      **Then leave the editor as it was:** close the editor tab (`tabs_close_mcp`), open it again, and check **Save** is grey and the values are the plan's defaults. Don't reload or navigate away from an editor with changes (the "Leave site?" dialog blocks Claude in Chrome); setting values back or undo often leaves Save active. **Never click Save, Publish, Remove section, delete, or anything that changes the store** (on a GitHub-connected draft a Save becomes a commit on the PR branch). Claude in Chrome missing, or a login page: BLOCKED rows for the dev.
   4. **By hand (dev checklist):** a BLOCKED "dev checks by hand" row only for what step 3 can't do and this change touches: placing by drag in the theme or checkout editor; touch-only behaviour on a real phone; Translate & Adapt texts; app blocks still working (the section accepts `@app` blocks and the store has such an app); anything else judged by eye that the plan names.
4. **Regression.** `node .claude/kit/compare.mjs <KEY>` compares live with the draft on the untouched paths (section lists and the feature prefix decide its verdict; `htmlDiffers` often lists per-request content: look at the sections the branch touches).
   - DIFFERS: rule out live edits made after the draft was copied (`draftCreatedAt`) before calling it a regression.
   - BLOCKED (password page, bot protection, wrong theme): report it as BLOCKED. Rate-limited even after its retries: compare in kit-browser instead (the section ids under `main` and the feature prefix), and say so in How.
5. **Console errors** on each target page: `__qa.errors()`.

### The report

- **§ You must still do** (top of the report): one numbered line per BLOCKED or NOT TESTED row, saying where and how the dev checks it ("#22 Open the draft on a phone and swipe the gallery: it must snap to each image"). A check that changes store data uses a test entry the task created or a preview, never a live value. Add any ticket AC not delivered, and each file status lists under "Live edits since the base" (live's edit there is replaced at merge unless the branch carries it).
- **§ Criteria:** `#`, criterion, expected, measured, how, verdict. Measured and How about 15 words each: the probe call or command and the number that decided it; longer evidence in a file the cell names.
- **§ Summary:** "N criteria: x PASS, y FAIL, z NOT TESTED, w BLOCKED." and "Gates: theme ✓ <id>, viewport ✓ <widths>."
- **Screenshots** only for what a human must judge visually, in `.claude/logs/<KEY>/screenshots/`.

### Fix what you can, before Gate 2

A FAIL whose fix stays inside the approved plan (a selector, a missing guard, a timing, a style value the plan states) goes back to build on its own: `kit.mjs back <KEY> build --reason "QA #n"`, fix it in fix mode (recorded under plan.md § Amendments), push, and re-measure the failed rows, the rows on pages the fix touched, and the regression check. PASS rows measured before the fix: re-measure each, or carry the ones the fix can't reach with `kit.mjs qa-row <KEY> <#,#,…> --carry "<why>"`. At most 2 rounds.

Ask instead of fixing when:
- **live fails the row too** (measure live first): the Expected was written from code, and "fixing" it would change an existing component (GSD-80's mega menu already overflowed on live);
- the fix touches a price or a discount, changes what the merchant controls, or adds a setting or definition;
- 2 rounds didn't fix it.

**Done when:** every criterion has a verdict recorded with qa-row, no FAIL is left that you could fix, the draft is at the branch head, and the summary is written. Then `kit.mjs done <KEY> qa`.

## Stage: accept (Gate 2)

1. Show the dev, and nothing more:
   - **"Not proven yet" rows that didn't pass** (plan.md § At a glance), each with its fallback, first and set apart: "#11 Restock Rocket for the set product: NOT TESTED. Fallback: no waitlist button."
   - one verdict line that keeps apart what only the dev can check (BLOCKED) and what you didn't check (NOT TESTED, with why): "20 PASS, 0 FAIL, 3 only you can check, 2 not tested by me (preview failed twice)"
   - each FAIL with what was measured
   - § You must still do, as written
   - "Since the plan was approved" from `kit.mjs status <KEY>` (files the plan didn't name, plan changes), or "none"
   - anything the dev should decide about, at most three lines
2. AskUserQuestion: "QA result for <KEY>". Options: **Accept, I'll do the N checks** (or **Accept** when nothing is open), **Fix the failures** (only with a FAIL left), and **I'll test more first**. A FAIL left open is accepted only by naming it as "#n" in the answer. When "not proven yet" rows didn't pass, replace the first option with **Use the fallback for #…** and **Accept #… untested** (the dev's risk, named), naming every such criterion that isn't PASS (each Not proven yet row's "QA #" column) in both labels.
3. Then:
   - **Accept** (or **Accept #… untested**) → `kit.mjs done <KEY> accept --answer "<their words>"`.
   - **Use the fallback for #…** → `kit.mjs back <KEY> build --reason "fallback for #…"`, record it under plan.md § Amendments, and continue as for fixes.
   - **Fix the failures** → `kit.mjs back <KEY> build --reason "<the failing rows>" --answer "<their words>"`, then as in "Fix what you can".
   - **I'll test more first** → wait; issues the dev reports become rows, treated as fixes.
