---
name: app-verify
description: The verify and accept stages of the App Kit. Run every automated check (surfaces, the scenarios' tests, the test ledger, the repo's verify commands, Function fixtures and instruction counts, bundle size, security check), measure the qa scenarios on the dev store, record the security review, then take the result to Gate 2. Use only when app.mjs status says the stage is verify or accept.
user-invocable: false
---

# Verify and accept

## Stage: verify

1. **Automated.** Run `node .claude/kit/app.mjs verify <ID>`. It runs every automated check and records the result against the current app code.
   - Any FAIL → back to build with the failing lines: `app.mjs back <ID> build --reason "<check>: <one line>"`.
   - **ledger: gone** → a test an earlier change bound was deleted or renamed. Restore it, or, if the change means it, go back to propose, list it under § Retires and ask Gate 1 again.
   - **surfaces: changed outside the kit** and **security check didn't run** are WARNs: tell the dev in one line (the security check is often a login: `! shopify auth login`; run verify again once it can). Other WARNs: read them; a real problem goes back to build.
2. **QA:** load the `app-qa` skill and do it: the `qa:` scenarios, the Figma frames, the A/B journeys, live data against its source, and the blind QA run, all on the dev store on the current code. A change with no `qa:` scenario and no UI skips it.
3. **Reviews.** verify's `reviews` says whether build's code review still covers this code. If not (a fix loop changed it), run `code-review` on what changed (`low` for a delta under about 30 lines, else `high`) and record it: `app.mjs review <ID> code --found "…"`. Run `security-review` on the change's diff and record it: `app.mjs review <ID> security --found "<what it found and what was done>"`. A real finding goes back to build.
4. Commit the change folder on the branch.

**Done when:** verify passed on the current code, every `qa:` scenario and Q row is PASS (or waived), the QA the change owes is recorded (done names what's missing: blind QA, a frame, a journey, a data check), and both reviews are recorded on this code. Run `app.mjs done <ID> verify`.

## Stage: accept (Gate 2)

Run `node .claude/kit/app.mjs gate <ID>`. Ask the dev with AskUserQuestion, built from it, in at most 20 lines:
- first, `notProvenYet` rows that aren't PASS, each with its fallback: the dev picks the fallback or accepts the risk by name
- the result: each check's verdict, the scenarios and `qaBeyondScenarios` with their results (QA as measured, and how), the blind QA's FAILs; a WARN in a line each
- § You must still do (from app-qa): what the dev checks on the client's store
- **changed since Gate 1**, if any: each scenario, § Surfaces or § Retires change from what they approved
- the surfaces that need attention, and the deploy steps they imply
- the manual checks left for the reviewer, and any waived scenario
- anything you are unsure of
Options: "Accept" and "Not yet" (the dev says what). On accept: `node .claude/kit/app.mjs done <ID> accept --answer "<the dev's words>"`. On "Not yet": go back to the stage that fixes it.

**Done when:** the dev accepted.
