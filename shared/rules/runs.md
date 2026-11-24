---
paths:
  - ".claude/logs/**"
  - "appspec/**"
---

# Every kit run (theme and app kits)

This kit's own rules are next to this file (`kit-runs.md` or `app-runs.md`).

- **Waiting on the client or CRO.** Some answers only the client or the CRO team can give: what customers see, content, a trade-off the ticket leaves open, an approval before going live. Flag each one as early as you can see it (the first stage that reveals it), and give the dev a ready-to-post comment: short, in the client's words, the question with its options and what each means for them. Then keep going with everything that doesn't depend on the answer, and say what you're doing meanwhile. Stop only where the answer decides the work ahead (a value the gate approves, the go-live or deploy); when the dev comes back with the reply, record it in their words and continue from there. No kit check enforces this: it's how the team works.
- **What this project does its own way** (its dev server command, a deploy step, where a draft's link goes, a quirk of its theme or app) lives in the repo's root `CLAUDE.md`, which every session loads and the kit's installer never touches. Read it at the start. When you learn such a fact that a teammate would need next time, offer to add one line there under "## Project notes", and add it on a yes. Never put credentials or client data in it.
- **Write files with the Write or Edit tool,** never `printf`, `echo`, a heredoc or `node -e`. The guard reads a shell command's text as something it could run, so text that mentions a CLI command, a deploy script or a secret file gets refused when it's written through the shell.
- **`--answer` is one line of at most 200 characters, in the dev's words, without quotes, backticks or `$`** (they break shell quoting). The full answers go in the documents.
- **Agents return reports;** you put what matters into the documents.
- **A refused chained command** (`a && b; c`): run its parts on their own to see which one the guard means, before blaming the rule.
- **Two failed attempts at the same thing → stop**, say what you tried and what you saw, and ask the dev.
- **How you talk to the dev.** The documents hold the detail; chat carries what the dev has to act on.
  - Open with what needs the dev, or "Nothing needed from you".
  - A message between gates is at most 6 lines. Point to the document section instead of quoting it.
  - Never repeat the ticket's criteria, a table that is already in a document, or anything the dev already answered.
  - Report only what is new. A finding that turned out wrong gets one line: "Earlier I said X; it was Y because Z."
  - Put "(Recommended)" only on real alternatives, never on approving or confirming your own work.
