---
name: app-handoff
description: The handoff stage of the App Kit. Record the change's surfaces in surfaces.json, move it to appspec/archive/ (its bound tests join the ledger), commit, push the branch, and hand the dev the PR text and deploy checklist. Use only when app.mjs status says the stage is handoff.
user-invocable: false
---

# Handoff

1. **Keep `appspec/project.md` true.** If the change added or removed what it describes (a backend, a route, a model, an extension), update those lines first, in the same commit. The first real run deleted the template backend and left project.md describing it.
2. **Hand off.** Run `node .claude/kit/app.mjs handoff <ID>`. It refuses unless verify passed on the current code and every `qa:` scenario is measured. It then:
   - updates `appspec/surfaces.json` with each new surface's reason, and the security baseline with the findings verify saw
   - writes `handoff.md` and moves the change to `appspec/archive/<date>-<ID>/`; its `test:` scenarios now join the ledger every later verify runs (minus what § Retires lists)

   If it stops because a file couldn't be written or the folder couldn't move, its message says why: fix that and run `handoff <ID>` again (it writes the same files again).
3. **Commit and push** with the commands it prints (`git add -- appspec`, the commit, `git push -u origin <branch>`). A test run never pushes (the guard blocks it).
4. **Tell the dev**, in at most 8 lines:
   - the PR text is in `appspec/archive/<date>-<ID>/handoff.md` § PR description (offer to open the PR with `gh pr create` using it; only if they say yes)
   - the deploy checklist in the same file: the dev deploys, in that order; the kit never does
   - the manual checks the reviewer still does
5. If the run had friction the kit caused, `app.mjs retro <ID>` lists the signals; record each kit cause with `app.mjs note <ID> "…" --kind <kind>`. Optional.

**Done when:** the handoff ran, the result is committed and pushed (not in a test run), and the dev has the PR text and checklist. `app.mjs status <ID>` says what's left if you're unsure.
