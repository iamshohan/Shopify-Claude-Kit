---
name: shopify-intake
description: Stages 1–2 of /shopify-implement. Read the Jira ticket(s), confirm the work type, collect the A/B code, then run the recon and analyst agents and record what they found. Use only when /shopify-implement's status says the stage is intake or analyze.
user-invocable: false
---

# Intake and analyze

## Stage: intake

**Goal:** `brief.md` § Asked is complete, and the work type and its facts are recorded.

0. **Investigated first?** (`kit.mjs status` says so.) Read `.claude/logs/<KEY>/investigation.md`: its question, answer and evidence are this task's starting context. After a feasibility check, copy its § Requirements answers into `brief.md` § Decided → Questions and answers (citing investigation.md), so the plan doesn't ask them again. Re-check code it cites at the current commit, and carry its Confirmed findings into `brief.md`.
1. **Start from current code.** `git fetch origin`, then look for a local or remote branch matching the key, ignoring case (`git branch --list`, `git ls-remote --heads origin`).
   - One exists → tell the dev now (a teammate may have started). Reuse it when it holds only this task's commits, and say so; ask otherwise. Record it: `kit.mjs set <KEY> branch=<name> base=<sha of git merge-base origin/<baseBranch> origin/<name>>`.
   - The checked-out commit isn't `origin/<baseBranch>`: with a clean tree, switch to it and say so (the plan is made against the code the build starts from). With uncommitted changes, ask: never switch over them.
2. **Read the ticket:** `node .claude/kit/jira.mjs <KEY>`. Missing credentials: pass on its fix or ask the dev to paste the ticket text. Don't guess requirements.
3. **Related tickets:** up to three with `--no-comments`, from the summary, links, parent and `mentionedKeys`. An A/B implementation ticket usually links the A/B test ticket, which holds the design, variations and targeting: read it (with comments if decisions seem to be there). Skip process tickets ("Resolve a new Comment in …", "… is ready for Client Review", "… is Ready to Launch"). Can't tell which is the A/B test: ask.
4. **Work type:** `node .claude/kit/kit.mjs set <KEY> type=<type>`, and tell the dev; if two fit, ask.

   | type | when |
   | --- | --- |
   | `abtest` | the ticket implements a tested, winning variation on the live site |
   | `feature` | the client asks for a new feature or change directly, or an A/B ticket with no test code or live variation to port (built from the criteria and the design) |
   | `bugfix` | something is broken and must be fixed |

   The kit only implements tickets that change theme code. A feasibility check, debugging or a question: suggest `/shopify-investigate <KEY>` and stop. App development and content-only work are out of scope.
5. **Which theme.** The kit builds on the theme that follows the base branch, normally live. **Live is a campaign theme** on another branch and the ticket is for the regular theme: ask the dev for the theme that follows the base branch and record it: `kit.mjs set <KEY> baseTheme=<id>` (drift check, `pull-live`, the draft copy and QA's comparison then use it). **The ticket targets the campaign theme itself:** out of scope, stop.
6. **A/B ports only.** Look things up first; ask only what's still open, in one AskUserQuestion round:
   - **The winner:** from the ticket and its comments; ask only when they name none or several.
   - **The A/B code:** look yourself with Glob (`shadow-drip-exps/src/*/<TEST-KEY>/` and `DripExperiments/` one and two folders above this repo, and paths the ticket names; read only). Found → copy it into `.claude/logs/<KEY>/abtest/` and say where from. Not found → ask: "I'll put the files in .claude/logs/<KEY>/abtest/" or "It's at <path>". Prefer the built bundle (`build/*.js`, `build/*.css`), which is what ran; note whether only source was provided.
   - **The testing tool** (recon's `experimentTools`, the ticket) and **whether it still runs.** Fetched HTML runs no JavaScript, so markers the test adds never show there: evidence is the tool's script tag or the experiment's id in that HTML, the ticket, or the dev's word; without it, `abtest.running=unknown`, not "no". Record: `kit.mjs set <KEY> abtest.tool=<tool> abtest.running=<yes|no|unknown>`.
   - **If it still runs:** QA compares the draft with the live winner. Targeted by country or audience: a link or cookie that forces the variation (from the ticket or the code; not found → ask): `kit.mjs set <KEY> abtest.reference=<link>`. Don't ask whether it excludes `preview_theme_id` URLs: QA checks the draft for the test's markers.

   The variation and the code's location go in `brief.md` § Asked.
7. **Bug fixes only.** Steps to reproduce, the page URL, expected vs actual: ask for what's missing.
8. **Figma.** A **feature** whose ticket links its design (`jira.mjs` lists `figmaLinks`): `kit.mjs set <KEY> design.figma=<link>`; several files → ask which is final. A/B ports and bug fixes skip this (the winning code is the source); a design check can still be added at QA.
9. **Write `brief.md` § Asked**, under the headings in the file:
   - type, tickets, and the winning variation with its code location (A/B ports)
   - a summary of three lines at most
   - **numbered acceptance criteria quoted from the tickets, not paraphrased**; mark inferred ones "(inferred)"
   - scope: pages and templates, locales and markets, devices
   - **what the tickets say should be editable**: one row per line about who may change what, quoted in full with its AC number. Don't narrow a line to the part a neighbouring AC mentions ("manage the mobile navigation without developer support" covers the whole navigation, images, icons and utility links included). "none" if no line says so.
   - what's unclear (list only; questions are asked in the plan stage), not what an editability line already settles.

**Done when:** § Asked has the quoted criteria and the type and its facts are recorded. Then `kit.mjs done <KEY> intake`.

## Stage: analyze

**Goal:** `brief.md` § Found, from a fresh reading of the theme (and the A/B code for ports).

1. Spawn in **one message, so they run in parallel**:
   - `theme-recon`: KEY, type, target pages/templates, and the selectors, classes or sections the A/B code touches (a bug fix: the reproduction).
   - `abtest-analyst` (A/B ports): KEY, the A/B code path, the winning variation, the acceptance criteria.
   - `design-extractor` (a Figma design in status): KEY, the Figma link and frames, target pages, viewports in scope, acceptance criteria.
2. **Write § Found** from the reports, under its headings: recon's commit stamp; the A/B inventory (ports); the render path per target page; the closest existing pattern and how it works; the repo facts that change how the task is built (CSS/JS approach, the cart and event contract, the build step, what git tracks, minified files, `.context.*` siblings, an experiment tool targeting the same element); risks. Keep the citations; cut what the plan won't need; under about 150 lines.
3. **Write `design.md`** (Figma design only): copy `.claude/kit/templates/design.md` to `.claude/logs/<KEY>/design.md` and fill it from the extractor's report, then fill § Differs yourself from the recon and analyst reports (a colour not in the theme's schemes, a size off its type scale, a value the winner changed). Add one line to § Found: "Design: design.md, N elements, M spacing checks".
   - **Save the extractor's JSON** as `.claude/logs/<KEY>/design-checks.json`, as it is.
   - **Pick the mode** and record it: `kit.mjs set <KEY> design.mode=exact|reference`, with the reason in design.md's Mode line. **exact:** the build must reproduce the design and Figma is its only spec (a new custom component with no code to follow, a landing or campaign section, complex UI, a ticket that says match Figma); QA audits every value. **reference:** the build mostly reuses the theme's sections, schemes and type scale, so Figma shows layout and content; QA checks layout, order and visibility. Unsure: exact (its QA is one audit call per viewport).
   - **Tell the dev in one line** how to switch: "Design check: exact (new custom section, Figma is the only spec). Say 'reference' to check layout only." Don't ask; switch if they reply.
   - **`NO FIGMA ACCESS`:** ask whether to connect Figma and run the extractor again, to paste the key values per viewport, or to skip the design check (`kit.mjs set <KEY> design.figma=none`).
4. A report says something is missing or unclear (A/B code incomplete, template not found, src and build disagree): ask the dev now rather than planning around a guess.

**Done when:** § Found has the render path, the closest pattern and the risks, plus the inventory for A/B ports and `design.md` for a Figma design. Then `kit.mjs done <KEY> analyze`.
