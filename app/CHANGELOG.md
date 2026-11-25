# Changelog

## 0.5.0 — 2026-11-26

**QA that doesn't grade itself, and proposals anchored to the ticket.** In asmc ASM-924, verify passed and then a blind human QA found five bugs. The scenarios had paraphrased the AC ("two most recent" became "2 review cards"), Figma was never opened, a wrong "no slot there" claim reached Gate 1, and a sibling repo's earlier answer went unread.

- **§ Asked:** every acceptance criterion and deciding comment, quoted word for word, plus every Figma frame, each tied to the scenarios that prove it. `app.mjs ticket <ID>` saves the ticket to `.claude/logs/<ID>/ticket.json`. Gate 1 refuses:
  - a quote that isn't in the ticket
  - a row no scenario proves
  - a Figma frame without a `qa:` scenario
  - a Figma node the ticket links but § Asked leaves out
- **Figma:** a new `design-extractor` agent reads each frame (per variation and viewport) into `design.md` and maps each value to what checkout, admin or theme components can express. Gate 1 wants it when the ticket links Figma.
- **Outside reviewer:** a new `outcome-checker` agent reads the ticket first, then the proposal. It looks for dropped words, uncovered frames, arms and surfaces, unproven claims, and precedent. It runs again on the client comment before handoff. Both runs are recorded (`review <ID> outside|handoff`) and required.
- **§ Not proven yet:** what the design relies on that the docs don't promise, with its evidence, fallback and scenario. Gate 2 lists these first. A "can't be done" line without a shopify.dev link gets a warning.
- **Precedent:** `app.mjs precedent <ID> <words>` searches this and the sibling app repos' archived changes. It is required before a change adds an extension or target. What it finds is an option, still checked in the docs.
- **A QA stage** (`app-qa` skill, loaded by verify), with a probe for checkout, storefront and admin (`qa-probe.init.js`, kit-browser). The probe finds elements by text through shadow roots and lists every copy of a block (mobile one-page checkout shows the summary twice). It reads sizes, colours, gaps, wrapping, overflow, links and images. Verify now owes, beyond the scenarios:
  - a **blind QA** run (new `blind-qa` agent: ticket, design and store only, never the proposal)
  - a row per § Asked Figma frame, at its width
  - the real journey per A/B arm and control
  - live data checked against its source

  Each is recorded with `qa-add` / `qa-row` (Q1, Q2, …) and shown at Gate 2 and in handoff.md.
- **More automated checks in verify:**
  - every `shopify.app*.toml` is validated (production warns)
  - theme app extensions run Theme Check and their size limits
  - a Function input query over 3000 bytes fails
  - `fetch` without `network_access` fails
  - API versions over 12 months old warn (and fail when the change touches them)
  - debug code the branch adds (`debugger`, `PROBE`, qa logging) fails
  - the bundle check counts only the compressed size Shopify limits
- **`shopify.mjs dev-status`:** reads the dev's `app dev` log to report which store it previews, whether it rebuilt after the last edit, build errors and sizes. It never prints the GraphiQL key.
- **Reviews must have run:** a `--found` saying "reviewed inline" or "carried over" is refused.
- **Friction fixes:**
  - `--quick` for small fixes with no surfaces: same gates, no outside review, precedent or blind QA; maintenance gets the same exemption
  - `app.mjs revert <ID> <file…>` drops uncommitted experiments and keeps a patch
  - a missing Dependabot setup no longer blocks verify
  - handoff.md no longer breaks wrapped bullets
  - QA records the editor placement with each placement row
- **Setup:** checks kit-browser and notes Figma access. `project.md` records the client's store vs the dev store (checkout layout, Plus, branding) and the sibling repos.

**Round 2, after an outside rating (6.5/10) and a code review of the first pass:**
- **Proof that reviews ran.** The guard logs every Agent and Skill call by name; it never blocks them. `review <ID> outside|blind|handoff|code|security` refuses unless the log shows `outcome-checker`, `blind-qa`, `code-review` or `security-review` ran since the last record (for handoff, since Gate 2). `design.md` likewise needs a logged `design-extractor` run. `--untraced "<why>"` covers an older Claude Code, and Gate 2 shows it.
- **AC coverage:**
  - the ticket's acceptance criteria (the list under an "Acceptance criteria"/"Akzeptanzkriterien"/"AC" heading, or a field so named) must each have a § Asked row or be named out of scope
  - meaning-carrying words in a quote that its scenarios drop ("most recent", counts, "new tab", "section") get a warning
  - every frame in `design-checks.json` needs a Figma row
- **Figma by machine:**
  - `__aq.compare(frame)` diffs one design-checks.json frame against the page: colours as hex, sizes within 1 px, gaps between texts
  - a figma row is refused unless `--how` names its frame's width
- **Deploy hygiene:** `app.mjs predeploy`, for the dev and read-only, checks:
  - a clean tree
  - on the merged base and up to date
  - no QA or debug code anywhere in the extensions

  It prints `shopify app deploy … --message "<ID> @ <sha>" --source-control-url <commit>`. It's the first step of every deploy checklist. Deploy uploads the working tree, which is how ASM-924's uncommitted probes reached production.
- **A fix's baseline:** `qa-row <ID> <S#> --baseline` at propose records the visual bug on the unfixed build. Gate 1 now refuses a fix with neither a failing test nor a baseline FAIL.
- **Smaller:**
  - `qa-row --file rows.json` records a batch
  - journeys go through each add-to-cart path the store has
  - an A/B change always leaves the dev a check in the A/B tool's preview on the client's store
  - Gate 1 and Gate 2 say when Figma wasn't read
  - app-proxy changes owe a data row
  - "can't be done" claims are found in more wordings and need a `shopify.dev/docs/api/` reference page
- **Fixed from the code review:**
  - the capability check now covers only checkout and customer-account extensions; admin extensions fetch their backend freely
  - the debug check no longer matches `no-debugger`, the word "probe" or lockfiles
  - `revert` keeps binary edits, stops if the diff fails, and refuses paths outside the repo
  - German „…“ and French «…» quotes are accepted
  - `precedent` keeps other clients' repo and ticket names in the local logs, out of change.json and the proposal
  - numbered steps stay separate in handoff.md
  - `dev-status` counts only errors since the last rebuild and redacts keys in them
  - blind-qa may run the A/B files and read design-checks.json
  - the probe reports screen-reader-only and overflow-clipped text as hidden, doesn't count padding as a line, and says "unknown" for a checkout layout it can't tell
  - "carried over" in a finding is allowed
  - `--quick` and `--baseline` are boolean flags
  - Figma nodes are matched whole, and a prototype's starting node isn't a frame
  - input query size ignores comments and line endings
  - the old-API-version check only warns, since the deploy refusal isn't confirmed

**Round 3: the dev's experience** (a DX review counted about 6 real decisions per A/B run and 30–70 prompts that protected nothing):
- **Prompts that guarded nothing are gone:**
  - `dev-status` is a safe verb; it prompted every QA round and was refused in bypass mode
  - allowed: the Figma read tools; kit-browser's run-code, type and fill tools, run-code still screened by the guard; Claude in Chrome's navigate, tabs, computer, javascript and form tools; the Shopify plugin's docs and validation helpers; `gh pr create --draft`
  - Chrome navigation without a prompt stays on the dev store, its admin, Shopify's docs, Figma and localhost; any other store or site asks
- **Fix loops are lighter:**
  - `qa-row <ID> S1,Q4 --carry "<why>"` keeps PASS rows a fix can't reach (shown in the handoff), instead of measuring every row again
  - a security review carries past a fix that only touched styles, locale files or tests (under 30 lines); the kit decides from the diff
- **Batches:** `qa-add <ID> --file blind.json` adds a blind QA run's whole table, with its measurements, in one call.
- **The post-handoff fix lane:** `--quick` may start on the branch it fixes while its PR is open (same branch, same PR). The agent edits directly, without the builder, and runs a `low` code review. Skipped: the security review, the outside reviews, precedent and blind QA.
- **Handoff:** no PR question. The draft PR opens when `gh` is logged in, else the compare link is shown; merge commands only on request.
- **Fewer false refusals:**
  - the AC section ends at bold labels and rules
  - only "acceptance" fields count, not "success" or "targeting criteria"
  - bare links aren't AC
  - an AC line split across rows counts
  - a corporate-identity Figma link (a file's first page) isn't a frame
  - "first", "last" and "top" don't trigger the dropped-words warning
  - "not checked" in a measurement is allowed
  - dashes and ellipses are normalised in quotes
- **Fixed from the round-2 review:**
  - the review trace only counts runs on this change's branch, applies only to 0.5.0 changes, and its message names the real causes (a session started before the update, a /code-review typed by hand)
  - design.md with "NO FIGMA ACCESS" needs no logged run
  - `revert` lets git write the patch, so files in other encodings survive
  - `dev-status` tracks errors per extension
  - `__aq.compare` resolves `between` through the frame's element names, skips pad and edge spacing, and handles `letter-spacing: normal`, unitless line heights, font-family lists, short hex and alpha
  - the hook matcher is anchored, so `Task` doesn't catch other tools
  - `precedent` also searches sibling repos' extension code and tomls (most were built before the kit)
  - a figma row's width comes from design-checks.json
  - a data row is owed whenever the branch adds a `fetch`

**From the final rating (8/10):**
- The app and extension tomls are now open at propose; the guard used to refuse the very validate-before-Gate-1 step propose asks for.
- app-implement says a quick fix to an open PR stays on that branch.
- The quick lane lists every section Gate 1 checks.
- Handoff uses the PR the branch already has.
- A fix loop's code review is `low` for a delta under about 30 lines.
- A `--quick` change that grows past 80 lines of app code owes blind QA and the security review again.
- `gh pr view`, `gh auth status` and kit-browser's dialog handling no longer prompt.

Not done, on purpose: saving the dev store's password in app-kit.json (it saves one question per run, but stores a password); taking the dev's request as the Gate 1 answer for a quick fix (Gate 1 stays an explicit yes).

Changes started before 0.5.0 keep their old checks (`schemaVersion` 2).

Theme kit: no counterpart in this release. It is held for a week to collect feedback. Its plan stage already has the outside reviewer and design extraction; a blind QA agent and § Not proven yet's Gate 2 ordering would be new there and are candidates for its next release.

## 0.4.0 — 2026-11-25

**The dev store's editor setup is the agent's job in verify.** It reads and changes the theme editor and checkout editor setup in the dev's Chrome itself (app embed, app block, block settings), says so in one line, and checks the preview afterwards. Before, it asked the dev to place blocks and report the setup. Publishing a theme or checkout configuration stays the dev's. Theme kit: no counterpart needed, its QA already works in the draft theme's editor in Chrome without asking.

**A lighter guard**, with the theme kit 1.17.0 (same principle and the same cuts): it's for secrets, sensitive actions and honest mistakes, not for an agent working around it on purpose.
- **change.json is read and committed freely** (`cat`, `git add` were refused); it's still written only by `app.mjs`.
- **App code after the build stage is logged**, not refused: verify's code digest and build's surface check already refuse results measured on other code. Before Gate 1 it's still refused (scenarios first).
- **A recursive search** is refused only where a `.env` (or `.claude/.env.local`, `~/.claude/.env`) really exists and isn't excluded.
- **Settings:** a change to `app-kit.json` asks only for the dev store, the app config, the protected branches, the verify commands or the Jira URL; others are logged.
- **Discards** ask only with something to lose; `.git/info/exclude` no longer asks; `node --env-file` / dotenv in code no longer counts as reading `.env` (printing it still does).
- **The seal is protected by path** (writing it is refused, reading it passes); the seal now goes under the normalised change id the wrapper reads.
- **Bypass mode works:** mutations, migrations, safety settings and the guard's own files stay refused; a kit skill edited here passes and is logged. `/app-setup` notes the mode instead of stopping.
- **Wording checks are warnings:** § Needs your attention saying "none" beside flagged surfaces passes with "Worth a look". `gate` prints warnings as `warnings` and fails only on refusals; Gate 1 shows them to the dev before approval. An A/B change's own test-code scenarios ("variation writes once", "control clears") stay required: without them nothing measures those.

**Caught by the last review, before release:** the guard fixes listed under theme kit 1.17.0 apply here too (`git clean -x`, kit code in bypass mode, a CRLF settings edit, names-only `env`, `prisma/.env` and `web/.env` counted for searches).

**Shorter instructions:** skills, commands, rules and READMEs are 19% shorter (9.4k → 7.6k words) with no rule removed, on the same principle as the theme kit's. The app kit still has no outside reviewer of its proposal or handoff: with one real repo, Gate 1 and Gate 2 stay the dev's review until real use shows the need.

**Fixed from the reviews:** the guard and `repo.mjs` share one app-code pattern (lockfiles still count as generated in the guard, so they stay editable before Gate 1); handoff prints `gh pr create --draft`; `generate-extension` runs without a prompt; the TOML reader takes only own keys and refuses a table defined twice (parity with the CLI checked on two real apps); `app-toml-parity` fails when it compared nothing; README, proposal template and app-implement corrected.

## 0.3.0 — 2026-11-25

**Three commands instead of eight**, like the theme kit's:
- `/app-setup` sets up and onboards, and on a re-run is the health check (was setup, onboard and drift).
- `/app-implement <KEY>` runs every kind of change; the agent picks the type from the ticket (change, fix, ab, maintain) and says which (was change, fix, maintain and ab).
- `/app-investigate <KEY or question>` answers a question, or checks a ticket's feasibility with what the client gets, the approaches, an estimate in agentic hours and a draft Jira comment (was ask, which only answered questions).
The installer removes the old command files on update.

**Setup in minutes, not 25 interactions:**
- An untouched app template that should be extension-only is stripped inside setup, before onboarding, without a change or a gate. `detect` reports `untouchedTemplate` and suggests the dev config. `templates/extension-only.app.toml` holds the validated defaults (the default app home, the `[auth]` redirect validate requires).
- Settings are decided, and the guard's prompt on app-kit.json is the confirmation.
- **The first change doesn't wait for the onboarding merge:** it stacks on `kit-onboard` and is measured from it until that branch is in the base (this replaces 0.2.0's refusal).
- **The kit generates extensions itself:** `shopify.mjs generate-extension <template> <name> --flavor <f>` (local files with the CLI's cached login; it refuses a ticket key as the name). The first A/B run waited for "extension generated".

**Level with the theme kit:** the client and CRO rule, project knowledge in the root `CLAUDE.md`, verify fixing failures inside the scenarios on its own (at most 2 rounds), `qa-row` refusing a hedged PASS, a client comment at handoff, and a shorter Gate 1 message (at most 15 lines; the first A/B Gate 1 was 39).

**From the review, with the theme kit 1.16.0:**
- Handoff offers the draft PR or the merge commands, one `!` command per line (`kit-onboard` first for a stacked change).
- Handoff prints the retro when the run looped back, was refused or blocked; `app.mjs feedback` and `retro` are gone (`export-logs.mjs` collects the notes).
- The guard no longer logs gate answers and waivers; change.json records the answers and handoff lists the waivers.
- Shared with the theme kit from `shared/`: `core.mjs` (helpers, seals), the guard's hook entry, the installer's body and `rules/runs.md`; `app-runs.md` keeps only the app kit's own rules.

**Fixed before release** (third review):
- **A/B code check:** comments no longer satisfy it. Each `variation*.js` must write exactly one value, together covering every value in § Gate's "Values:" clause; helper files don't count; `control.js` is required unless § Gate says the tool can't run code in control; the extension's read is looked for only in source changed since the base, not in tests.
- **§ Gate is part of the approved digest**, so a changed key or value after Gate 1 shows as drift. The handoff's A/B steps print only § Gate's lines.
- **The client comment** lives in proposal § Client comment (handoff refused it before, and nothing could write it); handoff copies it into handoff.md.
- **Stacking finished:** `start` checks that the branch really holds `kit-onboard` and records its commit, so the base still resolves once `kit-onboard` is deleted; the PR text says to merge `kit-onboard` first with a merge commit.
- A new extension no longer needs § Design (the deploy checklist orders it); `waive` needs the dev's words (`--answer`); the hedge check matches the theme kit's; `status` names the change's source before it starts; stale references to the old commands are gone.

## 0.2.1 — 2026-11-25

From the review of the first A/B change (ASM-924, at Gate 1).
- **The A/B key is checked end to end.** verify's new `ab code` check reads § Gate's key and values and fails when `abtest/<ID>/` is missing, still holds the template's `TICKET`, `TEST NAME` or `"true"`, doesn't write each value, has no control file, or when no extension file reads the key. Before, verify set the attribute by hand, so a variation that wrote the wrong value passed every scenario while its visitors saw control.
- **Gate 1 wants scenarios for the test code itself** (the variation writes the key once, control clears it): verify records those checks as `qa:` rows, which `qa-row` takes only for declared scenarios. Verify sets the "present" side by running the variation file unchanged, and measures "absent" in the same session.
- **The variation template** posts only its own keys (a stale copy of all attributes could overwrite another app's), writes one at a time with a short delay and at most 3 times per page (no update loop), and also reacts to adds through `fetch`, for themes without a cart drawer.
- **"Sunset" is now "A/B test completion"**, with a fixed order: remove the block or deactivate the Function, then stop the test, then delete the extension. Stale attributes stay on carts; the old template said they cleared. Proposals with `## Sunset` still count.
- **The handoff's A/B steps are steps,** not copies of § Gate: paste each file into its arm, set the targeting, preview on the client store (`/cart.js` shows the key), start; and the completion order.
- **Deploy checklist:** "deploy the app server" only when the repo still has one (the recorded kind went stale); a step to request network access before deploying a checkout extension that calls out.
- **Merge and PR links** work for an SSH-alias remote (`git@drip-dev:Org/repo`), and the handoff prints one too: without it, the dev pushed straight to main.
- **Verify knows the checkout editor's limits:** its preview is a cross-origin iframe the probe can't reach, a cleared text setting arrives as `undefined` (code defaults fill it back in), and an admin "Preview" checkout loses its cart when stepping back.
- **Guard** (with theme kit 1.15.2): a pattern inside a change's named log subfolder, and listing or finding files in the installed CLI's folder (with its path in a variable too), are allowed; running anything from there is still refused.

## 0.2.0 — 2026-11-24

After the first real run (an extension-only A/B app: setup, onboard and a first change took about 25 dev interactions, and left 19 kit notes).

- **Setup asks what kind of app first.** An untouched app template that should be extension-only gets re-initialised with the extension-only option before onboarding: onboarding the template recorded 43 surfaces, and removing them took a full change with two gates. Aim: setup and onboard take at most three things from the dev.
- **A lone `shopify.app.toml` is treated as production.** The dev creates a dev app first (`config link`, "Create a new app"), and setup copies the production toml's sections into the new, nearly empty dev toml itself (keeping its client_id, name and handle), shows the diff and validates it.
- **Branch protection that can't be checked** (no `gh`) is a ✗ under "Needs you", with where to set it. In the first run, a direct push to main went through.
- **`app.mjs onboard --redo`** rewrites the baseline while `appspec/` isn't committed; the guard kept the agent from deleting those files, so the dev had to. Onboard prints the merge link, and **`app.mjs start` refuses until the onboarding is merged into the base branch**: changes measured their surfaces against a base without it.
- **Propose validates an edited app or extension toml** with `shopify.mjs validate` before Gate 1: dropping `[auth]` from a docs reading cost a second Gate 1.
- **A kit update no longer fails a change in flight:** `gate` asks for § Decided for you only when the proposal has that heading.
- **Run rules:** files are written with the Write or Edit tool (a `package.json` with a deploy script or a `.gitignore` listing `.env`, written through the shell, read as commands to the guard), and each kit note is one direct `app.mjs note` call.
- **Guard:** reading the installed CLI's source (`cd` into its folder, then grep) is allowed when every part of the command only reads; running anything from there is still refused.
- **The deploy checklist follows what the change did.** A change that removed the backend no longer gets "migrate the production database" and "deploy the app server": it gets "retire the hosting and the database after the release". The checklist starts with validating the production config (the kit validates only the dev app's).
- **The app type is read from the repo, not only from setup:** status says when `kind` in app-kit.json no longer matches (setup's "admin" stayed after the backend was removed).
- **`app dev` runs in a separate terminal:** `shopify.mjs info` prints the appDev command without `!` and says where to run it. With `!` the dev server held the Claude Code session.
- **A refused chained command:** the rules say to run its parts on their own before blaming the guard. Three of the run's "false positives" came from another part of the same command.
- **Handoff keeps `appspec/project.md` true** when a change adds or removes what it describes. The README says the commands are typed, not pasted.

## 0.1.0 (not trialled on a real app change)

The Shopify App Kit: Claude Code for Shopify apps (admin apps and extension-only apps), scenarios first. It lives in `app/` of the Shopify-Claude-Kit repo; devs install it with `node install.mjs <app-repo> --app` from that repo's root.

- **Fewer questions** (with theme kit 1.15.0): the agent decides what the ticket, the app's code, the archived changes or the docs answer, and lists those decisions in proposal.md § Decided for you, which Gate 1 shows and `gate` wants filled (or "none"). It asks only for a departure from the ticket, a new scope or something the merchant maintains, money, real alternatives, a contradiction, or something hard to undo. It also picks a change's ID itself, reuses the change's own branch, and checks whether `app dev` reloaded instead of asking.
- **`/app-ab` writes the A/B test's own code** (from the team's abtest-checkout-extension skill), kept in the app repo under `abtest/<ID>/` instead of shadow-drip-experiments: `variation.js` sets the gate, `control.js` removes it. They start from two new templates (`kit/templates/abtest-variation.js`, `abtest-control.js`). Propose chooses the carrier (cart attribute or line item property) from what the test changes and lists the code in § Tasks. Verify checks the code on the dev store before the checkout rows: values in `/cart.js`, nothing on an empty cart, no second update, no loop on drawer changes, other attributes kept, control clears them. Extension names never carry the ticket key. Existing test code put in `abtest/<ID>/` stays data.

- **Guard** (with theme kit 1.13.10): text read from a file (`git commit -F`, `gh pr create --body-file`) is scanned for secrets; `gh auth token`, `git credential fill` and `~/.git-credentials` are refused; `gh api` writes to `…/contents/`, `gh repo sync`, `git subtree push` and `send-pack` are refused; `git push -q` is allowed; the Shopify plugin's `search_docs` runs whatever its query says; edits to `core.mjs` and `repo.mjs` ask. New self-tests for the SQLite, fetcher, access-token and `create-app` rules.
- **Playwright's output stays out of git** (with theme kit 1.13.8): the installer adds `.playwright-mcp/` to `.git/info/exclude`, and setup reports a repo that already tracks it.
- **One Jira token file per machine** (with theme kit 1.13.7): setup, the README and `jira.mjs` point to `~/.claude/.env` (once per machine) instead of a `.claude/.env.local` in every repo. The per-repo file still wins, for a repo that needs another Jira account; `JIRA_BASE_URL` stays out of the global file.
- **Shared with theme kit 1.13.1:** the guard checks `findstr /s` globs that reach `.env` files, and no longer blocks `Get-ChildItem env:PATH` or `cat .eslintrc*`. A moved kit clone shows a notice instead of silently ending update notices. On Windows, one repo spelled several ways is one entry in `update.mjs`'s list.
- **The repo moved** (2026-11-17) from `DripDevelopment/Shopify-Claude-Kit` to `github.com/iamshohan/Shopify-Claude-Kit`. A clone of the old repo gets no more updates: run `git remote set-url origin https://github.com/iamshohan/Shopify-Claude-Kit.git` in it.
- **A blocked permission mode names the modes that work** (with theme kit 1.11.3): Shift+Tab to auto (recommended), default or accept edits.
- **Updates** (with theme kit 1.2.0): `node update.mjs` from the kit repo updates every app and theme repo on the machine, and a SessionStart hook (`kit/update-check.mjs`) mentions a newer kit once every 15 days. The installer lists the repo for `update.mjs` and records its clone in the manifest.
- **`app dev` names its app and store** (with theme kit 1.5.0). A bare `shopify app dev` uses the CLI's cached config and store, possibly the production app or another project's store. `shopify.mjs info` now gives the exact command (`appDev`, with `--config` and `--store`), warns when the CLI caches another dev store, and verify tells the dev to run that command.
- **Gate 1 hands the proposal over** instead of asking: the dev reviews and replies in their own words.
- **A fix proves its reproduction** (with theme kit 1.6.0): `gate` and `done propose` run a fix's bound tests on the unfixed code and need at least one to fail on its own (not a missing vitest or file). Otherwise verify's PASS would prove nothing.
- **Fixes** (with theme kit 1.8.0): the fix reproduction check runs only before the first Gate 1, so a fix sent back to propose after it was built can pass again; a Function fixture failing on its missing baseline doesn't count as a reproduction. The run rules no longer say Gate 1 is an AskUserQuestion. The guard's messages no longer name the removed `set` verb or a bare `shopify app dev`; `info` calls the CLI's cached store `cliCachedStore`. Setup asks whether a single `shopify.app.toml` is a development app.
- **A maintenance change needs a test run:** verify fails `regression` when no scenario, ledgered or verify-command test ran.
- **Smaller:** propose says what to do without vitest, declares an extension's real targets rather than the template's, and build commits the generated extension instead of asking about it.
- **Updates** of a repo first installed with `--force` no longer fail. **Cleanup:** removed the unused `secret`/`secretSource`/`parseEnv`, `diagnosticJson`, `activeChanges` and the unused `set` verb.

- **One flow for every change type** (change, fix, maintain, ab): propose → Gate 1 → build → verify → accept (Gate 2) → handoff.
  - `/app-change` starts it; `/app-fix`, `/app-maintain` and `/app-ab` are short entry points to the same flow.
  - `/app-ask` and `/app-drift` are read-only.
- **The proposal** holds:
  - concrete GIVEN/WHEN/THEN scenarios, each bound to a check: a vitest test, a QA measurement on the dev store, or a manual check;
  - the surfaces the change adds;
  - a design section for data models, webhooks, extensions, the app proxy and config;
  - the tasks.

  `app.mjs gate` lists the proposal's problems, then Gate 1 asks everything in one question. Scenario, surface or retired-test changes after Gate 1 are listed at Gate 2. A new extension is generated by the dev first (`! shopify app generate extension`).
- **Verify** checks:
  - **Surfaces:** declared against what the branch changed. A new extension's own API version and dependencies come with it. A surface changed on the base branch outside the kit only warns, and archive records it.
  - **Scenario tests:** each must be new or changed on the branch, or its fixture.
  - **The test ledger,** read from `appspec/archive/`: every archived bound test must still exist and pass, unless a change retires it.
  - **The repo's own checks:**
    - its verify commands;
    - Function fixtures (compared regardless of key order, with the toml's export) and instruction counts;
    - checkout UI bundle size.

    `app build` never installs dependencies or runs a `shopify.web.toml` build that deploys. Extensions are found through `extension_directories`.
  - **`shopify app security check`,** against a findings baseline:
    - New medium, high or unknown-severity findings fail.
    - A check that can't run warns.
    - With no baseline yet, findings in untouched files count as older, and a medium one in a touched file warns.

  QA, results and the code and security reviews are recorded against the app code, so docs, CI or `.gitignore` commits and build output don't make them stale.
- **Handoff** moves the change to `appspec/archive/` and updates `surfaces.json` (one item per line) and the baseline. It writes `handoff.md`: the PR text with QA as measured and the reviews, and a deploy checklist:
  - migration order;
  - hosting, only when the server changed;
  - protected customer data access;
  - deploy with `--config`, and scopes;
  - Function activation and block placement, only for new extensions or targets.

  Re-running a failed handoff is safe.
- **Setup:** `/app-setup` checks the CLI and GitHub branch protection, writes `.claude/app-kit.json`, and creates the Shopify plugin's telemetry opt-out (`app.mjs optout`). `/app-onboard` creates `appspec/` with the current surfaces and the security baseline.
- **Build id:** VERSION plus the installed commit (`-dirty` for an uncommitted checkout), so `cli-check` re-runs after every kit update and feedback names the build.
- **The guard: trust first.** It catches a well-meaning agent's mistakes, not an agent disguising a command on purpose.
  - **Asks** (hard to undo):
    - store mutations, sealed and only on the dev store
    - database migrations
    - the kit's settings
    - writing, moving or removing `.claude/settings*.json`, `~/.claude/settings*.json`, hooks, `.mcp.json` or `.git/`
    - removing or renaming a whole change folder
    - git commands that discard work, and a commit or merge when the branch can't be read
    - a workflow or git hook that deploys, migrates or pushes a protected branch
  - **Refused, with what to do instead:**
    - **CLI and deploys:**
      - the Shopify CLI outside `shopify.mjs`
      - deploy, release, `app env`, `dev clean`, `--store` and `prisma migrate deploy`, including through package scripts in the package a command runs in
    - **Pushes and merges:** pushes other than `git push -u origin <branch>`, tag pushes, merges, a pull of another branch onto main, workflows and releases.
    - **Secrets and databases:**
      - `.env*`, SQLite files and the CLI's login folders
      - printing the environment or one secret by name
      - the Session table (including `db.session`) and `prisma studio`
      - recursive searches over the repo root or `.claude/`
    - **App code:** code edits while a change is at another stage than build.
    - **Kit-written files:** `appspec/archive/` (and deleting it), `surfaces.json`, `security-baseline.json`, and each change's `change.json` and `handoff.md`.
    - **Store writes:** a `mutate` file outside `.claude/logs/<ID>/`, refused before the prompt.
  - **Allowed and logged** (`app.mjs retro`):
    - gate answers and waivers
    - new dependencies
    - CI and hook edits that don't deploy
    - written scripts that call the CLI
    - code edits with no change open
  - **Not refused:** reading or copying kit files, `.env` hygiene, searches for `dotenv` or deploy words, a heredoc of notes, `npm ls`/`view`.
  - **Shared with the theme kit:** the shell reader, push routing and secret rules (`kit/guard-core.mjs`, generated from `shared/`).
  - **Settings:** CLI analytics are off, there's a 10-minute default Bash timeout, and `shopify.mjs --help` is allowed.
- **Jira:** tickets come through the kit's own `kit/jira.mjs` (shared with the theme kit). `/app-setup` asks for `jiraBaseUrl` and checks the credentials in `.claude/.env.local`.
- **Installer:**
  - It ships what git has.
  - It refuses the theme kit's repos and the kit's own repo, and refuses a downgrade or an older build without `--force`.
  - It removes only kit files inside `.claude/`, and doesn't carry a repo's `disableAllHooks` over.
- **Trial so far:** read-only on throwaway clones of BOD-DRIP and asmc-cms with the real CLI 4.9.4 (detect, onboard, drift, the guard on their package scripts, `info`, `security`). The TOML reader matches the CLI's own parse on 11 real config files.
