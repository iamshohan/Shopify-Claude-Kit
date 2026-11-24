---
name: shopify-plan
description: Stages 3–4 of /shopify-implement. Decide what merchants control and where (the control surface), decide what the ticket and the theme already answer and ask the dev only the real calls, write the file-by-file plan with its store setup and QA criteria, and get it approved. Use only when /shopify-implement's status says the stage is plan or approve.
user-invocable: false
---

# Plan and approve

## Stage: plan

**Goal:** every open point decided by you or, when it is the dev's call, answered by the dev, all recorded in `brief.md` § Decided, then a `plan.md` that the dev can approve from At a glance, and that the builder can follow without guessing.

### First: decide and ask

0. **Start from the ticket's editability lines** (`brief.md` § Asked → What the tickets say should be editable). A line about who may change something covers **everything visible in what it names**. "The client manages the mobile navigation without developer support" covers every item, label, link, order, image and icon in that navigation, not only the part a nearby AC mentions. A hard-coded value is only acceptable where no such line reaches it, where it's a design constant listed under Decided for you (the dev approves it at Gate 1), or where the dev agreed to it in a question about that value alone.
1. **Control surface.** List every dynamic candidate (from the A/B inventory, or the requirements for features and fixes) and decide where each one lives. Prefer what the theme already does (§ Found).

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
   - For A/B ports, defaults reproduce the winning variant's look and behaviour. Turning the feature on ships the winner. **Time-bound content isn't a default:** the test's dates, discount codes, campaign names and sale prices go into the QA preview, not the schema, which leaves those fields empty (the element hides when empty). Otherwise a Black Week banner that misses one field shows a Halloween code.
   - Every input defines its empty state: hide, fall back, or render nothing.
   - Finite options use a select or radio. Numbers use a range with min, max and step.
   - A value nobody will change soon stays in code, unless an editability line reaches it (step 0). How the A/B test built something (inline SVGs, CDN images, hard-coded copy) says nothing about whether the merchant must be able to change it. A block with more than about 8 settings gets split.
   - Never put per-product data in section settings, or per-template layout in metafields.
   - **Keep the feature's changes in the feature's own files.** When the feature needs a shared file to behave differently (an offset in `base.css`, a z-index in another section's CSS), put the override in the feature's own section, snippet or stylesheet, behind its toggle (a scoped selector or `:has()`), not in the shared file. Edit the shared file only when the feature can't reach it from its own code, and then list it under Needs your attention as a choice, with the contained alternative and its cost (specificity, load order).
   - **A section reading its blocks:** a section can't read the settings of its theme blocks (`@theme`); they render on their own. If the plan needs the parent to read child data, use section blocks, or spike it first: CHE-865 built the finder twice on this.
   - **Placement.** Prefer a section or block with presets that the merchant adds in the customizer over editing `templates/*.json`. Count how many templates would need it (e.g. 60 product templates). If that's a lot of manual work, offer an always-on render point with a theme-setting toggle as the alternative, and let the dev choose. If recon shows JSON templates aren't in git, placement can only be an admin step after merge.
   - **Definitions.** Reuse an existing one if it fits. Check with `node .claude/kit/shopify.mjs query definitions --owner PRODUCT` (or COLLECTION, PAGE…). With `adminApi: false`, read the admin's Settings → Custom data page for that owner in Chrome (look only: no clicks on Add, Save or Delete), or ask the dev. Never propose changing or deleting an existing definition. Use the store's own namespace, often `custom`. App-owned namespaces are off limits.
   - **Translations.** Which locales need copy (recon lists the locale files)? Metaobjects that hold copy need the translatable capability, and the merchant translates them in Translate & Adapt.
2. **List what the tickets don't settle:**
   - each dynamic choice the tickets don't state, the placement, and each setting's default
   - conflicts between tickets, or between a ticket and the A/B winner
   - missing copy per locale
   - risky findings
   - state the feature carries beyond its page (a discount code, the cart, a cookie): what other pages and the cart show, and how it combines with codes or offers already active. VET-33 found both at build review and reversed one after QA.
   - each row of `design.md` § Differs from the theme or the A/B code (follow Figma, or keep the theme's value or the winner's)
   - each value you'd keep in code that an editability line reaches
3. **Sort each one: decide it, or ask it** (`.claude/rules/kit-runs.md` → decide what's clear). In VSD-354 the dev picked the recommendation on all 12 questions with options: those were decisions, not questions.
   - **Decide** when the ticket, the winner, the theme's own pattern or a convention answers it: which sections get a setting, defaults that reproduce the winner, colours as settings, caps and breakpoints, porting the winner's logic, design constants kept in code (spacing, radii, timing, breakpoints), Figma rows the theme's scale already covers, the QA setup. Write each one under plan.md → At a glance → **Decided for you**: one line, with why.
   - **Ask** only what the rule's list names: a departure from a quoted AC or the winner; something the client or merchant must maintain (a new definition, data entry per product); money; real alternatives with different trade-offs that nothing in the ticket picks; a contradiction; something costly to undo. A value an editability line reaches that the merchant would change (text, images, links, which items show) and that you'd keep in code is a departure: ask it as its own question, naming the AC ("AC 18 says the client manages the menu. Keep the six utility icons in code anyway?").
   - **What customers see that the tickets don't settle** (what stays pinned, static or live, wording): decide it with the winner or the closest reading of the ticket, and mark the line "(client's call)" under Decided for you. The dev can send it to the client at Gate 1, and handoff tells the client.

   Ask everything that needs asking in as few AskUserQuestion calls as possible (up to 4 questions each), before writing the plan. Give each question 2–4 concrete options, with your recommendation first, marked "(Recommended)". An option that contradicts a quoted editability line is never the recommendation, and says so ("conflicts with AC 18"). Before the first call, write 3–6 lines in chat: what you decided (one line each, the most consequential first), and what you're asking and why. Nothing to ask: say what you decided and go on to the plan; Gate 1 is where the dev confirms it.
4. **Write § Decided:**
   - **Merchant can change:** one row per value, or "none".
   - **Stays in code:** one row per value. Name the editability AC it touches, or "none". When it touches one: a design constant you decided gets "Gate 1" in "Dev agreed" and a line under Decided for you; anything else cites the question in which the dev agreed (Q#). `kit.mjs done` refuses a row that touches an AC with neither.
   - **Questions and answers:** the dev's choice verbatim, or "none: nothing needed the dev's call". How you apply it goes in "Applied as". If "Applied as" stretches the choice beyond what the option said, ask again instead.

A task investigated first has its § Requirements answers in § Decided already: don't ask them again.

### Then: write the plan

Aim for 300 lines or fewer. A small fix gets a short plan: write "none" under a heading that doesn't apply. Fill each heading in `plan.md`. Write **At a glance** last, from the finished detail:

- **At a glance** (about 25 lines). The dev reads only this at Gate 1.
  - **Needs your attention** comes first. It lists where this change can affect what already exists, most impact first, in about 6 points at most. Most of a plan is new code only the feature uses; these points are what the dev actually has to weigh. Each point, in about 30 words: what's touched, what could go wrong for what already uses it, and how the plan contains it or what to watch.
    - **Store writes:** what gets created or set on the shared store, and whether it shows on live before the merge.
    - **Merchant-owned JSON** (`templates/*.json`, section groups, `settings_data.json`): the merge overwrites admin edits made on live since the base.
    - **Shared code:** the layout, theme settings, and snippets, sections and assets used beyond this feature. After writing § Files, run `node .claude/kit/kit.mjs reach <KEY>`: it lists these files and how far each reaches, and `done plan` refuses until each one is named here. It also lists planned files the repo's `.shopifyignore` excludes: push can't upload them, so say how each reaches the store (an admin step, or out of `.shopifyignore`).
    - **Behaviour that changes for what exists today:** a removed fallback, a changed default, markup that other code or an app reads.
    - **Apps, the A/B tool or third-party scripts** the change touches, and anything else the dev must act on or watch.

    Example: "`snippets/icon.liquid` (rendered from 14 files): three icons added, the existing ones untouched → regression check on home, product and cart." When nothing qualifies, write "none: only new files the feature owns".
  - **Decided for you** comes next: every decision from step 3 that you took without asking, one line each with its reason, the most consequential first. Show the 10 most consequential; more go below a line "N more:" so nothing is left out. Put "(vs AC n)" first on any line that touches an acceptance criterion. Mark lines about what customers see that the ticket doesn't settle "(client's call)". Write "none" when you decided nothing on your own. This is where the dev reviews your judgement, so leave nothing out that they'd want to change.
  - **Not proven yet** comes next: every assumption the approach relies on that you couldn't verify in this theme or store. Examples: a product's option layout you couldn't read (rate-limited, no access), an app's JS API used in a way its docs or this theme don't show, a Liquid object or setting type the theme doesn't use yet. One row each: what it relies on, why it isn't proven, the fallback if it doesn't hold, and the QA criterion that tests it. The fallback is a real alternative the dev could pick at Gate 1, not a silent degradation. Write "none" when everything was verified. A risk you already verified belongs in § Risks, not here.
  - **What changes:** one row per file, or per group of files ("locales/*.schema.json ×5"), with the files from Needs your attention first. "What happens" is at most 15 words and describes the effect, not the anchor: "Winner layout when the mobile menu is set; old markup unchanged otherwise."
  - **Merchant can change** and **Stays in code:** one line each, from § Decided. Put "(vs AC n)" after any value in code that an editability line reaches. Write them as the merchant sees them ("the bar stays pinned; its height can't be set"), not as code ("z-index, offsets").
  - **Merchant-facing text:** every new label, info text, preset name and option label, exactly as the merchant will read it in the editor. The dev approves the wording here, not after handoff.
  - **Differs from the ticket or the A/B test:** each deviation and who decided it ("no description field, AC 17: dev, Q3"), including an "Applied as" that does something other than a quoted AC or the winner does, and each AC no QA row checks, with why. Or "none".
  - **QA:** number of criteria, viewports, and how many checks the dev will have to do by hand.
- **Approach.** 3–5 lines: what gets built, and the one or two key decisions.
- **Files (builder detail).** One table row per file:
  - path, and create or modify
  - the exact change
  - the **anchor**: the symbol it attaches to, e.g. a `case block.type` branch, a `render` call, a schema `blocks` array or a function name. Never a line number; Shopify sync commits move lines.
  - the data flow: where the value comes from and how it reaches the markup
  - for styling with a Figma design: "values from design.md", or the theme token the dev chose instead (§ Decided)
- **Schema details.** Every setting: id, type, label (or `t:` key), default, options or range, info, `visible_if`. **Info text only when the label alone would mislead** (a unit, a side effect, a dependency on another setting); none by default. An info that restates the label ("Turn off after the campaign") is noise the merchant reads on every visit. For each section, say whether it has presets and where it may be added (`enabled_on` / `disabled_on`).
- **Store setup.**
  - **Definitions to create.** For each: owner, namespace.key, type, validations, translatable, not pinned, and "reuse: none fits because …".
    - **`adminApi: false`:** write numbered admin steps instead of mutations: Settings → Custom data → owner → Add definition, then every field (name, namespace and key, type, validations, storefront access, "translatable" for metaobjects). The dev creates them at the draft stage. Skip the mutation and scope points below.
    - Write each mutation now, to `.claude/logs/<KEY>/mutations/NN-<name>.graphql`, with variables in `NN-<name>.vars.json`.
    - Validate each one once with the `shopify-plugin:shopify` skill (topic `admin`, `--version <adminApiVersion from .claude/shopify-kit.json>`). The draft stage runs these same files.
    - Metaobject definitions that should render on the storefront need `access.storefront: PUBLIC_READ`. Don't set `access.admin` on merchant-owned definitions.
  - **Scopes:** the kit's default login covers product, variant, collection and metaobject definitions. Page, article, blog and customer definitions need one more scope: say so in the plan. If the draft stage's mutate fails on it, its error prints the login command with that scope added.
  - **QA test data.** Which products, collections or pages QA uses, and why each one.
    - **QA only looks at them** (layout, rendering, a sticky offset, a cart add on the draft): pick them yourself from the storefront (`/products.json`, `/collections/<handle>/products.json`, `/products/<handle>.js`). Choose ones that exercise the change: the most media for a gallery, variants and a single-variant product, a sale price, sold out, a long title. Take each product template the change touches (`template_suffix`), 2–3 products for each. Don't ask the dev.
    - **Ask the dev only when** QA must write store data on them (metafield values, a test metaobject entry), or needs a state you can't find on the storefront (a tag, a customer-only price). Never write to a live product yourself.
  - **Merchant steps after merge:** placement, entries, Translate & Adapt.
- **Conventions to follow,** from § Found. For example: "CSS via `stylesheet_tag` in the snippet, like `snippets/product-badges.liquid`".
- **QA criteria.** Numbered, one table row each. Each has an expected value quoted from a ticket or from § Decided, plus the page or template, the viewports, and the data state or locale, and names the ACs it checks ("AC 2/15"). An AC no row checks goes under At a glance → Differs from the ticket with why. `done plan` refuses an AC that is in neither. Always include:
  - defaults equal the winner (A/B ports)
  - each empty state
  - every locale in scope
  - mobile and desktop, e.g. 390×844 and 1440×900
  - the customizer contract: name, presets, where it can be added, labels and defaults (checked by `contract.mjs`)
  - untouched pages for the regression check
  - **existing components the change affects** (a menu, a drawer, the header, a sticky gallery): measure each on live first and write Expected relative to that ("same as live: 43 px overflow; plus the bar height"). An Expected written from reading the code fails on behaviour live already has (GSD-80's mega menu).
  - **bug fixes:** one row that reproduces the bug, its Criterion starting "Repro:", and Expected saying what live shows today (the failure) and what the draft must show. `done plan` refuses a bug fix without it.
  - **the design** (when `design.md` exists), by the mode in status:
    - **exact:** fill every empty selector in `design-checks.json` with the class the plan creates (Files and Markup). Where the dev chose the theme's value over Figma (§ Decided), or a value is a setting, put the theme value or the setting's default in `fixed`: the audit checks the default state. Then add one QA row per viewport: "Design matches Figma (kit.mjs design-audit <KEY> <viewport>)", default state. `done plan` refuses an empty selector or a missing audit row.
    - **reference:** one row per viewport for layout: the elements present, their order and alignment, what shows and hides at that width, and sizes that fill or flex as behaviour ("fills its column at 390"). No pixel values.
- **QA setup.**
  - Placement on the draft. If the merchant places the feature after merge, the draft needs preview overrides that place it.
  - A feature CSS class prefix that appears nowhere else in the theme (check with Grep). Record it: `kit.mjs set <KEY> featurePrefix=<prefix>`.
  - Untouched paths, without leading slashes, because Git Bash rewrites arguments that start with "/": `kit.mjs set <KEY> qa.paths=home,collections/x,products/y,cart`.
- **Risks,** and how the plan handles each one.

### Last: the independent check

**Skip it for a small fix:** a bug fix whose § Files names at most 3 files, with no store writes, nothing under Differs from the ticket and no "client's call". Write "Skipped: small fix." under Independent check; `done plan` refuses the skip when the plan isn't one. The same skip applies to the handoff's client check.

Otherwise spawn the `outcome-checker` agent with the key and mode `plan`. It reads the ticket and the theme first, writes its own expectations, then compares them with the plan, so it doesn't inherit the plan's blind spots.
- Fix what it finds: add Differs rows, Not proven yet rows, QA criteria with live baselines; move shared-file overrides into the feature's files; rewrite merchant text.
- A finding you disagree with stays, with one line on why.
- Record its lines (`Surprises:`, `Unlisted assumptions:`, `Convention:` and the rest) and your changes under At a glance → **Independent check**. The dev reads them at Gate 1. `done plan` refuses without the `Surprises:` and `Unlisted assumptions:` lines.

**Done when:** § Decided records the answers, every plan heading is filled, and the independent check is recorded. Then run `kit.mjs done <KEY> plan`.

## Stage: approve (Gate 1)

1. **Hand the plan over, don't ask yet.** Say the plan is ready and where it is (`.claude/logs/<KEY>/plan.md`), show § At a glance as it is (no file anchors, no restated criteria, no method notes), and name what approving it covers when there is any: "It includes 4 store writes, 6 decisions I took for you, 3 values kept in code, and 2 approaches not proven yet (each with a fallback)." Include what the independent check found and what you did about it. End with: "Review it and tell me: approve, what to change, or any question." Then stop and wait. No AskUserQuestion: the dev reads first and answers in their own words.
2. Then, by their reply:
   - **Questions** → answer them, and wait again.
   - **Changes** (such as "use the fallback for the waitlist") → edit `plan.md`, say what changed, and wait again.
   - **Approval** ("approve", "looks good, go") → `kit.mjs done <KEY> approve --answer "<their words>"`. Only an explicit approval counts; if the reply could be read either way, ask.
   - **Rejection** → `kit.mjs back <KEY> plan --reason "<their words>"`.

Changes at the gate edit the plan, so `done approve` runs the plan's checks again. After approval, change `plan.md` only when the work needs it, under **Amendments** with the date and the reason.
