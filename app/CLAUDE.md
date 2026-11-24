# Shopify App Kit (in the Shopify-Claude-Kit repo)

`app/` is the app kit, not a Shopify app. `app/.claude/` is the product that `app/install.mjs` copies into app repos (devs run it as `node install.mjs <repo> --app` from the repo root); `app/.claude/CLAUDE.md` describes those app repos, and here only tells you what the kit promises its users. The repo root is the theme kit: change nothing there for app work except the hand-over block at the top of `install.mjs`.

- **Which guard runs depends on where the session starts.** At the repo root it's the theme kit's guard. That guard protects `main` and asks before edits to `app/.claude/hooks/`, `app/.claude/settings.json`, `app/.claude/kit/guard-core.mjs` and `shared/guard-core.mjs`; other `app/` files get no extra prompt. Work on a branch.
- **Before calling a change done**, run `node test/all.mjs` from the repo root (both kits' suites and the shared-code check). After a TOML reader change, also `node app/test/app-toml-parity.mjs <app-repo>` on real app repos.
- **Safety code** (`hooks/guard.mjs`, `kit/guard-core.mjs`, `kit/shopify.mjs`, the GraphQL reading in `../shared/core.mjs`): every new rule or bypass gets a self-test or e2e case.
- **`kit/core.mjs`, `kit/guard-core.mjs`, `kit/jira.mjs`, `kit/update-check.mjs` and `rules/runs.md` are generated from `../shared/`** by `node ../scripts/sync-shared.mjs`: edit `shared/`, never the copy. The theme kit uses the same files, so run both kits' self-tests after a change there. The kit-specific run rules (`rules/app-runs.md`, the theme kit's `kit-runs.md`) are worth comparing when one side changes.
- **Release:** bump `app/.claude/VERSION`, add an `app/CHANGELOG.md` entry.
- **Keep level with the theme kit** (root `CLAUDE.md` → "Keep the two kits level"): a change to how runs behave gets its counterpart in the other kit in the same release, or a line in the changelog saying why not.
- `test/` stays outside `.claude/`, so app repos never get it.
