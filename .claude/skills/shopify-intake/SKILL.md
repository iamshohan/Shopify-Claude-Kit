---
name: shopify-intake
description: Stages 1–2 of /shopify-implement. Read the Jira ticket(s), confirm the work type, collect the A/B code, then run the recon and analyst agents and record what they found. Use only when /shopify-implement's status says the stage is intake or analyze.
user-invocable: false
---

# Intake and analyze

## Stage: intake

**Goal:** `brief.md` § Asked is complete, and the work type and its facts are recorded.

0. **Investigated first?** If `kit.mjs status` says so, read `.claude/logs/<KEY>/investigation.md`. Its question, answer and evidence are this task's starting context. After a feasibility check, its § Requirements answers are decisions the dev already made: copy them into `brief.md` § Decided → Questions and answers (citing investigation.md), so the plan stage doesn't ask them again. Re-check any code it cites at the current commit before relying on it, and carry its Confirmed findings into `brief.md`.
1. **Start from current code.** Run `git fetch origin`, then look for a local or remote branch matching the key, ignoring case (`git branch --list`, `git ls-remote --heads origin`).
   - One exists → tell the dev now, before analysis: a teammate may have started. If they'll reuse it, analyze reads that branch; build asks again when it creates the branch.
   - The checked-out commit isn't `origin/<baseBranch>` (status names the base) → say so, and ask whether to switch to it before analyze, so the plan is made against the code the build starts from. Never switch with uncommitted changes.
2. **Read the ticket:** `node .claude/kit/jira.mjs <KEY>`. If the script reports missing credentials, pass on its fix (create `~/.claude/.env` once per machine) or ask the dev to paste the ticket text. Don't guess requirements.
3. **Related tickets.** Read up to three with `node .claude/kit/jira.mjs <KEY> --no-comments`, chosen from the summary, links, parent and `mentionedKeys`.
   - An A/B implementation ticket usually names or links the A/B test ticket ("Implement ABC-120"). That ticket holds the design, the variations and the targeting, so read it. Fetch its comments too if decisions seem to be in them.
   - Skip process tickets such as "Resolve a new Comment in …", "… is ready for Client Review" and "… is Ready to Launch".
   - If you can't tell which ticket is the A/B test, ask.
4. **Work type.** Pick one and record it with `node .claude/kit/kit.mjs set <KEY> type=<type>`:

   | type | when |
   | --- | --- |
   | `abtest` | the ticket implements a tested, winning variation on the live site |
   | `feature` | the client asks for a new feature or change directly (no A/B test behind it). Also an A/B ticket with no test code or live variation to port: the dev builds it from the criteria and the design |
   | `bugfix` | something is broken and must be fixed |

   Tell the dev the type you picked. If two types fit, ask.

   The kit only implements tickets that change theme code. For a feasibility check, a debugging task or a question, suggest `/shopify-investigate <KEY>` and stop. App development and content-only work are out of scope.
5. **Which theme.** The kit builds on the theme that follows the base branch, normally the **live** theme.
   - **Live is a campaign theme** on another branch, and the ticket is for the regular theme: ask the dev for the theme that follows the base branch, and record it with `kit.mjs set <KEY> baseTheme=<id>` (the guard asks the dev). The drift check, `pull-live`, the draft copy and QA's regression comparison then use it instead of live.
   - **The ticket targets the campaign theme itself:** say that it's out of scope for the kit, and stop.
6. **A/B ports only.** Look things up first, and ask only what's still open, in one AskUserQuestion round:
   - **The winner:** from the ticket and its comments. Ask only when they don't name it, or name more than one.
   - **The A/B code:** look for it yourself with Glob: `shadow-drip-exps/src/*/<TEST-KEY>/` and `DripExperiments/` one and two folders above this repo (`../`, `../../`), and the paths the ticket names. Read only; never write there. Found → copy it into `.claude/logs/<KEY>/abtest/` and say where it came from. Not found → ask: "I'll put the files in .claude/logs/<KEY>/abtest/" or "It's at <path>".
   - **The testing tool:** from recon's `experimentTools` and the ticket. **Still running:** fetch a page the test targets live (`shopify.mjs fetch <KEY> <path> --live`) and look for its markers (the body class or element the code adds). Ask only when neither settles it. The go-live order at handoff needs both.
   - **If it still runs:** QA compares the draft with the live winner, and the tool must stay off the draft.
     - Targeting by country or audience: a link or cookie that forces the variation (the tool's preview or QA link), from the ticket or the code. Not found → ask; without one, QA can't see the winner from outside the targeted markets. Record it: `kit.mjs set <KEY> abtest.reference=<link>`.
     - Whether the experiment excludes `preview_theme_id` URLs: ask the dev to exclude them, or record that QA must check for it. This one stays a question: only the dev can see the tool's settings.

   Prefer the built bundle (`build/*.js`, `build/*.css`), because that's what actually ran. Note whether only source code was provided.

   The variation and the code's location go in `brief.md` § Asked. Record the rest; `done` refuses without it: `kit.mjs set <KEY> abtest.tool=<tool> abtest.running=<yes|no|unknown>`.
7. **Bug fixes only.** Make sure you have the steps to reproduce, the page URL, and expected vs actual. Ask for whatever is missing.
8. **Figma.** `jira.mjs` lists the ticket's Figma links (`figmaLinks`). A **feature** whose ticket links its design: record it with `kit.mjs set <KEY> design.figma=<link>`; if it links several files, ask which is final. A/B ports and bug fixes skip this: the winning code is the source. A design check can still be added at QA if the dev doubts the draft matches.
9. **Write `brief.md` § Asked**, using the headings already in the file:
   - type, tickets, and the winning variation with its code location (A/B ports)
   - a summary of three lines at most
   - **numbered acceptance criteria quoted from the tickets, not paraphrased**; mark any you inferred with "(inferred)"
   - scope: pages and templates, locales and markets, devices
   - **what the tickets say should be editable**: one table row per line about who may change what, quoted in full with its AC number. Don't narrow a line to the part a neighbouring AC mentions: "manage the mobile navigation without developer support" covers the whole navigation, including images, icons and the utility links. Write "none" if no line says so.
   - what's unclear (list it only; questions are asked in the plan stage). Don't list as unclear what an editability line already settles.

**Done when:** § Asked has the quoted criteria and the type and its facts are recorded. Then run `kit.mjs done <KEY> intake`.

## Stage: analyze

**Goal:** `brief.md` § Found, written from a fresh reading of the theme (and of the A/B code for ports).

1. Spawn these in **one message, so they run in parallel**:
   - `theme-recon`, with: KEY, type, target pages/templates, and the selectors, classes or sections the A/B code touches. For a bug fix, add the reproduction.
   - `abtest-analyst` (A/B ports only), with: KEY, the A/B code path, the winning variation, and the acceptance criteria.
   - `design-extractor` (when status shows a Figma design), with: KEY, the Figma link and frames, the target pages, the viewports in scope, and the acceptance criteria.
2. **Write § Found** from the reports, under its headings:
   - the commit stamp from recon
   - the A/B inventory table (ports)
   - the render path for each target page
   - the closest existing pattern and how it works
   - the repo facts that change how the task is built: CSS/JS approach, the cart and event contract if relevant, the build step, what git tracks, minified files, `.context.*` siblings, an experiment tool targeting the same element
   - risks

   Keep the citations. Cut what the plan won't need, and keep the section under about 150 lines.
3. **Write `design.md`** (Figma design only). Copy `.claude/kit/templates/design.md` to `.claude/logs/<KEY>/design.md` and fill it from the extractor's report. Then fill § Differs from the theme or the A/B code yourself, from the recon and analyst reports: a Figma colour that isn't in the theme's colour schemes, a size off the theme's type scale, a value the winning variation changed. In § Found, add one line: "Design: design.md, N elements, M spacing checks".
   - **Save the extractor's JSON** as `.claude/logs/<KEY>/design-checks.json`, as it is.
   - **Pick the mode** from the task and the code you now know, and record it: `kit.mjs set <KEY> design.mode=exact|reference`. Write the reason in design.md's Mode line.
     - **exact:** the build must reproduce the design, and Figma is its only spec. Examples: a new custom component or section with no existing code to follow, a landing or campaign section, a complex UI (cards, sliders, states), or a ticket that says to match Figma. QA audits every value automatically.
     - **reference:** the build mostly reuses what the theme already has (its sections, blocks, colour schemes, type scale), so Figma shows layout and content rather than values to match. QA checks layout, order and visibility only.
     - When unsure, pick exact: its QA is one audit call per viewport, not more work.
   - **Tell the dev in one line**, with the way to switch: "Design check: exact (new custom section, Figma is the only spec). Say 'reference' to check layout only." Don't ask; switch if they reply.
   - **`NO FIGMA ACCESS`:** ask the dev whether to connect Figma and run the extractor again, to paste the key values per viewport (you write `design.md` from those), or to skip the design check (`kit.mjs set <KEY> design.figma=none`).
4. If a report says something is missing or unclear (A/B code incomplete, target template not found, src and build disagree), ask the dev now rather than planning around a guess.

**Done when:** § Found has the render path, the closest pattern and the risks, plus the inventory for A/B ports and `design.md` for a Figma design. Then run `kit.mjs done <KEY> analyze`.
