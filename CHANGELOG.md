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
- Draft themes are named after the key alone (`ABC-123`), not `kit/<KEY>/<git user>`, which collided when devs share a git name. An existing unpublished theme with that name is adopted but treated as not made by the kit, so the kit never offers to delete it on its own. Old `kit/<KEY>/…` drafts still work.
- The build stage creates the task branch with `--no-track`, so it doesn't track the base branch.
- Fixes from the first store rehearsal (cherries, CLI 4.9.4):
  - `preview` failed on Windows: `theme preview --overrides` drops a path's backslashes, so the wrapper now passes every path with forward slashes.
  - `theme preview --json` prints its result to stderr, wrapped in a diagnostic event; the wrapper reads it from there.
  - CLI errors hid behind the `<claude-code-hint>` tag that Claude Code hides. The wrapper now drops that tag, and falls back to the exit code and raw output when there's no structured error.
  - QA: `Shopify.theme.id` is read only after load, and the editor wait is up to 60 s.
  - `compare.mjs --help` works.
- The Admin API login is optional (`adminApi` in `shopify-kit.json`). It installs Shopify's CLI app once per store, which many devs aren't allowed to do. Without it:
  - definitions and QA values become admin steps for the dev, checked in Chrome
  - investigations read admin pages and public storefront data
  - `query` and `mutate` refuse with that explanation

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
