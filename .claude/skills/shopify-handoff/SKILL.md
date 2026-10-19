---
name: shopify-handoff
description: Stage 10 of /implement. Push the task branch, write the PR text (with the run summary), admin steps, go-live order and the Jira comment into report.md, and offer cleanup. Use only when /implement's status says the stage is handoff.
user-invocable: false
---

# Handoff

The kit prepares everything and merges nothing. Creating the PR, merging, posting to Jira and going live are the dev's steps.

1. **Push the branch:** `git push -u origin <branch>`. Never push the base branch; the guard blocks it anyway.
2. **Run summary:** `node .claude/kit/kit.mjs summary <KEY>`. It gives the time per stage, loops back, gate answers, QA verdict counts and store changes. It goes in the PR body and gives the team its numbers.
3. **Write `report.md` § Handoff:**
   - **PR.** A title in the repo's commit style, and a body covering:
     - what changed and why
     - the files changed
     - the store setup done (each definition, with the IDs from the summary)
     - the QA summary
     - the preview URL
     - how to test
     - the run summary
   - **Deploy warning.** If the base branch receives "Update from Shopify" commits (recon `deploy`) or a CI workflow deploys it, write in bold at the top of the PR: **"Merging this PR deploys to the live theme."**
   - **Admin steps after merge.** Numbered and exact: where to click and what to set. Cover:
     - placing the section or block in the customizer
     - creating metaobject entries
     - Translate & Adapt for each locale
     - pinning definitions, only if wanted
   - **Go-live order** (A/B ports; the tool and running state come from status):
     1. Merge.
     2. Stop the experiment in <tool> straight away, and remove its code or targeting there.
     3. Verify on live: the native feature renders, and the test's injected element is gone.

     Say what happens in the gap either way. Stopping before the merge shows control to everyone. Stopping late shows variant traffic both versions.
   - **Jira comment, for the dev to post.** Jira stays read-only for the kit. Keep it short: what's done, the preview URL, what to review.
     - Tell the dev to move the ticket to the team's review status (in Drip's Jira usually "AC Review"), not to Done. Done can start billing automation.
     - The QA team reviews with `report.md` § Criteria.
   - **Open points:** known gaps, the "dev checks by hand" list, "noticed, not touched" items, and leftover store data.
4. **Cleanup.** Ask with AskUserQuestion:
   - **The draft theme:** keep it until client and AC review end (recommended), delete it after merge, or delete it now. Deleting uses `shopify.mjs delete-draft <KEY>`, and the dev approves it.
   - **QA test values** (in the summary's store changes): keep or remove? Each removal is a mutation the dev approves.
     - Order: `metafieldsDelete` first, then a definition the kit created with `deleteAllAssociatedMetafields: true`, metaobject definitions last.
     - Never delete anything the kit didn't create.
5. Run `kit.mjs done <KEY> handoff`.
6. Tell the dev:
   - The branch is pushed.
   - The PR text, admin steps and Jira comment are in `.claude/logs/<KEY>/report.md`.
   - The next steps are theirs: create the PR, merge, follow the go-live order.
   - **Client or AC feedback later:** run `/implement <KEY>`, then `kit.mjs back <KEY> build --reason "<feedback>"`.
