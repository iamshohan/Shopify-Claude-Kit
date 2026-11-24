---
paths:
  - "appspec/**"
  - ".claude/logs/**"
---

# App kit runs (/app-implement, /app-investigate)

- **Decide what's clear; ask only what's the dev's call.** When the ticket, the app's own code and conventions, the archived changes or Shopify's docs answer a question, decide it, record it in proposal.md § Decided for you (one line, with why), and go on. The dev reviews those at Gate 1 and can change any of them. **Ask** (all at once, each with 2–4 options and your recommendation first) only when:
  - the change would depart from the ticket;
  - it adds what the merchant must maintain or approve: a new access scope (merchants re-approve), metafield or metaobject definitions, settings they fill in, a new app or integration;
  - it touches money: discounts, prices, payment or delivery customizations, checkout totals;
  - there are real alternatives with different trade-offs (a Function vs a checkout UI extension, an app proxy vs a theme app extension, a webhook vs polling) and nothing in the ticket picks one;
  - the ticket and the code, or two tickets, contradict each other;
  - it can't be undone cheaply: a data migration, deleting data, a removed webhook or surface merchants rely on.
  A question whose recommended option you'd have taken anyway, with nothing in this list behind it, is a decision: take it and record it.
- **Waiting on the client or CRO.** Some answers only the client or the CRO team can give: what customers see, content, a trade-off the ticket leaves open, an approval before going live. Flag each one as early as you can see it (at propose, or the first stage that reveals it), and give the dev a ready-to-post comment: short, in the client's words, the question with its options and what each means for them. Then keep going with everything that doesn't depend on the answer, and say what you're doing meanwhile. Stop only where the answer decides the work ahead (a scenario value, the deploy); when the dev comes back with the reply, record it in their words and continue from there. No kit check enforces this: it's how the team works.
- **What this project does its own way** (its dev server command, a deploy step, where a draft's link goes, a quirk of its theme or app) lives in the repo's root `CLAUDE.md`, which every session loads and the kit's installer never touches. Read it at the start. When you learn such a fact that a teammate would need next time, offer to add one line there under "## Project notes", and add it on a yes. Never put credentials or client data in it.
- **Gates are the dev's decisions.** Gate 1 hands the proposal over and waits for the dev's reply (app-propose); Gate 2 asks with AskUserQuestion. Record their words. Never infer an answer. Silence is not approval.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting).
- **The dev reads scenarios, not code.** Write so that a reader who never opens the code can say yes or no.
- **Agents return reports;** you put what matters into the documents.
- **Long kit verbs** (`verify`, `drift --regression`, `onboard`) can take minutes: the settings give Bash a long default timeout, so don't pass a shorter one.
- **Write files with the Write or Edit tool,** never `printf`, `echo`, a heredoc or `node -e`. The guard reads a shell command's text as something it could run, so a `package.json` holding a deploy script, or a `.gitignore` listing `.env`, gets refused when written through the shell.
- **One direct `node .claude/kit/app.mjs note <ID> "…"` per note,** never inside a shell function or a loop: only a direct call's text is read as text.
- **A refused chained command** (`a && b; c`): run its parts on their own to see which one the guard means, before blaming the rule. In the first app run, three "false positives" came from another part of the same command (a trailing CLI call, a `node -e` that wrote `.env` lines).
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **How you talk to the dev.** The documents hold the detail; chat carries what the dev has to act on.
  - Open with what needs the dev, or "Nothing needed from you".
  - A message between gates is at most 6 lines. Point to the document section instead of quoting it.
  - Report only what is new. A finding that turned out wrong gets one line: "Earlier I said X; it was Y because Z."
  - Put "(Recommended)" only on real alternatives, never on approving your own work.
- **When the kit itself gets in your way** (a misleading instruction, a missing verb, an unclear check, a guard block on a harmless command), record it right away: `node .claude/kit/app.mjs note <ID> "<what happened> → <what would have prevented it>" --kind friction|mistake|kit-bug|missing|idea`. Don't mention these in chat before the retro.
