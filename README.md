# Shopify-Claude-Kit

The **Shopify Implementation Kit**: Claude Code commands that take a Jira ticket in a Shopify theme repo to a QA'd draft theme (`/shopify-implement`), or answer a question about the store read-only (`/shopify-investigate`). The team guide ships inside the kit: [`.claude/README.md`](.claude/README.md).

## Install or update in a theme repo

```
git clone https://github.com/DripDevelopment/Shopify-Claude-Kit.git
node Shopify-Claude-Kit/install.mjs <path-to-theme-repo>      # --dry-run shows what it would do
```

It copies the kit into `<theme-repo>/.claude/`. It keeps the repo's own config, credentials and logs, removes files a newer kit dropped, and keeps the kit out of the theme repo's git. Then run `/shopify-setup` in Claude Code, once per repo and person.

## Layout

```
install.mjs                 installs or updates the kit in a theme repo
.claude/
  CLAUDE.md                 always-loaded rules
  README.md                 team guide
  settings.json             guard hook, permissions, env
  commands/                 /shopify-implement, /shopify-investigate, /shopify-setup, /shopify-update
  rules/kit-runs.md         rules both commands share; loads when Claude touches .claude/logs/
  skills/                   one skill per phase (intake, plan, build, qa, handoff) plus shopify-investigate
  agents/                   theme-recon, abtest-analyst, design-extractor, theme-builder, evidence-checker
  hooks/guard.mjs           the safety guard (with --selftest)
  kit/                      scripts: kit.mjs (task state), shopify.mjs (the only CLI wrapper), lib.mjs (shared),
                            jira.mjs, recon.mjs, contract.mjs, compare.mjs, templates/, queries/,
                            probe.js (QA probe; build-probe generates probe.inject.js and probe.init.js)
test/                       e2e.mjs and fake-shopify.mjs: the offline end-to-end test (not installed)
```

## Maintaining the kit

- **Change it here, never in a theme repo's copy.** Teams pick up changes with `git pull` and the installer.
- **Before committing,** `node .claude/hooks/guard.mjs --selftest`, `node .claude/kit/kit.mjs --selftest` and `node test/e2e.mjs` must all pass. The e2e test runs the scripts offline against a fake Shopify CLI (`test/fake-shopify.mjs`); a wrapper change that reads new CLI output needs the fake to produce it too. After changing `kit/probe.js`, also run `node .claude/kit/kit.mjs build-probe`.
- **`hooks/guard.mjs` and `kit/shopify.mjs` are safety code.** Review changes to them in a PR, with a self-test case for every new rule or bypass.
- **After a Shopify CLI or plugin update,** run `/shopify-update` in a theme repo and fix here what it reports.
- **Every release:** bump `.claude/VERSION` (patch for fixes, minor for new behaviour) add a `CHANGELOG.md` entry, and update the version in both READMEs.
- **The Admin API scopes** live only in `kit/shopify.mjs`; `auth-check` builds the login command from them.

Status: v1.0.0. See `CHANGELOG.md`.
