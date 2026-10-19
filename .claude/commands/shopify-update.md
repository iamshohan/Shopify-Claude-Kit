---
description: Check that the installed Shopify CLI and Shopify plugin still offer every command, flag and output the kit relies on, and explain what an update changed. Run it after updating either tool, or when /implement says the CLI check failed.
disable-model-invocation: true
---

# /shopify-update

The kit's wrapper (`.claude/kit/shopify.mjs`) depends on specific Shopify CLI commands, flags and JSON output. The stage skills depend on the Shopify plugin's topics and scripts. When either tool updates, check them again.

1. Run `node .claude/kit/shopify.mjs cli-check --force`. It compares the installed versions with the last ones it verified, then checks:
   - every command and flag the wrapper uses, against the CLI's own `--help`
   - the output schemas the CLI publishes (`store execute`, `store auth list`)
   - the read-only output of `theme list`
   - the plugin's `liquid` and `admin` topics and its `search_docs` and `validate` scripts
   - that every query in `.claude/kit/queries/` still validates against the pinned Admin API version (`adminApiVersion` in `.claude/shopify-kit.json`), and which ones use deprecated fields

   The result is saved in `.claude/cli-check.json`.
2. **Everything ok** → tell the dev which CLI and plugin versions are verified, and that `/implement` can run.
3. **Problems listed** → for each one:
   - Say what changed in plain words, and which kit verbs and stages it affects; the report names them.
   - Look up the change: `shopify <command> --help`, the CLI's release notes, or `search_docs` with the `shopify-plugin:shopify` skill.
   - Propose the exact edit to the kit (file, current text, new text). **Don't edit the kit here.** Kit changes go into the master copy (the Shopify-Claude-Kit repo), so every theme repo gets them through `install.mjs`. The guard also asks before any kit-file edit.
   - Until the kit is fixed, give the dev the safe options:
     - Pin the last verified CLI version: `! npm i -g @shopify/cli@<previous.cliVersion from the report>`.
     - Or avoid the affected stages.
   - Pinned Admin API version no longer validates → propose the next stable version for `adminApiVersion`, and re-validate the kit's `.graphql` files and the task's mutations against it before the dev switches.
4. Optional: `! npm view @shopify/cli version` shows the newest CLI release. Plugin updates come through `/plugin`. After updating either, run this command again.
