---
paths:
  - ".claude/logs/**"
---

# Kit runs (/shopify-implement and /shopify-investigate)

- **Decide what's clear; ask only what's the dev's call.** When the ticket, the A/B winner, the theme's own pattern or a clear convention answers a question, decide it, record it, and tell the dev in one line ("Decided: … because …"). The dev reviews those at the next gate and can change any of them. **Ask** (all at once, each with 2–4 options and your recommendation first) only when:
  - the work would depart from a quoted acceptance criterion or from the A/B winner;
  - it creates something the client or merchant must maintain: a metafield or metaobject definition, data entry per product, a new app or integration;
  - it touches money: prices, discounts, checkout, shipping or payments;
  - there are real alternatives with different trade-offs in effort, risk or what the merchant controls, and nothing in the ticket picks one;
  - the ticket and the A/B test, or two tickets, contradict each other, or the code can't settle it;
  - it can't be undone cheaply later.
  A question whose recommended option you'd have taken anyway, with nothing in this list behind it, is a decision: take it and report it.
- **Waiting on the client or CRO.** Some answers only the client or the CRO team can give: what customers see, content, a trade-off the ticket leaves open, an approval before going live. Flag each one as early as you can see it (intake, or the first stage that reveals it), and give the dev a ready-to-post comment: short, in the client's words, the question with its options and what each means for them. Then keep going with everything that doesn't depend on the answer, and say what you're doing meanwhile. Stop only where the answer decides the work ahead (a question in the plan, the go-live); when the dev comes back with the reply, record it in their words and continue from there. No kit check enforces this: it's how the team works.
- **What this project does its own way** (its dev server command, a deploy step, where a draft's link goes, a quirk of its theme or app) lives in the repo's root `CLAUDE.md`, which every session loads and the kit's installer never touches. Read it at the start. When you learn such a fact that a teammate would need next time, offer to add one line there under "## Project notes", and add it on a yes. Never put credentials or client data in it.
- **Write files with the Write or Edit tool,** never `printf`, `echo`, a heredoc or `node -e`. The guard reads a shell command's text as something it could run, so text that mentions a CLI command or a secret file gets refused when it's written through the shell.
- **Gates are the dev's decisions.** Gate 1 hands the plan over and waits for the dev's reply (shopify-plan); the others ask with AskUserQuestion. Wait for the answer, and record their words. Never infer an answer. Silence is not approval.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting). The full answers go in the documents.
- **You write the task documents** in `.claude/logs/<KEY>/`. Agents return reports; you put what matters into the documents.
- **Long verbs take minutes:** `shopify.mjs draft`, `push`, `verify` and `check`, and `compare.mjs`. The kit's settings give Bash enough time; wait for them.
- **A refused chained command** (`a && b; c`): run its parts on their own to see which one the guard means, before blaming the rule. In the first app run, three "false positives" came from another part of the same command (a trailing CLI call, a `node -e` that wrote `.env` lines).
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **How you talk to the dev.** The documents hold the detail; chat carries what the dev has to act on.
  - Open with what needs the dev, or "Nothing needed from you".
  - A message between gates is at most 6 lines. Point to the document section instead of quoting it.
  - Never repeat the ticket's criteria, a table that is already in a document, or anything the dev already answered.
  - Report only what is new. A finding that turned out wrong gets one line: "Earlier I said X; it was Y because Z."
  - Put "(Recommended)" only on real alternatives, never on approving or confirming your own work.
- **Admin steps you can offer to do in the dev's Chrome.** When a step is the dev's (the kit has no verb for it) but you could click it in the admin with Claude in Chrome, add one line after the steps: "I can do this in your Chrome if you want." Do it only after a yes, then check the result with the kit's read-only verb and say what you changed. The guard doesn't see Chrome clicks, so only these qualify:

  | Offer | After it, check with |
  | --- | --- |
  | Connect the draft theme from the task branch on GitHub (Online Store → Themes → Add theme → Connect from GitHub). Pick the task branch by name; if the list shows anything else selected, stop. | `shopify.mjs draft <KEY> --github` (unpublished, named for the task) |
  | Create the plan's metafield or metaobject definitions in Settings → Custom data, with `adminApi: false`, field by field as the plan lists them | read the definitions page back |
  | Duplicate the active checkout configuration for QA, and place an app block on the copy only. Add: "That page also has the live configuration's Publish: I'll only use Duplicate on it." | the configuration list (the copy is unpublished) |

  **Never offer, whatever the dev says:** anything in the live theme's editor or code, publishing a theme or a checkout configuration, discounts, prices, shipping or payments, installing apps or granting access, logins and staff permissions, posting to Jira. Those stay the dev's.
- **When the kit itself gets in your way**, record it as soon as it happens: an instruction that misled you, a missing verb, a check that wanted something unclear, a guard block on a harmless command, a correction from the dev that the kit should have prevented. Use `kit.mjs note <KEY> "<what happened> → <what would have prevented it>" --kind friction|mistake|kit-bug|missing|idea`. These are for the kit's maintainer: don't mention them in chat before the retro.
