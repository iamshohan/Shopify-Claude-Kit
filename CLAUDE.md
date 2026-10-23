# Shopify-Claude-Kit (master repo)

This repo is the kit itself, not a Shopify theme. `.claude/` is the product that `install.mjs` copies into theme repos. `.claude/CLAUDE.md` describes those theme repos; here it only tells you what the kit promises its users.

- **The guard runs here too.** It protects `main`, so work on a branch, or leave committing to the maintainer. Its "maintainer mode" (install.mjs present, no `.claude/.kit-manifest.json`) lets kit files be edited without a prompt; changes to `.claude/hooks/` and `.claude/settings.json` still ask.
- **Before calling a change done:** `node .claude/hooks/guard.mjs --selftest`, `node .claude/kit/kit.mjs --selftest` and `node test/e2e.mjs`. After editing `kit/probe.js`: `node .claude/kit/kit.mjs build-probe`.
- **Safety code** (`hooks/guard.mjs`, `kit/shopify.mjs`, the mutation checks in `kit/lib.mjs`): every new rule or bypass gets a self-test or e2e case.
- **Release:** bump `.claude/VERSION`, add a `CHANGELOG.md` entry, and update the version in both READMEs.
- `test/` stays outside `.claude/`, so theme repos never get it.
