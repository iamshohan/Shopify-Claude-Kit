---
description: Implement a Jira ticket in this Shopify theme (a winning A/B test, a feature, or a bug fix) from ticket to a QA'd draft theme. Resumable. Run it again with the same key to continue.
argument-hint: <TICKET-KEY> [stage]
disable-model-invocation: true
---

# /implement $ARGUMENTS

You are running the Shopify Implementation Kit for one Jira ticket. The work moves through ten stages. A script keeps track of where you are, so you never have to remember it.

## Every time, before anything else

1. No key given → run `node .claude/kit/kit.mjs list`, ask the dev which task to continue or which key to start, and stop until they answer.
2. `.claude/shopify-kit.json` missing → tell the dev to run `/shopify-setup` first, and stop.
3. Once per session, run `node .claude/kit/shopify.mjs cli-check`. It's fast unless the Shopify CLI or plugin changed. If it reports problems (exit 2), tell the dev to run `/shopify-update`, and stop: the kit may no longer match the CLI.
4. Run `node .claude/kit/kit.mjs status <KEY>`. If it says "not started", run `node .claude/kit/kit.mjs start <KEY>`.
5. The status names the current stage and the skill that owns it. **Load that skill with the Skill tool and do only that stage.**
6. When the stage's "Done when" holds, run `node .claude/kit/kit.mjs done <KEY> <stage>`. Gate stages also need `--answer "<the dev's words>"`. The script refuses if the stage's output is missing. Read its message, fix the gap, and run it again.
7. Run status again and continue with the next stage the same way. Tell the dev in one line each time the stage changes.

Also:

- **A stage was named after the key** (e.g. `/implement ABC-123 qa`): use it only if status shows the earlier stages done. To redo an earlier stage, run `kit.mjs back <KEY> <stage> --reason "..."`.
- **After a compaction or in a new session:** run status first and continue from what it says, not from memory. If status still shows a stage you believe is finished, you skipped `done`: run it now. Never redo a gate the dev already answered.
- **The dev wants to stop the task:** run `kit.mjs abandon <KEY> --reason "..."` and walk them through the cleanup list it prints.

## The stages

| # | Stage | Skill | Who decides |
| --- | --- | --- | --- |
| 1 | intake | shopify-intake | |
| 2 | analyze | shopify-intake | |
| 3 | clarify | shopify-plan | **Gate 1**: the dev answers the open questions |
| 4 | plan | shopify-plan | |
| 5 | approve | shopify-plan | **Gate 2**: the dev approves the plan |
| 6 | build | shopify-build | |
| 7 | draft | shopify-build | |
| 8 | qa | shopify-qa | |
| 9 | accept | shopify-qa | **Gate 3**: the dev accepts the QA result |
| 10 | handoff | shopify-handoff | |

## Rules for the whole run

- **Gates are the dev's decisions.** Ask with AskUserQuestion, wait for the answer, and record their words. Never infer an answer. Silence is not approval.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting). The full answers go in the documents.
- **You write the task documents** (`.claude/logs/<KEY>/brief.md`, `plan.md`, `report.md`). Subagents return reports; you put what matters into the documents.
- **Only the kit's skills run inside /implement:** the stage skill that status names, `shopify-plugin:shopify` for docs, `code-review` at build, and `claude-in-chrome` at QA. Don't load other QA, dev, investigate or Jira skills or Jira MCP tools, even when a hook or a skill description suggests them. `jira.mjs` and `shopify-qa` replace them.
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **Scope is the ticket.** Note other problems in the report instead of fixing them.
