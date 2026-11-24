---
description: Make the client's walkthrough video for a task QA accepted - what's new, how to change it, where it lives. English voice with captions. Storefront scenes record on their own; theme-editor and admin scenes are stills from the dev's Chrome.
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---

# /shopify-video $ARGUMENTS

A video for the client, who isn't technical: what's new on their store, where it lives in the theme editor, how to use it and what to watch out for, how it behaves with different values, and how shoppers see it. Complete before short: every core change is in it. Optional: run it only when the client gets a video. The rules in `.claude/rules/runs.md` and `kit-runs.md` apply.

## Steps

1. Run `node .claude/kit/video.mjs check`. Not `ready` → run `node .claude/kit/video.mjs setup` yourself (once per machine, about 100 MB outside the repo) and check again; stop only if it still isn't ready. `ready` covers storefront scenes and slides only. Theme-editor scenes also need the `mcp__claude-in-chrome__*` tools in this session: if they aren't in your tool list, ask the dev to open Chrome with the Claude in Chrome extension and connect it (`/chrome` in Claude Code), then restart this session, before you write anything.
2. Run `node .claude/kit/video.mjs start <KEY>`. It refuses before Gate 2 and after the draft was deleted: tell the dev why, and stop. Pass on a `warning` in one line.
   - Refused only for the stage, and the task's report or kit notes say QA and Gate 2 were held by hand (the kit couldn't push, the branch was merged first): ask the dev with AskUserQuestion whether QA accepted what the draft shows now. Yes → `start <KEY> --accepted "<the dev's words>"`. Never pass it on your own judgment.
3. **Write the storyboard** (the path `start` printed) from the files it lists. Fill the Scenes table, the Optional scenes table and the `Query:` line; the comment in the file lists the kinds and actions. In this order:
   1. **An opening slide:** what's new, from brief.md § Asked and the plan's At a glance.
   2. **The theme editor (chrome), one feature at a time** (a section, a block, a settings group from contract.md): where it lives, what was added, how to use it, and what to watch out for. Watch-outs come from plan.md and report.md's edge-case rows, in a sentence each, at surface level. For example: it shows only on the collections picked; with none picked it shows nowhere; it hides on page 2. The first editor scene's Say also tells the client that this is a preview copy of their theme, and how they open the same editor on their live theme: Online Store › Themes › Customize. The top bar shows the draft's name, and they'd otherwise look for it.
   3. **Behaviour on the draft (chrome),** only where the result depends on a value the merchant enters. Take them from QA criteria whose result changes with a setting. Change the setting in the editor and show the preview change for different kinds of values: on/off, a short vs a long text, a row number. Everything is set back afterwards (step 7.4).
   4. **A short storefront tour:** the result as shoppers see it. Take the pages and selectors from report.md's PASS rows (the How column), so every selector has been measured. Desktop; add mobile when the plan has a mobile difference. Admin pages for store setup (plan.md § Merchant steps after merge) are chrome scenes here.
   5. **A closing slide:** where things live. Its first point is the way into the editor (Online Store › Themes › Customize), then the editor paths and the admin paths.
   - **Prio:** P1 for every core change, which is never left out, whatever the length. P2 for an important behaviour or watch-out, P3 for nice to have. About 5 minutes is a soft cap: past it, move P3 scenes to Optional scenes, never P1.
   - **Optional scenes:** 3-5 rows the dev may add (O1, O2…), one line each with Prio, an estimated Sec and what it shows. No Say until picked.
   - Say is the merchant's language: the labels they see in the editor, no file names, selectors, ticket text, A/B tool, risks or open QA rows.
   - **Beats:** split each Say with " / " into one beat per thing the picture shows, in Show's order. Each beat's words play with its own footage (a stretch of a storefront recording, or one still in a chrome scene), so voice and picture stay in step. A storefront Show gets the same number of parts, split the same way.
   - `Query:` takes the A/B tool's opt-out parameter from plan.md § QA setup, if there is one.
4. **Check it before the dev sees it.** The dev doesn't want to decide video details: you decide them.
   1. **Test content:** report.md and plan.md § QA setup name the values QA set (a "QA Headline", a test code). For each storefront page in the storyboard, run `node .claude/kit/shopify.mjs fetch <KEY> <path> --find "<value>"`. Note which values show and where (the banner, the tile). The editor scenes' settings are checked when you open them in step 7.
   2. **Review:** have the `video-reviewer` agent check the storyboard (give it `.claude/logs/<KEY>/`). Apply what it finds yourself: add what's missing, fix the language, cut padding. Don't show the dev its list. One pass; don't run it again.
   3. Run `node .claude/kit/video.mjs durations <KEY>`: it makes the narration and writes each scene's real length into Sec.
5. **Hand it over in a few lines,** like this, and nothing more (only a point that would change what the client sees goes in too):

   > The storyboard is ready to check: `<path>`. 14 scenes, 3:30 (P1 only: 2:40). Optional scenes you can add: O1-O4 (in the file).
   >
   > **Before I record:**
   > - The draft still shows QA test text: "QA Headline 15%" and code QATEST10 in the banner, "QA inlay" in the tile. The client would see it. Replace it in the theme editor (on the draft), or tell me to film it as it is.
   > - For the editor scenes I'll open a Chrome tab when you say record and ask you once to give it a maximised window of its own: a bigger window gives sharper pictures.

   Leave out the test-content point when there is none. Then wait. The dev edits rows, picks optional scenes ("add O2": move it into Scenes with a Say, then run `durations` again), or says to record.
6. **When the dev says record:** start `node .claude/kit/video.mjs record <KEY>` in the background (Bash `run_in_background`): it makes every scene's narration, records the storefront scenes and renders the slides. Meanwhile, close every tab in your tab group (`tabs_close_mcp`), then `tabs_context_mcp` with `createIfEmpty`, and navigate the new tab to the first chrome scene's page. The tab can land in the dev's own window (CHE-865), so tell the dev: "A Chrome tab, <its title>, just opened in the orange Claude tab group. If it shares a window with your tabs, drag it out by its tab so it gets a window of its own, maximise that window, and tell me." Then wait for the dev's answer and for `record`.
   - Cookie banners and app popups are hidden on their own; a theme popup needs a `hide`. A FAILED scene: fix its row and run `record <KEY> --scene <N>`. A password page: make it a chrome scene.
   - No chrome scenes: run `record` in the foreground and skip step 7.
7. **Chrome scenes: one still per beat, in that window.** Read `.claude/kit/video-overlay.js` once; you'll run its text after every page load. In the theme editor it lays the editor out at 1760x990, its wide layout, scaled into a 16:9 box in the middle of the tab: that box is what the stills show. Don't resize the window. For each scene:
   1. **Open the page in one `browser_batch`,** only when the scene is on another page than the last one (the editor takes 8-40 s to load): navigate, wait, run the overlay text plus `;__kc.frame(<the screenshot's coordinate-frame width>)` with `javascript_tool`, then a screenshot. Every screenshot reports its coordinate-frame width; on the very first page, take a screenshot before `frame()` to learn it. `frame()` returns `region`: the box, in screenshot coordinates. The editor must show the draft's name with the **Draft** badge and a greyed-out **Save**.
      - A login or 2FA page: ask the dev to log in in that tab, and wait. Another theme: navigate to the `editorUrl` that `start` printed. Make the scene a slide only if the dev says so.
      - The store's own popups (a newsletter popup after about 90 s) can cover the preview: close it with its ×, or load the editor again. Selecting a section in the sidebar doesn't always scroll the preview to it: scroll the preview (the mouse wheel over it) until the section is in view, so the still shows what the voice talks about.
   2. **For each beat, set up what its words describe, then take its still.** Each click is a `computer` `left_click`, then a 1-2 s wait; Claude in Chrome's pointer stays where it clicked and shows in the still, so it points at what the beat is about (the overlay draws none here). `__kc.highlight({left, top, width, height})` frames something, in screenshot coordinates (`null` clears it). Then `computer` `zoom` with `region` set to `frame()`'s region, `scale: 1` and `save_to_disk: true`: it saves the box at the screen's full resolution and prints the path. Look at it: it must show what the beat says.
      - **Zoom on what the voice talks about.** The editor's settings are small at full size. For a beat about settings (or a setting and its effect in the preview), call `__kc.focus({left, top, width, height})` with that area in screenshot coordinates and append the `@x,y,w,h` it returns to that beat's path. The video crops to it, at up to 2x, above the captions. Keep a scene's first beat unzoomed, so the viewer sees where they are. On an admin page the box has the tab's shape: focus each beat, or the still gets bars.
      - **Behaviour scenes:** type or toggle the value, wait until the preview shows it (2 s), and focus on the setting and the preview together. Each kind of value gets its own beat.
      - A storefront scene in Chrome (a password-protected store): the same, with stills; scroll and highlight with `javascript_tool` before each.
   3. Run `node .claude/kit/video.mjs still <KEY> <N> --shots "<path>[@x,y,w,h];<next beat's path>…"`: one image per beat, in order, split by ";". Each still shows while its beat's words play, with a slow zoom.
   4. **Leave the editor as it was:** set every changed setting back, then a screenshot. **Save** must be grey again; if not, close the editor tab (`tabs_close_mcp`) and open it again: undo often leaves Save active, and reloading an editor with changes raises the browser's "Leave site?" dialog, which blocks Claude in Chrome. After a behaviour scene, check every value you changed, not only Save. Never click Save, Publish, Remove section, delete, or anything else that changes the store. On admin pages, open and scroll only.
   5. **After the last chrome scene,** close the window's tabs (`tabs_close_mcp`): the window closes with them.
8. Run `node .claude/kit/video.mjs assemble <KEY>` and read every sheet it lists under `frames`: one frame from the middle of each beat, labelled scene.beat, six to a sheet. Check each frame against its beat's words, not the scene's:
   - The picture shows what the beat names: the setting, the section in the preview, the storefront element.
   - The editor is whole (top bar, sidebar labels not cut), with its settings on the right.
   - One pointer at most, and the caption doesn't cover what the beat talks about.
   - Nothing else shows: no login page, no dev-only UI (an extension's badge, a toolbar), and no QA test text the dev didn't say to film.

   Retake a wrong chrome scene's stills (step 7) or re-record a storefront scene (step 6), and assemble again: only changed scenes are re-encoded. Say "each beat shows what it describes" only after checking every frame.
9. Tell the dev the video's path and length, and that they watch it before it goes to the client. Ask with AskUserQuestion: "It can go to the client", or "Change something" (its description: "Write what to change in the text field, with the scene number or the time"). Run `node .claude/kit/video.mjs reviewed <KEY> --answer "<the dev's words>"` only for the first. Anything else, including "good, but…", is a change: edit the storyboard, re-record those scenes, assemble, and ask again. A wish for how the kit makes videos goes into `kit.mjs note` as well.

Sending it to the client is the dev's step.
