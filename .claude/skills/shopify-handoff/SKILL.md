---
name: shopify-handoff
description: Stage 9 of /shopify-implement. Push the task branch, write the PR text (with the run summary), admin steps, go-live order and the Jira comment into report.md, and offer cleanup. Use only when /shopify-implement's status says the stage is handoff.
user-invocable: false
---

# Handoff

The kit prepares everything and merges nothing. Merging, posting to Jira and going live are the dev's steps. It offers a draft PR or the merge commands; the dev can decline both.

1. **Push the branch:** `git push -u origin <branch>` (already done on a GitHub-connected draft). **Test run:** skip the push, write everything below as usual, and start the PR title with "TEST RUN, not for merge"; at cleanup, offer to delete the `<KEY>-kit-test` draft and the local branch.
2. **Run summary:** `node .claude/kit/kit.mjs summary <KEY>`, for the PR body.
3. **Write `report.md` § Handoff:**
   - **PR.** A title in the repo's commit style; a body with what changed and why, the files, the store setup done (each definition with its id from the summary), the QA summary naming every row that isn't PASS ("#7 NOT TESTED: …"), the preview URL, how to test, and the run summary. **On a GitHub-connected draft:** "Before merging: `node .claude/kit/kit.mjs premerge <KEY>` lists commits made on the branch after QA, such as editor saves." Never point to `.claude/logs/…` in the PR or the Jira comment (git ignores it): paste what reviewers need inline.
   - **What differs from what was asked** (a table): one row per AC under plan.md → Differs from the ticket, per question in brief.md § Decided that starts "Client's call", and per line under Decided for you marked "(client's call)" (Ref: "client's call"). What the client gets instead, in their words, and who decided it ("you", "the dev, for you", "Shopify doesn't allow it").
   - **Deploy warning.** The base branch receives "Update from Shopify" commits (recon `deploy`) or a CI workflow deploys it: in bold at the top of the PR, **"Merging this PR deploys to the live theme."**
   - **Admin steps after merge,** numbered and exact, split into **before launch**, **the launch moment** and **after**, each step whose Save shows to shoppers at once marked. Nothing shoppers see may depend on something that doesn't exist yet (the discount code before the banner that shows it). Cover placing the section or block, metaobject entries, Translate & Adapt per locale, pinning definitions only if wanted.
   - **Go-live order,** whenever merging deploys or the feature needs admin steps; say when shoppers first see the change. **A/B ports** (tool and running state from status): with an on/off setting, merge with it off, stop the experiment in <tool>, then switch it on. Without one: merge; stop the experiment straight away and remove its code or targeting; verify on live that the native feature renders and the test's injected element is gone. Say what happens in the gap (stopping before the merge shows control to everyone; stopping late shows variant traffic both versions).
   - **Jira comment, for the dev to post** (the kit never writes to Jira), for the client and the QA team, in plain words, in this order:
     1. what's done, in one or two lines, and when shoppers first see it (at merge, or when the merchant switches it on);
     2. **every row of "What differs from what was asked"**, in the client's words, with its AC number;
     3. a preview link that shows the feature filled in (a draft that renders nothing without content: the QA preview link with when it expires, or what the client will see once content is added);
     4. for the QA team, the checklist inline, not a file path;
     5. **on a GitHub-connected draft:** "Please don't press Save in this draft's theme editor: every save becomes a change in the code under review."

     Never restate the ticket. No branch names, PR numbers, file paths, Q numbers, internal names or pass counts. Tell the dev to move the ticket to the team's review status (in Drip's Jira usually "AC Review"), not to Done: Done can start billing automation.
   - **Client check.** Spawn the `outcome-checker` agent with the key and mode `handoff`, fix the Jira comment by what it finds, and record its `Client surprises:` line and your changes under § Handoff → Client check. A small fix (the plan skipped its check for the same reason): "Skipped: small fix."
   - **Open points:** known gaps, "see report.md § You must still do", "noticed, not touched" items, leftover store data.
4. **The PR.** Write the body to `.claude/logs/<KEY>/pr.md` (report.md § PR holds the same text). A PR for the branch already exists (`gh pr view <branch>`, after a loop back): update it with `gh pr edit <branch> --body-file …`, say so in one line, and don't ask again. Otherwise offer in one AskUserQuestion, with the cleanup questions below:
   - **Create the PR as a draft (Recommended)**, only if `gh` is logged in (`gh auth status`): `gh pr create --draft --repo <owner/repo of origin> --base <baseBranch> --head <branch> --title "<title>" --body-file .claude/logs/<KEY>/pr.md`, and give its URL. A draft refused (some plans don't allow drafts on private repos): stop and tell the dev; never retry without `--draft`, never `gh pr ready`.
   - **Give me the merge commands:** print them one per line for the dev to run (a long chained `!` command breaks when pasted): `! git switch <baseBranch>`, `! git pull --ff-only`, `! git merge --no-ff <branch>`, `! git push origin <baseBranch>`; before them, on a GitHub-connected draft, `! node .claude/kit/kit.mjs premerge <KEY>`; repeat the deploy warning when merging deploys. Never run them yourself.
   - **I'll handle it myself.**
5. **Cleanup,** in the same AskUserQuestion round, only for what applies:
   - **The draft theme:** ask only when QA store values exist or the dev wants it gone; otherwise say "Draft kept for client and AC review; `shopify.mjs delete-draft <KEY>` removes it later." When asked: keep it until review ends (recommended), delete after merge, or delete now (`shopify.mjs delete-draft <KEY>`, the dev approves). A client video (`/shopify-video <KEY>`) is filmed on the draft: say so when a video is mentioned.
   - **QA test values** (the summary's store changes): keep or remove? Each removal is a mutation the dev approves: `metafieldsDelete` first (only on owners this task created), then a definition the kit created with `deleteAllAssociatedMetafields: true`, metaobject definitions last. Never delete anything the kit didn't create; QA values under a merchant's own definition are the dev's to remove in the admin: list them in Open points.
6. `kit.mjs done <KEY> handoff` (the branch moved past the commit QA measured: go back to qa as it says). If it prints a `retro`, follow its `ask` before telling the dev.
7. Tell the dev: the branch is pushed; the PR text, admin steps and Jira comment are in `.claude/logs/<KEY>/report.md`; the next steps are theirs (the PR or its URL, `kit.mjs premerge <KEY>` right before merging a GitHub-connected draft, the merge, the go-live order); kit notes, if any, are in `kit-notes.md` (`node Shopify-Claude-Kit/export-logs.mjs` shares them); a client walkthrough video is `/shopify-video <KEY>` while the draft exists; client or AC feedback later: `/shopify-implement <KEY>` with the feedback (a defect goes back to build, a changed requirement to plan).
