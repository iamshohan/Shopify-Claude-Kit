# Shopify App Kit (in the Shopify-Claude-Kit repo)

`app/` is the app kit, not a Shopify app. `app/.claude/` is the product that `app/install.mjs` copies into app repos (devs run it as `node install.mjs <repo> --app` from the repo root); `app/.claude/CLAUDE.md` describes those app repos, and here only tells you what the kit promises its users. The repo root is the theme kit: change nothing there for app work except the hand-over block at the top of `install.mjs`.

- **Which guard runs depends on where the session starts.** At the repo root it's the theme kit's guard. That guard protects `main` and asks before edits to `app/.claude/hooks/`, `app/.claude/settings.json`, `app/.claude/kit/guard-core.mjs` and `shared/guard-core.mjs`; other `app/` files get no extra prompt. Work on a branch.
- **Before calling a change done**, run `node test/all.mjs` from the repo root (both kits' suites and the shared-code check). After a TOML reader change, also `node app/test/app-toml-parity.mjs <app-repo>` on real app repos.
- **Safety code** (`hooks/guard.mjs`, `kit/guard-core.mjs`, `kit/shopify.mjs`, the GraphQL reading in `kit/core.mjs`): every new rule or bypass gets a self-test or e2e case.
- **`kit/guard-core.mjs` and `kit/jira.mjs` are generated from `../shared/`** by `node ../scripts/sync-shared.mjs`: edit `shared/`, never the copy. The theme kit's guard uses the same core, so run both kits' guard self-tests after a change there. Still copied by hand from the theme kit, and worth checking when one side changes: parts of `kit/core.mjs` (GraphQL reading), `kit/repo.mjs` (`secret`, `secretSource`, `protectedBranches`), the seal and log helpers in `hooks/guard.mjs`, and `rules/app-runs.md`.
- **Release:** bump `app/.claude/VERSION`, add an `app/CHANGELOG.md` entry.
- `test/` stays outside `.claude/`, so app repos never get it.
