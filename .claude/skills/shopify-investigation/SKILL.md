---
name: shopify-investigation
description: The two stages of /shopify-investigate and /shopify-feasibility (gather, conclude). A read-only investigation of a Shopify store and theme, for a feasibility check, a bug, or a question. Use only when kit.mjs status names this skill.
user-invocable: false
---

# Investigate (read-only)

An investigation ends in an answer backed by evidence, not in a code change. The answer goes in `.claude/logs/<KEY>/investigation.md`.

**Read-only means:**
- **Theme files:** never edit them. `done … conclude` refuses if theme files changed since the start.
- **Store:** never change store data. The wrapper refuses `draft`, `push`, `verify`, `preview`, `mutate` and `delete-draft` for investigations.
- **Storefront** (the `kit-browser` tools, an isolated browser; Chrome if they're missing):
  - Allowed: browsing, choosing variants, adding to and changing the cart.
  - Never: checkout, submitting forms (contact, newsletter, reviews, account), or logging in as a customer.
- **Admin in Chrome:**
  - Look only. Never click Save, toggle a setting, or type into a field.
  - Never open the live theme's editor.
  - Prefer the Admin GraphQL queries below to admin screenshots.
- **JavaScript in the page:** read only. Inspect the DOM, computed styles and globals, and make GET requests such as `fetch('/cart.js')` or `?view=` and `.json` URLs. The only POSTs allowed are cart add and change, when reproducing a cart bug.
- **If a fix becomes obvious:** finish the investigation, and put the fix in § Next step.

## Stage: gather

**Goal:** a precise question with an agreed definition of "answered", then enough labelled evidence to answer it. For debug, also a reproduction and at least two hypotheses.

### First: the question

1. **Read the input.**
   - A ticket key → `node .claude/kit/jira.mjs <KEY>`, plus up to three related tickets with `--no-comments`. Skip process tickets.
   - A question from the dev → it's already in § Question.
2. **Pick the type** and record it: `node .claude/kit/kit.mjs set <KEY> type=<type>`. Started with `/shopify-feasibility`, the type is already `feasibility`.

   | type | when |
   | --- | --- |
   | `feasibility` | Can X be built, and how? (theme only, metafields/metaobjects, an app, Plus only, not at all) |
   | `debug` | Something behaves wrongly: storefront, theme, menus, markets, metafields, an app's storefront output |
   | `question` | How does X work, or where does it come from? |

3. **Write § Question.**
   - The question, made precise: "Why does the German menu show English links on mobile?", not "menu broken".
   - What counts as answered.
   - **Debug:** the URL, the steps, expected vs actual, and where it happens (devices, markets, languages, logged in or not).

   If something is missing, or the request reads two ways that would lead to different work, ask everything in as few AskUserQuestion calls as possible (up to 4 questions each). Otherwise don't ask.
4. **Feasibility: check the requirements.** Write § Requirements: one row per acceptance criterion (R1, R2…), quoted (for a request without a ticket, the requirements in the dev's words). Mark each one clear, unclear or conflicting, and give it an **owner**:
   - **Dev:** how it's built (approach, files, setup, which app hosts it): usually settled by the code and docs, as the approaches table below.
   - **Client:** what customers see or what the merchant gets: content, look, position, what stays pinned, static or live, trade-offs like screen space, anything touching price or discounts. **The client decides these, not the dev.** Don't ask the dev to pick one. Put it in the Jira comment as a question, with the options and their trade-off, and leave the row open. If the dev already knows the client's answer, record it as "Client (via dev): …". Proposing a default is fine: say it's a proposal.

   A Dev row the code and docs can settle (which approach, which app hosts it) isn't a question: it becomes the approaches table, with your recommendation, and the dev weighs it at the gate. Ask the dev only a Dev row that changes what you investigate, or that `.claude/rules/kit-runs.md` lists (a departure from the ticket, money, something to maintain), together with step 3's questions, each with 2–4 concrete options and your recommendation first, and record the answer verbatim. Don't ask about what the ticket already settles. If `/shopify-implement` follows, these answers count as decided and aren't asked again. Open Client rows don't: implement asks again unless the client has answered.

### Then: the evidence

### Where to look

| Topic | First source | Then |
| --- | --- | --- |
| How the theme renders or behaves | Grep the repo. `git log -S "<text>"` or `git log -L` shows when it changed and why. | `node .claude/kit/shopify.mjs pull-live <KEY> <files>` when live may differ from git (admin edits, JSON templates, files that aren't in git) |
| What the storefront renders | `node .claude/kit/shopify.mjs fetch <KEY> <path> --live`: saves the live page's HTML in `.claude/logs/<KEY>/fetch/` and says which theme rendered it. Cite the saved file, so the evidence checker can re-read it. | the browser, for what only shows after scripts run |
| Product or collection data | `shopify.mjs query product --handle <h>`, `query collection --handle <h>` | the storefront page |
| Metafields and metaobjects | `query definitions --owner PRODUCT` (or `COLLECTION`, `PAGE`, …), `query metaobjects --type <type>`; the product query lists a product's metafields | Grep the theme for `metafields.<namespace>` and `metaobjects.` |
| Menus | `query menus` | the sections that render `linklists` (header, footer, drawers) |
| Markets, languages, currency | `query markets`, `query locales` | the storefront in each market or language (subfolder or domain from `markets`), and the theme's `localization` form |
| Apps | app embeds (`shopify://apps/…` blocks) in `config/settings_data.json`; app blocks in templates and section groups; the app's scripts in the storefront's network requests and console | the app's public docs (WebFetch). App settings and backends are invisible to the kit: mark them Unknown and ask the dev to check the app's admin. |
| What Shopify supports, and its limits | `search_docs` with the `shopify-plugin:shopify` skill | `query shop` (the plan; some features need Plus) |
| Checkout | A theme can't change checkout pages. Changes need Checkout Extensibility (apps, some Plus only). Confirm in the docs. | |
| Anything else in the Admin API | Write a query in `.claude/logs/<KEY>/queries/<name>.graphql`. Validate it with the plugin (`--api admin --version <adminApiVersion from .claude/shopify-kit.json>`), which also prints the scopes it needs. Then run `shopify.mjs query <file>`. | A missing scope → give the dev the `investigateScopesFix` command from `shopify.mjs auth-check`. Never ask for order or customer data unless the dev explicitly says so; it's personal data. For discounts, read how they're set up (type, conditions, dates, combinations), never the codes themselves, and never copy a code into the chat or the report. |

**Without Admin API access** (`adminApi: false` in `.claude/shopify-kit.json`, and `query` refuses):
- **Admin pages in Chrome, look only:** Content → Menus, Settings → Markets, Languages, Custom data, Products and Collections.
- **Public storefront data:** `/products/<handle>.js`, `/collections/<handle>/products.json`, `/cart.js`, the page's `localization` form, and the rendered HTML (`shopify.mjs fetch <KEY> <path> --live`).
- **Is the store on Plus?** Settings → Plan is often locked for staff, and an admin tab title ("… · Shopify Plus") is not evidence. Open Settings → Checkout → the active configuration's Customize (look only). An app block placed on, or "Add block" offered in, a checkout step (information, shipping, payment, or the one-page Checkout page) means Plus. Thank you and Order status pages don't count: every plan gets those. Save a screenshot that shows that block, scrolled to it. The checkout editor takes about 30 seconds to open: open `settings/checkout/editor/profiles/<id>` directly and wait for it, rather than clicking Customize again.
- **Otherwise ask the dev.**

Label what you read this way as usual. A screenshot or page reading is Confirmed if you cite it.

`node .claude/kit/recon.mjs` gives the theme's overall facts (theme name, build step, apps' experiment tools, locales) in one call, if you need them.

### Debug: reproduce first

- **Reproduce on the live storefront** at the reported device size: with the `kit-browser` tools (`browser_resize`, then read `innerWidth` back), or with the `claude-in-chrome` tools if they're missing.
  - In Chrome, read `innerWidth` back after any resize. If the size matters and you can't set it, ask the dev to resize the window.
  - A bug that needs a logged-in customer or the admin can't be reproduced in `kit-browser`; ask the dev before using Chrome for it.
  - Record the steps, URL and what you saw in § Reproduction.
  - Save screenshots in `.claude/logs/<KEY>/screenshots/`.
- **For measurements,** use the QA probe. In `kit-browser`: once per session, `browser_run_code_unsafe` with `filename: ".claude/kit/probe.init.js"`, and every later page has `__qa`. In Chrome: run `.claude/kit/probe.inject.js` once per tab. After that, this one line re-injects it:
  ```js
  sessionStorage.getItem('__qaSrc') ? ((0, eval)(sessionStorage.getItem('__qaSrc')), 'probe ready') : 'NO PROBE: inject probe.inject.js'
  ```
- **Hold at least two hypotheses** in § Hypotheses.
  - For each one, name the observation that would rule it out, then look for that observation.
  - Mark it ruled out with the evidence number that settled it.
  - Don't stop at the first explanation that fits.
- **Live can differ from git.** When theme code is the suspect, compare the repo file with `pull-live`.

### Feasibility: requirement by requirement

For each requirement in the ticket, decide which of these it is:
- native (theme settings and Liquid)
- needs metafields or metaobjects
- needs an app
- needs Plus
- not possible

Back each one with docs, the store's plan, and the theme's code. Note the limitations as you go: what the platform, the store's plan, the theme or an installed app won't allow, and what would need the merchant or an app vendor.

**"Can it be built" isn't the answer. "What will the client get" is.** Fill § Client gets: a row per requirement and **per surface** it touches (storefront per device and market, cart, checkout, emails, the theme editor). Each requirement has properties: position, look, width, behaviour (sticky, animation, timing), content, and where it's edited. Check every property on every surface, and say which ones carry over and which don't. A requirement that holds on the storefront can change, or fail, in checkout. The last column says how the result differs from what the ticket expects or the store shows today.
- **Look up exactly where every extension target, app block or theme slot renders** (above or below what, which column on desktop, the order on mobile), with the docs sentence that says so, before you call it feasible. "At the top of checkout" isn't a position.
- **Anything rendered by Shopify or an app** (checkout, the account pages, an app's widget) uses its own styling, not the theme's. Say so whenever the client expects the theme's look.
- `done gather` refuses a feasibility check where § Client gets has no row for a requirement.

Then write 2–3 approaches with their trade-offs: merchant control, effort, risk, page speed, and what it costs later (upkeep, app fees). Name the one you recommend and why. Size each with these bands:

| Size | Typically |
| --- | --- |
| S | up to 3 theme files, one template, no store setup |
| M | a new section or block with settings, metafield definitions, or several templates or locales |
| L | metaobjects across several surfaces, an app, a change to shared layout code, or an unknown that needs a spike first |

Check the size against the theme's code, not the ticket's length: count the files and templates the approach touches.

### Evidence rules

- **Every claim gets a row in § Evidence,** with one of these labels:
  - **Confirmed:** you read it or observed it. The source must let someone check it: `file:line`, a query name plus the field, a fetched page in `.claude/logs/<KEY>/fetch/`, a shopify.dev URL plus the quoted sentence, a URL plus what was seen, or a screenshot file. `done gather` refuses a Confirmed row with no source.
  - **Inferred:** it follows from confirmed facts, but you didn't check it directly.
  - **Assumed:** a default or convention you relied on.
  - **Unknown:** you couldn't find out.
- What you observe while the code runs outweighs what you read in it, and both outweigh inference.
- Comments and docs drift. If the code disagrees with them, the code wins, and the mismatch is a finding.

### Stop and ask the dev when

- three hypotheses remain and nothing you can look at separates them
- the question has grown well beyond § Question; report what you have and ask whether to go on
- about 40 tool calls haven't moved you closer to the answer
- the same attempt has failed twice

**Done when:** the type is set and § Question is precise (feasibility: § Requirements has a row per requirement with its owner, and § Client gets covers every requirement on every surface it touches), and § Evidence has a labelled row for every claim the answer rests on, at least one of them Confirmed. For debug, § Hypotheses has at least two rows and § Reproduction is filled. Run `kit.mjs done <KEY> gather`.

## Stage: conclude

**Goal:** an answer the dev can act on; for feasibility, checked by someone other than you.

1. **Write the answer.**
   - **§ Answer:** one or two sentences first, then your confidence and what it rests on. Feasibility: yes, yes with conditions, or no; the limitations; then the approaches table, the recommended one first.
   - **§ Estimate** (feasibility): **agentic development hours.** That's the dev's time to deliver it with this kit, not hand-coding time. Count development only: no client calls, design, someone else's manual QA, or go-live. Give a table per part with these columns:

     | Part | Investigation and plan | Build | QA and fixes | Buffer | Total |
     | --- | --- | --- | --- | --- | --- |

     - **Investigation and plan:** what this report hasn't settled yet, plus `/shopify-implement`'s plan stage (about 0.25–0.5 h when this report is its starting context).
     - **Build:** the agent writes the code and the dev reviews the diff.
     - **QA and fixes:** the kit's measured QA on the draft, plus one round of fixing what it finds.
     - **Buffer:** about 20%, at least 0.25 h, for what nobody expects.
     - **Bands from the first measured kit runs** (November 2026, start to accept, dev review included; hand-coding estimates run two to four times these):
       - a bug fix in 1–3 files: 0.5–1.5 h after its investigation;
       - one new section or setting with QA on two viewports: 1–2 h;
       - a feature over several files, templates or markets: 3–5 h.
     - A part above its band needs a stated reason.
     - **Work outside the theme** (an app extension in another repo, a deploy, a checkout editor placement) gets its own row, marked as not run by this kit.
     - Also give the size (S, M or L, as above), what could add hours (each with its hours), and your confidence.
   - **§ Could not determine:** a report with nothing here usually stopped looking. Write "Nothing material" only if that's true.
   - **§ Next step**, one of:
     - A theme change → `/shopify-implement <KEY>`. The same key continues, with this file as its starting context. An `INV-…` key has no ticket, so say the dev starts `/shopify-implement` with the real ticket and names this log.
     - A store or app setting → exact steps for the dev or merchant. The kit doesn't change them.
     - Nothing to do → say why.
   - **§ Jira comment:** text the dev can post, written for the client. The kit doesn't write to Jira. For a feasibility check, in this order and as short as it can be:
     1. the verdict for each part, one line each;
     2. **every row of § Client gets that differs** from what they expect or see today (position, look, behaviour, where it's edited), in their words;
     3. the limitations;
     4. the open Client questions, each with its options and trade-off.

     Never restate the ticket's request or criteria back to the client. Leave out internal names (apps, configurations, files), sizes, hours and QA steps.
2. **Independent check (feasibility only).** Spawn the `evidence-checker` agent with the path to `investigation.md` and the ticket key.
   - **First, as the client:** it reads only the ticket, § Answer and § Jira comment, and lists what would surprise the client after delivery. It checks for any requirement and surface § Client gets skips, and any Client decision recorded as decided.
   - **Then, as a reviewer:** it re-checks every Confirmed claim against its source and looks for an explanation that fits the evidence better.
   - Apply what it finds: add the missing § Client gets rows, put the surprises in the Jira comment, downgrade labels it couldn't confirm, and change the answer if it found a better one.
   - Record its verdict, its `Client surprises:` line and your changes in § Review. `done conclude` flags a feasibility § Review without that line.
3. **Gate.** Show the dev the answer, what it rests on ("rests on 4 Confirmed, 2 Inferred: #3, #5"), the evidence-checker's verdict for a feasibility check, and the next step. For a feasibility check, also show the § Client gets rows that differ and the open Client questions, so the dev reviews what the client will get, not only the verdict. Then ask with AskUserQuestion:
   - Accept
   - Dig further (what?)
   - Wrong question

   Record their words: `kit.mjs done <KEY> conclude --answer "<their words>"`. For "dig further" or "wrong question", run `kit.mjs back <KEY> gather --reason "…"` instead; back at conclude, run the evidence checker again on the new evidence and replace § Review. If `done` prints a `retro`, follow its `ask` (a `kit.mjs note` per thing the kit caused, or `--none`).
4. Tell the dev the next step in one line.

**Done when:** § Answer, § Could not determine and § Next step are filled (feasibility: also § Estimate, § Review with its client pass, and § Jira comment), theme files are unchanged, and the dev has accepted.
