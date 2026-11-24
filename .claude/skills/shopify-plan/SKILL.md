---
name: shopify-plan
description: Stages 3–4 of /shopify-implement. Decide what merchants control and where (the control surface), decide what the ticket and the theme already answer and ask the dev only the real calls, write the file-by-file plan with its store setup and QA criteria, and get it approved. Use only when /shopify-implement's status says the stage is plan or approve.
user-invocable: false
---

# Plan and approve

## Stage: plan

**Goal:** every open point decided by you or, when it is the dev's call, answered by the dev, all recorded in `brief.md` § Decided, then a `plan.md` the dev can approve from At a glance and the builder can follow without guessing.

### First: decide and ask

0. **Start from the ticket's editability lines** (`brief.md` § Asked → What the tickets say should be editable). A line about who may change something covers **everything visible in what it names**: "the client manages the mobile navigation without developer support" covers every item, label, link, order, image and icon in it, not only the part a nearby AC mentions. A hard-coded value is acceptable only where no such line reaches it, where it's a design constant listed under Decided for you (approved at Gate 1), or where the dev agreed to it in a question about that value alone.
1. **Control surface.** List every dynamic candidate (from the A/B inventory, or the requirements) and decide where each lives. Prefer what the theme already does (§ Found).

   | If the value… | It lives in… |
   | --- | --- |
   | differs per product, collection or page | a metafield on that resource |
   | is structured, repeated, or shared by many resources | a metaobject, plus a reference metafield or a metaobject setting |
   | differs per placement or per template | a section or block setting |
   | is one store-wide value, or a kill switch | a theme setting (`config/settings_schema.json`) |
   | is UI text: labels, aria text, button text | a locale key (only if the theme's `locales/` is in git; otherwise a setting) |
   | is a design or dev constant: breakpoints, timing | code |
   | was A/B targeting: device, page, market | a setting, a template assignment, or a `.context.*` file |

   **How much control:**
   - For A/B ports, defaults reproduce the winning variant. **Time-bound content isn't a default:** the test's dates, discount codes, campaign names and sale prices go into the QA preview, not the schema, which leaves those fields empty (the element hides when empty).
   - Every input defines its empty state: hide, fall back, or render nothing. Finite options use a select or radio; numbers use a range with min, max and step.
   - A value nobody will change soon stays in code, unless an editability line reaches it. How the A/B test built something (inline SVGs, hard-coded copy) says nothing about whether the merchant must change it. A block with more than about 8 settings gets split.
   - Never per-product data in section settings, or per-template layout in metafields.
   - **Keep the feature's changes in the feature's own files.** When a shared file must behave differently (an offset in `base.css`, a z-index in another section), put the override in the feature's own code behind its toggle (a scoped selector or `:has()`). Edit the shared file only when the feature can't reach it, and list it under Needs your attention as a choice, with the contained alternative and its cost.
   - **A section can't read its theme blocks' settings** (`@theme`): use section blocks, or spike it first (CHE-865 built the finder twice on this).
   - **Placement.** Prefer a section or block with presets the merchant adds over editing `templates/*.json`. If that's a lot of manual work (count the templates), offer an always-on render point with a theme-setting toggle and let the dev choose. JSON templates not in git: placement can only be an admin step after merge.
   - **Definitions.** Reuse one if it fits: `node .claude/kit/shopify.mjs query definitions --owner PRODUCT` (or COLLECTION, PAGE…); with `adminApi: false`, read Settings → Custom data in Chrome (look only) or ask the dev. Never change or delete an existing definition. Use the store's own namespace, often `custom`; app-owned namespaces are off limits.
   - **Translations.** Which locales need copy? Metaobjects that hold copy need the translatable capability (the merchant translates them in Translate & Adapt).
2. **List what the tickets don't settle:** each dynamic choice, the placement and each default; conflicts between tickets or with the A/B winner; missing copy per locale; risky findings; state the feature carries beyond its page (a discount code, the cart, a cookie: what other pages and the cart show, how it combines with active codes or offers); each row of `design.md` § Differs; each value you'd keep in code that an editability line reaches.
3. **Sort each one: decide it, or ask it** (`.claude/rules/kit-runs.md` → decide what's clear).
   - **Decide** what the ticket, the winner, the theme's pattern or a convention answers (which sections get a setting, defaults, colours as settings, caps and breakpoints, design constants in code, Figma rows the theme's scale covers, the QA setup), and write each under plan.md → At a glance → **Decided for you**: one line, with why.
   - **Ask** what that rule lists. A value an editability line reaches that the merchant would change (text, images, links, which items show) and that you'd keep in code is a departure from the ticket: ask it as its own question, naming the AC ("AC 18 says the client manages the menu. Keep the six utility icons in code anyway?").
   - **What customers see that the tickets don't settle** (what stays pinned, static or live, wording): decide it with the winner or the closest reading, and mark the line "(client's call)" under Decided for you. The dev can send it to the client at Gate 1; handoff tells the client.

   Ask everything in as few AskUserQuestion calls as possible (up to 4 questions each), before writing the plan: 2–4 concrete options each, your recommendation first, marked "(Recommended)". An option that contradicts a quoted editability line is never the recommendation, and says so ("conflicts with AC 18"). Before the first call, write 3–6 lines in chat: what you decided (most consequential first), and what you're asking and why. Nothing to ask: say what you decided and go on.
4. **Write § Decided:**
   - **Merchant can change:** one row per value, or "none".
   - **Stays in code:** one row per value, naming the editability AC it touches, or "none". When it touches one: a design constant you decided gets "Gate 1" in "Dev agreed" and a line under Decided for you; anything else cites the question the dev agreed in (Q#).
   - **Questions and answers:** the dev's choice verbatim, or "none: nothing needed the dev's call". How you apply it goes in "Applied as"; if that stretches the choice beyond the option, ask again instead.

A task investigated first has its § Requirements answers in § Decided already: don't ask them again.

### Then: write the plan

Aim for 300 lines or fewer; a small fix gets a short plan ("none" under headings that don't apply). Write **At a glance** last, from the finished detail:

- **At a glance** (about 25 lines). The dev reads only this at Gate 1.
  - **Needs your attention** first: where this change can affect what already exists, most impact first, about 6 points, each about 30 words (what's touched, what could go wrong for what already uses it, how the plan contains it or what to watch). Consider:
    - **Store writes:** what gets created or set on the shared store, and whether it shows on live before the merge.
    - **Merchant-owned JSON** (`templates/*.json`, section groups, `settings_data.json`): the merge overwrites admin edits made on live since the base.
    - **Shared code:** after writing § Files, run `node .claude/kit/kit.mjs reach <KEY>`; it lists the layout, settings and shared snippets, sections and assets the plan touches and how far each reaches, and planned files `.shopifyignore` excludes (say how each reaches the store).
    - **Behaviour that changes for what exists today:** a removed fallback, a changed default, markup other code or an app reads.
    - **Apps, the A/B tool or third-party scripts** the change touches.

    Example: "`snippets/icon.liquid` (rendered from 14 files): three icons added, the existing ones untouched → regression check on home, product and cart." Nothing qualifies: "none: only new files the feature owns".
  - **Decided for you:** every decision you took without asking, one line each with its reason, most consequential first; the top 10, then "N more:" so nothing is left out. "(vs AC n)" first on any line that touches an AC; "(client's call)" on what customers see that the ticket doesn't settle. Or "none".
  - **Not proven yet:** every assumption the approach relies on that you couldn't verify in this theme or store (an option layout you couldn't read, an app's JS API used in a way its docs don't show, a Liquid object or setting type the theme doesn't use yet). One row each: what it relies on, why it isn't proven, the fallback (a real alternative the dev could pick at Gate 1), and the QA criterion that tests it. Or "none". A verified risk belongs in § Risks.
  - **What changes:** one row per file or group ("locales/*.schema.json ×5"), files from Needs your attention first; "What happens" in at most 15 words, the effect not the anchor.
  - **Merchant can change** and **Stays in code:** one line each, from § Decided, "(vs AC n)" after a value in code an editability line reaches. Written as the merchant sees them ("the bar stays pinned; its height can't be set"), not as code.
  - **Merchant-facing text:** every new label, info text, preset name and option label, exactly as the merchant reads it. The dev approves the wording here.
  - **Differs from the ticket or the A/B test:** each deviation and who decided it ("no description field, AC 17: dev, Q3"), including an "Applied as" that does something other than a quoted AC or the winner, and each AC no QA row checks, with why. Or "none".
  - **QA:** number of criteria, viewports, and how many checks the dev does by hand.
- **Approach.** 3–5 lines: what gets built, and the one or two key decisions.
- **Files (builder detail).** One row per file: path, create or modify; the exact change; the **anchor** (the symbol it attaches to: a `case block.type` branch, a `render` call, a schema `blocks` array, a function; never a line number); the data flow; for styling with a Figma design, "values from design.md" or the theme token the dev chose instead.
- **Schema details.** Every setting: id, type, label (or `t:` key), default, options or range, info, `visible_if`. **Info text only when the label alone would mislead** (a unit, a side effect, a dependency); an info that restates the label is noise. For each section: presets, and where it may be added (`enabled_on` / `disabled_on`).
- **Store setup.**
  - **Definitions to create:** owner, namespace.key, type, validations, translatable, not pinned, and "reuse: none fits because …".
    - **`adminApi: false`:** numbered admin steps instead of mutations (Settings → Custom data → owner → Add definition, then every field: name, namespace and key, type, validations, storefront access, "translatable" for metaobjects). Skip the mutation and scope points below.
    - Otherwise write each mutation now to `.claude/logs/<KEY>/mutations/NN-<name>.graphql` (variables in `NN-<name>.vars.json`) and validate it once with the `shopify-plugin:shopify` skill (topic `admin`, `--version <adminApiVersion>`). The draft stage runs these files.
    - Metaobject definitions that render on the storefront need `access.storefront: PUBLIC_READ`. Don't set `access.admin` on merchant-owned definitions.
  - **Scopes:** the default login covers product, variant, collection and metaobject definitions. Page, article, blog and customer definitions need one more scope: say so.
  - **QA test data:** which products, collections or pages QA uses, and why. When QA only looks at them, pick them yourself from the storefront (`/products.json`, `/collections/<handle>/products.json`, `/products/<handle>.js`): ones that exercise the change (most media, variants and single-variant, a sale price, sold out, a long title), 2–3 per product template the change touches. Ask the dev only when QA must write store data on them or needs a state you can't find. Never write to a live product yourself.
  - **Merchant steps after merge:** placement, entries, Translate & Adapt.
- **Conventions to follow,** from § Found ("CSS via `stylesheet_tag` in the snippet, like `snippets/product-badges.liquid`").
- **QA criteria.** Numbered rows, each with an expected value quoted from a ticket or § Decided, the page or template, viewports, data state or locale, and the ACs it checks ("AC 2/15"). Always include:
  - defaults equal the winner (A/B ports); each empty state; every locale in scope; mobile and desktop (e.g. 390×844 and 1440×900)
  - the customizer contract: name, presets, where it can be added, labels and defaults (checked by `contract.mjs`)
  - untouched pages for the regression check
  - **existing components the change affects** (a menu, a drawer, the header, a sticky gallery): measure each on live first and write Expected relative to that ("same as live: 43 px overflow; plus the bar height"). An Expected written from the code fails on behaviour live already has (GSD-80).
  - **bug fixes:** one row starting "Repro:", whose Expected says what live shows today (the failure) and what the draft must show.
  - **the design** (when `design.md` exists), by the mode in status:
    - **exact:** fill every empty selector in `design-checks.json` with the class the plan creates. Where the dev chose the theme's value over Figma, or a value is a setting, put the theme value or the setting's default in `fixed` (the audit checks the default state). Add one row per viewport: "Design matches Figma (kit.mjs design-audit <KEY> <viewport>)".
    - **reference:** one row per viewport for layout: elements present, order and alignment, what shows and hides, sizes as behaviour ("fills its column at 390"). No pixel values.
- **QA setup.** Placement on the draft (preview overrides when the merchant places it after merge). A feature CSS class prefix that appears nowhere else in the theme: `kit.mjs set <KEY> featurePrefix=<prefix>`. Untouched paths, without leading slashes (Git Bash rewrites them): `kit.mjs set <KEY> qa.paths=home,collections/x,products/y,cart`.
- **Risks,** and how the plan handles each one.

### Last: the independent check

**Skip it for a small fix:** a bug fix whose § Files names at most 3 files, with no store writes, nothing under Differs from the ticket and no "client's call". Write "Skipped: small fix." under Independent check.

Otherwise spawn the `outcome-checker` agent with the key and mode `plan`. It reads the ticket and the theme first and writes its own expectations, so it doesn't inherit the plan's blind spots.
- Fix what it finds (Differs rows, Not proven yet rows, QA criteria with live baselines, shared-file overrides moved into the feature's files, merchant text). A finding you disagree with stays, with one line on why.
- Record its lines (`Surprises:`, `Unlisted assumptions:`, `Convention:` and the rest) and your changes under At a glance → **Independent check**.

**Done when:** § Decided records the answers, every plan heading is filled, and the independent check is recorded. Then `kit.mjs done <KEY> plan`.

## Stage: approve (Gate 1)

1. **Hand the plan over, don't ask yet.** Say it's ready and where (`.claude/logs/<KEY>/plan.md`), show § At a glance as it is, and name what approving covers: "It includes 4 store writes, 6 decisions I took for you, 3 values kept in code, and 2 approaches not proven yet (each with a fallback)." Include what the independent check found and what you did. End with: "Review it and tell me: approve, what to change, or any question." Then wait. No AskUserQuestion: the dev answers in their own words.
2. Then, by their reply:
   - **Questions** → answer, and wait again.
   - **Changes** → edit `plan.md`, say what changed, and wait again.
   - **Approval** ("approve", "looks good, go") → `kit.mjs done <KEY> approve --answer "<their words>"`. Only an explicit approval counts; if the reply could be read either way, ask.
   - **Rejection** → `kit.mjs back <KEY> plan --reason "<their words>"`.

After approval, change `plan.md` only when the work needs it, under **Amendments** with the date and the reason.
