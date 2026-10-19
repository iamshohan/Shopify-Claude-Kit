---
name: shopify-qa
description: Stages 8–9 of /implement. Check the task's draft theme against the plan's QA criteria with measured values (storefront, settings previews, customizer contract and editor, regression), write report.md, and get the dev's acceptance. QA failures go back to the builder. Use only when /implement's status says the stage is qa or accept.
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
4. **Browser.** Load the `claude-in-chrome` skill, then create a new tab with the Chrome MCP. Keep that tab in front: background tabs freeze animations and timers.
5. **Plan the order.** Work page by page, then viewport by viewport, and measure every criterion for that page and width before navigating again.

### On every page, before measuring

1. **Probe loaded.** On the first page of a storefront origin, read `.claude/kit/probe.inject.js` and run its contents with `javascript_tool`. It defines `window.__qa` and keeps the source in the tab's `sessionStorage`. After every navigation or reload, run only this one line:
   ```js
   sessionStorage.getItem('__qaSrc') ? ((0, eval)(sessionStorage.getItem('__qaSrc')), 'probe ready') : 'NO PROBE: inject probe.inject.js'
   ```
   If eval is refused on a page, inject `.claude/kit/probe.js` directly.
2. **Right theme.** Run `__qa.env()`, plus `Shopify.theme.id`, which must equal the draft id. A URL alone doesn't prove it, because the preview cookie survives redirects. Read it once `document.readyState` is `complete`; earlier, `Shopify.theme` can still be unset, and null means "not loaded yet", not a wrong theme.
3. **Right width.** After a resize, reload and read `window.innerWidth`. If the width is wrong, ask the dev to un-maximize or resize the browser window, then check again; `resize_window` does nothing on a maximized window. Never record a mobile result measured at desktop width.
4. **Change present.** `__qa.live('<prefix>')` must find the feature where it should render.

| The criterion is about | Call |
| --- | --- |
| visible / exists | `__qa.see(sel)` |
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
2. **Settings behaviour.** Cover the defaults, each empty state, and up to two combinations. Use virtual previews, not the editor.
   1. Copy `.claude/kit/templates/preview-overrides.example.json` to `.claude/logs/<KEY>/previews/NN-<case>.json` and change only the file, section key, block ids and values.
      - Use the template the test product actually renders with: products often use an alternate template like `product.alternate.json`.
      - Take section keys from that template: pull it with `shopify.mjs pull-live <KEY> templates/<file>`, or read the branch's copy if the branch changed it. Keys differ per template; only `main` is common.
      - `merge` deep-merges objects but replaces arrays, so send the full `block_order`.
      - `merge` can't remove a value. To test an empty image or url setting, use `source` with the whole template.
   2. Run `node .claude/kit/shopify.mjs preview <KEY> <file>`, open the URL it returns, pass the gates above, and measure.
   3. After two failed previews for one case, mark those rows NOT TESTED, quote the CLI error, and move on.
3. **Customizer.** The theme editor is one cross-origin iframe: `read_page`, `find`, `get_page_text` and `javascript_tool` can't see inside it. Split the check in three.
   1. **Contract (script).** Run `node .claude/kit/contract.mjs <KEY>`. It writes `.claude/logs/<KEY>/contract.md` from the changed schemas, locales and templates: names, presets, where each section can be added, and every setting's label, type, default, options/range, info and `visible_if`.
      - Compare it row by row with `plan.md` § Schema details. Each mismatch is a FAIL.
      - Each entry in its "Problems" list is a FAIL: missing `t:` keys, a default that isn't an option, an off-range default, unknown preset blocks.
   2. **Presence (screenshots).** Go section by section:
      1. Get the section's id from the **draft** storefront HTML, e.g. `shopify-section-template--<n>__<key>`. Ids differ per theme copy, so never take them from live.
      2. Navigate to `<editorUrl>?previewPath=<page>&section=template--<n>__<key>`.
      3. Wait 10 seconds and take a screenshot. Repeat until the settings panel shows the section, for up to 60 seconds; the editor took 8–40 s to load in tests. Zoom on the top right. It must show the draft's name with the **Draft** badge, and a greyed-out **Save** button. A login or 2FA page means BLOCKED; stop.
      4. Read the settings panel from the screenshot. `scroll` returns its own screenshot.
      5. Record each contract line you can see in contract.md's "Seen in editor" column: the label is present and the value is right. The panel shows stored values, which on a fresh placement are the defaults. Cite the screenshot in the How column.
      6. For a section with presets, open the right group's "Add section", take a screenshot, check the entry is there (or absent) as `enabled_on`/`disabled_on` says, then press **Escape**. Never click an entry, and never type into the search box.
      7. Before leaving, zoom on Save again. If it's enabled, something changed: don't navigate away; ask the dev to discard the changes.

      Never click the preview's floating toolbar or the eye icons. Labels appear in the admin user's language.
   3. **By hand (dev checklist).** Add these as BLOCKED rows with "dev checks by hand":
      - the dynamic-source picker shows the metafield
      - a value change re-renders live in the preview
      - image, colour and url pickers open
      - blocks can be added, removed and reordered
      - app blocks still work
      - the mobile preview toggle
      - Translate & Adapt texts
      - anything judged by eye
4. **Regression.** Run `node .claude/kit/compare.mjs <KEY>`. It compares live with the draft on the untouched paths, checking the section lists and the feature prefix.
   - DIFFERS: rule out live edits made after the draft was copied (`draftCreatedAt`) before calling it a regression.
   - BLOCKED (password page, bot protection, wrong theme): report it as BLOCKED.
5. **Console errors** on each target page: `__qa.errors()`.

### The report

- **§ Criteria:** one row per criterion, with the columns `#`, criterion, expected, measured, how (the probe call, command or screenshot), and verdict.
- **§ Summary:**
  - "N criteria: x PASS, y FAIL, z NOT TESTED, w BLOCKED."
  - "Gates: theme ✓ <id>, viewport ✓ <widths>."
  - "Not covered: …"
  - "Dev checks by hand: …"
  - "The draft is a copy of live plus this branch."
- **Screenshots** only for things a human must judge visually, saved in `.claude/logs/<KEY>/screenshots/`.

**Done when:** every criterion has a verdict and the summary is written. Then run `kit.mjs done <KEY> qa`.

## Stage: accept (Gate 3)

1. Show the dev the summary, then every FAIL, NOT TESTED and BLOCKED row, with the "dev checks by hand" list.
2. AskUserQuestion: "QA result for <KEY>", with the options **Accept**, **Fix the failures**, and **I'll test more first**.
3. Then:
   - **Accept** → `kit.mjs done <KEY> accept --answer "<their words>"`.
   - **Fix the failures** → `kit.mjs back <KEY> build --reason "<the failing rows>"`. Then:
     1. Follow the build stage in fix mode: the builder gets the failing rows. Then commit.
     2. Run the draft stage again (push).
     3. Run the qa stage again. Re-measure the failed rows, the rows on pages the fix touched, and the regression check. Earlier rows stay, with the date they were measured.
   - **I'll test more first** → wait. When the dev reports issues, add them as rows and treat them as fixes.
