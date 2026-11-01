---
description: Health check of this Shopify app's kit records - surfaces changed outside a change, ledgered tests that are gone, stale changes, and optionally the full regression of every ledgered test.
argument-hint: [--regression]
disable-model-invocation: true
---

# /app-drift $ARGUMENTS

Read-only.

1. Run `node .claude/kit/app.mjs drift` (add `--regression` when the arguments include it, or before a release: it runs every ledgered test).
2. Report, most important first:
   - **surfacesChangedOutsideArchive**: scopes, webhooks, extensions or models in the config files that differ from `appspec/surfaces.json`. Open changes on other branches explain some (the output names them). Anything else changed outside the kit; the next archived change records it.
   - **regression** failures (with `--regression`) and **ledgerTestsGone**: a test an archived change bound fails or no longer exists. Suggest `/app-fix`, or a change that retires it.
   - **securityBaseline** missing: `app.mjs onboard` records it when the security check can run.
   - **staleChanges**: open changes untouched for two weeks. Ask the dev whether to continue or abandon each.
3. Optional, when the dev asks about scopes on Shopify: `node .claude/kit/shopify.mjs info` shows the scopes in `shopify.app.toml` against those granted to the released app.

End with what the dev should do, or "Nothing needs attention".
