---
name: shopify-qa
description: Stages 7–8 of /shopify-implement. Check the task's draft theme against the plan's QA criteria with measured values (storefront, settings previews, customizer contract and editor, regression), write report.md, and get the dev's acceptance. QA failures go back to the builder. Use only when /shopify-implement's status says the stage is qa or accept.
user-invocable: false
---

# QA and accept

You check; you don't fix. A criterion is PASS only when a value measured on the running draft meets it. Use exactly these four verdicts:

| Verdict | Meaning |
| --- | --- |
| PASS | measured, and it meets the criterion |
| FAIL | measured, and it doesn't |
| NOT TESTED | checkable here but not checked; say why |
| BLOCKED | can't be checked here; say exactly what's missing, e.g. "dev checks by hand: …" |

Never write "QA passed" while any row is FAIL, NOT TESTED or BLOCKED.

## Stage: qa

### Setup

1. Run `node .claude/kit/kit.mjs status <KEY>`. It gives the draft theme id, the preview URL, the editor URL and the feature prefix.
2. Copy every row of `plan.md` § QA criteria into `report.md` § Criteria, filling the Expected column and leaving Measured empty. Do this before measuring anything, so that results can't shape the expectations.
3. **Write each row's result into `report.md` as soon as you've measured it**, not at the end. A compaction then loses nothing.
   Use `kit.mjs qa-row <KEY> <#> --measured "…" --how "…" --verdict PASS`. It edits one row safely; don't rewrite the table with heredocs or regex scripts.
   - PASS and FAIL need `--measured` and `--how` in the same call, and a draft at HEAD. The row records the commit, the draft, the time and the plan's text for the criterion.
   - `done qa` wants a qa-row verdict for every numbered plan criterion, shown as recorded in report.md, so never type, edit or blank a verdict in the table. A criterion changed in `plan.md` after it was measured gets measured again.
   - **QA resumed from an earlier kit version:** if `done qa` names rows qa-row has no matching record for, re-measure each and record it with qa-row on the draft at HEAD.
4. **Browsers: two, each for what it's safe for.**
   - **Storefront (the draft, live for comparison): the `kit-browser` tools** (`mcp__kit-browser__*`, an isolated Playwright browser that `/shopify-setup` adds). It isn't logged in anywhere, so nothing it does can reach the admin.
   - **Theme editor and admin pages: Chrome** (load the `claude-in-chrome` skill, then open a new tab and keep it in front: background tabs freeze animations and timers). Chrome runs as the dev's admin account.
   - **No `kit-browser` tools?** Stop and ask the dev to add the server (the command is in `/shopify-setup`, step 8) and restart Claude Code. The storefront isn't measured in Chrome: it can't set the viewport.
5. **Viewports.** `browser_resize` to each width × height the criteria need, then read `innerWidth` back. `browser_click` is a real pointer click on the element. Touch-only behaviour (swipes, `touchstart` handlers) stays a by-hand row.
6. **Plan the order.** Work page by page, then viewport by viewport, and measure every criterion for that page and width before navigating again.
7. **Plain HTML checks** (does the draft render X, which theme served it) don't need the browser: `node .claude/kit/shopify.mjs fetch <KEY> <path> --find <text>`.

### On every page, before measuring

1. **Probe loaded.**
   - Once per session, before opening the first storefront page, run `browser_run_code_unsafe` with `filename: ".claude/kit/probe.init.js"` (no `code`). The file only adds the probe to every page; the prompt names it, so the dev can see what runs. From the next navigation on, each page defines `window.__qa` before its own scripts, so `__qa.errors()` and `__qa.shift()` include the load. Check with `browser_evaluate` `() => typeof __qa`. Measure with `browser_evaluate` too, e.g. `() => __qa.see('.x')`.
   - **The init file is refused:** on the first page, run the contents of `.claude/kit/probe.inject.js` with `browser_evaluate`. It keeps the source in the tab's `sessionStorage`; after every navigation or reload, run only this one line:
     ```js
     sessionStorage.getItem('__qaSrc') ? ((0, eval)(sessionStorage.getItem('__qaSrc')), 'probe ready') : 'NO PROBE: inject probe.inject.js'
     ```
2. **Right theme.** Run `__qa.env()`. Its `theme.id` must equal the draft id. A URL alone doesn't prove it, because the preview cookie survives redirects. When comparing with live, `theme.role` must be `main`. Read it once `document.readyState` is `complete`; earlier, `Shopify.theme` can still be unset, and null means "not loaded yet", not a wrong theme.
3. **Right width.** Read `window.innerWidth` after every reload. If it isn't the viewport you asked for, ask the dev; never record a mobile result measured at desktop width.
4. **Change present.** `__qa.live('<prefix>')` must find the feature where it should render.

| The criterion is about | Call |
| --- | --- |
| visible / exists | `__qa.see(sel)` |
| copy (text) | `__qa.text(sel)`: compare its `textContent`. `innerText` comes back CSS-uppercased under `text-transform` |
| size, position, spacing | `__qa.gap(a, b)`, `__qa.pad(container, child)`, `__qa.gutter(sel)` |
| colours, fonts, values | `__qa.css(sel, ['color', 'font-size'])` |
| a style that isn't applying | `__qa.why(sel, prop)` |
| layout at a width | `__qa.overflow()`, then the checks above |
| a click or toggle | `__qa.snap()` → act → `__qa.diff()` |
| an animation | `await __qa.motion(sel, 600)` |
| JS errors | `__qa.errors()` |
| the How column | `__qa.report()` (copy the call verbatim) |

### Checks, cheapest first

1. **Storefront.** Cover each target page in the plan, at each viewport, in each locale in scope (locale paths such as `/de/…`), and in each data state (metafield set and unset on the agreed products).
   - A/B ports: compare with the live winner through the force link in status (`abtest.reference`). Without one, a geo-targeted test is invisible from outside its markets: mark that row BLOCKED and say so, rather than comparing with control.
   - **Bug fixes:** measure the "Repro:" row on live too. It must fail there and pass on the draft; record both in Measured ("live: …; draft: …"). A repro that doesn't fail on live proves nothing about the fix, and `done qa` refuses a PASS without both.
   - Check that the experiment isn't running on the draft (its body class or init attribute, from the A/B inventory). If it is, stop and ask the dev: its code rewrites the new markup.
   - **Design audit rows (exact mode):** run `node .claude/kit/kit.mjs design-audit <KEY> <viewport>` and do what it prints: resize, open the page in the default state, run the generated file with `browser_run_code_unsafe`. It checks every value in `design-checks.json` with these margins: colours, font family and weight exact; font size ±1px; line height, spacing and radius ±2px; fixed width and height ±5px; "fills its parent" within 2px. PASS only when its verdict is PASS. Otherwise record FAIL with the failures and missing selectors in Measured (the full output goes in report.md § Details if it's long). A missing selector usually means the build named the class differently from the plan: that's a FAIL to fix, not a spec to edit.
   - **Design rows (reference mode):** layout only, at the Figma frame's width: what's present, the order, what shows and hides, and sizes that fill or flex (`__qa.see`, `__qa.gap`, `__qa.box`).
   - **A design check on request:** if the dev doubts the draft matches a Figma design that wasn't part of the plan, run the `design-extractor` agent on the frames they name, write `design.md` and `design-checks.json` as analyze does, fill the selectors from the build, and add audit rows to report.md § Criteria marked "(design)".
2. **Settings behaviour.** Cover the defaults, each empty state, and up to two combinations. Use virtual previews, not the editor.
   1. Copy `.claude/kit/templates/preview-overrides.example.json` to `.claude/logs/<KEY>/previews/NN-<case>.json` and change only the file, section key, block ids and values.
      - Use the template the test product actually renders with: products often use an alternate template like `product.alternate.json`.
      - Take section keys from that template: pull it with `shopify.mjs pull-live <KEY> templates/<file>`, or read the branch's copy if the branch changed it. Keys differ per template; only `main` is common.
      - `merge` deep-merges objects but replaces arrays, so send the full `block_order`.
      - `merge` can't remove a value. To test an empty image or url setting, use `source` with the whole template.
      - Section groups work the same way: header and footer settings live in `sections/header-group.json` (or `footer-group.json`), so override that file, not a template.
   2. Run `node .claude/kit/shopify.mjs preview <KEY> <file>`, open the URL it returns, pass the gates above, and measure.
   3. After two failed previews for one case, mark those rows NOT TESTED, quote the CLI error, and move on.
3. **Customizer.** The theme editor is one cross-origin iframe: `read_page`, `find`, `get_page_text` and `javascript_tool` can't see inside it. Split the check in three.
   1. **Contract (script).** Run `node .claude/kit/contract.mjs <KEY>`. It writes `.claude/logs/<KEY>/contract.md` from the changed schemas, locales and templates: names, presets, where each section can be added, and every setting's label, type, default, options/range, info and `visible_if`.
      - Compare it row by row with `plan.md` § Schema details. Each mismatch is a FAIL.
      - Each entry in its "Problems" list is a FAIL: missing `t:` keys, a default that isn't an option, an off-range default, unknown preset blocks.
   2. **Loads in the editor (one screenshot per task).** Navigate to `<editorUrl>?previewPath=<a target page>`, wait about 30 seconds (the editor took 8–40 s to load in tests), and take one screenshot. It must show the draft's name with the **Draft** badge, a greyed-out **Save** button, and the feature in the preview. A login or 2FA page means BLOCKED; stop. Cite the screenshot in the How column of the customizer row. Never click in the editor.
   3. **By hand (dev checklist).** Add these as BLOCKED rows with "dev checks by hand":
      - each setting's label and value in the editor panel, and each section's entry (or its absence) in "Add section": contract.md lists them, with a "Seen in editor" column for the dev
      - the dynamic-source picker shows the metafield
      - a value change re-renders live in the preview
      - image, colour and url pickers open
      - blocks can be added, removed and reordered
      - placing a section or block by drag in the theme or checkout editor (synthetic drag events there aren't reliable)
      - app blocks still work
      - the mobile preview toggle
      - Translate & Adapt texts
      - anything judged by eye
4. **Regression.** Run `node .claude/kit/compare.mjs <KEY>`. It compares live with the draft on the untouched paths: the section lists and the feature prefix decide its verdict. `htmlDiffers` lists sections whose HTML differs, often per-request content (stock, recommendations): look at the ones the branch touches.
   - DIFFERS: rule out live edits made after the draft was copied (`draftCreatedAt`) before calling it a regression.
   - BLOCKED (password page, bot protection, wrong theme): report it as BLOCKED.
5. **Console errors** on each target page: `__qa.errors()`.

### The report

- **§ You must still do** (top of the report): one numbered line per BLOCKED or NOT TESTED row, saying where and how the dev checks it: "#22 Replace the FAQ icon in Content → Metaobjects → Mobile menu image, reload the draft, restore it." Add any ticket AC that isn't delivered, and each file status lists under "Live edits since the base": live's own edit there is replaced at merge unless the branch carries it.
- **§ Criteria:** one row per criterion, with the columns `#`, criterion, expected, measured, how, and verdict. Keep Measured and How to about 15 words each: the probe call or command and the number that decided it. Longer evidence goes in a file under `.claude/logs/<KEY>/` that the cell names.
- **§ Summary:**
  - "N criteria: x PASS, y FAIL, z NOT TESTED, w BLOCKED."
  - "Gates: theme ✓ <id>, viewport ✓ <widths>."
  - "Not covered: …"
  - "Dev checks by hand: …"
  - "The draft is a copy of live plus this branch."
- **Screenshots** only for things a human must judge visually, saved in `.claude/logs/<KEY>/screenshots/`.

**Done when:** every criterion has a verdict recorded with qa-row, the draft is at the branch head, and the summary is written. Then run `kit.mjs done <KEY> qa`.

## Stage: accept (Gate 2)

1. Show the dev, and nothing more:
   - one verdict line: "20 PASS, 0 FAIL, 5 for you to check"
   - each FAIL with what was measured
   - § You must still do, as written in the report
   - "Since the plan was approved" from `kit.mjs status <KEY>`: changed files the plan didn't name, and the plan's changes. Say "none" when both are none.
   - anything noticed that the dev should decide about, at most three lines
   - **"Not proven yet" rows that didn't pass** (plan.md § At a glance), each with its fallback, first and set apart: "#11 Restock Rocket for the set product: NOT TESTED. Fallback: no waitlist button."
2. AskUserQuestion: "QA result for <KEY>". Options: **Accept, I'll do the N checks** (or **Accept** when nothing is open), **Fix the failures**, and **I'll test more first**. When a "not proven yet" row didn't pass, replace the first option with **Use the fallback for #…** and **Accept #… untested** (the dev's risk, named), and keep the other two. `done accept` refuses an untested not-proven row the answer doesn't name.
3. Then:
   - **Accept** (or **Accept #… untested**) → `kit.mjs done <KEY> accept --answer "<their words>"`.
   - **Use the fallback for #…** → `kit.mjs back <KEY> build --reason "fallback for #…"`, record it under plan.md § Amendments, and continue as for fixes below.
   - **Fix the failures** → `kit.mjs back <KEY> build --reason "<the failing rows>"`. Then:
     1. Follow the build stage in fix mode: the builder gets the failing rows. Then commit.
     2. Run the draft stage again (push).
     3. Run the qa stage again. Re-measure the failed rows, the rows on pages the fix touched, and the regression check. `done qa` lists the PASS rows measured before the fix changed theme files: re-measure each, or keep the ones the fix can't reach with `kit.mjs qa-row <KEY> <#,#,…> --carry "<why>"`.
   - **I'll test more first** → wait. When the dev reports issues, add them as rows and treat them as fixes.
