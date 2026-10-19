# Shopify-Claude-Kit

The **Shopify Implementation Kit**: a Claude Code setup that takes a Jira ticket in a Shopify theme repo to a QA'd draft theme. It covers winning A/B tests, features and bug fixes. The team guide (stages, safety rails, troubleshooting) ships inside the kit: [`.claude/README.md`](.claude/README.md).

## Install or update in a theme repo

```
git clone https://github.com/DripDevelopment/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>            # add --dry-run to see what it would do
```

- It copies the kit into `<theme-repo>/.claude/`.
- It leaves the repo's own files alone: `shopify-kit.json`, `.env.local`, `settings.local.json`, `cli-check.json` and `logs/`. If the repo has its own `settings.json`, the kit's version is written beside it as `settings.kit.json` for you to merge.
- It writes `.claude/.gitignore`, so the kit stays out of the theme repo's git.
- Running it again after a `git pull` updates the kit and removes files a newer version dropped.

Then open Claude Code in the theme repo and run `/shopify-setup` (once per repo, per person).

## Layout

```
install.mjs                 installs or updates the kit in a theme repo
.claude/
  CLAUDE.md                 always-loaded rules
  README.md                 team guide
  settings.json             guard hook, permissions, env
  commands/                 /implement, /shopify-setup, /shopify-update
  skills/                   one skill per pipeline phase (intake, plan, build, qa, handoff)
  agents/                   theme-recon, abtest-analyst, theme-builder
  hooks/guard.mjs           the safety guard (with --selftest)
  kit/                      scripts: kit.mjs (task state), shopify.mjs (the only CLI wrapper),
                            jira.mjs, recon.mjs, contract.mjs, compare.mjs, probe.js, templates/, queries/
```

## Maintaining the kit

- **Change it here, never in a theme repo's copy.** Teams pick up changes with `git pull` + `install.mjs`.
- **Before committing:**
  - Run `node .claude/hooks/guard.mjs --selftest` and `node .claude/kit/kit.mjs --selftest`. Both must pass.
  - If you changed `kit/probe.js`, run `node .claude/kit/kit.mjs build-probe`.
- **Changes to `hooks/guard.mjs` or `kit/shopify.mjs` are safety changes.** Review them in a PR, and add a self-test case for every new rule or bypass.
- **When the Shopify CLI or plugin updates,** run `/shopify-update` in any theme repo. Fix what it reports here, then bump `.claude/VERSION` and add a `CHANGELOG.md` entry.
- **Version bumps:** patch for fixes, minor for new behaviour. Each task's state records the kit version it started with.

Status: v0.1, before the first pilot ticket. See `CHANGELOG.md`.
