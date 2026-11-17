# Changelog

## 1.8.0 — 2026-11-17

From the second review round, and one new command.

- **`node export-logs.mjs`** copies the task logs of every kit repo on the machine (theme and app) into `kit-logs/<date>/`, so whoever improves the kit can read real runs. Text only (no screenshots, theme pulls or A/B code); each run takes only tasks changed since the last; same-named repos get a short tag from their path; exports older than 90 days are deleted. `kit-logs/` is git-ignored.
- **Fixes to recent changes:**
  - The always-loaded run rules (both kits) no longer tell the agent to ask Gate 1 with AskUserQuestion, which undid the 1.5.0 hand-over.
  - `set draft.themeId` to another theme clears the old one's verified and pushed commits and points the preview and editor URLs at the new id (the way out the 1.3.0 branch refusal suggests).
  - The AC coverage check counts only QA criteria and the "Differs" bullet (a mention under "Merchant can change" isn't coverage), asks for numbered ACs instead of passing silently, and reads "AC #4".
  - The design audit compares colours inside any value (borders, shadows), reads `letter-spacing: normal` as `0px`, measures the visible copy when a theme renders a desktop and a mobile one, and keeps a colour's transparency.
- **QA:** a page snapshot after `browser_navigate` means the machine's kit-browser predates 1.7.0: the agent tells the dev once. With a base theme, "live" in QA's checks means that theme.
- **Contract:** `visible_if` references are checked only within their own scope (a block may read `section.settings`).
- **Build:** stages before the review, so new files count toward its size.
- **Updates:** `update.mjs` shows each repo's installer warnings; each kit has its own 15-day notice clock.
- **Setup:** asks for the store once, and reuses the CLI check's result.
- **Smaller:** the kit help lists `design-audit`; stale and repeated instruction lines removed.

## 1.7.1 — 2026-11-17

- **`/shopify-setup` checks the browser's options,** not just that it exists. If `claude mcp get kit-browser` shows no `--snapshot-mode none`, setup has the dev re-add it, so a machine that missed the 1.7.0 note is fixed on its next setup run. Marked temporary in the setup command: remove it once every machine has re-added the browser.

## 1.7.0 — 2026-11-17

Speed, from the review.

- **`kit-browser` no longer returns a page snapshot after every action.** A Shopify product page's snapshot is about 4k tokens (measured), sent after each navigate, resize and click, and QA never read it: roughly 80–120k tokens per QA run. The setup command adds `--snapshot-mode none`; clicks take a CSS selector or a `browser_find` ref. **Re-add it once per machine:** `claude mcp remove kit-browser --scope user`, then the command in `/shopify-setup` step 8.
- **The minute-long CLI check reruns only when it has to:** after a CLI or plugin update, a new Admin API version, or a kit release that changes the CLI contract or the bundled queries. Before, every kit release reran it in every repo.
- **Setup asks for one restart**, covering both a newly installed plugin and the browser.
- **Code review is sized to the change:** `medium` for a diff under about 150 lines that touches no shared file, `high` otherwise (both kits).

## 1.6.0 — 2026-11-17

The second batch from the review: what reaches the gates.

- **Every acceptance criterion is covered or set aside on purpose.** Each QA criterion names the ACs it checks ("AC 2/15"); an AC no row checks goes under At a glance → Differs with why. `done plan` refuses an AC that is in neither. On POP-1150's own logs this flags the targeting ACs (4, 5, 16, 22–24), which had quietly become a merchant step.
- **Differs lists every quiet deviation:** an "Applied as" that does something other than a quoted AC or the winner (POP-1150's preselect rule) belongs there too.
- **The investigation gate shows what the answer rests on** ("4 Confirmed, 2 Inferred") and the evidence-checker's verdict.

## 1.5.0 — 2026-11-17

From a four-way review of both kits, and two things teammates ran into.

- **The store is never taken from the CLI's memory.** A teammate finished work on one store, set up the kit in another repo, and setup recorded the first store, because `auth-check` fell back to the store the CLI was last used with. Now `auth-check` reports it only as `cliLastStore`, a hint. `/shopify-setup` asks the dev for the store, showing that hint next to any store the repo names itself. Every wrapper call already passes `--store` from the config, so a correct config can't be overridden by the CLI's login.
- **Gate 1 hands the plan over instead of asking.** The agent says the plan is ready, gives its path, shows At a glance and what approving covers, and waits. The dev reads it and replies in their own words (approve, change, ask). Only an explicit approval is recorded. The app kit's Gate 1 works the same way.
- **The customizer contract covers theme settings.** `contract.mjs` now lists each `config/settings_schema.json` group the branch changed and checks its settings (defaults, options, ranges, `visible_if`, `t:` keys), like a section's.
- **NOT TESTED and BLOCKED need a reason** in `--measured`, and Gate 2 says "only you can check" (BLOCKED) apart from "not tested by me" (NOT TESTED).
- **Locales follow the plan.** The builder and the build review add keys to the locales § Decided names, not every locale file.
- **Setup:** a missing Shopify plugin no longer sends a new teammate to `/shopify-update`; it's installed in step 7.
- **Updates:** a repo first installed with `--force` updates without it, so `update.mjs` no longer fails on it.
- **Cleanup:** removed unused code (`slug`, `secretSource`), and a stale "Not in v1.0" README section; the QA skill no longer repeats the audit's tolerances.

## 1.4.0 — 2026-11-17

- **Design checks have two modes, and the agent picks.** At analyze, with the recon and extractor reports in hand, the agent records `design.mode` and tells the dev in one line. It never asks; the dev can reply to switch.
  - **exact:** the build must reproduce the design and Figma is its only spec (a new custom component, a landing section, complex UI, or a ticket that says to match Figma).
  - **reference:** the build reuses the theme's own sections, colour schemes and type scale, and Figma shows layout and content. QA checks presence, order, visibility and fill/flex behaviour only.
  - Tasks without a Figma design, A/B ports and bug fixes are unchanged: no design check.
- **Exact mode is audited automatically, every value.** The design-extractor also returns its values as JSON, saved as `design-checks.json`. The plan fills in the classes the build creates (`done plan` refuses an empty selector or a missing audit row). Values the dev moved to a theme token or a setting are checked against that value, in the default state. QA runs `kit.mjs design-audit <KEY> <viewport>`, which writes one file with the audit and that viewport's spec, then runs it in the page: one call checks every property and spacing, with shadow-drip-exps' style-checker tolerances (colours and fonts exact, type ±1px, spacing ±2px, sizes ±5px). This replaces the hand-measured design rows.

## 1.3.0 — 2026-11-17

From a teammate's review of POP-1150: "If the kit recommends something it hasn't tested yet, it should say so clearly when asking for approval, offer a safe backup option, and not finish the task until that part is tested and works." The task's log showed why: the plan rested on two unverified assumptions (the set product's option layout, which the store rate-limited; Restock Rocket for another product), both only in § Risks, which Gate 1 doesn't show. Then the run stopped at the draft stage with its 22 QA criteria unmeasured.

- **"Not proven yet" at Gate 1.** plan.md § At a glance lists everything the plan relies on but couldn't verify, each with why, a fallback the dev could choose, and the QA criterion that tests it, or says "none". `done plan` refuses a row without a fallback or with a criterion that doesn't exist. The approval question names how many there are.
- **Gate 2 won't wave them through.** A "not proven yet" criterion that didn't pass is shown first, with its fallback. The options become: use the fallback (back to build), accept it untested by name, fix, or test more. `done accept` refuses unless the dev's answer names each one.
- **A run that stopped before QA says so.** `kit.mjs list` and `status` show "QA: 0 of 22 criteria measured, so the build is unchecked" between build and QA.
- **A GitHub-connected draft keeps its branch.** `kit.mjs set <KEY> branch=…` refuses while a GitHub-connected draft follows the old branch (POP-1150 switched branches after adopting its draft). To move, connect a theme to the new branch and set `draft.themeId` and `branch` together.
- **A campaign theme on live.** When live is a campaign theme on another branch, `kit.mjs set <KEY> baseTheme=<id>` (the guard asks) names the theme that follows the base branch. The drift check, `pull-live`, the draft copy and QA's regression comparison then use it, instead of flagging every merchant file as a live edit. Intake asks for it instead of stopping.
- **Guard self-test:** the `cd` cases quote their paths, so the self-test passes in a repo under a folder with spaces.

## 1.2.0 — 2026-11-17

- **One command updates every repo on your machine:** `node Shopify-Claude-Kit/update.mjs`. It pulls the kit, then re-runs the installer in each theme and app repo it was installed into, and lists each one as it goes.
  - The installers now keep that list themselves (`.installs.json` in the clone, git-ignored). Repos installed before 1.2.0 join it once with `update.mjs --scan <folder>`; `--list` shows it, `--no-pull` installs the checkout as it is.
  - A repo whose kit is gone drops off the list. A failed pull updates nothing.
- **Update notice.** A new SessionStart hook (`kit/update-check.mjs`, both kits) checks every 15 days whether a newer kit is out, on the clone's remote or already pulled into the clone. If so, it says so once, with the update command. It only informs: it never updates, and it stays quiet for the next 15 days whatever the dev decides. The check is per machine, not per repo, and an offline machine just gets no notice.
- **Manifests name their clone** (`source`), which is how the notice finds it. Repos get it with their next install or update.

## 1.1.2 — 2026-11-17

- **The kit moved** from `DripDevelopment/Shopify-Claude-Kit` to `github.com/iamshohan/Shopify-Claude-Kit` (both kits, one repo). Both READMEs clone from there. A clone of the old `DripDevelopment` repo gets no more updates: run `git remote set-url origin https://github.com/iamshohan/Shopify-Claude-Kit.git` in it, then update as usual.

## 1.1.1 — 2026-11-17

- **The retro is back at the end of a run, only when something went wrong.** When `done handoff` (or `done conclude`) finishes a run that looped back, had a stage exit refused, or hit a guard block, it prints the run's signals and asks which ones the kit caused, to record with `kit.mjs note`. A clean run sees nothing, and the retro never blocks handoff. 1.1.0 had made the retro optional and nothing asked for it, so finished tasks left no judgement of the kit's part; `kit.mjs feedback` collects these notes for the kit maintainer.

## 1.1.0 — 2026-11-17

Shared with the team. Two gates instead of four, a guard that trusts the agent and blocks its mistakes, shared code with the new app kit, and fixes from first use: `/shopify-investigate` runs again, the Admin API login command and the "What you need" list are back in the README, and `cli-check` passes on Shopify CLI 5.

- **"What you need" is back in `.claude/README.md`:** what to get before `/shopify-setup`, including the parts that come from other people (a staff account, someone who can install apps), plus a new optional Figma row. `node test/all.mjs` fails if its `kit-browser` command, plugin install or Claude Code version differs from `/shopify-setup`.
- **`cli-check` passes on Shopify CLI 5.0.1.**
  - CLI 5 moved the `store auth list` session fields behind a `$ref`, so the check reported all four (`store`, `subdomain`, `scopes`, `expiresAt`) as gone. It now follows `$ref`s (in the nested result schema or the top level) and still reads CLI 4's inline shape. The `store execute` error check reads the same way.
  - A field that is really missing is still reported.
  - **A failed run no longer replaces `previous`:** it keeps the last versions that passed, which `/shopify-update` tells devs to pin back to. The app kit's `cli-check` had the same bug.
- **The Admin API login command is back in `.claude/README.md`.** It had been removed in favour of `auth-check`, but the person who installs Shopify's CLI app on the store is often not the dev and doesn't have the kit. The README now has the full command again, says to skip it and hand it on when you can't install apps yet, and what to change once it's installed. `node test/all.mjs` fails if its scopes differ from `shopify.mjs`.
- **`/shopify-investigate` runs again.** The command and the skill behind it were both named `shopify-investigate`. When a skill and a command share a name, Claude Code runs the skill, and this one is agent-only (`user-invocable: false`), so typing the command was refused. The skill is now `shopify-investigation`; updating a theme repo removes the old one. `node test/all.mjs` now fails if any command in either kit shares a skill's name.
- **Simpler pipeline: two gates.**
  - **Stages:** intake, analyze, plan, approve (Gate 1), build, draft, qa, accept (Gate 2), handoff.
  - **Clarify is folded into plan:** the plan stage asks every open question before the plan is written, and `done plan` checks the recorded answers. The small lane (`--small`, `kit.mjs lane`) is gone with it.
  - **Tasks already in flight:** a task at `clarify` resumes at `plan`.
  - **Investigations have two stages,** gather and conclude (the gate). The evidence-checker runs for feasibility checks only. A task at `frame` resumes at `gather`.
  - **Approve re-runs the plan checks,** so "approve with changes" is checked too.
  - **No "run status again":** `done` and `back` already print the next step.
- **Shown instead of refused:**
  - **Plan changes:** `done approve` keeps `plan.approved.md`. `done build` and the accept gate list changed files that plan.md § Files doesn't name, and the plan's changes since approval (read from the task branch, whatever is checked out).
  - **Retro is optional:** handoff and conclude no longer need it, and `note --none` doesn't need one first. `note`, `feedback` and the retro on abandon stay.
  - **Content checks are presence checks:** no minimum lengths, no At a glance limits, no 3-criterion minimum.
  - **`compare.mjs`:** reports a section's HTML difference without setting DIFFERS.
- **One theme check per build pass.**
  - There's no baseline and no second check of the commit.
  - `done build` refuses only errors the branch introduced, including errors that name a file it deleted. It accepts the check only for the theme files it actually checked; after any later change, run `check` again.
  - The diff is read with fixed prefixes, so `diff.noprefix`, `diff.mnemonicPrefix` and non-ASCII names don't hide errors.
  - A crashing theme check is recorded and doesn't block.
- **QA:**
  - **Every criterion measured:** `done qa` wants each numbered plan criterion's report row to show the verdict `qa-row` recorded. It re-asks for a criterion whose plan text changed after it was measured. Each row records a measurement, how it was taken, the commit and the theme. Verdicts typed into the report are refused.
  - **Re-measured after a fix:** a PASS measured before theme files changed is re-measured, or carried with `qa-row <KEY> 2,3 --carry "why"`.
  - **Bug fixes:** need a repro criterion, and its PASS records both live and draft, in either order.
  - **Storefront QA runs in `kit-browser`** (no Chrome fallback). The theme-editor check is one load screenshot per task; per-setting checks are on the dev's by-hand list.
  - **Tasks at qa under an earlier kit:** rows recorded by hand are re-recorded with `qa-row`.
  - **Values that start with dashes:** a value like `--measured "--gap: 16px"` is read as a value.
  - **Probe:** gains `__qa.text()` and the rendered theme in `env()`. `build-probe` writes LF and has `--check`.
- **Live drift:**
  - Merchant JSON that live changed is refused: merge, or `--reconciled`.
  - Other live edits are listed in push output, status and the report.
  - Live that only lags the base branch passes, and `buildOutputs` are left out.
  - On the GitHub route, `verify` doesn't mark the draft verified while drift is refused.
- **`.shopifyignore`:** planned files it excludes are flagged at plan (`reach`, `done plan`). `push --skip-ignored` (with the dev's yes) pushes the rest, and status lists the skipped files for the report.
- **Draft and lifecycle:**
  - **Interrupted drafts:** a draft interrupted mid-copy, or a `theme duplicate` that timed out, is adopted on the next run.
  - **Deleted drafts:** `delete-draft` handles a theme that's already gone.
  - **Status:** shows the task's owner.
  - **QA data:** naming existing products no longer counts as a store write.
  - **Git Bash:** `/…` arguments are restored from `cygpath -m /`, so a Scoop Git works too.
  - **Build id:** VERSION plus the installed commit (`-dirty` for an uncommitted checkout). `cli-check` re-runs after every kit update, and status and feedback show which build a task started with.
- **Settings:**
  - Shopify CLI analytics are off (`SHOPIFY_CLI_NO_ANALYTICS`).
  - Bash calls get a 10-minute default timeout (`BASH_DEFAULT_TIMEOUT_MS`).
  - `shopify.mjs --help` is allowed.
- **Guard: trust first.** It catches a well-meaning agent's mistakes, not an agent disguising a command on purpose. GitHub branch protection and store permissions are the real limits.
  - **Asks** (hard to undo):
    - store writes and draft deletes (sealed: a rejected mutation can't run later)
    - adopting a theme or setting `draft.themeId`
    - reconciled merchant JSON
    - the kit's settings
    - writing, moving or removing `.claude/settings*.json`, `~/.claude/settings*.json`, hooks, `.mcp.json` or `.git/`
    - removing `.claude/logs` or a task's log folder
    - git commands that discard work (`reset --hard`, `clean -f`, `checkout`/`switch -f`, `restore`, `branch -D`/`-M`/`-C`, `update-ref`, `stash drop`)
    - a commit or merge when the guard can't read the branch
    - a workflow or git hook that pushes a protected branch, or publishes or deletes a theme
  - **Refused, with what to do instead:**
    - **The Shopify CLI outside the wrapper,** in its normal spellings:
      - npx, full paths, `env`/`time` prefixes
      - package scripts with their pre/post scripts, `run-s`/`run-p`/`npm-run-all`/`concurrently`, in the package the command runs in
      - plus `--allow-mutations` and direct Admin API calls
    - **Pushes and merges:**
      - pushes other than `git push -u origin <branch>`, including ones the repo's git config would route to another branch (push.default, upstream, refspec)
      - tag pushes, merges, a pull of another branch onto a protected one, `gh workflow run`, and releases or deployments through `gh`
    - **Secrets:**
      - `.env*`, `config.yml`, `.envrc` and dotenv loaders
      - the CLI's login folders
      - printing the environment or one secret by name (`console.log(process.env.JIRA_API_TOKEN)`, `os.environ[…]`, `%VAR%`; `Boolean(…)` is fine)
      - a recursive search or `find -exec grep` over the repo root, `.claude/` or `~/.claude` (unless it excludes `.env*`)
      - `git add -f` of `.`, `.claude` or `.env`
      - a commit with a secret staged
      - `JIRA_*=` on the command line
      - a commit message that runs `$(…)`
    - **Kit-owned files:** writing task state, the seal or the manifest, including from scripts.
  - **Allowed and logged** (`kit.mjs retro` lists them, per task branch):
    - gate answers (the skill asks; no second prompt)
    - `git add -f` of a named file
    - git settings that run a program
    - CI and git-hook edits that don't push or publish
    - written scripts that call the CLI
  - **Not refused:**
    - quoted regexes
    - listings
    - CLI words in grep, echo, git log or PR text
    - a heredoc of notes, even after `cd` or `mkdir`
    - read-only `node -e`
    - reading `state.json`
    - `.env` hygiene (`echo .env >> .gitignore`, `git check-ignore`, `git rm --cached .env`)
    - searching for `dotenv`
    - `npm ls`/`view`
    - library packages like `@shopify/theme-check-node`
    - `.circleci/config.yml` and `.environment.ts`
  - **Faster:** the branch is read from `.git/HEAD`, and git runs only for push and commit (about 80 → 35 ms per call).
  - **Log:** records every decision with its kind, branch and gate, with repo-relative paths. It blanks tokens: Atlassian, Shopify, GitHub, npm, Stripe, Slack, bearer and basic auth, URL credentials.
  - **Monitor and PowerShell** are guarded like Bash. Windows 8.3 short paths can't reach task state or the seal.
  - **Allow-list:**
    - `git push -u origin`, `git pull --no-rebase origin`
    - `git branch --list`/`--show-current`, `git grep`, `git blame`
    - read-only Chrome and kit-browser tools
- **Mutations:**
  - A delete by `identifier` is refused even beside an owned id.
  - `metafieldsDelete` runs only on owners the task created, and never on `ownerId: $variable`.
  - Ids are read with string escapes and JSON variables decoded, and `query` reads comments and strings the way the mutation check does.
  - `mutate` runs the exact checked bytes from a private copy.
  - The CLI runs without inherited `SHOPIFY_FLAG_*` variables.
  - `protectedBranches` given as a string protects that branch.
- **Removed:**
  - From state: `tickets`, `qa.products`, `abtest.variation`/`path` (they're in brief.md).
  - Flags, verbs and rules: `qa-row --viewport/--expected`, kept earlier measurements, `done --note`, the `themes` verb, the "(Recommended)" and "(A1:)" rules, the pre-0.2.0 draft-name exception.
  - From the instructions: the command's stage table and the per-step timeout lines.
- **Jira:** `jira.mjs` is shared with the app kit. A Jira URL from the shell environment must be on atlassian.net (only `.env.local` or `~/.claude/.env` can name another host), and redirects aren't followed with the token.
- **Installers:**
  - They ship the files git has and warn about uncommitted ones.
  - They refuse the kit's own repo, and a downgrade without `--force`. With VERSION unchanged, the build is the commit: an install recorded from a commit this checkout doesn't include is refused too.
  - They remove only kit files a manifest names inside `.claude/`.
  - They don't carry a repo's `disableAllHooks` into `settings.local.json`.
- **`install.mjs --app` installs the app kit**, which lives in `app/` with its own installer, tests, VERSION and CHANGELOG. Without `--app` nothing changes. The two kits refuse to install over each other.
- **Maintenance:**
  - `node test/all.mjs` runs both kits' suites side by side (about a minute) and checks the built probe.
  - Code both kits share lives in `shared/`.
  - Tests:
    - guard self-tests 219 → 449
    - kit self-test 44 → 46
    - e2e 36 → 78

## 1.0.0 — 2026-10-30

The first version presented to the team as ready for use: `/shopify-implement`, `/shopify-investigate` and `/shopify-feasibility` on live theme repos, with the 0.x history below.

- **`/shopify-feasibility <KEY>`: a feasibility check and estimate before a ticket is picked up.** It's the `/shopify-investigate` flow with the type set to feasibility, under the name devs look for. A feasibility check now also lists each requirement in § Requirements and asks the dev the unclear ones in the frame stage, names the limitations, gives 2–3 approaches with the recommended one first, and ends with § Estimate: a size band (S, M or L, defined in the skill by files, templates and store setup), what drives it, what could move it up a size, and the confidence. No hours: the drivers let the dev put a number on it. `done frame` and `done conclude` refuse without those sections, for feasibility only. If `/shopify-implement` follows, intake copies the requirement answers into § Decided, so clarify doesn't ask them again. e2e: 33 → 36 checks.
- **A task can no longer pick up a teammate's draft by a longer key.** Draft lookups matched the key anywhere in a theme's name, so `ABC-12` matched a teammate's "ABC-123 hero" and could adopt it, push to it or delete it. The key now has to appear as a whole word (`namesKey` in lib.mjs). The guard also asks before taking over an existing theme (`draft --adopt`, `draft --github --theme N`, `kit.mjs set <KEY> draft.themeId=N`), which the build skill already required in words. Guard self-tests: 213 → 219.
- **The installer no longer overwrites a repo's own `settings.json`, and new kit settings always land.** A repo that had its own `.claude/settings.json` at its first install got no hash in the manifest. Once the dev merged the guard hook in (as the installer told them to), the next update read the file as the kit's and replaced it, dropping their own entries. A repo that kept its own file also never got the kit's new hooks or deny rules without a merge by hand. Now `settings.json` is always the kit's; anything a repo's file has beyond it moves to `settings.local.json`, which Claude Code merges with it (list keys combine, and an allow there doesn't outrank the kit's ask or deny). A hand-merged copy of the guard isn't moved, so it doesn't run twice. `settings.kit.json` is gone.
- **Figma design check, only where it pays.** A feature whose ticket links its Figma design records it at intake (`kit.mjs set <KEY> design.figma=<link>`). At analyze, a new read-only `design-extractor` agent reads the frames' values per viewport into `design.md` (type, colour, size, spacing as rendered distances, and whether a size is fixed or fills its parent), using whatever Figma MCP the dev has. Values that differ from the theme's tokens are asked at Gate 1, the plan turns `design.md` into QA criteria, and QA measures them with the probe within set margins (colour exact, font size ±1px, spacing ±2px). A/B ports and bug fixes skip it, because the winning code is the source; the dev can still ask for a design check at QA. Adapted from shadow-drip-exps' `figma-design-extract` and `style-checker`. e2e: 31 → 32 checks.
- **A rejected mutation can't run later.** The guard writes the seal when it shows the prompt and can't see the dev's answer, so after a No the seal stayed valid for 15 minutes, and a helper script could have used it. Every guarded call now clears outstanding seals first: the approved `mutate` or `delete-draft` runs as the very next command, and anything in between voids it.
- **Live-theme commands are blocked however they're spelled.** `$(which shopify) theme publish`, `S=shopify; $S theme publish`, `shop""ify theme publish` and a Python `subprocess.run(['shopify','theme','publish'])` all passed the guard. It now joins empty quote pairs before scanning, and denies `theme publish|push|delete` and `--allow-live` whatever program runs them (not `--live`, which the read-only `fetch` uses). Guard self-tests: 206 → 213.
- **Store writes only ever delete what the task created.** `metaobjectUpsert` is no longer allowed (no skill used it; an upsert that hit a merchant's entry recorded that entry as the task's), and `mutate` records only the ids each response created, not nested references or owners. The README now says that setting or deleting a metafield value can change a merchant's existing value, and that nothing on Shopify's side stops a publish made with the dev's login.
- **Installer:** a first install keeps a copy of a `.claude/CLAUDE.md` or `README.md` the repo already had (`<file>.pre-kit`); an unreadable `.kit-manifest.json` warns instead of crashing; only `.claude/logs/` is skipped, not every folder named `logs`. e2e: 27 → 31 checks.

## 0.6.0 — 2026-10-28

- **`/implement` is now `/shopify-implement`**, like `/shopify-investigate`, `/shopify-setup` and `/shopify-update`. Updating a theme repo removes the old command file. Tasks already in progress resume with `/shopify-implement <KEY>`, because the task state keeps its internal kind (`implement`).
- **The guard no longer lets a mention of `kit.mjs` unlock a `state.json` write.** Any command that named `.claude/kit/kit.mjs`, even in a comment (`echo … > .claude/logs/<KEY>/state.json # .claude/kit/kit.mjs`), skipped the state-file check. Real `kit.mjs` calls were already out of the scanned text, so the exemption is gone. Guard self-tests: 203 → 206.
- **`__qa.css()` keeps transparency.** `rgba(0,0,0,0.5)` was reported as `#000000`, so a 50% overlay could pass a criterion for opaque black, and an alpha of `0.0` didn't count as transparent. Alpha below 1 is now a fourth byte (`#00000080`); opaque colours are still `#rrggbb`.
- **Readable code.** Each script opens with what it does, how to run it and what it reads and writes, and the long ones are split into `// ── Section ──` blocks. Comments only; no behaviour changed.
- **README:** a permission mode that hides prompts blocks only the steps that would ask you; read-only work still runs, and `/shopify-implement` stops at plan approval. Only the approve gate asks, not every gate answer.

## 0.5.0 — 2026-10-24

- **The kit measures a branch from where it meets the base branch now, not from where it started.** Before, `push` refused "Live has changed …", the dev merged `origin/<base>` as told, and `push` refused again, forever: it kept comparing live with the copy at the task's first base commit. The same fixed base made `push` upload teammates' merged files, `check` count their offenses as introduced, and `contract` list their sections; the "merge base" in `check` and `contract` was always the starting commit. `push`, `verify`, `check`, `contract` and `done build` now use `git merge-base HEAD origin/<baseBranch>`, and `push` also sends files a merge resolution changed.
- **`push|verify <KEY> --reconciled <files>`** for repos where live edits never reach git: the dev copies them into the branch and confirms; the guard asks. It pins the live version the dev confirmed, so a later live edit is flagged again.
- **Small lane.** `/implement <KEY> --small` (or `kit.mjs lane <KEY> small` before the plan is approved) skips the separate clarify gate: questions are asked at the start of the plan stage, and the approve gate is the only one before QA. `done plan` refuses the lane for A/B ports, tickets with editability lines, store writes, merchant-owned JSON or more than 3 files, and names `kit.mjs lane <KEY> full`, which reopens clarify. CHE-802's editability rule stays intact: a ticket that says who may change what always gets Gate 1.
- **Storefront QA in an isolated browser.** `kit-browser` is a pinned Playwright MCP server (`--isolated --headless`) that `/shopify-setup` adds once per machine. It sets exact viewports itself, so the dev no longer switches Chrome's device toolbar, and its clicks are real pointer clicks. `kit.mjs build-probe` also writes `probe.init.js`: run once per session, it loads the probe on every page before the page's own scripts, so `errors()` and `shift()` cover the load. Chrome stays for the theme editor and the admin, and is the fallback without `kit-browser`. A dev's own Playwright server isn't used, because it may drive their logged-in Chrome (`--extension`).
- **Offline end-to-end test:** `node test/e2e.mjs` installs the kit into a temporary theme repo with a fake `shopify` CLI and runs draft → push → live drift → merge → push → check → contract → reconcile → mutate through the real scripts and guard (25 checks). Against 0.4.0 it fails 11, starting with the drift loop above. It lives outside `.claude/`, so theme repos don't get it.
- **Maintainer mode.** In the kit's master repo (install.mjs present, no install manifest), the guard lets kit files be edited without a prompt; `hooks/` and `settings.json` still ask. A `cd` or `git -C` into another repository no longer counts as committing on this repo's protected branch.
- **Cleanup.** About 40 lines of instructions that repeated another loaded file, or a script's own refusal message, are gone (the retro steps, most draft and push refusal handling, restated rules). A stale "kit v0.1" and the hard-coded `--version 2026-07` (now `adminApiVersion` from the config) are fixed. Safeguards that cost more than they caught are removed:
  - the 15-word and 260-character checks on At a glance (the 25-line limit stays)
  - the report.md title check
  - the pre-0.3 brief.md migration
  - the 3-row minimum in an investigation's evidence (at least one Confirmed row stays)
  - the builder's second check of Gate 2
  - the guard's ask on fetches from other remotes (`--upload-pack`/`--exec` still ask)
  - the guard's lookup of renamed test-run branches (the `-kit-test` suffix rule stays)
  
  The merchant-JSON prompt now skips files the approved plan of the checked-out task names.
- **Shared run rules in one place.** Gates, `--answer`, how to talk to the dev, two failed attempts and kit notes were written into both commands, and had started to drift apart. They're now `.claude/rules/kit-runs.md`, a path-scoped rule (`.claude/logs/**`): it loads in kit runs and not in other chats in the theme repo, and loads again after a compaction the next time a task file is touched. The commands keep only their start-up steps and their own rules.
- **Smaller.** The merchant-JSON pattern in `lib.mjs` is case-insensitive, like the guard's, and the guard imports it and the protected-branch list from there. Guard self-tests: 142 → 156.

## 0.4.0 — 2026-10-23

- **Plans open with what needs your attention.** Most of a plan is new code that only the feature uses. What the dev has to weigh at Gate 2 is where the change can affect what already exists, so At a glance now starts with **Needs your attention**: at most 6 points, most impact first, each saying what's touched, what could go wrong and how the plan contains it. It covers store writes, merchant-owned JSON, shared code, changed behaviour and apps. It replaces the "Store writes" and "Risks to know" lines. The file table follows, with those files first.
- **`kit.mjs reach <KEY>`** lists the files in plan.md § Files that reach beyond the feature: merchant-owned JSON, the layout, theme settings, and snippets, sections and assets used elsewhere, each with how far it reaches. `done plan` refuses until each one, and any store write, is named in Needs your attention. On cherries it flags `snippets/icon.liquid` ("rendered from 62 files"), the file CHE-802's draft left stale.

- **Test runs.** `/implement <KEY> --test` (`kit.mjs start <KEY> --test`) runs every stage on a real ticket without touching the real work.
  - The branch and the draft theme are named `<KEY>-kit-test`.
  - The guard blocks pushing any `*-kit-test` branch, or any branch a test task recorded.
  - The draft is always a CLI copy of live, because the GitHub route needs a push.
  - Handoff skips the push and marks the PR text "TEST RUN, not for merge".
  - A real task and a test run of the same key can't share a logs folder.

## 0.3.1 — 2026-10-23

Security hardening from a review of the kit's controls (findings F1, F3, F4, F6, F7, F8). Each item was reproduced first, and each fix has guard self-test cases (99 → 139).

- **Mutations: only the kit's own, and only what the dev saw.**
  - The wrapper runs only definition creates, `metafieldsSet`, metaobject entry creates, and the cleanup deletes. A delete must name an id this task created. One operation per file, no fragments, and aliases are checked by their real name. `productDelete` and everything else are refused.
  - The guard parses a `mutate`/`delete-draft` command with the wrapper's own argument parser. Before, `x--dry-run.graphql` or `--dry-run-x` skipped the prompt, a second `.graphql` argument changed which file the prompt showed, and `node .claude/kit/./shopify.mjs` or `cd .claude/kit && node shopify.mjs` weren't recognised.
  - The guard records a fingerprint of what it showed, in `.claude/logs/<KEY>/guard-seal.json`. The wrapper runs only a matching file, once, within 15 minutes. A file swapped after the prompt (`cp x.graphql ok.graphql && …mutate`) or a call the guard never saw is refused. `mutate` must run on its own, and the prompt shows the whole file instead of the first 1,500 characters.
- **Data can't leave through allow-listed git.** The allow rules cover only `git fetch origin` and `git ls-remote --heads origin`. The guard asks for other remotes or URLs, `--upload-pack`, and `git -c`.
- **The Jira token goes only to Atlassian.** A `jiraBaseUrl` from `shopify-kit.json` must be https on `atlassian.net`; any other host must come from the dev's own `.env.local`.
- **`shopify-kit.json` asks before it changes**, and the prompt names each setting and what it controls (store, protected branches, Jira URL…). `/shopify-setup` now checks that the base branch, and any branch a published theme is connected to, are protected on GitHub.
- **Credential stores outside the repo** are denied: the Shopify CLI's `shopify-cli-*` folders (Windows, macOS, Linux paths) and `~/.claude/.env`.
- **A failing guard blocks the call** (`onFailure: "block"`, Claude Code 2.1.295+), and unreadable hook input is blocked rather than allowed. A lone `&` now separates commands, so a chained call can't hide behind it.
- **What stays as it was, documented.** The agent's Chrome stays logged in as the dev (README → Safety rails → Browser states what that allows). The Admin login keeps asking for both commands' scopes at once, so a client approves the CLI app once per store. Investigations read how discounts are set up, never the codes.
- **The team guide is about a third shorter** (3,240 → 2,000 words). It now spells out the full Admin API login command, with every scope, for the person who installs the CLI app. The section on how the kit uses Shopify's tools is gone; `shopify.mjs --help` covers it.
- **Smaller fixes.**
  - Values passed to the CLI's `--only` must be theme paths.
  - The CLI is never started from a `shopify.cmd` in the repo root.
  - `shopify.mjs fetch` and `verify` are on the allow list; they prompted on every call before.

## 0.3.0 — 2026-10-20

From the first real ticket (CHE-802) and a developer-experience review of its logs.

- **Hard-coded values can't slip through Gate 1.** CHE-802's ticket said the client manages the mobile menu without a developer, yet the utility icons were planned as code: intake narrowed the editability line to the categories, and Gate 1 showed "icons in code" as one row among twelve, under a confirm question marked "(Recommended)".
  - Intake quotes every editability line in full, in a table. A line covers everything visible in what it names.
  - `brief.md` § Control surface is split into "Merchant can change" and "Stays in code". A value in code that touches an editability AC must cite the separate question in which the dev agreed (Q#); `kit.mjs done clarify` refuses otherwise.
  - The confirm question names every value that stays in code and is never marked "(Recommended)". Answers are stored verbatim, with "Applied as" kept apart.
- **Plans read in two tiers.** `plan.md` opens with At a glance (at most 25 lines; "what happens" at most 15 words per file), listing what stays in code, deviations from the ticket, store writes and risks. The builder detail follows. `kit.mjs done plan` enforces the limits. Gate 2 shows only At a glance and what changed since Gate 1. Amendments mark the At a glance line they change.
- **Reports start with "You must still do"**: every BLOCKED or NOT TESTED row as a step for the dev. QA refuses to finish without it, and checks that the report's title line is intact.
- **Chat rules** in /implement and /shopify-investigate: lead with what needs the dev, at most 6 lines between gates, never repeat documents or answered questions, and no "(Recommended)" on approving your own work.
- **Kit feedback.** `kit.mjs note` records problems with the kit itself in `.claude/logs/<KEY>/kit-notes.md` (created only on the first note). `kit.mjs retro` lists what the record shows (loops back, refused stage exits, guard blocks, open QA rows), and handoff and conclude refuse to finish without a retro. `kit.mjs feedback` collects all tasks into `.claude/logs/kit-feedback.md` for the kit maintainer. The guard logs its blocks, and `done` logs its refusals, for the retro.
- **GitHub-connected drafts** (`draftRoute: "github"`). The dev connects the task branch in the admin (Add theme → Connect from GitHub; Shopify offers no CLI or API for it), and `shopify.mjs draft <KEY> --github` adopts it. Updates go through `git push`, and `verify` waits for the sync.
- **A teammate's draft is never adopted silently.** `draft` refuses an existing unpublished theme named `<KEY>` unless the dev confirms with `--adopt`; pushing into it would overwrite their work.
- **The draft is proven, not assumed.**
  - `push` uploads every file any branch commit touched, so a file reverted to its base content no longer keeps an earlier push's version. On CHE-802, `snippets/icon.liquid` stayed on the draft with six removed icons.
  - It then reads the files back and refuses if any differ.
  - `verify <KEY>` does the same check on its own.
- **`shopify.mjs fetch <KEY> <path> [--find T] [--live]`** fetches one storefront page with the preview cookie and checks `Shopify.theme`. The guard blocks `curl`/`wget`/`Invoke-WebRequest` with `?preview_theme_id`, which is served the live theme without an error: on CHE-802 that looked like a broken draft and cost two pushes and a trip to the editor.
- **`kit.mjs qa-row`** fills one row of report.md § Criteria, replacing hand-edited tables and heredocs.
- **QA**
  - Viewports are asked for once, up front, as Chrome device-toolbar presets.
  - Clicks that time out in device-toolbar mode go through `element.click()`.
  - "Measured" and "How" stay short.
  - Preview overrides on section groups (`header-group.json`) are documented.
- **A/B ports.**
  - A copy of the A/B code found locally is offered as the default.
  - Intake asks for the tool's force-variant link (geo-targeted tests are invisible from outside their markets) and whether the tool excludes draft previews.
- **Smaller fixes.**
  - Build matches existing local branches case-insensitively, not only remote ones.
  - Code-review findings that restate a Gate 1 decision or a winner value are listed once as intentional.

## 0.2.0 — 2026-10-20

- `/shopify-investigate <KEY or question>`: read-only feasibility checks, debugging and questions, in three stages (frame, gather, conclude) with a dev gate at the end.
  - Every claim is labelled Confirmed, Inferred, Assumed or Unknown, with a source.
  - Debugging needs a reproduction and at least two hypotheses.
  - The new `evidence-checker` agent re-checks Confirmed claims before the dev sees the answer.
  - Read-only is enforced: the wrapper refuses its write verbs for investigations, and `conclude` refuses if theme files changed.
  - A finished investigation continues as `/implement` on the same key, and intake reads it.
- `shopify.mjs query <name>`: kit queries for product, collection, metaobjects, menus, markets and locales, alongside shop and definitions, all validated against 2026-07. `shop` now includes the plan.
- The Admin login requests read scopes for investigations (navigation, markets, locales, translations, content, discounts, files, publications). `auth-check` reports them separately as `investigateScopesFix`.
- `cli-check` validates every kit query, not only definitions, and reports deprecated fields.
- Draft themes are named after the key alone (`ABC-123`), not `kit/<KEY>/<git user>`, which collided when devs share a git name. An existing unpublished theme with that name is adopted but treated as not made by the kit, so the kit never offers to delete it on its own. Old `kit/<KEY>/…` drafts still work.
- The build stage creates the task branch with `--no-track`, so it doesn't track the base branch.
- Fixes from the first store rehearsal (cherries, CLI 4.9.4):
  - `preview` failed on Windows: `theme preview --overrides` drops a path's backslashes, so the wrapper now passes every path with forward slashes.
  - `theme preview --json` prints its result to stderr, wrapped in a diagnostic event; the wrapper reads it from there.
  - CLI errors hid behind the `<claude-code-hint>` tag that Claude Code hides. The wrapper now drops that tag, and falls back to the exit code and raw output when there's no structured error.
  - QA: `Shopify.theme.id` is read only after load, and the editor wait is up to 60 s.
  - `compare.mjs --help` works.
- The Admin API login is optional (`adminApi` in `shopify-kit.json`). It installs Shopify's CLI app once per store, which many devs aren't allowed to do. Without it:
  - definitions and QA values become admin steps for the dev, checked in Chrome
  - investigations read admin pages and public storefront data
  - `query` and `mutate` refuse with that explanation

## 0.1.0 — 2026-10-20

First version, before the pilot.

- `/implement <KEY>`: ten stages with three human gates (clarify, approve, accept), resumable through `kit.mjs` state and exit checks. One command handles A/B ports, features and bug fixes.
- `/shopify-setup`: proves the guard is live, checks the CLI and plugin, logins and scopes, and writes `shopify-kit.json`.
- `/shopify-update`: re-verifies every Shopify CLI command, flag and output field the kit uses (`shopify.mjs cli-check`) after a CLI or plugin update.
- Shopify CLI only through `kit/shopify.mjs`:
  - drafts are copies of the live theme named `kit/<KEY>/<dev>`
  - pushes upload only changed files and include a live-JSON drift check
  - virtual previews for settings
  - theme check reports only offenses the branch introduced
  - read and mutate Admin GraphQL, pinned to API 2026-07
- Guard hook (`hooks/guard.mjs`, 93 self-test cases): blocks direct CLI and Theme Kit use, pushes and commits to protected branches, credential and state access. It asks before store mutations, draft deletion, discarding git commands, and edits to merchant JSON and kit files.
- Customizer QA: `contract.mjs` checks what the merchant will see, from the schemas; the editor is checked by screenshots via deep links; plus a hand-check list for the dev.
- Task logs per ticket: `brief.md`, `plan.md`, `report.md`, `contract.md`, `state.json`; `kit.mjs summary` gives the numbers for the PR and for reporting.
- Reviewed before release by six reviewers (project manager, automation-engineer accuracy, scalability, Claude-setup effectiveness, Shopify CLI/plugin use, customizer QA), and their findings were fixed.
