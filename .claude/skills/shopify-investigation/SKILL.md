---
name: shopify-investigation
description: The two stages of /shopify-investigate and /shopify-feasibility (gather, conclude). A read-only investigation of a Shopify store and theme, for a feasibility check, a bug, or a question. Use only when kit.mjs status names this skill.
user-invocable: false
---

# Investigate (read-only)

An investigation ends in an answer backed by evidence, not in a code change. The answer goes in `.claude/logs/<KEY>/investigation.md`.

**Read-only means:**
- **Theme files and store data:** never change them (the kit refuses the store-changing verbs for investigations).
- **Storefront** (`kit-browser`; Chrome if it's missing): browsing, choosing variants, adding to and changing the cart. Never checkout, submitting forms (contact, newsletter, reviews, account), or logging in as a customer.
- **Admin in Chrome:** look only (never Save, toggle or type), never the live theme's editor; prefer the Admin GraphQL queries below to screenshots.
- **JavaScript in the page:** read only: the DOM, computed styles, globals, and GET requests (`fetch('/cart.js')`, `?view=`, `.json` URLs). The only POSTs allowed are cart add and change, when reproducing a cart bug.
- **A fix becomes obvious:** finish the investigation, and put the fix in § Next step.

## Stage: gather

**Goal:** a precise question with an agreed definition of "answered", then enough labelled evidence to answer it. For debug, also a reproduction and at least two hypotheses.

### First: the question

1. **Read the input.** A ticket key → `node .claude/kit/jira.mjs <KEY>`, plus up to three related tickets with `--no-comments` (skip process tickets). A question from the dev is already in § Question.
2. **Pick the type:** `node .claude/kit/kit.mjs set <KEY> type=<type>` (already `feasibility` from `/shopify-feasibility`).

   | type | when |
   | --- | --- |
   | `feasibility` | Can X be built, and how? (theme only, metafields/metaobjects, an app, Plus only, not at all) |
   | `debug` | Something behaves wrongly: storefront, theme, menus, markets, metafields, an app's storefront output |
   | `question` | How does X work, or where does it come from? |

3. **Write § Question:** the question made precise ("Why does the German menu show English links on mobile?", not "menu broken"), and what counts as answered. **Debug:** the URL, the steps, expected vs actual, and where it happens (devices, markets, languages, logged in or not). Something missing, or two readings that would lead to different work: ask everything in as few AskUserQuestion calls as possible. Otherwise don't ask.
4. **Feasibility: § Requirements.** One row per acceptance criterion (R1, R2…), quoted (without a ticket, the dev's words), marked clear, unclear or conflicting, with an **owner**:
   - **Dev:** how it's built (approach, files, setup, which app hosts it). What the code and docs can settle isn't a question: it becomes the approaches table with your recommendation. Ask the dev only a Dev row that changes what you investigate, or that `.claude/rules/kit-runs.md` lists, with step 3's questions (2–4 options, your recommendation first), and record the answer verbatim. If `/shopify-implement` follows, these count as decided.
   - **Client:** what customers see or the merchant gets (content, look, position, what stays pinned or live, trade-offs like screen space, anything touching price or discounts). **The client decides these, not the dev.** Put it in the Jira comment as a question with the options and their trade-off, and leave the row open (implement asks again unless the client answered). A client answer the dev already knows: "Client (via dev): …". Proposing a default is fine: say it's a proposal.

### Then: the evidence

| Topic | First source | Then |
| --- | --- | --- |
| How the theme renders or behaves | Grep the repo. `git log -S "<text>"` or `git log -L` shows when it changed and why. | `node .claude/kit/shopify.mjs pull-live <KEY> <files>` when live may differ from git (admin edits, JSON templates, files not in git) |
| What the storefront renders | `node .claude/kit/shopify.mjs fetch <KEY> <path> --live`: saves the live HTML in `.claude/logs/<KEY>/fetch/` and says which theme rendered it. Cite the saved file. | the browser, for what only shows after scripts run |
| Product or collection data | `shopify.mjs query product --handle <h>`, `query collection --handle <h>` | the storefront page |
| Metafields and metaobjects | `query definitions --owner PRODUCT` (or `COLLECTION`, `PAGE`, …), `query metaobjects --type <type>` | Grep the theme for `metafields.<namespace>` and `metaobjects.` |
| Menus | `query menus` | the sections that render `linklists` |
| Markets, languages, currency | `query markets`, `query locales` | the storefront in each market or language, and the theme's `localization` form |
| Apps | app embeds (`shopify://apps/…`) in `config/settings_data.json`; app blocks in templates and section groups; the app's scripts in the storefront's network requests | the app's public docs (WebFetch). App settings and backends are invisible to the kit: Unknown, and ask the dev to check the app's admin. |
| What Shopify supports, and its limits | `search_docs` with the `shopify-plugin:shopify` skill | `query shop` (the plan; some features need Plus) |
| Checkout | A theme can't change checkout pages: that needs Checkout Extensibility (apps, some Plus only). Confirm in the docs. | |
| Anything else in the Admin API | A query in `.claude/logs/<KEY>/queries/<name>.graphql`, validated with the plugin (`--api admin --version <adminApiVersion>`, which also prints the scopes), run with `shopify.mjs query <file>`. | A missing scope → the `investigateScopesFix` command from `shopify.mjs auth-check`. Never order or customer data unless the dev explicitly says so. For discounts, read how they're set up, never the codes, and never copy a code into the chat or the report. |

**Without Admin API access** (`adminApi: false`):
- **Admin pages in Chrome, look only:** Content → Menus, Settings → Markets, Languages, Custom data, Products and Collections.
- **Public storefront data:** `/products/<handle>.js`, `/collections/<handle>/products.json`, `/cart.js`, the `localization` form, the rendered HTML.
- **Is the store on Plus?** Settings → Plan is often locked for staff, and a tab title is no evidence. Open `settings/checkout/editor/profiles/<id>` directly (it takes about 30 seconds; look only): an app block on, or "Add block" offered in, an information, shipping, payment or one-page checkout step means Plus (Thank you and Order status don't count). Save a screenshot scrolled to that block.
- **Otherwise ask the dev.**

A screenshot or page reading you cite is Confirmed. `node .claude/kit/recon.mjs` gives the theme's overall facts (name, build step, experiment tools, locales) in one call.

### Debug: reproduce first

- **Reproduce on the live storefront** at the reported device size, in `kit-browser` (`browser_resize`, then read `innerWidth` back), or Chrome if it's missing (read `innerWidth` back; if the size matters and you can't set it, ask the dev to resize the window). A bug that needs a logged-in customer or the admin: ask the dev before using Chrome for it. Record the steps, URL and what you saw in § Reproduction; screenshots in `.claude/logs/<KEY>/screenshots/`.
- **Measure with the QA probe:** in `kit-browser`, once per session `browser_run_code_unsafe` with `filename: ".claude/kit/probe.init.js"`, and every later page has `__qa`. In Chrome, run `.claude/kit/probe.inject.js` once per tab, then this line re-injects it:
  ```js
  sessionStorage.getItem('__qaSrc') ? ((0, eval)(sessionStorage.getItem('__qaSrc')), 'probe ready') : 'NO PROBE: inject probe.inject.js'
  ```
- **Hold at least two hypotheses** in § Hypotheses: for each, name the observation that would rule it out, look for it, and mark it ruled out with the evidence number that settled it. Don't stop at the first explanation that fits.
- **Live can differ from git:** when theme code is the suspect, compare the repo file with `pull-live`.

### Feasibility: requirement by requirement

For each requirement: native (theme settings and Liquid), needs metafields or metaobjects, needs an app, needs Plus, or not possible. Back each with docs, the store's plan and the theme's code, and note the limitations as you go (what the platform, the plan, the theme or an installed app won't allow; what needs the merchant or an app vendor).

**"Can it be built" isn't the answer. "What will the client get" is.** Fill § Client gets: a row per requirement and **per surface** it touches (storefront per device and market, cart, checkout, emails, the theme editor). Check every property (position, look, width, behaviour, content, where it's edited) on every surface: a requirement that holds on the storefront can change, or fail, in checkout. The last column says how the result differs from what the ticket expects or the store shows today.
- **Look up exactly where every extension target, app block or theme slot renders** (above or below what, which column on desktop, the order on mobile), with the docs sentence that says so, before calling it feasible. "At the top of checkout" isn't a position.
- **Anything rendered by Shopify or an app** (checkout, account pages, an app's widget) uses its own styling, not the theme's: say so whenever the client expects the theme's look.

Then write 2–3 approaches with their trade-offs (merchant control, effort, risk, page speed, what it costs later), name the one you recommend and why, and size each against the theme's code (count the files and templates), not the ticket's length:

| Size | Typically |
| --- | --- |
| S | up to 3 theme files, one template, no store setup |
| M | a new section or block with settings, metafield definitions, or several templates or locales |
| L | metaobjects across several surfaces, an app, a change to shared layout code, or an unknown that needs a spike first |

### Evidence rules

- **Every claim gets a row in § Evidence:**
  - **Confirmed:** you read or observed it, with a source someone can check: `file:line`, a query plus the field, a fetched page in `.claude/logs/<KEY>/fetch/`, a shopify.dev URL plus the quoted sentence, a URL plus what was seen, or a screenshot file.
  - **Inferred:** follows from confirmed facts, not checked directly. **Assumed:** a default or convention you relied on. **Unknown:** you couldn't find out.
- What you observe while the code runs outweighs what you read in it; both outweigh inference.
- Comments and docs drift: where the code disagrees, the code wins, and the mismatch is a finding.

### Stop and ask the dev when

- three hypotheses remain and nothing you can look at separates them
- the question has grown well beyond § Question (report what you have and ask whether to go on)
- about 40 tool calls haven't moved you closer to the answer
- the same attempt has failed twice

**Done when:** the type is set and § Question is precise (feasibility: § Requirements has a row per requirement with its owner, and § Client gets covers every requirement on every surface), and § Evidence has a labelled row for every claim the answer rests on, at least one Confirmed. Debug: § Hypotheses has at least two rows and § Reproduction is filled. Then `kit.mjs done <KEY> gather`.

## Stage: conclude

**Goal:** an answer the dev can act on; for feasibility, checked by someone other than you.

1. **Write the answer.**
   - **§ Answer:** one or two sentences first, then your confidence and what it rests on. Feasibility: yes, yes with conditions, or no; the limitations; the approaches table, the recommended one first.
   - **§ Estimate** (feasibility): **agentic development hours**, the dev's time to deliver it with this kit, development only (no client calls, design, someone else's QA, go-live). A table per part:

     | Part | Investigation and plan | Build | QA and fixes | Buffer | Total |
     | --- | --- | --- | --- | --- | --- |

     - **Investigation and plan:** what this report hasn't settled, plus implement's plan stage (about 0.25–0.5 h with this report as context). **Build:** the agent writes, the dev reviews the diff. **QA and fixes:** measured QA plus one fix round. **Buffer:** about 20%, at least 0.25 h.
     - **Bands from the first measured kit runs** (start to accept, dev review included; hand-coding estimates run two to four times these): a bug fix in 1–3 files, 0.5–1.5 h after its investigation; one new section or setting with QA on two viewports, 1–2 h; a feature over several files, templates or markets, 3–5 h. A part above its band needs a stated reason.
     - **Work outside the theme** (an app extension, a deploy, a checkout editor placement) gets its own row, marked as not run by this kit.
     - Also the size (S, M or L), what could add hours (each with its hours), and your confidence.
   - **§ Could not determine:** a report with nothing here usually stopped looking. "Nothing material" only if true.
   - **§ Next step:** a theme change → `/shopify-implement <KEY>` (same key, this file as its context; an `INV-…` key has no ticket, so the dev starts it with the real ticket and names this log); a store or app setting → exact steps for the dev or merchant; nothing to do → why.
   - **§ Jira comment:** text the dev can post, for the client (the kit doesn't write to Jira). For feasibility, in this order and as short as it can be: the verdict per part, one line each; **every row of § Client gets that differs** from what they expect or see today, in their words; the limitations; the open Client questions with options and trade-off. Never restate the ticket back to the client; leave out internal names, sizes, hours and QA steps.
2. **Independent check (feasibility only).** Spawn the `evidence-checker` agent with the path to `investigation.md` and the ticket key. It first reads as the client (what would surprise them, requirements or surfaces § Client gets skips, Client decisions recorded as decided), then re-checks every Confirmed claim and looks for a better explanation. Apply what it finds (missing rows, surprises into the Jira comment, downgraded labels, a better answer), and record its verdict, its `Client surprises:` line and your changes in § Review.
3. **Gate.** Show the dev the answer, what it rests on ("rests on 4 Confirmed, 2 Inferred: #3, #5"), the evidence-checker's verdict, and the next step; for feasibility also the § Client gets rows that differ and the open Client questions. Then AskUserQuestion: Accept / Dig further (what?) / Wrong question. Accept → `kit.mjs done <KEY> conclude --answer "<their words>"`. Otherwise `kit.mjs back <KEY> gather --reason "…"`; back at conclude, run the evidence checker again and replace § Review. If `done` prints a `retro`, follow its `ask`.
4. Tell the dev the next step in one line.

**Done when:** § Answer, § Could not determine and § Next step are filled (feasibility: also § Estimate, § Review with its client pass, and § Jira comment), theme files are unchanged, and the dev has accepted.
