# Shopify Implementation Kit · v0.3.1

A Claude Code setup for Shopify theme repos.

- **`/implement <KEY>`** takes a Jira ticket (a winning A/B test, a feature or a bug fix) to a QA'd draft theme. It reads the ticket and the code, asks you every open decision, gets a file-by-file plan approved, builds on a task branch, pushes to an unpublished copy of the live theme, and checks the draft with measured values.
- **`/shopify-investigate <KEY or question>`** answers feasibility, debugging and how-does-it-work questions, read-only and with evidence.

It never publishes a theme, writes to the live theme, or pushes or merges into the base branch. Merging stays with you.

## What you need

| Need | Check or get it |
| --- | --- |
| Claude Code 2.1.295 or newer | `claude --version` |
| Node 20+ and git | `node --version` |
| Shopify CLI | `npm i -g @shopify/cli@latest`; `/shopify-setup` checks the commands the kit uses |
| A staff account on the store: themes, metafields and metaobjects | the store owner |
| The Shopify plugin for Claude Code, per person (the kit opts out of its telemetry) | `claude plugin install shopify-ai-toolkit@claude-plugins-official` |
| Claude in Chrome, logged into the store admin, with access to the storefront and `admin.shopify.com` | the browser tools show up in Claude Code |
| A Jira API token | id.atlassian.com → Security → API tokens |
| Optional: the Admin API login (below) | `node .claude/kit/shopify.mjs auth-check` |
| For A/B ports: the test's code | e.g. a shadow-drip-exps checkout |

### Admin API login (optional, once per store)

It installs Shopify's own CLI app on the store, so the first person to run it must be allowed to install apps there. Run it in a terminal, or in Claude Code with `!` in front:

```
shopify store auth --store <store>.myshopify.com --scopes read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_navigation,read_markets,read_locales,read_translations,read_content,read_discounts,read_files,read_publications
```

- A browser opens Shopify's approval page. Once it's approved, other devs run the same command on their own machines to log in.
- The first six scopes are for `/implement`. The rest are read-only, for investigations. They're requested together because adding a scope later needs a new approval, and removing one means uninstalling the app.
- `auth-check` prints this command with your store filled in, and lists any scopes the login lacks.
- Without the login, set `adminApi: false`. The kit then gives you admin steps for definitions and reads admin pages in Chrome.

## Install

```
git clone https://github.com/DripDevelopment/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>
```

Use the installer, not a hand copy. It writes `.claude/.gitignore`, which keeps the kit and your credentials out of the theme repo's git. If the repo already has its own `.claude/settings.json`, the installer writes `settings.kit.json` beside it; merge its `hooks`, `permissions` and `env` into yours.

Then open Claude Code in the repo, trust the folder, and run **`/shopify-setup`**. It proves the guard is live, checks your tools and logins, writes `.claude/shopify-kit.json` with you, and tells you when to create `.claude/.env.local`:
```
JIRA_USER=you@company.com
JIRA_API_TOKEN=...
```
That file is yours alone: git ignores it, and Claude can't read it.

**Protect the base branch on GitHub** (require PRs). The guard is a seatbelt; branch protection is the boundary.

**Updating:** `git pull` in your kit clone, then run the installer again. Your config, `.env.local`, `settings.local.json` and `logs/` are kept. After a Shopify CLI or plugin update, run `/shopify-update`.

## Use

```
/implement ABC-123                      start or continue a ticket
/implement ABC-123 qa                   jump to a stage whose earlier stages are done
/implement                              list tasks in this repo
/shopify-investigate ABC-123            investigate a ticket
/shopify-investigate why do German menus link to English pages?    a question without a ticket (key INV-…)
```

### Implementation stages

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | intake | Reads the ticket and linked tickets; decides A/B port, feature or bug fix. | answer; for A/B ports, put the code in `.claude/logs/<KEY>/abtest/` |
| 2 | analyze | One agent reads the theme fresh; another turns the A/B code into a list of behaviours. | — |
| 3 | clarify | Decides what merchants control and where, and asks every open question at once. A value kept in code that the ticket says the client must be able to change gets its own question. | **Gate 1:** answer |
| 4 | plan | At a glance (25 lines) on top, then the builder detail, store setup and QA criteria. | — |
| 5 | approve | Shows At a glance and what changed since Gate 1. | **Gate 2:** approve, change or reject |
| 6 | build | Creates the task branch from a fresh base. The builder agent implements; `/code-review` and a Shopify checklist review; then it commits. | — |
| 7 | draft | Creates the planned definitions. Pushes to an unpublished theme named `<KEY>`, or adopts the theme you connect to the branch (`draftRoute: "github"`), and proves the draft matches the commit. | approve mutations; connect the branch (GitHub route) |
| 8 | qa | Measures every criterion on the draft: storefront, settings previews, customizer, regression against live. | set the viewports once; do the "by hand" checks |
| 9 | accept | Shows the result. Failures go back to the builder. | **Gate 3:** accept or send back |
| 10 | handoff | Pushes the branch. Writes the PR text, admin steps, go-live order and a Jira comment, then runs a retro on the kit. | create the PR, merge, go live |

### Investigation stages

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | frame | Picks the type (feasibility, debug, question) and states what counts as answered. | answer if asked |
| 2 | gather | Code and git history, live files, read-only store data, Shopify's docs and the live storefront. Every claim is labelled Confirmed, Inferred, Assumed or Unknown. Bugs are reproduced first. | resize the window if asked |
| 3 | conclude | The answer, the unknowns, the next step and a Jira comment. A second agent re-checks every Confirmed claim. | **Gate:** accept, dig further, or "wrong question" |

Investigations can't change the theme or the store. If the answer is a fix, run `/implement` on the same key; the investigation becomes its starting context.

### Task files in `.claude/logs/<KEY>/`

| File | Holds |
| --- | --- |
| `brief.md` | what was asked (quoted), what the code looks like, what was decided and by whom |
| `plan.md` | **At a glance** first; below it the detail for the builder and QA, amendments and "as built" |
| `report.md` | **You must still do** first; then QA results, PR text, admin steps and the Jira comment |
| `kit-notes.md` | only when the kit itself got in the way: one line per problem |
| `contract.md` | what the merchant sees in the customizer |
| `investigation.md` | investigations: the question, answer, evidence and next step |
| `state.json` | machine state for resuming; managed by `kit.mjs` |

The logs are history, not a knowledge base: every task reads the code fresh.

### Team workflow

- **QA team:** reviews in Jira's review status ("AC Review" at Drip), using `report.md` § Criteria. Don't move the ticket to Done: that can start billing.
- **Feedback after handoff:** `/implement <KEY>`, then `kit.mjs back <KEY> build --reason "…"`. Keep the draft until review ends.
- **Scope change midway:** go `back` to the stage it affects. The plan records it under Amendments.
- **Another dev takes over:** copy `.claude/logs/<KEY>/` to their machine. The draft is named after the key, so they continue on it.
- **Dropping a task:** `kit.mjs abandon <KEY> --reason "…"` lists the draft and store data left to clean up.
- **Reporting:** `kit.mjs summary <KEY>`: time per stage, loops, verdicts and store changes.
- **Kit problems:** the agent notes them in `kit-notes.md` as they happen, and runs a retro at the end. `node .claude/kit/kit.mjs feedback` collects every task's notes into `.claude/logs/kit-feedback.md`; send that to the kit maintainer.

## Safety rails

| Rail | How |
| --- | --- |
| One CLI wrapper | `.claude/kit/shopify.mjs` builds every command and writes only to the task's own unpublished theme, named after the key. It has no publish, live or delete-other command. The guard denies direct `shopify`, `npx @shopify/cli` and Theme Kit calls, including inside npm scripts and `bash -c`. |
| Store changes | Only the kit's own mutations: definitions, QA values, metaobject entries, and deleting what this task created. Anything else (e.g. `productDelete`) is refused. |
| Your approval | `mutate` and `delete-draft` show you the whole file (or the theme) first. The wrapper runs only what you were shown, once, within 15 minutes; a changed file or a chained call is refused. |
| Git | Pushes go only as `git push -u origin <task-branch>`: no force, no delete, nothing to protected branches. No commits on protected branches. Other remotes, `git -c` and commands that discard work ask first. |
| Files | Credentials are never read or written: `.env*`, `~/.claude/.env`, Theme Kit's `config.yml`, the CLI's `shopify-cli-*` folders. `state.json` changes only through `kit.mjs`. Changes to `shopify-kit.json`, merchant-owned JSON and the kit's own files ask first. |
| Jira token | Sent only over https, and only to an `atlassian.net` site unless your own `.env.local` sets `JIRA_BASE_URL`. |
| Admin API | Read-only, except for products, metafields and metaobjects. The agent never prints discount codes, and never reads orders or customers. |
| Browser | Chrome runs as your admin account, and no hook sees clicks. The agent's "look only" rules and the extension's prompts are the only checks. Don't give `admin.shopify.com` "always allow". |
| The real boundary | The guard is a seatbelt; if it fails, the call is blocked. GitHub branch protection and your store permissions are what hold. Never run the kit in bypass-permissions mode. |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup: the guard didn't block `shopify version` | Update Claude Code and trust the folder. Don't use the kit until it's blocked. |
| "Theme login missing or expired" | `! shopify theme list --store <store>` |
| "Admin API login missing or lacks scopes", or an investigation's query gets "access denied" | the login command above (`auth-check` prints it) |
| "No Jira credentials" | create `.claude/.env.local`, or paste the ticket text |
| "The theme library is full" | delete old kit drafts with `shopify.mjs delete-draft <KEY>`, and others in the admin (stores allow 20 themes, 100 on Plus) |
| push: "Live has changed … since this branch's base" | merge `origin/<base>` into the task branch, commit, push again |
| push: "Shopify rejected files" | fix the named file (often a Liquid error), commit, push again |
| push or verify: "the draft doesn't match" | push once more. A JSON file that keeps differing usually needs its schema change pushed first. |
| The draft seems to show old code | `shopify.mjs fetch <KEY> <path> --find <text>`. A plain `?preview_theme_id` request gets the live theme. |
| GitHub route: `git push` is rejected | someone saved in the admin: `git pull --no-rebase origin <branch>`, then push |
| A `done` is refused | it lists what's missing: finish that and run it again |
| The guard blocks a harmless command that mentions "shopify" | use the Grep tool, or rephrase |
| You need a CLI command the wrapper doesn't have | run it yourself with `!`; the guard only watches Claude |

## Not in v0.3

Shopify app development, fetching A/B code from shadow-drip, target themes other than live, posting to Jira or creating PRs, unattended runs, and a short lane for small changes.
