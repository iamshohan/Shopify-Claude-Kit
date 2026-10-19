# Shopify Implementation Kit · v0.2.0

A Claude Code setup for Shopify theme repos. Give it a Jira ticket and it takes the work to a QA'd draft theme:

1. it reads the ticket and the current code
2. every open decision goes to you
3. it writes a file-by-file plan for your approval
4. it builds the code and pushes it to an unpublished copy of the live theme
5. it checks the draft with measured values

It handles winning A/B tests (implementation ticket + A/B ticket + the test's code), normal features, and bug fixes, for tickets that change theme code.

`/shopify-investigate` covers the work before or instead of a change. It's read-only and ends in an answer backed by evidence:
- feasibility checks ("can we build X, and how?")
- debugging the storefront, theme, menus, markets, metafields, or an app's storefront output
- questions about how something works

It never publishes a theme, never writes to the live theme, and never pushes or merges into the base branch. Merging stays with you.

## What you need

| Need | Check | Get it |
| --- | --- | --- |
| Claude Code, recent enough for exec-form hooks | `/shopify-setup` step 1 proves the guard is live | update Claude Code |
| Node 20+ and git | `node --version` | nodejs.org |
| Shopify CLI with `theme duplicate`, `theme preview`, `store execute` | `/shopify-setup` → auth-check `cliCommands` | `npm i -g @shopify/cli@latest` |
| A staff account on the store: themes, plus managing metafields and metaobjects | — | the store owner |
| Shopify plugin for Claude Code, installed by each person (listing it in settings doesn't install it) | `/plugin` → installed | `claude plugin install shopify-ai-toolkit@claude-plugins-official` |
| Claude in Chrome, logged into the store admin, with site access to the storefront and `admin.shopify.com` | browser tools available in Claude Code | the Claude in Chrome extension |
| A Jira API token | `node .claude/kit/jira.mjs --check` | id.atlassian.com → Security → API tokens |
| For A/B ports: the test's code (e.g. a shadow-drip-exps checkout) | — | — |

## Install into a theme repo

1. **Install with the installer, not by copying.** Clone the kit repo once, then run it against the theme repo:
   ```
   git clone https://github.com/DripDevelopment/Shopify-Claude-Kit.git
   node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>
   ```
   - It writes `.claude/.gitignore`, which keeps the whole folder, including your credentials file, out of the theme repo's git. A hand copy misses this.
   - It leaves the repo's own `.claude/` files alone.
   - If the repo has its own `.claude/settings.json`, the installer writes the kit's version beside it as `settings.kit.json`; merge its `hooks`, `permissions` and `env` into yours.
2. Open Claude Code in the repo, trust the folder, and run **`/shopify-setup`**. It:
   - proves the guard blocks a direct CLI call
   - checks that `.claude/.env.local` is git-ignored, before you put a token in it
   - checks your logins and scopes
   - reads the repo
   - writes `.claude/shopify-kit.json` after you confirm the values (store, Jira URL, base branch, protected branches, branch and commit patterns, Admin API version)
   - creates the Shopify plugin's telemetry opt-out file
3. When setup says so, create `.claude/.env.local`. It's yours only: git ignores it, and Claude is denied from reading it.
   ```
   JIRA_USER=you@company.com
   JIRA_API_TOKEN=...
   ```

**Protect the base branch on GitHub** (require PRs). In repos where a merge deploys to the live theme, the guard is a seatbelt, not the boundary.

## Use

```
/implement ABC-123          start or continue a ticket
/implement ABC-123 qa       jump to a stage whose earlier stages are done (e.g. re-run QA after you fixed something)
/implement                  list tasks in this repo
```

### Investigations

```
/shopify-investigate ABC-123                         investigate a ticket
/shopify-investigate why do German menus link to English pages?   a question without a ticket (key INV-…)
```

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | frame | Reads the ticket, picks the type (feasibility, debug, question), and writes the question precisely, with what counts as answered. | answer if it asks |
| 2 | gather | Theme code and git history, live files, store data through read-only Admin queries (products, collections, metafields, metaobjects, menus, markets, languages), Shopify's docs, and the live storefront in Chrome. Every claim is labelled Confirmed, Inferred, Assumed or Unknown, with its source. Bugs are reproduced first and need at least two hypotheses. | resize the window if asked |
| 3 | conclude | Writes the answer, what it couldn't determine, the next step and a Jira comment. A separate agent re-checks every Confirmed claim and looks for a better explanation. | **Gate:** accept, dig further, or "wrong question" |

- Nothing changes: the wrapper refuses draft, push, preview and mutate for investigations, and `conclude` refuses if theme files changed.
- If the answer is a theme fix, run `/implement` on the same key. The investigation becomes its starting context.

### Implementations

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | intake | Reads the ticket and linked tickets and decides: A/B port, feature or bug fix. For A/B ports it asks which variation won, where the code is, and which tool runs the test. | answer; drop the A/B code in `.claude/logs/<KEY>/abtest/` |
| 2 | analyze | Two agents in parallel. One reads the theme fresh: render path, closest existing pattern, constraints. The other turns the A/B code into a behaviour inventory. | — |
| 3 | clarify | Decides what merchants control and where (metafield, metaobject, section/block setting, theme setting, locale key, code), then asks every open question at once. | **Gate 1:** answer |
| 4 | plan | Writes the file-by-file plan, the store setup (validated mutations) and the QA criteria. | — |
| 5 | approve | Shows the plan. | **Gate 2:** approve, change or reject |
| 6 | build | Branches from a fresh base. The builder agent implements; `/code-review` plus a Shopify checklist reviews; then it commits. | — |
| 7 | draft | Creates the planned definitions (you approve each mutation), copies the live theme to `kit/<KEY>/<you>`, and pushes the branch's changed files to it. | approve mutations |
| 8 | qa | Measures every criterion on the draft: the storefront in Chrome, settings via virtual previews, the customizer contract from the schemas plus editor screenshots, and regression against live. | resize the window if asked; do the "by hand" checks |
| 9 | accept | Shows the result. Failures go back to the builder. | **Gate 3:** accept or send back |
| 10 | handoff | Pushes the branch and writes the PR text (with a run summary), admin steps, go-live order and a Jira comment for you to post. | create the PR, merge, go live |

Everything for a task is in `.claude/logs/<KEY>/`:

| File | Holds |
| --- | --- |
| `brief.md` | Why: what was asked (quoted), what the code looks like (stamped with the commit it was read at), what was decided and by whom. |
| `plan.md` | What and how: the approved plan, amendments, and "as built". |
| `report.md` | Proof and handoff: QA criteria with measured values and verdicts, PR text, admin steps, Jira comment. |
| `contract.md` | What the merchant will see in the customizer, generated from the schemas. |
| `investigation.md` | Investigations only: the question, answer, labelled evidence, hypotheses, reproduction, review and next step. |
| `state.json` | Machine state, so a run can resume. Managed by `kit.mjs`; don't edit it by hand. |

The logs are history, not a knowledge base. Every new task reads the code fresh, because code changes and stored descriptions of it go stale.

### How it fits the team's workflow

- **The QA team** reviews in Jira's review status, using `report.md` § Criteria as the script. The dev moves the ticket there (in Drip's Jira usually "AC Review"), not to Done, which can start billing automation.
- **Client or AC feedback** after handoff: run `/implement <KEY>`, then `kit.mjs back <KEY> build --reason "…"`. Keep the draft until review ends.
- **Scope changes midway:** go `back` to the stage they affect. The plan records them under Amendments.
- **Another dev takes over:** copy `.claude/logs/<KEY>/` to their machine. Their draft will be their own `kit/<KEY>/<name>` copy.
- **Dropping a task:** `kit.mjs abandon <KEY> --reason "…"` lists the draft theme and store data left to clean up.
- **Numbers for reporting:** `kit.mjs summary <KEY>` gives the time per stage, loops, gate answers, QA verdicts and store changes. Handoff puts it in the PR.

Expect roughly 1.5–3 hours of wall time per A/B port, about half of it QA. That's an estimate from the review; the pilot will measure it.

## Safety rails

| Rail | How |
| --- | --- |
| Shopify CLI only through one wrapper | `.claude/kit/shopify.mjs` builds every command itself and only writes to the task's own unpublished `kit/<KEY>/…` theme. A draft you made yourself must have the key in its name. The wrapper has no publish, live or delete-other command. The guard hook denies direct `shopify`, `npx @shopify/cli`, `SHOPIFY_FLAG_*` and Theme Kit calls, including inside npm scripts and `bash -c`/`cmd /c` wrappers. |
| Store changes | Every `mutate` and `delete-draft`, and any wrapper verb that isn't on the read-only list, shows you the exact GraphQL and variables (or theme name and id) and waits for your approval. |
| Git | Pushes go only as `git push -u origin <task-branch>` with a literal name: no force, delete, `HEAD:main`, variables, or pushes to protected branches. No commits or merges on protected branches, even after `git switch main && …`. Commands that discard work (`reset --hard`, `clean -f`, `checkout <file>`, …) ask first. |
| Files | `state.json` changes only through `kit.mjs`. Credential files (`.env*`, `.claude/.env.local`, Theme Kit `config.yml`) are never read or written, including through the shell. Merchant-owned JSON (`templates/*.json`, section groups, `settings_data.json`) and the kit's own files ask first. |
| The real boundary | Hooks are a seatbelt. Branch protection on GitHub and staff permissions on the store are the limits that hold. |

## How the kit uses Shopify's tools

**Shopify CLI** (through the wrapper):

| Command | Used for |
| --- | --- |
| `theme list` | finding the live theme and the drafts |
| `theme duplicate` | creating the draft as a copy of live; waits while it's processing |
| `theme push --only` | uploading just the changed files; fails if Shopify rejects any |
| `theme pull --live --only` | drift checks, and templates that exist only in the admin |
| `theme preview --overrides` | settings combinations without touching files; reuses the preview id |
| `theme check` | reporting only offenses the branch introduced |
| `theme delete` | removing your draft, with approval |
| `store auth list` | the granted scopes |
| `store execute --version 2026-07` | Admin GraphQL: reading definitions and, for investigations, products, collections, metaobjects, menus, markets and languages (`shopify.mjs query <name>`); creating definitions and QA values, with approval |

**Shopify plugin** (`shopify-plugin:shopify` skill):
- Fresh docs (`search_docs`) for every Liquid object, filter, tag and schema setting the theme doesn't already use.
- Validation of every GraphQL operation, which also reports the access scopes it needs.
- Its Liquid validator needs packages the plugin doesn't ship, so Liquid is checked with `theme check` instead.
- The kit sets `OPT_OUT_INSTRUMENTATION` and `DO_NOT_TRACK` and creates the opt-out file, because by default the plugin reports prompts and code to shopify.dev.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/shopify-setup` says the guard didn't block `shopify version` | Update Claude Code and trust the folder. Don't use the kit until it's blocked. |
| "Theme login missing or expired" | `! shopify theme list --store <store>` |
| "Admin API login missing or lacks scopes" | `shopify store auth --store <store> --scopes <the scopes it lists>` (in Claude Code, prefix it with `!`) |
| An investigation stops at "access denied" for a query | The login lacks a read scope. `shopify.mjs auth-check` prints the command as `investigateScopesFix`. |
| "No Jira credentials" | Create `.claude/.env.local` (see Install), or paste the ticket text. |
| "The theme library is full" | Remove old drafts: `kit/…` ones via `shopify.mjs delete-draft <KEY>`, others in the admin. Basic, Grow and Advanced plans allow 20 themes; Plus allows 100. |
| push refuses: "Live has changed … since this branch's base" | Merge `origin/<base>` into the task branch, resolve, commit, push again. |
| push refuses: "Shopify rejected files" | Fix the file it names (often a Liquid error), commit, push again. |
| A `done` is refused | It lists what the stage is missing. Finish that and run it again. |
| The guard blocks a harmless command that mentions "shopify" | Use the Grep tool for text searches, or rephrase. |
| You need a CLI command the wrapper doesn't have | Run it yourself with `!`. The guard only watches Claude's commands. |

## Updating the kit

Run `git pull` in your kit clone, then `node install.mjs <path-to-theme-repo>` again. Your `shopify-kit.json`, `.env.local`, `settings.local.json`, `cli-check.json` and `logs/` aren't part of the kit, so they're kept, and files a newer kit dropped are removed. `VERSION` is recorded in each task's state, and a task started on an older version says so in status. After a Shopify CLI or plugin update, run `/shopify-update`.

Maintainers:
- After any guard or helper change, run `node .claude/hooks/guard.mjs --selftest` and `node .claude/kit/kit.mjs --selftest`.
- After changing `kit/probe.js`, run `node .claude/kit/kit.mjs build-probe`.

## Not in v0.2

- Shopify app development (separate repos and risks; planned as its own kit)
- fetching A/B code from shadow-drip automatically (you supply the path or files)
- tickets that target a non-live theme
- posting to Jira and creating PRs
- unattended runs
- a short lane for small changes
- `theme metafields pull` (metafield-type-aware theme check)
- `theme profile` (render-time before/after)

These come after the pilot.
