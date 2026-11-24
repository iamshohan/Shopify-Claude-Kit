---
description: Onboard an existing Shopify app to the App Kit - create appspec/ (project.md, changes/, archive/), record the app's current surfaces (scopes, webhooks, extensions, Prisma models) from its config files, and the security baseline.
disable-model-invocation: true
---

# /app-onboard

1. `.claude/app-kit.json` missing → `/app-setup` first, and stop.
2. Work on a branch: `git fetch origin`, then `git switch -c kit-onboard --no-track origin/<baseBranch>` (ask first if the tree has uncommitted changes).
3. Run `node .claude/kit/app.mjs onboard`. It creates `appspec/`, writes `appspec/surfaces.json` deterministically from `shopify.app*.toml`, the extension TOMLs, the Prisma schema and the package files, and `appspec/security-baseline.json` from `shopify app security check`. Show the dev the surface counts and the security findings it prints. If the security check couldn't run, say so: running onboard again later records the baseline (until then verify treats findings in files a change didn't touch as older).
4. Fill `appspec/project.md`, a few factual lines per section. Read the repo's own `README.md`, `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`, `shopify.app.toml` and `package.json`; spawn `app-recon` for a map if the app is large. No guesses: write "unknown" rather than invent.
   **Wrong baseline** (the dev toml was still nearly empty, the template was onboarded by mistake): fix the cause, then `node .claude/kit/app.mjs onboard --redo`. It rewrites `surfaces.json` and the security baseline while `appspec/` isn't committed yet; after the commit, a change records what changed.
5. Commit `appspec/` (`git add appspec` and commit) and push the branch (`git push -u origin kit-onboard`). Then give the dev the merge in one step: the compare link onboard prints (with `gh`: offer `gh pr create --base <baseBranch> --head kit-onboard`). **A change can't start until `kit-onboard` is merged into the base branch**: `app.mjs start` refuses before, because every change measures its surfaces against the base.

Tell the dev: what was recorded, and that `/app-change` is next.
