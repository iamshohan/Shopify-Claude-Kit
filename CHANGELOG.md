# Changelog

## Unreleased

- **The installer no longer overwrites a repo's own `settings.json`, and new kit settings always land.** A repo that had its own `.claude/settings.json` at its first install got no hash in the manifest. Once the dev merged the guard hook in (as the installer told them to), the next update read the file as the kit's and replaced it, dropping their own entries. A repo that kept its own file also never got the kit's new hooks or deny rules without a merge by hand. Now `settings.json` is always the kit's; anything a repo's file has beyond it moves to `settings.local.json`, which Claude Code merges with it (list keys combine, and an allow there doesn't outrank the kit's ask or deny). A hand-merged copy of the guard isn't moved, so it doesn't run twice. `settings.kit.json` is gone.
- **Figma design check, only where it pays.** A feature whose ticket links its Figma design records it at intake (`kit.mjs set <KEY> design.figma=<link>`). At analyze, a new read-only `design-extractor` agent reads the frames' values per viewport into `design.md` (type, colour, size, spacing as rendered distances, and whether a size is fixed or fills its parent), using whatever Figma MCP the dev has. Values that differ from the theme's tokens are asked at Gate 1, the plan turns `design.md` into QA criteria, and QA measures them with the probe within set margins (colour exact, font size ±1px, spacing ±2px). A/B ports and bug fixes skip it, because the winning code is the source; the dev can still ask for a design check at QA. Adapted from shadow-drip-exps' `figma-design-extract` and `style-checker`. e2e: 31 → 32 checks.
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
