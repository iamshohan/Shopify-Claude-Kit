# Shopify App Kit

A Claude Code setup for building and maintaining Shopify apps scenarios first: admin apps (React Router, Prisma) and extension-only apps (checkout UI extensions, Functions). `app/.claude/` is the product; `app/install.mjs` copies it into an app repo.

The team guide is [`.claude/README.md`](.claude/README.md). This file is for whoever maintains the kit.

## Install into an app

From the Shopify-Claude-Kit repo's root:

```
node install.mjs <path-to-app-repo> --app [--dry-run] [--force]
```

Without `--app`, the root installer installs the theme kit. Then, in the app repo: `/app-setup`, `/app-onboard`, `/app-change <KEY>`.

The app kit lives in `app/` of the theme kit's repo. The code both kits share lives in `../shared/`: `guard-core.mjs`, `jira.mjs` and `update-check.mjs` are copied into `kit/` by `scripts/sync-shared.mjs`, and both installers import `installer-core.mjs`. Parts of `kit/core.mjs` are still copied by hand (see `CLAUDE.md`).

## Layout

| Path | What |
| --- | --- |
| `.claude/kit/app.mjs` | The state machine: one stage graph, gates, verify, handoff, drift |
| `.claude/kit/scenarios.mjs` | proposal.md's scenario table: parse, check, what changed since Gate 1 |
| `.claude/kit/surfaces.mjs` · `toml.mjs` | Surfaces from the config files; a TOML reader matched against the CLI's own parse |
| `.claude/kit/checks.mjs` | The vitest runner, the test ledger, the repo's verify commands |
| `.claude/kit/shopify.mjs` | The only door to the Shopify CLI (dev store only, sealed mutations) |
| `.claude/kit/repo.mjs` · `core.mjs` | Paths, settings, stages, change state; generic helpers |
| `.claude/hooks/guard.mjs` · `kit/guard-core.mjs` | The PreToolUse guard; its shell reader is shared with the theme kit |
| `.claude/commands`, `skills`, `agents`, `rules` | The instructions |
| `test/` | Offline e2e with a fake CLI and a fake vitest; a TOML parity check against the real CLI |

## Tests

`node test/all.mjs` from the repo root runs every suite. After a TOML reader change, also `node app/test/app-toml-parity.mjs <app-repo> ...` (needs the Shopify CLI and a login; read-only).
