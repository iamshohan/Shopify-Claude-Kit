# Changelog

## 0.1.0 — 2026-10-20

First version, before the pilot.

- `/implement <KEY>`: ten stages with three human gates (clarify, approve, accept), resumable through `kit.mjs` state and exit checks. One command handles A/B ports, features and bug fixes.
- `/shopify-setup`: proves the guard is live, checks the CLI and plugin, logins and scopes, and writes `shopify-kit.json`.
- `/shopify-update`: re-verifies every Shopify CLI command, flag and output field the kit uses (`shopify.mjs cli-check`) after a CLI or plugin update.
- Shopify CLI only through `kit/shopify.mjs`:
  - drafts are copies of the live theme named `kit/<KEY>/<dev>`
  - pushes upload only changed files and include a live-JSON drift check
  - virtual previews for settings
  - theme check reports only offenses the branch introduced
  - read and mutate Admin GraphQL, pinned to API 2026-07
- Guard hook (`hooks/guard.mjs`, 93 self-test cases): blocks direct CLI and Theme Kit use, pushes and commits to protected branches, credential and state access. It asks before store mutations, draft deletion, discarding git commands, and edits to merchant JSON and kit files.
- Customizer QA: `contract.mjs` checks what the merchant will see, from the schemas; the editor is checked by screenshots via deep links; plus a hand-check list for the dev.
- Task logs per ticket: `brief.md`, `plan.md`, `report.md`, `contract.md`, `state.json`; `kit.mjs summary` gives the numbers for the PR and for reporting.
- Reviewed before release by six reviewers (project manager, automation-engineer accuracy, scalability, Claude-setup effectiveness, Shopify CLI/plugin use, customizer QA), and their findings were fixed.
