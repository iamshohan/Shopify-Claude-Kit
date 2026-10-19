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
3. **Once per session,** run `node .claude/kit/shopify.mjs cli-check`. If it reports problems (exit 2), tell the dev to run `/shopify-update`, and stop.
4. **The key:**
   - A ticket key in the arguments (like `ABC-123`) → use it.
   - Only a question → use `INV-<month><day><hour><minute>`, for example `INV-10201530`.
5. **Run `node .claude/kit/kit.mjs status <KEY>`.**
   - **"not started":** run `node .claude/kit/kit.mjs start <KEY> --investigate`. Then, if the dev gave a question, write it under § Question in `.claude/logs/<KEY>/investigation.md` in their words.
   - **It's an implementation task:** investigations of a running implementation happen inside `/implement`. Tell the dev that, and offer a separate `INV-…` key.
6. **Status names the stage and the skill.** Load that skill (`shopify-investigate`) with the Skill tool, and do only that stage.
7. **When the stage is finished,** run `node .claude/kit/kit.mjs done <KEY> <stage>`. The last stage is a gate and needs `--answer "<the dev's words>"`. If the script refuses, fix what it lists and run it again.
8. **Run status again and continue.** Tell the dev in one line each time the stage changes.

After a compaction or in a new session, run status first and continue from what it says.

## Rules

- **Read-only.** No theme edits, no store changes, no draft themes. The wrapper refuses the write verbs, and `conclude` refuses if theme files changed.
- **Gates are the dev's decisions.** Ask with AskUserQuestion, and record their words. `--answer` is one line of at most 200 characters, without quotes, backticks or `$`.
- **You write `investigation.md`.** Agents return reports, and you record what matters.
- **Only these skills run here:** `shopify-investigate`, `shopify-plugin:shopify` for docs, and `claude-in-chrome` for the storefront. Don't load other investigate, QA or Jira skills, or Jira MCP tools; `jira.mjs` replaces them.
- **Two failed attempts at the same thing → stop,** say what you tried and what you saw, and ask.
