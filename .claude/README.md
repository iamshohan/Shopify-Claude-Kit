# Shopify Implementation Kit · v1.16.0

A Claude Code setup for Shopify theme repos.

- **`/shopify-implement <KEY>`** takes a Jira ticket (a winning A/B test, a feature or a bug fix) to a QA'd draft theme. It reads the ticket and the code, decides what they answer and asks you only the real calls, gets a file-by-file plan approved, builds on a task branch, pushes to an unpublished copy of the live theme, and checks the draft with measured values.
- **`/shopify-investigate <KEY or question>`** answers feasibility, debugging and how-does-it-work questions, read-only and with evidence.
- **`/shopify-feasibility <KEY>`** is the same flow set up for a ticket nobody has picked up yet: it settles what the ticket and the code answer, then says whether it can be built, what the client will actually get (and how it differs from what they expect), the limitations, the approaches with their trade-offs, and an estimate in agentic development hours. Questions only the client can answer go into the Jira comment, not to you.
- **`/shopify-video <KEY>`** makes the client's walkthrough video once QA is accepted: what's new, where it lives in the theme editor and what to watch out for, how it behaves with different values, and a storefront tour. English voice with captions; you approve the storyboard (with each scene's length, and optional scenes to add) and watch the video before it goes out.

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
| Optional, for tickets with a Figma design: Figma connected in Claude Code | the Figma tools show up in Claude Code; without them you paste the values or skip the design check |
| For A/B ports: the test's code | e.g. a shadow-drip-exps checkout |
| Optional, for client videos: the recorder, ffmpeg and the voice, once per machine (about 100 MB in `~/.shopify-kit/video`) | `node .claude/kit/video.mjs setup` in any theme repo; theme-editor scenes need Windows for now |

## Install

```
git clone https://github.com/iamshohan/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>
```

For every Shopify repo under a folder at once, `node Shopify-Claude-Kit/install.mjs --all <folder>` lists the theme and app repos it finds, and `--yes` installs into those without a kit. Each one still needs `/shopify-setup` (or `/app-setup` for an app).

Use the installer, not a hand copy. It writes `.claude/.gitignore`, which keeps the kit and your credentials out of the theme repo's git. `.claude/settings.json` is the kit's and is replaced on every update. Put your own permissions, hooks and env in `.claude/settings.local.json`: Claude Code merges the two, and the kit's deny and ask rules still win. If the repo already has its own `settings.json`, the installer moves what it adds beyond the kit's into `settings.local.json` and says so.

Then open Claude Code in the repo, trust the folder, and run **`/shopify-setup`**. It proves the guard is live and checks every tool and login without asking. Then it confirms `.claude/shopify-kit.json` with you in one round, installs what this machine is missing after one go-ahead, and ends with what only you can do: logins, a restart if it installed something, and `~/.claude/.env` (once per machine; it covers every kit repo):
```
JIRA_USER=you@company.com
JIRA_API_TOKEN=...
```
That file is yours alone: Claude can't read it. A repo that needs another Jira account gets the same lines in `.claude/.env.local`, which git ignores and which wins over `~/.claude/.env`. Keep `JIRA_BASE_URL` out of `~/.claude/.env`: there it overrides `jiraBaseUrl` in every repo.

### Admin API login (optional, once per store)

It installs Shopify's own CLI app on the store, so the first person to run it must be allowed to install apps there. If you can't yet, skip it (`adminApi: false`) and send this command to someone who can, such as the store owner or a staff member with app permissions. Run it in a terminal, or in Claude Code with `!` in front:

```
shopify store auth --store <store>.myshopify.com --scopes read_products,write_products,read_metaobject_definitions,write_metaobject_definitions,read_metaobjects,write_metaobjects,read_online_store_navigation,read_markets,read_locales,read_translations,read_content,read_discounts,read_files,read_publications
```

- A browser opens Shopify's approval page. Once it's approved, other devs run the same command on their own machines to log in.
- The first six scopes are for `/shopify-implement`. The rest are read-only, for investigations. They're requested together because adding a scope later needs a new approval, and removing one means uninstalling the app.
- Once the app is installed, set `adminApi: true` in `.claude/shopify-kit.json` (or run `/shopify-setup` again). `node .claude/kit/shopify.mjs auth-check` prints this command with your store filled in, and lists any scopes the login lacks.
- Without the login, the kit gives you admin steps for definitions and reads admin pages in Chrome.

**Protect the base branch on GitHub** (require PRs). The guard is a seatbelt; branch protection is the boundary.

**Updating:** `node Shopify-Claude-Kit/update.mjs` pulls the kit and updates every repo on your machine that has it (theme and app kits). Repos installed before kit 1.2.0: add them once with `node Shopify-Claude-Kit/update.mjs --scan <folder that holds your repos>`. Every 15 days, a session here mentions it once when a newer kit is out; it never updates on its own. A clone made from the old `DripDevelopment` repo gets no more updates; point it at the new one first: `git remote set-url origin https://github.com/iamshohan/Shopify-Claude-Kit.git`. Your config, `.env.local`, `settings.local.json` and `logs/` are kept. After a Shopify CLI or plugin update, run `/shopify-update`.

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
| 2 | analyze | One agent reads the theme fresh; another turns the A/B code into a list of behaviours. For a feature with a Figma design, a third reads the frames' values into `design.md`, and QA measures the draft against them. | — |
| 3 | plan | First decides what merchants control and where. It decides what the ticket, the A/B winner or the theme's own patterns already answer, and asks you only the real calls, all at once: a departure from the ticket, something the client must maintain, money, real alternatives, a contradiction. Then writes the plan: At a glance (about 25 lines) on top, first what **needs your attention**, then what it **decided for you** (one line each, with why; change any of them at Gate 1) (anything that can affect what already exists: store writes, merchant JSON, shared code, changed behaviour), then file by file, and the exact text merchants will read. Below it the builder detail, store setup and QA criteria. Last, a second agent reads the ticket and the theme on its own and lists what the plan would surprise you or the client with. | answer the questions |
| 4 | approve | Shows At a glance and the plan's path, then waits for you. | **Gate 1:** review it, then approve, ask for changes or reject, in your own words |
| 5 | build | Creates the task branch from a fresh base. The builder agent implements and runs theme check; `/code-review` and a Shopify checklist review; then it commits. | — |
| 6 | draft | Creates the planned definitions. Pushes to an unpublished theme named `<KEY>`, or adopts the theme you connect to the branch (`draftRoute: "github"`), and proves the draft matches the commit. | approve mutations; connect the branch (GitHub route), or let the agent do it in your Chrome (without asking, when `chromeWithoutAsking` in shopify-kit.json lists it) |
| 7 | qa | Measures every criterion on the draft: storefront, settings previews, regression against live, and the customizer, where it selects sections, opens pickers and changes settings, then undoes them (never Save). | the few "by hand" checks left: drag placement, a real phone, Translate & Adapt |
| 8 | accept | Shows the result, and what changed since you approved the plan (plan edits, files it didn't name). Failures go back to the builder. | **Gate 2:** accept or send back |
| 9 | handoff | Pushes the branch. Writes the PR text, admin steps (before launch, the launch moment, after), go-live order, and a Jira comment for the client that lists every way the result differs from the ticket; a second agent reads it as the client first. Offers to create the PR as a draft. | say yes or no to the PR; `kit.mjs premerge <KEY>` right before merging a GitHub-connected draft; merge, go live |

### Investigation stages

| # | Stage | What happens | Your part |
| --- | --- | --- | --- |
| 1 | gather | Picks the type (feasibility, debug, question) and states what counts as answered; feasibility lists each requirement with its owner (you or the client), asks you the unclear technical ones, and states what the client gets on every surface each requirement touches. Then code and git history, live files, read-only store data, Shopify's docs and the live storefront. Every claim is labelled Confirmed, Inferred, Assumed or Unknown. Bugs are reproduced first. | answer if asked; resize the window if asked |
| 2 | conclude | The answer, the unknowns, the next step and a Jira comment; for feasibility also the limitations, the approaches and the agentic-hours estimate. A second agent first reads it as the client would (what would surprise them), then re-checks every Confirmed claim. | **Gate:** accept, dig further, or "wrong question" |

Investigations can't change the theme or the store. If the answer is a fix, run `/shopify-implement` on the same key; the investigation becomes its starting context.

### Task files in `.claude/logs/<KEY>/`

| File | Holds |
| --- | --- |
| `brief.md` | what was asked (quoted), what the code looks like, what was decided and by whom |
| `plan.md` | **At a glance** first; below it the detail for the builder and QA, amendments and "as built" |
| `report.md` | **You must still do** first; then QA results, PR text, admin steps and the Jira comment |
| `kit-notes.md` | only when the kit itself got in the way: one line per problem |
| `contract.md` | what the merchant sees in the customizer |
| `design.md` | Figma values to match: features with a design, or a design check you ask for at QA |
| `investigation.md` | investigations: the question, answer, evidence and next step |
| `storyboard.md` | `/shopify-video`: the scenes and what the voice says; the finished video and its parts are in `video/` |
| `state.json` | machine state for resuming; managed by `kit.mjs` |

The logs are history, not a knowledge base: every task reads the code fresh.

### Team workflow

- **QA team:** reviews in Jira's review status ("AC Review" at Drip), using `report.md` § Criteria. Don't move the ticket to Done: that can start billing.
- **Feedback after handoff:** `/shopify-implement <KEY>`, then `kit.mjs back <KEY> build --reason "…"`. Keep the draft until review ends.
- **Scope change midway:** go `back` to the stage it affects. The plan records it under Amendments.
- **Another dev takes over:** push the task branch first (`git push -u origin <branch>`), then copy `.claude/logs/<KEY>/` to their machine; they fetch and switch to the branch. The draft is named after the key, so they continue on it. `kit.mjs status <KEY>` shows the owner and warns when your git `user.email` is someone else's.
- **Test runs** (`/shopify-implement <KEY> --test`): for trying the kit on a ticket someone else owns.
  - The branch and the draft theme are named `<KEY>-kit-test`, so they're easy to match later and can't clash with the real ones. The guard blocks pushing the branch, and the draft is a CLI copy of live.
  - Handoff writes the report, marked "TEST RUN", and pushes nothing.
  - Afterwards, move `.claude/logs/<KEY>/` aside if you'll work the ticket for real on the same machine.
- **Dropping a task:** `kit.mjs abandon <KEY> --reason "…"` lists the draft and store data left to clean up, and what the record shows went wrong with the kit.
- **Client video:** `/shopify-video <KEY>` after QA is accepted, before the draft is deleted.
  - It writes a storyboard and has it reviewed for missing changes and jargon. The agent applies the review itself, then hands it over in a few lines: the path, the length, the optional scenes you can add.
  - Before recording, it names only what the client would see: QA test content still on the draft (replace it in the theme editor, or say to film it as it is).
  - Storefront scenes record on their own, in a hidden browser; mobile scenes fill the picture's height. A password-protected storefront is recorded in Chrome.
  - Theme-editor scenes record in a Chrome tab the agent opens as soon as you say record. They need Claude in Chrome connected to the session (`/chrome`). Give that tab a window of its own (drag it out of yours if it lands there) and maximise it, then answer once. While it shows a red **Recording** badge at the top, leave it alone: with a second screen you can work there, with one leave the computer. The editor shows smaller, in a 16:9 box in the middle of the tab: that's what's recorded, in the editor's wide layout. A laptop screen works; a bigger one gives a sharper video. The tab closes when recording is done.
  - If the tab goes behind another window while recording, the agent notices, asks you to bring it back, and redoes that part. A login page in the tab: it asks you to log in.
  - The voice stays in step with the picture: each sentence plays with the footage that shows it.
  - The picture fills the whole frame, with captions over its bottom, kept clear of what's being talked about. `Captions: off` in the storyboard leaves them out.
  - The video tells the client it was filmed on a preview copy, and how they open the editor on their live theme.
  - Before you see it, the agent checks a frame from every sentence. You watch the result before sending it; to change something, write what and where in the answer.
- **Reporting:** `kit.mjs summary <KEY>`: time per stage, loops, verdicts and store changes.
- **Kit problems:** the agent notes them in `kit-notes.md` as they happen; a finished run that went wrong (loops back, refused stages, guard blocks) shows what the record says at its end. `node Shopify-Claude-Kit/export-logs.mjs` shares every repo's task logs, notes included, with the kit maintainer.

## Safety rails

| Rail | How |
| --- | --- |
| One CLI wrapper | `.claude/kit/shopify.mjs` builds every command and writes only to the task's own unpublished theme, named after the key. It has no publish, live or delete-other command. The guard denies direct `shopify`, `npx @shopify/cli` and Theme Kit calls, including inside npm scripts and `bash -c`. |
| Store changes | Only the kit's own mutations: creating definitions and metaobject entries, setting and deleting metafield values, and deleting definitions and entries this task created. Anything else (e.g. `productDelete`) is refused. Setting or deleting a metafield value can change one the merchant already had, so read those prompts closely. |
| Your approval | `mutate` and `delete-draft` show you the whole file (or the theme) first. The wrapper runs only what you were shown, once, as the very next command and within 15 minutes; a changed file, a chained call or any command in between is refused. |
| Git | Pushes go only as `git push -u origin <task-branch>` (or `<task-branch>:<task-branch>`): no force, no delete, nothing to protected branches, and not when git's config would route the push elsewhere. No commits on protected branches, and none with a secret staged. No tag pushes, merges or releases. Commands that discard work ask first. |
| Files | Credentials are never read or written: `.env*`, `~/.claude/.env`, Theme Kit's `config.yml`, the CLI's `shopify-cli-*` folders. `state.json` changes only through `kit.mjs`. Changes to `shopify-kit.json`, the kit's own files, and merchant-owned JSON that the approved plan doesn't name ask first. |
| Jira token | Sent only over https, and only to an `atlassian.net` site unless your own `.env.local` sets `JIRA_BASE_URL`. |
| Admin API | Read-only, except for products, metafields and metaobjects. The agent never prints discount codes, and never reads orders or customers. |
| Browser | Storefront checks run in `kit-browser`, an isolated browser logged in nowhere. Chrome (editor, admin) runs as your admin account, and no hook sees clicks. The agent's "look only" rules and the extension's prompts are the only checks. Don't give `admin.shopify.com` "always allow". |
| The real boundary | The guard is a seatbelt; if it fails, the call is blocked. It catches a well-meaning agent's mistakes, not a command disguised on purpose. GitHub branch protection and your store permissions are what hold. One exception: nothing on Shopify's side stops a theme publish or a push to live made with your login. For that, the guard (which blocks those words wherever a command could run them) and Claude Code's own prompt for unknown commands are the only checks, so never approve a command you can't read. In a permission mode that hides prompts (bypass, `dontAsk`, plan), any step that needs your confirmation is blocked instead of silently approved: read-only work, the build and your gate answers still run, and the first store write stops until you switch with Shift+Tab to auto (recommended), default or accept edits. |
| What asks, what doesn't | The guard interrupts you only for what's hard to undo: store writes, deleting the draft, adopting a theme or setting `draft.themeId`, merchant JSON you reconcile, the kit's settings, writing or removing files that turn the guard or git's safety off (`.claude/settings*.json`, hooks, `.mcp.json`, `.git/`), git commands that discard work, a commit when the guard can't read the branch, and a workflow or git hook that would push or publish a theme. Mistakes with a clear alternative (the CLI outside the wrapper, secrets, printing the environment, a recursive search of the repo root or `.claude/`) are refused with the reason, and the agent switches. Gate answers, `git add -f` of a named file, CI and git-hook edits, scripts that call the CLI and git settings that run a program go through without a prompt and are logged in `.claude/logs/_guard.jsonl`. |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Setup: the guard didn't block `shopify version` | Update Claude Code and trust the folder. Don't use the kit until it's blocked. |
| "Theme login missing or expired" | `! shopify theme list --store <store>` |
| "Admin API login missing or lacks scopes", or an investigation's query gets "access denied" | the login command `node .claude/kit/shopify.mjs auth-check` prints, with your store and the missing scopes filled in |
| "No Jira credentials" | create `~/.claude/.env` (or `.claude/.env.local` for this repo only), or paste the ticket text |
| "The theme library is full" | delete old kit drafts with `shopify.mjs delete-draft <KEY>`, and others in the admin (stores allow 20 themes, 100 on Plus) |
| push: "Live has changed … since this branch's base" (merchant JSON) | merge `origin/<base>` into the task branch, commit, push again. If admin edits never reach git: carry them into the branch, commit, and `push <KEY> --reconciled <file>` (you're asked to confirm). Other files live changed (a code-editor hotfix) are only listed, and the report names them |
| push: "Shopify rejected files" | fix the named file (often a Liquid error), commit, push again |
| push: "The repo's .shopifyignore excludes …" | decide how those files reach the store (often an admin step). If the draft can go without them: `push <KEY> --skip-ignored`, and the report lists them |
| push or verify: "the draft doesn't match" | push once more. A JSON file that keeps differing usually needs its schema change pushed first. |
| The draft seems to show old code | `shopify.mjs fetch <KEY> <path> --find <text>`. A plain `?preview_theme_id` request gets the live theme. |
| GitHub route: `git push` is rejected | someone saved in the admin: look first (`git log HEAD..origin/<branch> --stat`), then `git pull --no-rebase origin <branch>` and push, or drop test edits |
| A `done` is refused | it lists what's missing: finish that and run it again |
| The guard blocks a harmless command that mentions "shopify" | use the Grep tool, or rephrase |
| You need a CLI command the wrapper doesn't have | run it yourself with `!`; the guard only watches Claude |

## Not in the kit

Fetching A/B code from shadow-drip, posting to Jira, merging PRs, unattended runs, and shared task state between devs. Shopify apps have their own kit (`node install.mjs <app-repo> --app`).
