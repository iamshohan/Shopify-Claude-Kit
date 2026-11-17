---
name: shopify-handoff
description: Stage 9 of /shopify-implement. Push the task branch, write the PR text (with the run summary), admin steps, go-live order and the Jira comment into report.md, and offer cleanup. Use only when /shopify-implement's status says the stage is handoff.
user-invocable: false
---

# Handoff

The kit prepares everything and merges nothing. Creating the PR, merging, posting to Jira and going live are the dev's steps.

1. **Push the branch:** `git push -u origin <branch>` (already done on a GitHub-connected draft).
   - **Test run** (status says TEST RUN): skip the push. Write everything below as usual so the run can be judged, and start the PR title with "TEST RUN, not for merge". At cleanup, offer to delete the `<KEY>-kit-test` draft and the local branch.
2. **Run summary:** `node .claude/kit/kit.mjs summary <KEY>`. It goes in the PR body.
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
     - Order: `metafieldsDelete` first (only on owners this task created, such as its metaobjects), then a definition the kit created with `deleteAllAssociatedMetafields: true` (its values go with it), metaobject definitions last.
     - Never delete anything the kit didn't create. QA values set under a merchant's own definition (on their products, for example) are the dev's to remove in the admin; the kit refuses those deletes. List them in Open points.
5. Run `kit.mjs done <KEY> handoff`. It refuses when the branch moved past the commit QA measured (or the draft isn't at the branch head): go back to qa as it says; a commit QA never saw doesn't reach the PR unmeasured.
   If it prints a `retro` (the run looped back, had a stage exit refused, or hit a guard block), follow its `ask` before telling the dev: one `kit.mjs note` per thing the kit caused, or `kit.mjs note <KEY> --none`. Nothing printed: skip this.
6. Tell the dev:
   - The branch is pushed.
   - The PR text, admin steps and Jira comment are in `.claude/logs/<KEY>/report.md`.
   - The next steps are theirs: create the PR, merge, follow the go-live order.
   - If you recorded kit notes: they're in `.claude/logs/<KEY>/kit-notes.md`, and `node .claude/kit/kit.mjs feedback` collects all tasks' notes into one file for the kit maintainer.
   - **Client or AC feedback later:** run `/shopify-implement <KEY>`, then `kit.mjs back <KEY> build --reason "<feedback>"`.
