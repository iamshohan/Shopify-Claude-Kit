---
name: app-qa
description: The QA part of the App Kit's verify stage. Measure the qa scenarios, the Figma frames, the real journey per A/B arm and live data on the dev store, run the blind QA agent, and record every row with app.mjs qa-add / qa-row. Use only when app-verify sends you here.
user-invocable: false
---

# QA

You measure; fixes go back to build. A row is PASS only when a value observed on the dev store, on the current code, meets it. ASM-924 passed its own scenarios and then failed five checks a person ran blind: the scenarios were the author's, the widths were the author's, and nothing compared the build with Figma or the data with its source. This stage closes those gaps.

Verdicts: **PASS** (measured, meets it), **FAIL** (measured, doesn't), **BLOCKED** (can't be measured here: say what's missing). Never a PASS whose `--measured` says part of it wasn't shown.

## 1. Before measuring

1. **The rows, written first.** List what you'll measure before opening the store, so the results can't shape the expectations:
   - every `qa:` scenario (they're already rows: S1, S2, …);
   - **Figma:** for each § Asked Figma row, `node .claude/kit/app.mjs qa-add <ID> --source figma --asked <#> --criterion "<frame>: <what>" --expected "<values from design.md>"`, at the frame's width: the texts, sizes, colours, radii, spacing and assets of that variation (Variation C's icons are not Variation B's). Add 768 px when the design has a mobile and a desktop frame, and the narrowest width any frame or the ticket names;
   - **journey** (A/B changes): one row per arm and one for control, through every add-to-cart path the storefront has (product page, quick add, upsell; a store whose collection pages can't add to cart just has fewer): `qa-add --source journey`;
   - **data** (anything fetched live): one row comparing what's shown with the source: `qa-add --source data`;
   - **asked:** an AC line a scenario only partly covers: `qa-add --source asked`.
2. **The app running, current code.** `node .claude/kit/shopify.mjs dev-status`: app dev runs, on the dev store, has rebuilt after the last edit, no build errors. Not running → give the dev the `appDev` command from `shopify.mjs info` for a separate terminal (it keeps running, so not with `!`), and say its `devStoreWarning` if any. Checkout UI extensions and Functions reach the dev store only through that `app dev`.
3. **The dev store vs the client's store.** `appspec/project.md` says the client's checkout layout (one-page or three steps), Plus, and branding. When the dev store differs in a way a row depends on (placement on mobile, a branding colour), say so in the row's `--how`, and add a § You must still do line for the dev to check it on the client's store after deploy. **Never measure on the client's live store** and never ship probe or debug code to it; read-only looks at the client's public storefront are fine when the dev agrees.

## 2. Two browsers, each for what it's safe for

- **Storefront and checkout: kit-browser** (`mcp__kit-browser__*`): isolated, logged in nowhere, and it sets the viewport exactly. Missing: ask the dev to add it (`claude mcp add kit-browser --scope user -- npx -y @playwright/mcp@0.0.83 --isolated --headless --snapshot-mode none`) and restart; don't measure mobile widths in Chrome (its resize changes the window, not the viewport, and stalls near 650 px).
  - Load the probe once per session: `browser_run_code_unsafe` with `filename: ".claude/kit/qa-probe.init.js"` (no `code`). From then on every page has `__aq`; measure with `browser_evaluate`, e.g. `() => __aq.copies('Sicher bei ASMC')`.
  - Widths: `browser_resize`, then `__aq.env().width`. A result measured at another width doesn't count.
  - Password page (dev store): ask the dev for the password (Online Store → Preferences), enter it on `/password`, never store it.
- **Admin, the theme editor and the checkout editor: Chrome** (claude-in-chrome), as the dev's admin. Editor setup on the dev store is yours, without asking: read what's placed and how it's set, turn on the app embed, add the app block with the editor's add-block picker (drags don't take), change its settings. Say in one line what you're doing; don't ask the dev to check the setup. Saving is fine on the dev store; publishing a theme or checkout configuration stays the dev's. A login page: ask the dev to log in.

## 3. What to measure, and how

| The row is about | How |
| --- | --- |
| where it renders | `__aq.expand()`, then `__aq.copies('<text>')`: every copy, visible or hidden, and which summary or region it's in. Say which copy you measured, and record the editor placement with it (the placement in the checkout editor decides the position). Test other placements with the block target's `?placement-reference=<REF>` checkout URL parameter instead of moving the block. |
| text and order | `__aq.copies` / `__aq.box`: `textContent`, not CSS-uppercased `innerText` |
| a Figma frame | at the frame's width: `__aq.compare(<that frame's object from design-checks.json>)` gives PASS/FAIL/MISSING per element and gap; record the figma row from it, with the width in `--how` (qa-row refuses a figma row measured at another width). A screenshot beside the frame for what compare can't read (an icon's colour inside an image) |
| size, colour, spacing | `__aq.box('<text>', [props])`, `__aq.gap(a, b)` |
| wrapping and overflow | `__aq.wraps('<text>')` at the narrowest width, `__aq.overflow()` |
| links and buttons | `__aq.links('<block text>')` for name, href, target; click once to confirm the new tab's URL |
| images | `__aq.images('<block text>')`: loaded, rendered vs natural size, data: or hosted |
| live data | the source's own page or public API, in the same minute: the items shown are the ones the ticket asks for (the newest really are the newest; ASM-924 read page 1 sorted the wrong way) |
| A/B gate | with the attribute and without, **set by running the variation file unchanged** (only that proves code and extension agree on key and value); "absent" measured in the same checkout session right after |
| A/B journey | per arm, through each add-to-cart path the storefront has (a product page; a collection page or quick add where they exist) → add to cart → the trigger (drawer open) → the variation file runs as the A/B tool would → checkout shows that arm. Control: the control file → nothing shows. Not only from the home page, and not with a hand-set `fetch` |
| A/B test code | after adding a product, run `variation.js`, then `/cart.js`: the right values; nothing on an empty cart; no second `/cart/update.js` on a rerun; no update loop when the drawer opens and a quantity changes (count requests); other attributes kept. Then `control.js`: the attributes are gone |
| checkout traps | the checkout editor preview is a cross-origin iframe (measure on the checkout itself); a cleared text setting arrives as `undefined`; an admin "Preview" checkout loses its cart when you step back (start each step from a fresh cart) |
| store setup for QA | a test product, a Function's activation: write the mutation to `.claude/logs/<ID>/<name>.graphql` and run `node .claude/kit/shopify.mjs mutate <ID> <file>` (the guard shows it to the dev first) |

Record each row as soon as it's measured, one call at a time, or several in one call with `--file .claude/logs/<ID>/rows.json` (`[{ "row": "Q3", "verdict": "PASS", "measured": "…", "how": "…" }]`): `node .claude/kit/app.mjs qa-row <ID> <S#|Q#> --measured "<what you saw: the value, the text>" --how "<page, width, probe call or screenshot>" --verdict PASS|FAIL|BLOCKED`.

## 4. Blind QA

Once your own rows are measured and pass (or went back to build and came back), run the `blind-qa` agent. Its prompt: the change ID; how to get the change on screen on the dev store (URL, steps; for an A/B change, the paths of `abtest/<ID>/variation*.js` and `control.js`, which it runs to switch arms); the viewports from design.md and the ticket. Don't give it the proposal, the scenarios or your results: its value is that it doesn't share them. Unlock the storefront password in kit-browser first, so it doesn't need it.

Then add its whole table in one call: write it as `[{ "source": "blind", "criterion": "…", "expected": "…", "verdict": "PASS", "measured": "…", "how": "…" }]` to `.claude/logs/<ID>/blind.json` and run `app.mjs qa-add <ID> --file .claude/logs/<ID>/blind.json` (re-measure anything it marked approximate). Record the run: `app.mjs review <ID> blind --found "<N criteria, the FAILs in a line each, what went back to build>"`.

A blind FAIL is a FAIL. If you think its expectation is wrong (it misread the ticket), don't drop it: ask the dev, and waive it only with their words (`app.mjs waive <ID> <Q#> --reason … --answer "…"`).

## 5. Fixes

A FAIL whose fix stays inside the approved scenarios goes back to build on its own: `app.mjs back <ID> build --reason "QA <rows>"`, fix, commit, `verify` again, then re-measure the failed rows and every PASS the fix could reach. Results are recorded against the code, so keep the ones it can't reach in one call: `app.mjs qa-row <ID> S1,Q4,Q7 --carry "<why the fix can't reach them>"` (the handoff shows each). At most 2 rounds, then Gate 2 with what's left. Ask instead when the scenario itself looks wrong, the fix touches money, or after 2 rounds. A row that truly can't be measured on a dev store: ask the dev; with their agreement, `app.mjs waive`.

**§ You must still do** (for Gate 2 and the handoff): one line per BLOCKED or waived row and per dev-store difference, saying where and how the dev checks it on the client's store ("On asmc.de after deploy, on a phone: the trust section shows below Jetzt kaufen"). An A/B change always gets: "In the A/B tool's preview of each arm on the client's store, from a product page: /cart.js shows <key> = <value> before checkout, and control shows none": only there do the tool's targeting and URL rules run (ASM-924's wrong URL rule was invisible on the dev store).
