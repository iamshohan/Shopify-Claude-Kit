---
description: Implement a Jira ticket in this Shopify theme (a winning A/B test, a feature, or a bug fix) from ticket to a QA'd draft theme. Resumable. Run it again with the same key to continue.
argument-hint: <TICKET-KEY> [stage] [--test]
disable-model-invocation: true
---

# /shopify-implement $ARGUMENTS

You are running the Shopify Implementation Kit for one Jira ticket. The work moves through nine stages. A script keeps track of where you are, so you never have to remember it.

## Every time, before anything else

1. No key given → run `node .claude/kit/kit.mjs list`, ask the dev which task to continue or which key to start, and stop until they answer.
2. `.claude/shopify-kit.json` missing → tell the dev to run `/shopify-setup` first, and stop.
3. Once per session, run `node .claude/kit/shopify.mjs cli-check`. If it reports problems (exit 2), tell the dev to run `/shopify-update`, and stop: the kit may no longer match the CLI. If it prints `warnings` (usually a theme login to renew), pass them on to the dev with the command they name, and go on.
4. Run `node .claude/kit/kit.mjs status <KEY>`. If it says "not started", run `node .claude/kit/kit.mjs start <KEY>`. Add `--test` when the arguments include `--test` or the dev calls it a test run.
5. The status names the current stage and the skill that owns it. **Load that skill with the Skill tool and do only that stage.**
6. When the stage's "Done when" holds, run `node .claude/kit/kit.mjs done <KEY> <stage>`. Gate stages also need `--answer "<the dev's words>"`. The script refuses if the stage's output is missing. Read its message, fix the gap, and run it again.
7. `done` (and `back`) print the new status: continue with the stage it names, the same way. Tell the dev in one line each time the stage changes, e.g. `✓ plan → approve · 2 things need you`.

Also:

- **A stage was named after the key** (e.g. `/shopify-implement ABC-123 qa`): use it only if status shows the earlier stages done. To redo an earlier stage, run `kit.mjs back <KEY> <stage> --reason "..."`.
- **After a compaction or in a new session:** run status first and continue from what it says, not from memory. If status still shows a stage you believe is finished, you skipped `done`: run it now. Never redo a gate the dev already answered.
- **Status says "finished" and the dev brings feedback** (the client's, or a missed AC): ask whether it's a defect in what was built or a changed requirement. A defect → `kit.mjs back <KEY> build --reason "<feedback>"`; a changed requirement → `kit.mjs back <KEY> plan --reason "<feedback>"`, so the plan is approved again. Then continue as usual.
- **The dev wants to stop the task:** run `kit.mjs abandon <KEY> --reason "..."`, and walk them through the cleanup list it prints.

## Rules for the whole run

The rules every kit run shares (gates, `--answer`, talking to the dev, kit notes) are in `.claude/rules/kit-runs.md`; they load once you touch the task folder. These are /shopify-implement's own:

- **Only the kit's skills run inside /shopify-implement:** the stage skill that status names, `shopify-plugin:shopify` for docs, `code-review` at build, and at QA the `kit-browser` tools (storefront) and `claude-in-chrome` (editor and admin). Don't load other QA, dev or investigate skills, even when a hook or a skill description suggests them; `shopify-qa` replaces them.
- **Scope is the ticket.** Note other problems in the report instead of fixing them.
