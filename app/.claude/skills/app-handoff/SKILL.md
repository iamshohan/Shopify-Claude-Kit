---
name: app-handoff
description: The handoff stage of the App Kit. Record the change's surfaces in surfaces.json, move it to appspec/archive/ (its bound tests join the ledger), commit, push the branch, and hand the dev the PR text and deploy checklist. Use only when app.mjs status says the stage is handoff.
user-invocable: false
---

# Handoff

1. **Keep `appspec/project.md` true.** If the change added or removed what it describes (a backend, a route, a model, an extension), update those lines first, in the same commit. The first real run deleted the template backend and left project.md describing it.
2. **A comment for the client** first, in proposal.md § Client comment (proposal.md is still open; handoff.md isn't yours to write): what's done and when shoppers first see it (after the deploy, or when the block is placed), every way the result differs from the ticket in the client's words, and for an A/B change what the client or CRO does to start the test. Plain words: no branch names, file paths, scenario ids or internal names. An answer from the client or CRO still open: end with it as a question. Tell the dev to move the ticket to the team's review status (usually "AC Review"), not to Done: Done can start billing automation.
3. **Hand off.** Run `node .claude/kit/app.mjs handoff <ID>`. It refuses unless verify passed on the current code and every `qa:` scenario is measured. It then:
   - updates `appspec/surfaces.json` with each new surface's reason, and the security baseline with the findings verify saw
   - writes `handoff.md` and moves the change to `appspec/archive/<date>-<ID>/`; its `test:` scenarios now join the ledger every later verify runs (minus what § Retires lists)

   If it stops because a file couldn't be written or the folder couldn't move, its message says why: fix that and run `handoff <ID>` again (it writes the same files again).
4. **Commit and push** with the commands it prints (`git add -- appspec`, the commit, `git push -u origin <branch>`). A test run never pushes (the guard blocks it).
5. **Tell the dev**, in at most 8 lines:
   - the PR text is in `appspec/archive/<date>-<ID>/handoff.md` § PR description. Offer in one AskUserQuestion: **Open the PR as a draft** (only with `gh` logged in: `gh pr create --draft --repo <owner/repo of origin> --base <base> --head <branch> --body-file <handoff.md's PR text>`; never retry without `--draft`), **Give me the merge commands** (print one per line for the dev to run: `! git switch <base>`, `! git pull --ff-only`, `! git merge --no-ff <branch>`, `! git push origin <base>`; a change stacked on `kit-onboard` merges `kit-onboard` first, the same way), or **I'll handle it myself**. Never run a merge or a push to the base yourself.
   - the deploy checklist in the same file: the dev deploys, in that order; the kit never does
   - the manual checks the reviewer still does
6. If `handoff` printed a `retro` (the run looped back, was refused or blocked), record each kit cause with `app.mjs note <ID> "…" --kind <kind>`.

**Done when:** the handoff ran, the result is committed and pushed (not in a test run), and the dev has the PR text and checklist. `app.mjs status <ID>` says what's left if you're unsure.
