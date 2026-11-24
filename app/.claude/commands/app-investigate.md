---
description: Investigate this Shopify app, read-only. A question (how does X work, where is Y handled, why does Z happen) gets an answer with evidence. A ticket gets a feasibility check before anyone picks it up - what the client will get, the approaches, an estimate in agentic development hours, and the client's open questions as a draft Jira comment.
argument-hint: <JIRA-KEY or question>
disable-model-invocation: true
---

# /app-investigate $ARGUMENTS

Read-only: no edits to the app, no store writes, no change started. The notes go in `.claude/logs/<KEY or a short id>/investigation.md`.

## Every investigation

1. Read `appspec/project.md` and the archived changes that touched the area (`appspec/archive/*/proposal.md` § Scenarios: what was approved, with values and the test that proves each; and `handoff.md`).
2. Map the code with the `app-recon` agent (give it the question and those archived changes), or read it yourself when it's one or two files. The code is what actually runs.
3. Every claim names its source (`file:line`, an archived scenario, a test, a docs URL with the sentence) and a label: **Confirmed** (read or measured), **Inferred** (follows from confirmed facts) or **Unknown**.
4. An archived scenario and the code disagree → say so, with both sides; fixing it is an `/app-implement` the dev may start.

## A question

Open with the answer in one or two lines; then the evidence; then what couldn't be determined.

## A ticket: feasibility and estimate

`node .claude/kit/jira.mjs <KEY>` for the ticket. Then, in investigation.md:
- **Requirements:** one per acceptance criterion, quoted, with an owner: **Dev** (how it's built: decide it, as the approaches table) or **Client** (what customers see, content, money: a question for the client, unless the ticket settles it).
- **What the client gets:** per requirement and per surface it touches (checkout steps, the thank-you page, customer accounts, the admin, the storefront), what the client will actually see: position, look (Shopify's checkout styling, not the theme's), behaviour, where it's edited, and how that differs from what they expect. Look up where each extension target renders before calling it feasible. What needs Shopify Plus.
- **Approaches:** 2–3, with merchant control, effort, risk and upkeep (app fees, a hosted backend or none), the recommended one first.
- **Estimate in agentic development hours** (with this kit, not by hand), per part: investigation and propose, build, verify and fixes, buffer (about 20%). Development only: no client calls, deploy or review time. Add what could add hours.
- **Jira comment** for the client, in their words: the verdict per part, every difference from what they expect, the limitations, and the open client questions with their options.

Tell the dev the verdict, the recommended approach and its hours, in one line, and that `/app-implement <KEY>` would start from this file.
