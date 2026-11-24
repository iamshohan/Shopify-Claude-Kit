---
paths:
  - "appspec/**"
  - ".claude/logs/**"
---

# App kit runs (/app-change, /app-fix, /app-maintain, /app-ab)

- **Decide what's clear; ask only what's the dev's call.** When the ticket, the app's own code and conventions, the archived changes or Shopify's docs answer a question, decide it, record it in proposal.md § Decided for you (one line, with why), and go on. The dev reviews those at Gate 1 and can change any of them. **Ask** (all at once, each with 2–4 options and your recommendation first) only when:
  - the change would depart from the ticket;
  - it adds what the merchant must maintain or approve: a new access scope (merchants re-approve), metafield or metaobject definitions, settings they fill in, a new app or integration;
  - it touches money: discounts, prices, payment or delivery customizations, checkout totals;
  - there are real alternatives with different trade-offs (a Function vs a checkout UI extension, an app proxy vs a theme app extension, a webhook vs polling) and nothing in the ticket picks one;
  - the ticket and the code, or two tickets, contradict each other;
  - it can't be undone cheaply: a data migration, deleting data, a removed webhook or surface merchants rely on.
  A question whose recommended option you'd have taken anyway, with nothing in this list behind it, is a decision: take it and record it.
- **Gates are the dev's decisions.** Gate 1 hands the proposal over and waits for the dev's reply (app-propose); Gate 2 asks with AskUserQuestion. Record their words. Never infer an answer. Silence is not approval.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting).
- **The dev reads scenarios, not code.** Write so that a reader who never opens the code can say yes or no.
- **Agents return reports;** you put what matters into the documents.
- **Long kit verbs** (`verify`, `drift --regression`, `onboard`) can take minutes: the settings give Bash a long default timeout, so don't pass a shorter one.
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **How you talk to the dev.** The documents hold the detail; chat carries what the dev has to act on.
  - Open with what needs the dev, or "Nothing needed from you".
  - A message between gates is at most 6 lines. Point to the document section instead of quoting it.
  - Report only what is new. A finding that turned out wrong gets one line: "Earlier I said X; it was Y because Z."
  - Put "(Recommended)" only on real alternatives, never on approving your own work.
- **When the kit itself gets in your way** (a misleading instruction, a missing verb, an unclear check, a guard block on a harmless command), record it right away: `node .claude/kit/app.mjs note <ID> "<what happened> → <what would have prevented it>" --kind friction|mistake|kit-bug|missing|idea`. Don't mention these in chat before the retro.
