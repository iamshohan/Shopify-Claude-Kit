---
paths:
  - "appspec/**"
  - ".claude/logs/**"
---

# App kit runs (/app-implement, /app-investigate)

The app kit's own rules; the ones both kits share are in `runs.md` next to this file.

- **Decide what's clear; ask only what's the dev's call.** When the ticket, the app's own code and conventions, the archived changes or Shopify's docs answer a question, decide it, record it in proposal.md § Decided for you (one line, with why), and go on. The dev reviews those at Gate 1. **Ask** (all at once, each with 2–4 options and your recommendation first) only when:
  - the change would depart from the ticket;
  - it adds what the merchant must maintain or approve: a new access scope (merchants re-approve), metafield or metaobject definitions, settings they fill in, a new app or integration;
  - it touches money: discounts, prices, payment or delivery customizations, checkout totals;
  - there are real alternatives with different trade-offs (a Function vs a checkout UI extension, an app proxy vs a theme app extension, a webhook vs polling) and nothing in the ticket picks one;
  - the ticket and the code, or two tickets, contradict each other;
  - it can't be undone cheaply: a data migration, deleting data, a removed webhook or surface merchants rely on.
  A question whose recommended option you'd have taken anyway, with nothing in this list behind it, is a decision: take it and record it.
- **Gates are the dev's decisions.** Record their words. Never infer an answer; silence is not approval.
- **Long kit verbs** (`verify`, `drift --regression`, `onboard`) can take minutes: the settings give Bash a long default timeout, so don't pass a shorter one.
- **When the kit itself gets in your way** (a misleading instruction, a missing verb, an unclear check, a guard block on a harmless command), record it right away with one direct call per note, never in a shell function or loop: `node .claude/kit/app.mjs note <ID> "<what happened> → <what would have prevented it>" --kind friction|mistake|kit-bug|missing|idea`. Don't mention these in chat before the retro.
