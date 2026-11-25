---
name: app-handoff
description: The handoff stage of the App Kit. Record the change's surfaces in surfaces.json, move it to appspec/archive/ (its bound tests join the ledger), commit, push the branch, and hand the dev the PR text and deploy checklist. Use only when app.mjs status says the stage is handoff.
user-invocable: false
---

# Handoff

1. **Keep `appspec/project.md` true.** If the change added or removed what it describes (a backend, a route, a model, an extension), update those lines first, in the same commit.
2. **A comment for the client** in proposal.md § Client comment (handoff.md isn't yours to write): what's done and when shoppers first see it (after the deploy, or when the block is placed), every way the result differs from the ticket in the client's words, and for an A/B change what the client or CRO does to start the test. Plain words: no branch names, file paths, scenario ids or internal names. An answer still open from the client or CRO: end with it as a question. Tell the dev to move the ticket to the team's review status (usually "AC Review"), not to Done: Done can start billing automation.
   Say only what happened: the kit never deploys, places blocks on the client's store or sets up the A/B tool, so the comment says what the dev or the client does next, not that it's done. QA's § You must still do goes to the dev (step 6), not into the comment.
3. **Read as the client.** Run the `outcome-checker` agent (mode `handoff`, with the change ID). Fix the comment where it's right, and record it: `node .claude/kit/app.mjs review <ID> handoff --found "<findings and what you changed>"`. A `--quick` change skips this.
4. **Hand off:** `node .claude/kit/app.mjs handoff <ID>`. It updates surfaces.json and the security baseline, writes handoff.md and moves the change to `appspec/archive/`. If it stops on a file it couldn't write or move, fix that and run it again.
5. **Commit and push** with the commands it prints. A test run never pushes.
6. **Tell the dev**, in at most 8 lines:
   - the PR, without asking: with `gh` logged in, open it as a draft (`gh pr create --draft --repo <owner/repo of origin> --base <base> --head <branch> --body-file <handoff.md's PR text>`; never retry without `--draft`) and give its link; without `gh`, the compare link handoff printed. The PR text is in `appspec/archive/<date>-<ID>/handoff.md` § PR description. Merge commands only if the dev asks (one per line: `! git switch <base>`, `! git pull --ff-only`, `! git merge --no-ff <branch>`, `! git push origin <base>`; a change stacked on `kit-onboard` merges that first). Never run a merge or a push to the base yourself.
   - a fix after handoff, while the PR is open: `/app-implement <new-id>` with `--quick` on this same branch (same PR)
   - the deploy checklist in the same file: the dev deploys, in that order; the kit never does
   - the manual checks the reviewer still does, and QA's § You must still do (what the dev checks on the client's store after deploy)
7. If `handoff` printed a `retro`, record each kit cause with `app.mjs note <ID> "…" --kind <kind>`.

**Done when:** the handoff ran, the result is committed and pushed (not in a test run), and the dev has the PR text and checklist.
