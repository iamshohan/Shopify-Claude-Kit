---
description: Answer a question about this Shopify app (how does X work, where is Y handled, why does Z happen) from its archived changes and its code, read-only, with evidence.
argument-hint: <question>
disable-model-invocation: true
---

# /app-ask $ARGUMENTS

Read-only: no edits, no store writes, no change started.

1. Read `appspec/project.md`. Find the archived changes that touched the area: grep `appspec/archive/*/proposal.md` (their § Scenarios say what was approved, with values, and the test that proves each) and `handoff.md`.
2. Map the code with the `app-recon` agent (give it the question and the archived changes you found), or read it yourself when it's one or two files. The code is what actually runs.
3. Answer with evidence: every claim names its source (`file:line`, an archived scenario, a test). Label each as **Confirmed** (read or measured), **Inferred** (follows from confirmed facts) or **Unknown**.
4. **An archived scenario and the code disagree** → say so, with both sides. Don't decide which is right: that's a `/app-fix` the dev may start.
5. Behaviour no archived change covers → say so; answer from the code alone.
6. Shopify platform questions (API limits, scopes, what an extension target can do) come from fresh docs via `shopify-plugin:shopify`, not memory.

Open with the answer in one or two lines; then the evidence; then what couldn't be determined.
