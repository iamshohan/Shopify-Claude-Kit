---
paths:
  - ".claude/logs/**"
---

# Kit runs (/shopify-implement and /shopify-investigate)

- **Gates are the dev's decisions.** Ask with AskUserQuestion, wait for the answer, and record their words. Never infer an answer. Silence is not approval.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting). The full answers go in the documents.
- **You write the task documents** in `.claude/logs/<KEY>/`. Agents return reports; you put what matters into the documents.
- **Long verbs take minutes:** `shopify.mjs draft`, `push`, `verify` and `check`, and `compare.mjs`. The kit's settings give Bash enough time; wait for them.
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **How you talk to the dev.** The documents hold the detail; chat carries what the dev has to act on.
  - Open with what needs the dev, or "Nothing needed from you".
  - A message between gates is at most 6 lines. Point to the document section instead of quoting it.
  - Never repeat the ticket's criteria, a table that is already in a document, or anything the dev already answered.
  - Report only what is new. A finding that turned out wrong gets one line: "Earlier I said X; it was Y because Z."
  - Put "(Recommended)" only on real alternatives, never on approving or confirming your own work.
- **When the kit itself gets in your way**, record it as soon as it happens: an instruction that misled you, a missing verb, a check that wanted something unclear, a guard block on a harmless command, a correction from the dev that the kit should have prevented. Use `kit.mjs note <KEY> "<what happened> → <what would have prevented it>" --kind friction|mistake|kit-bug|missing|idea`. These are for the kit's maintainer: don't mention them in chat before the retro.
