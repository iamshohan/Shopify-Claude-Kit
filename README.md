# Shopify-Claude-Kit

Claude Code automation kits for Shopify development: the theme kit takes a Jira ticket in a theme repo to a QA'd draft theme, and the app kit takes an app change from approved scenarios to a verified branch with its deploy checklist.

## Install

```
git clone https://github.com/DripDevelopment/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>          # theme kit
node Shopify-Claude-Kit/install.mjs <path-to-app-repo> --app      # app kit
```

Re-run the same command to update.

## Set up (once per repo and person)

Open Claude Code in the repo you installed into, trust the folder when it asks, then run:

- **Theme repo:** `/shopify-setup`. It proves the guard is live, checks the Shopify CLI, your logins and tools (with the exact fix for anything missing), and writes `.claude/shopify-kit.json` with you.
- **App repo:** `/app-setup`, then `/app-onboard` (once per repo). Setup checks the CLI and writes `.claude/app-kit.json` (dev store, app config, verify commands). Onboard creates `appspec/` with the app's current surfaces; commit it.

For Jira keys, both setups tell you when to create `.claude/.env.local`:

```
JIRA_USER=you@company.com
JIRA_API_TOKEN=...
```

Without it, paste the ticket text instead.

## Theme kit commands

| Command | Use it to |
| --- | --- |
| `/shopify-setup` | Set up once per repo and person: checks the CLI, logins and guard, writes `.claude/shopify-kit.json` |
| `/shopify-implement ABC-123` | Take a ticket (A/B winner, feature, bug fix) to a QA'd draft theme: plan → your approval → build → QA → your acceptance → PR text |
| `/shopify-implement ABC-123 qa` | Jump to a stage whose earlier stages are done |
| `/shopify-implement ABC-123 --test` | Try the kit on a ticket without pushing anything to git |
| `/shopify-implement` | List the tasks in this repo |
| `/shopify-investigate ABC-123` | Answer a bug or how-does-it-work question, read-only, with evidence (a plain question works too) |
| `/shopify-feasibility ABC-123` | Can it be built, how, and how big (S/M/L)? Before a ticket is picked up |
| `/shopify-update` | After a Shopify CLI or plugin update: checks the kit still matches |

Run a command again with the same key to continue where it stopped. Team guide: [`.claude/README.md`](.claude/README.md).

## App kit commands

| Command | Use it to |
| --- | --- |
| `/app-setup` | Set up once per repo and person: checks the CLI, writes `.claude/app-kit.json` (dev store, app config, verify commands) |
| `/app-onboard` | Once per repo: creates `appspec/` with the app's current surfaces |
| `/app-change ABC-123` | Add or change behaviour: scenarios → your approval → build → verify → your acceptance → PR text and deploy checklist |
| `/app-fix ABC-123` | Fix a bug: a failing test first, then the fix |
| `/app-maintain ABC-123` | API version bump, dependencies or refactor, with no behaviour change |
| `/app-ab ABC-123` | Build an A/B-gated checkout extension or Function |
| `/app-ask <question>` | Ask how something works, read-only |
| `/app-drift` | Health check: surfaces changed outside the kit, archived tests gone (`--regression` runs them all) |

Run a command again with the same key to continue where it stopped. Team guide: [`app/.claude/README.md`](app/.claude/README.md).
