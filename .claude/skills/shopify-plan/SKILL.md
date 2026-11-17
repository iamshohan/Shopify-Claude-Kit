---
name: shopify-plan
description: Stages 3–4 of /shopify-implement. Decide what merchants control and where (the control surface), ask the dev every open question, write the file-by-file plan with its store setup and QA criteria, and get it approved. Use only when /shopify-implement's status says the stage is plan or approve.
user-invocable: false
---

# Plan and approve

## Stage: plan

**Goal:** every open question answered by the dev and recorded in `brief.md` § Decided, then a `plan.md` that the dev can approve from At a glance, and that the builder can follow without guessing.

### First: decide and ask

0. **Start from the ticket's editability lines** (`brief.md` § Asked → What the tickets say should be editable). A line about who may change something covers **everything visible in what it names**. "The client manages the mobile navigation without developer support" covers every item, label, link, order, image and icon in that navigation, not only the part a nearby AC mentions. A hard-coded value is only acceptable where no such line reaches it, or where the dev has agreed to it in a question about that value alone.
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
   - For A/B ports, defaults reproduce the winning variant exactly. Turning the feature on ships the winner.
   - Every input defines its empty state: hide, fall back, or render nothing.
   - Finite options use a select or radio. Numbers use a range with min, max and step.
   - A value nobody will change soon stays in code, unless an editability line reaches it (step 0). How the A/B test built something (inline SVGs, CDN images, hard-coded copy) says nothing about whether the merchant must be able to change it. A block with more than about 8 settings gets split.
   - Never put per-product data in section settings, or per-template layout in metafields.
   - **Placement.** Prefer a section or block with presets that the merchant adds in the customizer over editing `templates/*.json`. Count how many templates would need it (e.g. 60 product templates). If that's a lot of manual work, offer an always-on render point with a theme-setting toggle as the alternative, and let the dev choose. If recon shows JSON templates aren't in git, placement can only be an admin step after merge.
   - **Definitions.** Reuse an existing one if it fits. Check with `node .claude/kit/shopify.mjs query definitions --owner PRODUCT` (or COLLECTION, PAGE…). With `adminApi: false`, read the admin's Settings → Custom data page for that owner in Chrome (look only: no clicks on Add, Save or Delete), or ask the dev. Never propose changing or deleting an existing definition. Use the store's own namespace, often `custom`. App-owned namespaces are off limits.
   - **Translations.** Which locales need copy (recon lists the locale files)? Metaobjects that hold copy need the translatable capability, and the merchant translates them in Translate & Adapt.
2. **Collect the questions:** everything the tickets don't settle.
   - each dynamic choice the tickets don't state
   - conflicts between tickets
   - missing copy per locale
   - the placement choice and each setting's default
   - risky findings
   - each row of `design.md` § Differs from the theme or the A/B code: follow Figma, or keep the theme's value (or the winner's). Group rows of one kind into one question ("Figma's greys are 1–2 shades off the colour scheme: use the scheme?").

   - **each value you'd keep in code that an editability line reaches**: one question per value, never folded into another question. Name the AC: "AC 18 says the client manages the menu without a developer. Keep the six utility icons in code anyway?"

   Give each question 2–4 concrete options, with your recommendation first, marked "(Recommended)". An option that contradicts a quoted editability line is never the recommendation, and says so in its description ("conflicts with AC 18").
3. **Ask all of them before planning**, in as few AskUserQuestion calls as possible (up to 4 questions per call). Don't drip-feed them one at a time. Before the first call, write 3–6 lines in chat: what is settled, and what you're asking and why. Don't restate the tickets.
4. **Confirm the control surface** with one more question. Its text lists the values that stay in code by name: "These stay in code: colours, spacing, separators. Everything else is editable as shown in brief.md. OK?" The options are "OK", "Make something editable" (they type which), and "Discuss".
5. **Write § Decided:**
   - **Merchant can change:** one row per value, or "none".
   - **Stays in code:** one row per value. Name the editability AC it touches, or "none". When it touches one, cite the question in which the dev agreed (Q#). `kit.mjs done` refuses a row that touches an AC without a Q#.
   - **Questions and answers:** the dev's choice verbatim. How you apply it goes in "Applied as". If "Applied as" stretches the choice beyond what the option said, ask again instead. A "Why" cell that cites the dev (Qn) is only allowed when Qn's options named that exact value.

If there are genuinely no open questions, still ask the confirm question in step 4. A task investigated first has its § Requirements answers in § Decided already: don't ask them again.

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
  - **Not proven yet** comes next: every assumption the approach relies on that you couldn't verify in this theme or store. Examples: a product's option layout you couldn't read (rate-limited, no access), an app's JS API used in a way its docs or this theme don't show, a Liquid object or setting type the theme doesn't use yet. One row each: what it relies on, why it isn't proven, the fallback if it doesn't hold, and the QA criterion that tests it. The fallback is a real alternative the dev could pick at Gate 1, not a silent degradation. Write "none" when everything was verified. A risk you already verified belongs in § Risks, not here.
  - **What changes:** one row per file, or per group of files ("locales/*.schema.json ×5"), with the files from Needs your attention first. "What happens" is at most 15 words and describes the effect, not the anchor: "Winner layout when the mobile menu is set; old markup unchanged otherwise."
  - **Merchant can change** and **Stays in code:** one line each, from § Decided. Put "(vs AC n)" after any value in code that an editability line reaches.
  - **Differs from the ticket or the A/B test:** each deviation and who decided it ("no description field, AC 17: dev, Q3"), or "none".
  - **QA:** number of criteria, viewports, and how many checks the dev will have to do by hand.
- **Approach.** 3–5 lines: what gets built, and the one or two key decisions.
- **Files (builder detail).** One table row per file:
  - path, and create or modify
  - the exact change
  - the **anchor**: the symbol it attaches to, e.g. a `case block.type` branch, a `render` call, a schema `blocks` array or a function name. Never a line number; Shopify sync commits move lines.
  - the data flow: where the value comes from and how it reaches the markup
  - for styling with a Figma design: "values from design.md", or the theme token the dev chose instead (§ Decided)
- **Schema details.** Every setting: id, type, label (or `t:` key), default, options or range, info, `visible_if`. For each section, say whether it has presets and where it may be added (`enabled_on` / `disabled_on`).
- **Store setup.**
  - **Definitions to create.** For each: owner, namespace.key, type, validations, translatable, not pinned, and "reuse: none fits because …".
    - **`adminApi: false`:** write numbered admin steps instead of mutations: Settings → Custom data → owner → Add definition, then every field (name, namespace and key, type, validations, storefront access, "translatable" for metaobjects). The dev creates them at the draft stage. Skip the mutation and scope points below.
    - Write each mutation now, to `.claude/logs/<KEY>/mutations/NN-<name>.graphql`, with variables in `NN-<name>.vars.json`.
    - Validate each one once with the `shopify-plugin:shopify` skill (topic `admin`, `--version <adminApiVersion from .claude/shopify-kit.json>`). The draft stage runs these same files.
    - Metaobject definitions that should render on the storefront need `access.storefront: PUBLIC_READ`. Don't set `access.admin` on merchant-owned definitions.
  - **Scopes the Admin login needs**, by owner type:

    | Owner type | Scope |
    | --- | --- |
    | PRODUCT, PRODUCTVARIANT, COLLECTION | `write_products` |
    | metaobject definitions and entries | `write_metaobject_definitions`, `write_metaobjects` |
    | PAGE, ARTICLE, BLOG | `write_content` |
    | CUSTOMER | `write_customers` |

    The kit's default login covers the first two rows. For the others, give the dev the `! shopify store auth --store <store> --scopes …` command with the extra scope added. The CLI merges it with the scopes already granted.
  - **QA test data.** Which products. Ask the dev to name them; never pick live products yourself.
  - **Merchant steps after merge:** placement, entries, Translate & Adapt.
- **Conventions to follow,** from § Found. For example: "CSS via `stylesheet_tag` in the snippet, like `snippets/product-badges.liquid`".
- **QA criteria.** Numbered, one table row each. Each has an expected value quoted from a ticket or from § Decided, plus the page or template, the viewports, and the data state or locale. Always include:
  - defaults equal the winner (A/B ports)
  - each empty state
  - every locale in scope
  - mobile and desktop, e.g. 390×844 and 1440×900
  - the customizer contract: name, presets, where it can be added, labels and defaults (checked by `contract.mjs`)
  - untouched pages for the regression check
  - **bug fixes:** one row that reproduces the bug, its Criterion starting "Repro:", and Expected saying what live shows today (the failure) and what the draft must show. `done plan` refuses a bug fix without it.
  - **the design** (when `design.md` exists), by the mode in status:
    - **exact:** fill every empty selector in `design-checks.json` with the class the plan creates (Files and Markup). Where the dev chose the theme's value over Figma (§ Decided), or a value is a setting, put the theme value or the setting's default in `fixed`: the audit checks the default state. Then add one QA row per viewport: "Design matches Figma (kit.mjs design-audit <KEY> <viewport>)", default state. `done plan` refuses an empty selector or a missing audit row.
    - **reference:** one row per viewport for layout: the elements present, their order and alignment, what shows and hides at that width, and sizes that fill or flex as behaviour ("fills its column at 390"). No pixel values.
- **QA setup.**
  - Placement on the draft. If the merchant places the feature after merge, the draft needs preview overrides that place it.
  - A feature CSS class prefix that appears nowhere else in the theme (check with Grep). Record it: `kit.mjs set <KEY> featurePrefix=<prefix>`.
  - Untouched paths, without leading slashes, because Git Bash rewrites arguments that start with "/": `kit.mjs set <KEY> qa.paths=home,collections/x,products/y,cart`.
- **Risks,** and how the plan handles each one.

**Done when:** § Decided records the answers and every plan heading is filled. Then run `kit.mjs done <KEY> plan`.

## Stage: approve (Gate 1)

1. Show the dev `plan.md` § At a glance as it is. Nothing else: no file anchors, no restated criteria, no method notes. The path `.claude/logs/<KEY>/plan.md` is for the detail.
2. AskUserQuestion: "Approve the plan for <KEY>?", naming what the approval covers when there is any: "…including 4 store writes, 3 values kept in code, and 2 approaches not proven yet (fallback for each)?" The options are **Approve**, **Approve with changes** (they type the changes, such as "use the fallback for the waitlist"), and **Reject**.
3. Then:
   - **Approve** → `kit.mjs done <KEY> approve --answer "<their words>"`.
   - **Approve with changes** → edit `plan.md` and ask again.
   - **Reject** → `kit.mjs back <KEY> plan --reason "<their words>"`.

**Approve with changes** edits the plan at the gate, so `done approve` runs the plan's checks again. After approval, change `plan.md` only when the work needs it, under **Amendments** with the date and the reason. `done approve` keeps a copy; `done build` and Gate 2 list every change since, and every changed file § Files doesn't name.
