---
description: Feasibility check and estimate before anyone picks up a ticket. Reads the ticket, settles what the ticket and the code answer, asks the dev only the real calls, and answers whether it can be built, the limitations, what the client will get, the approaches with their trade-offs, and an estimate in agentic development hours. Read-only, with evidence. The same flow as /shopify-investigate with the type set to feasibility. Resumable.
argument-hint: <TICKET-KEY or a description of what's wanted>
disable-model-invocation: true
---

# /shopify-feasibility $ARGUMENTS

This is `/shopify-investigate` with the type fixed to `feasibility`: one flow under a name devs look for before picking up a ticket. Read `.claude/commands/shopify-investigate.md` and follow its steps and rules exactly, with these differences:

1. **After starting** (`kit.mjs start <KEY> --investigate`), and whenever status shows the gather stage with no type yet, run `node .claude/kit/kit.mjs set <KEY> type=feasibility`.
2. **An existing investigation of another type** (debug or question): tell the dev, and continue it as it is with `/shopify-investigate <KEY>` rather than changing its type midway.
3. **At the end,** tell the dev in one line: the verdict, the recommended approach and its agentic hours, and that `/shopify-implement <KEY>` would start from this report.
