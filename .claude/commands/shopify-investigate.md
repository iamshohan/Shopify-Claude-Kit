---
description: Read-only investigation of this Shopify store and theme. Use it for a feasibility check ("can we build X?"), debugging (storefront, theme, menus, markets, metafields, an app's storefront output), or a question. It ends in an evidence-backed answer, not a code change. Resumable.
argument-hint: <TICKET-KEY or a question>
disable-model-invocation: true
---

# /shopify-investigate $ARGUMENTS

You are running a read-only investigation with the Shopify Implementation Kit. A script keeps track of the stage, so you never have to remember it.

## Every time, before anything else

1. **Nothing given** → run `node .claude/kit/kit.mjs list`, ask the dev which investigation to continue or what to investigate, and stop until they answer.
2. **`.claude/shopify-kit.json` missing** → tell the dev to run `/shopify-setup` first, and stop.
3. **Once per session,** run `node .claude/kit/shopify.mjs cli-check`. If it reports problems (exit 2), read each one's "Affects:". Stop and tell the dev to run `/shopify-update` only when one affects what investigations use: `query`, `pull-live`, `fetch`, `auth-check` or docs lookups. Otherwise mention them in one line and go on. Pass on its `warnings` the same way (usually a theme login to renew, which `pull-live` needs).
4. **The key:**
   - A ticket key in the arguments (like `ABC-123`) → use it.
   - Only a question → use `INV-<month><day><hour><minute>`, for example `INV-10201530`.
5. **Run `node .claude/kit/kit.mjs status <KEY>`.**
   - **"not started":** run `node .claude/kit/kit.mjs start <KEY> --investigate`. Then, if the dev gave a question, write it under § Question in `.claude/logs/<KEY>/investigation.md` in their words.
   - **It's an implementation task:** investigations of a running implementation happen inside `/shopify-implement`. Tell the dev that, and offer a separate `INV-…` key.
   - **"finished":** show the dev its answer (§ Answer, one or two lines) and ask whether to reopen it (`kit.mjs back <KEY> gather --reason "<what to look at>"`) or start a new `INV-…` key.
6. **Status names the stage and the skill.** Load that skill (`shopify-investigation`) with the Skill tool, and do only that stage.
7. **When the stage is finished,** run `node .claude/kit/kit.mjs done <KEY> <stage>`. The last stage is a gate and needs `--answer "<the dev's words>"`. If the script refuses, fix what it lists and run it again.
8. **Continue from what `done` printed:** it is the new status. Tell the dev in one line each time the stage changes.

After a compaction or in a new session, run status first and continue from what it says.

## Rules

The rules every kit run shares (gates, `--answer`, talking to the dev, kit notes) are in `.claude/rules/kit-runs.md`; they load once you touch the task folder. These are the investigation's own:

- **Read-only:** the skill lists what that means.
- **Only these skills run here:** `shopify-investigation`, `shopify-plugin:shopify` for docs, the `kit-browser` tools for the storefront (Chrome if they're missing), and `claude-in-chrome` for admin pages. Don't load other investigate or QA skills.
