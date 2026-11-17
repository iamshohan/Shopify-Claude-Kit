# Shopify-Claude-Kit (master repo)

This repo is the kit itself, not a Shopify theme. `.claude/` is the product that `install.mjs` copies into theme repos. `.claude/CLAUDE.md` describes those theme repos; here it only tells you what the kit promises its users.

- **The guard runs here too.** It protects `main`, so work on a branch, or leave committing to the maintainer. Its "maintainer mode" (install.mjs present, no `.claude/.kit-manifest.json`) lets kit files be edited without a prompt; changes to `.claude/hooks/` and `.claude/settings.json` still ask.
- **Before calling a change done:** `node test/all.mjs` (both kits' suites and the shared-code check, about a minute). After editing `kit/probe.js`: `node .claude/kit/kit.mjs build-probe`.
- **Safety code** (`hooks/guard.mjs`, `kit/shopify.mjs`, the mutation checks in `kit/lib.mjs`): every new rule or bypass gets a self-test or e2e case.
- **Release:** bump `.claude/VERSION`, add a `CHANGELOG.md` entry, and update the version in the title of `.claude/README.md`. The root `README.md` holds only install, setup and the command list.
- **After a Shopify CLI or plugin update,** run `/shopify-update` in a theme repo and fix here what it reports. The Admin API scopes live only in `kit/shopify.mjs`; `auth-check` builds the login command from them.
- `test/` stays outside `.claude/`, so theme repos never get it.
- **`app/` is the app kit**, a separate product with its own installer, tests, VERSION and CHANGELOG: read `app/CLAUDE.md` before changing it. `install.mjs --app` hands over to `app/install.mjs`. After changing the top of `install.mjs`, also run `node app/test/e2e.mjs` (it covers the hand-over).
- **Code both kits share lives in `shared/`.** `guard-core.mjs` (the guards' shell reader, push routing, secrets, package scripts) `jira.mjs` and `update-check.mjs` are copied into each kit's `.claude/kit/` by `node scripts/sync-shared.mjs`: edit `shared/`, run the script, and never edit a copy (both e2e suites run `--check` and fail on drift). `installer-core.mjs` is imported by both installers directly. A guard change in `shared/` runs both kits' self-tests.
- **Installers ship what git has.** A new kit file must be added to git (staged at least), or installs skip it with a warning. A missing import then crashes the kit in every repo.
- **Updates:** `update.mjs` pulls this clone and re-runs the installer for every repo in `.installs.json` (the installers write it; git-ignored, per machine). `update-check.mjs` (from `shared/`) is both kits' SessionStart hook: every 15 days it compares the installed VERSION with this clone's and its remote's, and only informs. A release that should reach the team needs a VERSION bump, or the notice stays quiet.
