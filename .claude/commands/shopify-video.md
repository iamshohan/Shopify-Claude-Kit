---
description: Make the client's walkthrough video for a task QA accepted - what's new, how to change it, where it lives. English voice with captions. Storefront scenes record on their own; theme-editor and admin scenes record in the dev's Chrome.
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---

# /shopify-video $ARGUMENTS

A video for the client, who isn't technical: what's new on their store, where it lives in the theme editor, how to use it and what to watch out for, how it behaves with different values, and how shoppers see it. Complete before short: every core change is in it. Optional: run it only when the client gets a video. The rules in `.claude/rules/kit-runs.md` apply.

## Steps

1. Run `node .claude/kit/video.mjs check`. Not `ready` → tell the dev what it reports (the fix is usually `! node .claude/kit/video.mjs setup`, once per machine) and stop.
2. Run `node .claude/kit/video.mjs start <KEY>`. It refuses before Gate 2 and after the draft was deleted: tell the dev why, and stop. Pass on a `warning` in one line.
   - Refused only for the stage, and the task's report or kit notes say QA and Gate 2 were held by hand (the kit couldn't push, the branch was merged first): ask the dev with AskUserQuestion whether QA accepted what the draft shows now. Yes → `start <KEY> --accepted "<the dev's words>"`. Never pass it on your own judgment.
3. **Write the storyboard** (the path `start` printed) from the files it lists. Fill the Scenes table, the Optional scenes table and the `Query:` line; the comment in the file lists the kinds and actions. In this order:
   1. **An opening slide:** what's new, from brief.md § Asked and the plan's At a glance.
   2. **The theme editor (chrome), one feature at a time** (a section, a block, a settings group from contract.md): where it lives, what was added, how to use it, and what to watch out for. Watch-outs come from plan.md and report.md's edge-case rows, in a sentence each, at surface level. For example: it shows only on the collections picked; with none picked it shows nowhere; it hides on page 2.
   3. **Behaviour on the draft (chrome),** only where the result depends on a value the merchant enters. Take them from QA criteria whose result changes with a setting. Change the setting in the editor and show the preview change for different kinds of values: on/off, a short vs a long text, a row number. Everything is set back afterwards (step 6).
   4. **A short storefront tour:** the result as shoppers see it. Take the pages and selectors from report.md's PASS rows (the How column), so every selector has been measured. Desktop; add mobile when the plan has a mobile difference. Admin pages for store setup (plan.md § Merchant steps after merge) are chrome scenes here.
   5. **A closing slide:** where things live (the editor path, the admin paths).
   - **Prio:** P1 for every core change, which is never left out, whatever the length. P2 for an important behaviour or watch-out, P3 for nice to have. About 5 minutes is a soft cap: past it, move P3 scenes to Optional scenes, never P1.
   - **Optional scenes:** 3-5 rows the dev may add (O1, O2…), one line each with Prio, an estimated Sec and what it shows. No Say until picked.
   - Say is the merchant's language: the labels they see in the editor, no file names, selectors, ticket text, A/B tool, risks or open QA rows.
   - `Query:` takes the A/B tool's opt-out parameter from plan.md § QA setup, if there is one.
4. **Check it before the dev sees it.** The dev doesn't want to decide video details: you decide them.
   1. **Test content:** report.md and plan.md § QA setup name the values QA set (a "QA Headline", a test code). For each storefront page in the storyboard, run `node .claude/kit/shopify.mjs fetch <KEY> <path> --find "<value>"`, and look for them in the editor scenes' settings. Note which values show and where (the banner, the tile).
   2. **Review:** have the `video-reviewer` agent check the storyboard (give it `.claude/logs/<KEY>/`). Apply what it finds yourself: add what's missing, fix the language, cut padding. Don't show the dev its list. One pass; don't run it again.
   3. Run `node .claude/kit/video.mjs durations <KEY>`: it makes the narration and writes each scene's real length into Sec.
5. **Hand it over in a few lines,** like this, and nothing more (only a point that would change what the client sees goes in too):

   > The storyboard is ready to check: `<path>`. 14 scenes, 3:30 (P1 only: 2:40). Optional scenes you can add: O1-O4 (in the file).
   >
   > **Before I record:**
   > - The draft still shows QA test text: "QA Headline 15%" and code QATEST10 in the banner, "QA inlay" in the tile. The client would see it. Replace it in the theme editor (on the draft), or tell me to film it as it is.
   > - I'll open a new Chrome window for the editor scenes. Move it to your main screen, maximise it, and leave it alone until I say recording is done (about N minutes). Your other screen is fine.

   Leave out the test-content point when there is none. Then wait. The dev edits rows, picks optional scenes ("add O2": move it into Scenes with a Say, then run `durations` again), or says to record.
6. Run `node .claude/kit/video.mjs record <KEY>`. It makes every scene's narration, records the storefront scenes and renders the slides. Cookie banners and app popups are hidden on their own; a theme popup needs a `hide`. A FAILED scene: fix its row and run `record <KEY> --scene <N>`. A password page: make it a chrome scene.
7. **Chrome scenes, in a window of their own.** Close every tab in your tab group (`tabs_close_mcp`), then `tabs_context_mcp` with `createIfEmpty`: that opens a new window. Tell the dev: "A new Chrome window just opened. Move it to your main screen, maximise it, then tell me. Don't touch it until I say recording is done." Wait for their answer. Read `.claude/kit/video-overlay.js` once; you'll run its text after every page load. For each scene:
   1. **Open the page in one `browser_batch`:** navigate, wait (the editor takes 8-40 s), run the overlay text plus `;__kc.frame(<the screenshot's coordinate-frame width>)` with `javascript_tool`, then a screenshot. In the editor that screenshot must show the draft's name with the **Draft** badge and a greyed-out **Save**. Anything else (another theme, a login or 2FA page): make the scene a slide. The store's own popups (a newsletter popup after about 90 s) can cover the preview: close it with its ×, or load the editor again.
   2. Run `node .claude/kit/video.mjs chrome-start <KEY> <N>`. It prints `minimumSceneSeconds`. No corner marks found, or the tab is too small: ask the dev to bring that window to the front and maximise it, and wait.
   3. **Record in batches.** Each `browser_batch` starts with `javascript_tool` `__kc.marks(false)` (the first time) or `__kc.now()`, and ends with `__kc.now()` and a screenshot. The two results are one stretch to keep.
      - Each click is `javascript_tool` `await __kc.move(x, y); __kc.ripple()`, then the click at the same screenshot coordinates, then a 1-2 s wait.
      - **Zoom on what the voice talks about.** The editor's settings are small at full size. For a stretch that shows settings (or a setting and its effect in the preview), call `__kc.focus({left, top, width, height})` in that batch with the area in screenshot coordinates, and append the `@x,y,w,h` it returns to that stretch in `--keep`. The video cuts to that area, at up to 2x. Keep the first stretch of a scene unzoomed, so the viewer sees where they are.
      - **Behaviour scenes:** type or toggle the value, wait until the preview shows it (2 s), and focus on the setting and the preview together. Show each kind of value in its own stretch.
      - A batch can only click what its starting screenshot shows. When a click opens something new (a section's settings), end the batch there and plan the next one from its screenshot. The time you spend between batches is cut out.
      - `__kc.highlight({left, top, width, height})` frames something, in screenshot coordinates; `__kc.highlight(null)` clears it.
      - A storefront scene in Chrome is usually one `javascript_tool` that scrolls and highlights, and returns both marks.
      - The kept stretches together should last `minimumSceneSeconds`, at most about 1 s more. Put waits before the last click, not after it.
   4. **Leave the editor as it was,** in the last batch after its closing `__kc.now()` (this part isn't kept): set every changed setting back, then a screenshot. **Save** must be grey again; if not, use the editor's undo until it is. After a behaviour scene, check every value you changed, not only Save. Never click Save, Publish, Remove section, delete, or anything else that changes the store. On admin pages, open and scroll only.
   5. Run `node .claude/kit/video.mjs chrome-stop <KEY> <N> --keep <from>-<to>[@x,y,w,h][,<from>-<to>…]`. A refused `--keep` keeps the recording: fix it and run chrome-stop again.
   6. **After the last chrome scene,** close the window's tabs (`tabs_close_mcp`) and tell the dev in one line that recording is done.
8. Run `node .claude/kit/video.mjs assemble <KEY>` and look at the `frames.png` it writes, one frame per scene. Each frame must show what its Say describes. Nothing else may show: no login page, no other tab or window, no dev-only UI (an extension's badge, a toolbar), nothing covering the feature, and no QA test text the dev didn't say to film. Re-record a wrong scene (step 6 or 7) and assemble again: only changed scenes are re-encoded.
9. Tell the dev the video's path and length, and that they watch it before it goes to the client. Ask with AskUserQuestion: "It can go to the client", or "Change something". Run `node .claude/kit/video.mjs reviewed <KEY> --answer "<the dev's words>"` only for the first. Anything else, including "good, but…", is a change: edit the storyboard, re-record those scenes, assemble, and ask again. A wish for how the kit makes videos goes into `kit.mjs note` as well.

Sending it to the client is the dev's step.
