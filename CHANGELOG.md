# Changelog

## 0.2.0 — 2026-10-20

- `/shopify-investigate <KEY or question>`: read-only feasibility checks, debugging and questions, in three stages (frame, gather, conclude) with a dev gate at the end.
  - Every claim is labelled Confirmed, Inferred, Assumed or Unknown, with a source.
  - Debugging needs a reproduction and at least two hypotheses.
  - The new `evidence-checker` agent re-checks Confirmed claims before the dev sees the answer.
  - Read-only is enforced: the wrapper refuses its write verbs for investigations, and `conclude` refuses if theme files changed.
  - A finished investigation continues as `/implement` on the same key, and intake reads it.
- `shopify.mjs query <name>`: kit queries for product, collection, metaobjects, menus, markets and locales, alongside shop and definitions, all validated against 2026-07. `shop` now includes the plan.
- The Admin login requests read scopes for investigations (navigation, markets, locales, translations, content, discounts, files, publications). `auth-check` reports them separately as `investigateScopesFix`.
- `cli-check` validates every kit query, not only definitions, and reports deprecated fields.

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
