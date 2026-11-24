---
name: shopify-handoff
description: Stage 9 of /shopify-implement. Push the task branch, write the PR text (with the run summary), admin steps, go-live order and the Jira comment into report.md, and offer cleanup. Use only when /shopify-implement's status says the stage is handoff.
user-invocable: false
---

# Handoff

The kit prepares everything and merges nothing. Merging, posting to Jira and going live are the dev's steps. The kit offers to create the PR as a draft, or to print the merge commands for the dev to run; the dev can decline both.

1. **Push the branch:** `git push -u origin <branch>` (already done on a GitHub-connected draft).
   - **Test run** (status says TEST RUN): skip the push. Write everything below as usual so the run can be judged, and start the PR title with "TEST RUN, not for merge". At cleanup, offer to delete the `<KEY>-kit-test` draft and the local branch.
2. **Run summary:** `node .claude/kit/kit.mjs summary <KEY>`. It goes in the PR body.
3. **Write `report.md` § Handoff:**
   - **PR.** A title in the repo's commit style, and a body covering:
     - what changed and why
     - the files changed
     - the store setup done (each definition, with the IDs from the summary)
     - the QA summary, naming every row that isn't PASS ("#7 NOT TESTED: …"), so the PR claims nothing QA didn't show; `done handoff` refuses a PR that leaves one out
     - the preview URL
     - how to test
     - the run summary
     - **on a GitHub-connected draft:** "Before merging: `node .claude/kit/kit.mjs premerge <KEY>` lists commits made on the branch after QA, such as editor saves."

     Never point to `.claude/logs/…` in the PR or the Jira comment: git ignores that folder, so reviewers can't open it. Paste what they need (the QA table, the checklist) inline.
   - **What differs from what was asked** (a table): one row per AC under plan.md → Differs from the ticket, per question in brief.md § Decided that starts "Client's call", and per line under plan.md → Decided for you marked "(client's call)" (Ref: "client's call"). Say what the client gets instead, in their words, and who decided it ("you", "the dev, for you", "Shopify doesn't allow it"). `done handoff` refuses a missing row.
   - **Deploy warning.** If the base branch receives "Update from Shopify" commits (recon `deploy`) or a CI workflow deploys it, write in bold at the top of the PR: **"Merging this PR deploys to the live theme."**
   - **Admin steps after merge.** Numbered and exact: where to click and what to set. Split them into **before launch**, **the launch moment** and **after**, and mark each step whose Save shows to shoppers at once. Nothing shoppers see may depend on something that doesn't exist yet: create the discount code before the banner that shows it. Cover:
     - placing the section or block in the customizer
     - creating metaobject entries
     - Translate & Adapt for each locale
     - pinning definitions, only if wanted
   - **Go-live order,** whenever merging deploys (the deploy warning above) or the feature needs admin steps. Say when shoppers first see the change.
     - **A/B ports** (the tool and running state come from status). With an on/off setting: merge with it off, stop the experiment in <tool>, then switch the setting on, so no visitor sees both versions. Without one:
       1. Merge.
       2. Stop the experiment in <tool> straight away, and remove its code or targeting there.
       3. Verify on live: the native feature renders, and the test's injected element is gone.

       Say what happens in the gap: stopping before the merge shows control to everyone; stopping late shows variant traffic both versions.
   - **Jira comment, for the dev to post.** Jira stays read-only for the kit. Written for the client and the QA team, in plain words, in this order:
     1. what's done, in one or two lines, and when shoppers will first see it (at merge, or when the merchant switches it on);
     2. **every row of "What differs from what was asked"**, in the client's words, with its AC number;
     3. a preview link that shows the feature filled in. A draft that renders nothing without content needs the QA preview link (with when it expires) or a sentence on what the client will see once content is added;
     4. for the QA team, the checklist inline (criteria and how to check them), not a file path;
     5. **on a GitHub-connected draft:** "Please don't press Save in this draft's theme editor: every save becomes a change in the code under review." (CHE-865: 36 test edits reached the branch that way.)

     Never restate the ticket. No branch names, PR numbers, file paths, Q numbers, internal names or pass counts. Tell the dev to move the ticket to the team's review status (in Drip's Jira usually "AC Review"), not to Done: Done can start billing automation.
   - **Client check.** Spawn the `outcome-checker` agent with the key and mode `handoff`. Fix the Jira comment by what it finds, and record its `Client surprises:` line and your changes under § Handoff → Client check. `done handoff` refuses without that line, except for a small fix (the plan stage skipped its check for the same reason): write "Skipped: small fix." there.
   - **Open points:** known gaps, "see report.md § You must still do", "noticed, not touched" items, and leftover store data.
4. **The PR.** Write the PR body to `.claude/logs/<KEY>/pr.md`. A PR for the branch already exists (`gh pr view <branch>`, after a loop back): update its body with `gh pr edit <branch> --body-file …` and say so in one line; don't ask again, and don't ask cleanup questions already answered. Otherwise offer in one AskUserQuestion, together with the cleanup questions below:
   - **Create the PR as a draft (Recommended)**, only if `gh` is installed and logged in (`gh auth status`): `gh pr create --draft --repo <owner/repo of origin> --base <baseBranch> --head <branch> --title "<title>" --body-file .claude/logs/<KEY>/pr.md`, and give the dev its URL. A draft refused (some plans don't allow draft PRs on private repos): stop and tell the dev; never retry without `--draft`. Never `gh pr ready`.
   - **Give me the merge commands**, for a team that merges from the terminal. Print them for the dev to run, one per line (a long chained `!` command breaks when pasted): `! git switch <baseBranch>`, `! git pull --ff-only`, `! git merge --no-ff <branch>`, `! git push origin <baseBranch>`. Before them, on a GitHub-connected draft, `! node .claude/kit/kit.mjs premerge <KEY>`; and repeat the deploy warning when merging deploys to the live theme. Never run them yourself: the guard blocks it.
   - **I'll handle it myself.**

   report.md § PR holds the same text as pr.md.
5. **Cleanup.** In the same AskUserQuestion round, only for what applies:
   - **The draft theme:** ask only when QA store values exist or the dev wants it gone; otherwise say "Draft kept for client and AC review; `shopify.mjs delete-draft <KEY>` removes it later." When asked: keep it until client and AC review end (recommended), delete it after merge, or delete it now. Deleting uses `shopify.mjs delete-draft <KEY>`, and the dev approves it. A client walkthrough video (`/shopify-video <KEY>`) is filmed on the draft: say so when the ticket or the dev mentions a video.
   - **QA test values** (in the summary's store changes): keep or remove? Each removal is a mutation the dev approves.
     - Order: `metafieldsDelete` first (only on owners this task created, such as its metaobjects), then a definition the kit created with `deleteAllAssociatedMetafields: true` (its values go with it), metaobject definitions last.
     - Never delete anything the kit didn't create. QA values set under a merchant's own definition (on their products, for example) are the dev's to remove in the admin; the kit refuses those deletes. List them in Open points.
6. Run `kit.mjs done <KEY> handoff`. It refuses when the branch moved past the commit QA measured (or the draft isn't at the branch head): go back to qa as it says; a commit QA never saw doesn't reach the PR unmeasured.
   If it prints a `retro`, follow its `ask` before telling the dev. Nothing printed: skip this.
7. Tell the dev:
   - The branch is pushed.
   - The PR text, admin steps and Jira comment are in `.claude/logs/<KEY>/report.md`.
   - The next steps are theirs: the PR (or its URL, if the kit created it), `kit.mjs premerge <KEY>` right before merging on a GitHub-connected draft, the merge, and the go-live order.
   - If you recorded kit notes: they're in `.claude/logs/<KEY>/kit-notes.md`, and `node Shopify-Claude-Kit/export-logs.mjs` shares every repo's task logs, notes included, with the kit maintainer.
   - **A walkthrough video for the client:** `/shopify-video <KEY>`, while the draft exists.
   - **Client or AC feedback later:** run `/shopify-implement <KEY>` with the feedback. A defect goes back to build; a changed requirement goes back to plan, so it's approved again.
