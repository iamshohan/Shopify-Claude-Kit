# {{ID}} · Proposal

> Type: {{TYPE}}. {{TYPE_NOTE}}
> The dev reads this file at Gate 1, not the code. Keep it short and concrete.

## Why

<!-- The problem or the ticket's goal, in two or three sentences. Quote the ticket where it decides something. -->

## What changes

<!-- The behaviour, as the merchant or buyer sees it, in a few bullets. -->

{{TYPE_SECTIONS}}## Scenarios

<!-- One row per behaviour, with concrete values: amounts, currencies, counts, the exact text shown. Cover the boundary,
the empty case and the failure the merchant would notice. IDs are S1, S2, … Check is one of:
  test: <file> › <vitest full name>   logic, data and Functions (the default). The full name is the describe titles and
                                      the test title joined by single spaces; Shopify's Function template names one test
                                      per fixture: "<describe title> runs at-threshold.json". The test (or that fixture)
                                      is new or changed on the branch, except in maintenance.
  qa: <expected result>               UI only: measured on the dev store in verify (the text, the value, the viewport)
  manual: <what the reviewer checks>  only when neither works (a real card payment, an email arriving) -->

| ID | GIVEN | WHEN | THEN | Check |
| --- | --- | --- | --- | --- |

## Surfaces

<!-- Every scope, webhook, extension, target, capability, custom data definition, Prisma model or new dependency this change
adds (+), removes (-) or changes (~). Keys as `node .claude/kit/app.mjs surfaces {{ID}}` prints them (scope:read_orders,
webhook:orders/create, extension:gift-banner, capability:gift-banner/network_access, model:GiftRule, dependency:zod).
Scenario: the ID of the scenario that needs each new scope and webhook. Write "none" if nothing changes. -->

| Change | Surface | Why | Scenario |
| --- | --- | --- | --- |

## Design

<!-- Required when § Surfaces adds or changes a data model, a webhook, an extension, an app proxy or the app config:
the decisions (options weighed, why this one), the data model and migration (what happens to existing rows), which
authenticate.* each new route uses, and the deploy order with how each step rolls back. Otherwise "none". -->

## Retires

<!-- Tests an archived change bound (the ledger) that this change deletes or renames, one per line:
"- test: <file> › <name>: why". Usually "none". -->

## Needs your attention

<!-- What this change can affect beyond the new behaviour, most impact first: each surface above, data migrations,
shared code other features use, merchant re-approval. Or "none: new files only". -->

## Decided for you

<!-- One line per decision taken without asking the dev: what, and why in a few words (the ticket, the app's own pattern, an archived change, the docs). Most consequential first, at most about 10 lines. Or "none". The dev changes any of them at Gate 1. -->

## Out of scope

<!-- What this change deliberately doesn't do. -->

## Tasks

<!-- One "- [ ] …" line per task in build order, each naming the scenarios it satisfies (S1, S2), the tests and fixtures
included. Tick a task when it is committed. -->

