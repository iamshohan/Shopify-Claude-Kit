# Shopify Implementation Kit · v1.17.0

A Claude Code setup for Shopify theme repos.

- **`/shopify-implement <KEY>`** takes a Jira ticket (a winning A/B test, a feature or a bug fix) to a QA'd draft theme: it reads the ticket and the code, asks you only the real calls, gets a file-by-file plan approved, builds on a task branch, pushes to an unpublished copy of the live theme, and checks the draft with measured values.
- **`/shopify-investigate <KEY or question>`** answers feasibility, debugging and how-does-it-work questions, read-only and with evidence.
- **`/shopify-feasibility <KEY>`** is the same flow for a ticket nobody has picked up yet: can it be built, what the client actually gets (and how it differs from what they expect), the limitations, the approaches, and an estimate in agentic development hours. Questions only the client can answer go into the Jira comment.
- **`/shopify-video <KEY>`** makes the client's walkthrough video once QA is accepted: what's new, where it lives in the theme editor, what to watch out for, and a storefront tour. English voice with captions; you approve the storyboard and watch the video before it goes out.

It never publishes a theme, writes to the live theme, or pushes or merges into the base branch. Merging stays with you.

## What you need

`/shopify-setup` installs the Shopify plugin, `kit-browser` and the video tools itself, after one go-ahead. Get the rest before it: some come from other people and take time.

| Need | Check or get it |
| --- | --- |
| Claude Code 2.1.295 or newer | `claude --version` |
| Node 20+ and git | `node --version` |
| Shopify CLI | `npm i -g @shopify/cli@latest`; `/shopify-setup` checks the commands the kit uses |
| A staff account on the store: themes, metafields and metaobjects | the store owner |
| The Shopify plugin for Claude Code, per person (the kit opts out of its telemetry) | `claude plugin install shopify-ai-toolkit@claude-plugins-official` |
| Claude in Chrome, logged into the store admin, with access to the storefront and `admin.shopify.com` (theme editor and admin checks) | the browser tools show up in Claude Code |
| The `kit-browser` server: an isolated Playwright browser for storefront QA, once per machine | `claude mcp add kit-browser --scope user -- npx -y @playwright/mcp@0.0.83 --isolated --headless --snapshot-mode none` |
| A Jira API token | id.atlassian.com → Security → API tokens |
| Optional: the Admin API login, which installs Shopify's CLI app on the store | [Admin API login](#admin-api-login-optional-once-per-store) below; someone allowed to install apps |
| Optional, for tickets with a Figma design: Figma connected in Claude Code | without it you paste the values or skip the design check |
| For A/B ports: the test's code | e.g. a shadow-drip-exps checkout |
| Optional, for client videos: the recorder, ffmpeg and the voice, once per machine (about 100 MB in `~/.shopify-kit/video`) | `node .claude/kit/video.mjs setup` in any theme repo |

## Install

```
git clone https://github.com/iamshohan/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>
```

`install.mjs --all <folder>` lists every theme and app repo under a folder, and `--yes` installs into those without a kit. Use the installer, not a hand copy: it writes `.claude/.gitignore`, which keeps the kit and your credentials out of git. `.claude/settings.json` is replaced on every update; put your own permissions, hooks and env in `.claude/settings.local.json` (the kit's deny and ask rules still win).

Then open Claude Code in the repo, trust the folder, and run **`/shopify-setup`**. It proves the guard is live, checks every tool and login, confirms `.claude/shopify-kit.json` with you in one round, installs what this machine is missing after one go-ahead, and ends with what only you can do: logins, a restart if it installed something, and `~/.claude/.env` (once per machine, for every kit repo):
```
JIRA_USER=you@company.com
JIRA_API_TOKEN=...
```
Claude can't read that file. A repo that needs another Jira account gets the same lines in `.claude/.env.local`, which wins. Keep `JIRA_BASE_URL` out of `~/.claude/.env`: there it overrides `jiraBaseUrl` in every repo.

### Admin API login (optional, once per store)

It installs Shopify's own CLI app on the store, so the first person to run it must be allowed to install apps. If you can't yet, skip it (`adminApi: false`) and send this command to someone who can. Run it in a terminal, or in Claude Code with `!` in front:

```
shopify store auth --store <store>.myshopify.com --scopes read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_navigation,read_markets,read_locales,read_translations,read_content,read_discounts,read_files,read_publications
```

- Once it's approved, other devs run the same command to log in. The first six scopes are for `/shopify-implement`, the rest are read-only for investigations (adding one later needs a new approval).
- Then set `adminApi: true` (or run `/shopify-setup` again). `node .claude/kit/shopify.mjs auth-check` prints this command for your store and lists missing scopes.
- Without it, the kit gives you admin steps for definitions and reads admin pages in Chrome.

**Protect the base branch on GitHub** (require PRs). The guard is a seatbelt; branch protection is the boundary.

**Updating:** `node Shopify-Claude-Kit/update.mjs` pulls the kit (on main, with no local edits) and updates every repo on your machine that has it. Repos installed before kit 1.2.0: `update.mjs --scan <folder>` once. A session mentions a newer kit every 15 days; it never updates on its own. A clone of the old `DripDevelopment` repo: `git remote set-url origin https://github.com/iamshohan/Shopify-Claude-Kit.git` first. Your config, `.env.local`, `settings.local.json` and `logs/` are kept. After a Shopify CLI or plugin update, run `/shopify-update`.

## Use

```
/shopify-implement ABC-123              start or continue a ticket
/shopify-implement ABC-123 qa           jump to a stage whose earlier stages are done
/shopify-implement ABC-123 --test       a test run of the kit: every stage, nothing pushed to git
/shopify-implement                      list tasks in this repo
/shopify-investigate ABC-123            investigate a ticket
/shopify-feasibility ABC-123            can it be built, how, and how big? (before picking it up)
/shopify-investigate why do German menus link to English pages?    a question without a ticket (key INV-…)
/shopify-video ABC-123                  the client's walkthrough video, after QA is accepted
```

### Implementation stages

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | intake | Reads the ticket and linked tickets; decides A/B port, feature or bug fix. | answer; for A/B ports, put the code in `.claude/logs/<KEY>/abtest/` |
| 2 | analyze | Agents read the theme, turn the A/B code into behaviours, and (with a Figma design) read the frames' values for QA to measure. | — |
| 3 | plan | Decides what merchants control and where, decides what the ticket and the theme already answer, and asks you only the real calls, all at once. Writes the plan with At a glance on top: what **needs your attention**, what it **decided for you** (change any at Gate 1), the files, and the text merchants will read. A second agent reads the ticket on its own and lists what would surprise you or the client. | answer the questions |
| 4 | approve | Shows At a glance and waits. | **Gate 1:** approve, ask for changes or reject, in your own words |
| 5 | build | Task branch from a fresh base; the builder implements and runs theme check; code review; commit. | — |
| 6 | draft | Creates the planned definitions, pushes to an unpublished theme named `<KEY>` (or the theme you connect to the branch, `draftRoute: "github"`), and proves it matches the commit. | approve mutations; connect the branch, or let the agent do it in your Chrome (`chromeWithoutAsking`) |
| 7 | qa | Measures every criterion on the draft: storefront, settings previews, regression against live, and the customizer (never Save). Fixes failures inside the plan itself, at most 2 rounds. | the few "by hand" checks left: drag placement, a real phone, Translate & Adapt |
| 8 | accept | Shows the result and what changed since Gate 1. | **Gate 2:** accept or send back |
| 9 | handoff | Pushes the branch; writes the PR text, admin steps, go-live order and a Jira comment for the client listing every way the result differs from the ticket (a second agent reads it as the client first). Offers a draft PR or the merge commands. | the PR or merge; `kit.mjs premerge <KEY>` right before merging a GitHub-connected draft; go live |

### Investigation stages

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | gather | Picks the type (feasibility, debug, question) and what counts as answered; reads code, git history, live files, read-only store data, docs and the storefront. Every claim is labelled Confirmed, Inferred, Assumed or Unknown; bugs are reproduced first. | answer if asked |
| 2 | conclude | The answer, unknowns, next step and a Jira comment; for feasibility also limitations, approaches and an estimate. A second agent reads it as the client, then re-checks every Confirmed claim. | **Gate:** accept, dig further, or "wrong question" |

Investigations can't change the theme or the store. If the answer is a fix, run `/shopify-implement` on the same key.

### Task files in `.claude/logs/<KEY>/`

| File | Holds |
| --- | --- |
| `brief.md` | what was asked (quoted), what the code looks like, what was decided and by whom |
| `plan.md` | **At a glance** first; below it the detail for the builder and QA, amendments and "as built" |
| `report.md` | **You must still do** first; then QA results, PR text, admin steps and the Jira comment |
| `kit-notes.md` | only when the kit itself got in the way |
| `contract.md` | what the merchant sees in the customizer |
| `design.md` | Figma values to match |
| `investigation.md` | investigations: the question, answer, evidence and next step |
| `storyboard.md` | `/shopify-video`: the scenes and the voice; the video is in `video/` |
| `state.json` | machine state for resuming; managed by `kit.mjs` |

The logs are history, not a knowledge base: every task reads the code fresh.

### Team workflow

- **QA team:** reviews in Jira's review status ("AC Review" at Drip), using `report.md` § Criteria. Don't move the ticket to Done: that can start billing.
- **Feedback after handoff:** `/shopify-implement <KEY>`, then `kit.mjs back <KEY> build --reason "…"`. Keep the draft until review ends. **Scope change midway:** go `back` to the stage it affects.
- **Another dev takes over:** push the task branch, copy `.claude/logs/<KEY>/` to their machine; they switch to the branch and continue on the same draft. `kit.mjs status <KEY>` shows the owner.
- **Test runs** (`--test`): for trying the kit on someone else's ticket. Branch and draft are named `<KEY>-kit-test`, nothing is pushed to git, and handoff marks the report "TEST RUN". Move `.claude/logs/<KEY>/` aside afterwards if you'll work the ticket for real.
- **Dropping a task:** `kit.mjs abandon <KEY> --reason "…"` lists the draft and store data to clean up.
- **Client video:** `/shopify-video <KEY>` after QA is accepted, before the draft is deleted. You get the storyboard (already reviewed for missing changes and jargon) and the finished video. Storefront scenes record in a hidden browser; theme-editor and admin scenes are stills with a slow zoom, taken in a Chrome tab the agent opens (Claude in Chrome connected: `/chrome`; maximise that window once for sharper stills; you can keep working). `Captions: off` in the storyboard leaves captions out.
- **Reporting:** `kit.mjs summary <KEY>`: time per stage, loops, verdicts and store changes.
- **Kit problems:** the agent notes them in `kit-notes.md`; `node Shopify-Claude-Kit/export-logs.mjs` shares every repo's task logs with the kit maintainer.

## Safety rails

| Rail | How |
| --- | --- |
| One CLI wrapper | `.claude/kit/shopify.mjs` writes only to the task's own unpublished theme, named after the key; it has no publish, live or delete-other command. Direct `shopify`, `npx @shopify/cli` and Theme Kit calls are refused, also inside npm scripts and script files. |
| Store changes | Only the kit's own mutations: creating definitions and metaobject entries, setting and deleting metafield values, and deleting what this task created. Setting a metafield value can change one the merchant had, so read those prompts closely. |
| Your approval | `mutate` and `delete-draft` show you the whole file (or the theme) first, and the wrapper runs only what you were shown, once, within 15 minutes. |
| Git | Pushes only as `git push -u origin <task-branch>`: no force, no delete, nothing to protected branches. No commits on protected branches or with a secret staged; no tags, merges or releases. Discarding uncommitted work asks first. |
| Files | Credentials are never read or written (`.env*`, `~/.claude/.env`, Theme Kit's `config.yml`, the CLI's login folders). `state.json` changes only through `kit.mjs`. Safety settings in `shopify-kit.json` (store, protected branches, Jira URL, Chrome standing yes), Claude Code's and git's settings, and merchant JSON the plan doesn't name ask first. |
| Jira token | Sent only over https, and only to an `atlassian.net` site unless your own `.env.local` sets `JIRA_BASE_URL`. |
| Admin API | Read-only, except products, metafields and metaobjects. Never prints discount codes; never reads orders or customers. |
| Browser | Storefront checks run in `kit-browser`, logged in nowhere. Chrome (editor, admin) runs as your admin account and no hook sees clicks: don't give `admin.shopify.com` "always allow". |
| The real boundary | The guard catches a well-meaning agent's honest mistakes, not a command disguised on purpose; GitHub branch protection and store permissions are what hold. Nothing on Shopify's side stops a publish made with your login, so never approve a command you can't read. **Bypass mode works:** store writes, deleting the draft, picking a theme, safety settings and discarding uncommitted work are refused there (switch with Shift+Tab to auto for that step); everything else passes and is logged in `.claude/logs/_guard.jsonl`. |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup: the guard didn't block `shopify version` | Update Claude Code and trust the folder. Don't use the kit until it's blocked. |
| "Theme login missing or expired" | `! shopify theme list --store <store>` |
| "Admin API login missing or lacks scopes", or "access denied" | the login command `node .claude/kit/shopify.mjs auth-check` prints |
| "No Jira credentials" | create `~/.claude/.env` (or `.claude/.env.local`), or paste the ticket text |
| "The theme library is full" | delete old kit drafts with `shopify.mjs delete-draft <KEY>`, others in the admin (20 themes, 100 on Plus) |
| push: "Live has changed … since this branch's base" (merchant JSON) | merge `origin/<base>` into the task branch, commit, push again. Admin edits that never reach git: carry them in, commit, `push <KEY> --reconciled <file>` (you confirm) |
| push: "Shopify rejected files" | fix the named file (often a Liquid error), commit, push again |
| push: "The repo's .shopifyignore excludes …" | decide how those files reach the store; if the draft can go without them, `push <KEY> --skip-ignored` |
| push or verify: "the draft doesn't match" | push once more; a JSON file that keeps differing usually needs its schema change pushed first |
| The draft seems to show old code | `shopify.mjs fetch <KEY> <path> --find <text>` (a plain `?preview_theme_id` request gets live) |
| GitHub route: `git push` is rejected | someone saved in the admin: `git log HEAD..origin/<branch> --stat`, then `git pull --no-rebase origin <branch>` and push |
| A `done` is refused | it lists what's missing; "Worth a look" lines don't block |
| The guard blocks a harmless command that mentions "shopify" | use the Grep tool, or rephrase |
| You need a CLI command the wrapper doesn't have | run it yourself with `!`; the guard only watches Claude |

## Not in the kit

Fetching A/B code from shadow-drip, posting to Jira, merging PRs, unattended runs, and shared task state between devs. Shopify apps have their own kit (`node install.mjs <app-repo> --app`).
