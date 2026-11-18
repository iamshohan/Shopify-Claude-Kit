---
description: Make the client's walkthrough video for a task QA accepted - what's new, how to change it, where it lives. English voice with captions. Storefront scenes record on their own; theme-editor and admin scenes record in the dev's Chrome.
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---

# /shopify-video $ARGUMENTS

A short video (1-3 minutes) for the client, who isn't technical: what's new on their store, how to change it, and where it lives. Optional: run it only when the client gets a video. The rules in `.claude/rules/kit-runs.md` apply.

## Steps

1. Run `node .claude/kit/video.mjs check`. Not `ready` → tell the dev what it reports (the fix is usually `! node .claude/kit/video.mjs setup`, once per machine) and stop.
2. Run `node .claude/kit/video.mjs start <KEY>`. It refuses before Gate 2 and after the draft was deleted: tell the dev why, and stop. Pass on a `warning` in one line.
   - Refused only for the stage, and the task's report or kit notes say QA and Gate 2 were held by hand (the kit couldn't push, the branch was merged first): ask the dev with AskUserQuestion whether QA accepted what the draft shows now. Yes → `start <KEY> --accepted "<the dev's words>"`. Never pass it on your own judgment.
3. **Write the storyboard** (the path `start` printed) from the files it lists. Fill the table and the `Query:` line; the comment in the file lists the kinds and actions.
   - Scene 1, a slide: what's new, from brief.md § Asked and the plan's At a glance.
   - Storefront scenes for what shoppers see. Take the pages and selectors from report.md's PASS rows (the How column), so every selector has been measured. Desktop; add mobile when the plan has a mobile difference.
   - Chrome scenes for how to change it: the theme editor for the settings the merchant uses (contract.md), admin pages for store setup (plan.md § Merchant steps after merge).
   - Last scene, a slide: where things live (the editor path, the admin paths).
   - 5-10 scenes, 3 minutes at most. Say is the merchant's language: the labels they see in the editor, no file names, selectors, ticket text, A/B tool, risks or open QA rows.
   - `Query:` takes the A/B tool's opt-out parameter from plan.md § QA setup, if there is one.
4. **Hand it over like Gate 1.** Give the storyboard's path, the scene count and the rough length, then wait. The dev edits it or says to record.
5. Run `node .claude/kit/video.mjs record <KEY>`. It makes every scene's narration, records the storefront scenes and renders the slides. A FAILED scene: fix its row and run `record <KEY> --scene <N>`. A password page: make it a chrome scene.
6. **Chrome scenes.** Tell the dev once, before the first: "Recording in your Chrome now (about N minutes). Leave that window alone: no tab switching, moving, hovering or clicking in it. Your other screen is fine." Read `.claude/kit/video-overlay.js` once; you'll run its text after every page load. For each scene:
   1. **Open the page in one `browser_batch`:** navigate, wait (the editor takes 8-40 s), run the overlay text plus `;__kc.frame(<the screenshot's coordinate-frame width>)` with `javascript_tool`, then a screenshot. In the editor that screenshot must show the draft's name with the **Draft** badge and a greyed-out **Save**. Anything else (another theme, a login or 2FA page): make the scene a slide.
   2. Run `node .claude/kit/video.mjs chrome-start <KEY> <N>`. It prints `minimumSceneSeconds`. No corner marks found: the tab isn't in front in a window of its own. Ask the dev to drag it into its own window on a screen they aren't using, and wait.
   3. **Record in batches.** Each `browser_batch` starts with `javascript_tool` `__kc.marks(false)` (the first time) or `__kc.now()`, and ends with `__kc.now()` and a screenshot. The two results are one stretch to keep.
      - Each click is `javascript_tool` `await __kc.move(x, y); __kc.ripple()`, then the click at the same screenshot coordinates, then a 2-3 s wait.
      - A batch can only click what its starting screenshot shows. When a click opens something new (a section's settings), end the batch there and plan the next one from its screenshot. The time you spend between batches is cut out.
      - `__kc.highlight({left, top, width, height})` frames something, in screenshot coordinates; `__kc.highlight(null)` clears it.
      - A storefront scene in Chrome is usually one `javascript_tool` that scrolls and highlights, and returns both marks.
      - The kept stretches together should last `minimumSceneSeconds`, at most about 1 s more. Put waits before the last click, not after it.
   4. **Leave the editor as it was,** in the last batch after its closing `__kc.now()` (this part isn't kept): set every changed setting back, then a screenshot. **Save** must be grey again; if not, use the editor's undo until it is. Never click Save, Publish, Remove section, delete, or anything else that changes the store. On admin pages, open and scroll only.
   5. Run `node .claude/kit/video.mjs chrome-stop <KEY> <N> --keep <from>-<to>[,<from>-<to>…]`.
7. Run `node .claude/kit/video.mjs assemble <KEY>` and look at the `frames.png` it writes, one frame per scene. Each frame must show what its Say describes. Nothing else may show: no login page, no other tab or window, no dev-only UI (an extension's badge, a toolbar), and nothing covering the feature. Re-record a wrong scene (step 5 or 6) and assemble again: only changed scenes are re-encoded.
8. Tell the dev the video's path and length, and that they watch it before it goes to the client. Ask with AskUserQuestion: watched it and it can go, or change something. A change: edit the storyboard, re-record those scenes, assemble. Watched: `node .claude/kit/video.mjs reviewed <KEY> --answer "<the dev's words>"`.

Sending it to the client is the dev's step.
