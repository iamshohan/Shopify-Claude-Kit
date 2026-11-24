---
description: Build a checkout UI extension or Shopify Function that only acts for A/B test visitors (gated by a cart attribute or line item property the A/B code writes), with its gate and sunset. Resumable.
argument-hint: <JIRA-KEY> [--test]
disable-model-invocation: true
---

# /app-ab $ARGUMENTS

Read `.claude/commands/app-change.md` and follow it exactly, with the type **ab**: `app.mjs start <ID> --type ab`. The propose skill says what an A/B change adds: the test's own code in `abtest/<ID>/` (variation and control), the carrier, § Gate, § Sunset, scenarios in pairs. The handoff lists activation (pasting the code into the A/B tool) and the sunset as the dev's steps.
