---
name: shopify-plan
description: Stages 3–5 of /implement. Decide what merchants control and where (the control surface), ask the dev every open question, write the file-by-file plan with its store setup and QA criteria, and get it approved. Use only when /implement's status says the stage is clarify, plan or approve.
user-invocable: false
---

# Clarify, plan, approve

## Stage: clarify (Gate 1)

**Goal:** every open question answered by the dev, and the answers recorded in `brief.md` § Decided.

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
   - A value nobody will change soon stays in code. A block with more than about 8 settings gets split.
   - Never put per-product data in section settings, or per-template layout in metafields.
   - **Placement.** Prefer a section or block with presets that the merchant adds in the customizer over editing `templates/*.json`. Count how many templates would need it (e.g. 60 product templates). If that's a lot of manual work, offer an always-on render point with a theme-setting toggle as the alternative, and let the dev choose. If recon shows JSON templates aren't in git, placement can only be an admin step after merge.
   - **Definitions.** Reuse an existing one if it fits. Check with `node .claude/kit/shopify.mjs query definitions --owner PRODUCT` (or COLLECTION, PAGE…). Never propose changing or deleting an existing definition. Use the store's own namespace, often `custom`. App-owned namespaces are off limits.
   - **Translations.** Which locales need copy (recon lists the locale files)? Metaobjects that hold copy need the translatable capability, and the merchant translates them in Translate & Adapt.
2. **Collect the questions:** everything the tickets don't settle.
   - each dynamic choice the tickets don't state
   - conflicts between tickets
   - missing copy per locale
   - the placement choice and each setting's default
   - risky findings

   Give each question 2–4 concrete options, with your recommendation first, marked "(Recommended)".
3. **Ask all of them before planning**, in as few AskUserQuestion calls as possible (up to 4 questions per call). Don't drip-feed them one at a time.
4. **Write § Decided:** the final control-surface table (one row per value, or "none"), and every question with the dev's answer in their own words, plus the date.
5. **Record the gate:** `kit.mjs done <KEY> clarify --answer "<the dev's answers, one short line>"`.

If there are genuinely no open questions, still show the dev the control-surface table and ask one question: "Is this right?"

## Stage: plan

**Goal:** a `plan.md` that the builder can follow without guessing. Aim for 300 lines or fewer.

Fill each heading in `plan.md`:

- **Approach.** 3–5 lines: what gets built, and the one or two key decisions.
- **Files.** One table row per file:
  - path, and create or modify
  - the exact change
  - the **anchor**: the symbol it attaches to, e.g. a `case block.type` branch, a `render` call, a schema `blocks` array or a function name. Never a line number; Shopify sync commits move lines.
  - the data flow: where the value comes from and how it reaches the markup
- **Schema details.** Every setting: id, type, label (or `t:` key), default, options or range, info, `visible_if`. For each section, say whether it has presets and where it may be added (`enabled_on` / `disabled_on`).
- **Store setup.**
  - **Definitions to create.** For each: owner, namespace.key, type, validations, translatable, not pinned, and "reuse: none fits because …".
    - Write each mutation now, to `.claude/logs/<KEY>/mutations/NN-<name>.graphql`, with variables in `NN-<name>.vars.json`.
    - Validate each one once with the `shopify-plugin:shopify` skill (topic `admin`, `--version 2026-07`). The draft stage runs these same files.
    - Metaobject definitions that should render on the storefront need `access.storefront: PUBLIC_READ`. Don't set `access.admin` on merchant-owned definitions.
  - **Scopes the Admin login needs**, by owner type:

    | Owner type | Scope |
    | --- | --- |
    | PRODUCT, PRODUCTVARIANT, COLLECTION | `write_products` |
    | metaobject definitions and entries | `write_metaobject_definitions`, `write_metaobjects` |
    | PAGE, ARTICLE, BLOG | `write_content` |
    | CUSTOMER | `write_customers` |

    The kit's default login covers the first two rows. For the others, give the dev the `! shopify store auth --store <store> --scopes …` command with the extra scope added. Re-running it replaces the grant.
  - **QA test data.** Which products. Ask the dev to name them; never pick live products yourself.
  - **Merchant steps after merge:** placement, entries, Translate & Adapt.
- **Conventions to follow,** from § Found. For example: "CSS via `stylesheet_tag` in the snippet, like `snippets/product-badges.liquid`".
- **QA criteria.** Numbered, one table row each. Each has an expected value quoted from a ticket or decided at Gate 1, plus the page or template, the viewports, and the data state or locale. Always include:
  - defaults equal the winner (A/B ports)
  - each empty state
  - every locale in scope
  - mobile and desktop
  - the customizer contract: name, presets, where it can be added, labels and defaults (checked by `contract.mjs`)
  - untouched pages for the regression check
- **QA setup.**
  - Placement on the draft. If the merchant places the feature after merge, the draft needs preview overrides that place it.
  - A feature CSS class prefix that appears nowhere else in the theme (check with Grep). Record it: `kit.mjs set <KEY> featurePrefix=<prefix>`.
  - Untouched paths, without leading slashes, because Git Bash rewrites arguments that start with "/": `kit.mjs set <KEY> qa.paths=home,collections/x,products/y,cart`.
  - Test products: `kit.mjs set <KEY> qa.products=<handles>`.
- **Risks,** and how the plan handles each one.

**Fresh docs:** check every Liquid object, filter or tag and every schema setting type the plan uses that the theme doesn't already use with `search_docs` (topic `liquid`).

**Done when:** every heading is filled. Then run `kit.mjs done <KEY> plan`.

## Stage: approve (Gate 2)

1. Show the dev a short summary: number of files, the store setup (definitions and scopes), the number of QA criteria, and the path `.claude/logs/<KEY>/plan.md`.
2. AskUserQuestion: "Approve the plan for <KEY>?", with the options **Approve**, **Approve with changes** (they type the changes), and **Reject**.
3. Then:
   - **Approve** → `kit.mjs done <KEY> approve --answer "<their words>"`.
   - **Approve with changes** → edit `plan.md` and ask again.
   - **Reject** → `kit.mjs back <KEY> clarify --reason "<their words>"`, or `back <KEY> plan`, depending on what they say.

After approval, `plan.md` is frozen. Later changes go under **Amendments**, with the date and the reason.
