---
description: Make the client's walkthrough video for a task QA accepted - what's new, how to change it, where it lives. English voice with captions. Storefront scenes record on their own; theme-editor and admin scenes are stills from the dev's Chrome.
argument-hint: <TICKET-KEY>
disable-model-invocation: true
---

# /shopify-video $ARGUMENTS

A video for the client, who isn't technical: what's new on their store, where it lives in the theme editor, how to use it and what to watch out for, how it behaves with different values, and how shoppers see it. Complete before short: every core change is in it. The rules in `.claude/rules/runs.md` and `kit-runs.md` apply.

## Steps

1. `node .claude/kit/video.mjs check`. Not `ready` → run `node .claude/kit/video.mjs setup` yourself (once per machine, about 100 MB outside the repo) and check again; stop only if it still isn't ready. `ready` covers storefront scenes and slides; theme-editor scenes also need the `mcp__claude-in-chrome__*` tools: if they're missing, ask the dev to connect Claude in Chrome (`/chrome`) and restart this session, before you write anything.
2. `node .claude/kit/video.mjs start <KEY>`. Refused (before Gate 2, or the draft was deleted): tell the dev why, and stop. Pass on a `warning` in one line.
   - Refused only for the stage, and the report or kit notes say QA and Gate 2 were held by hand (the kit couldn't push, the branch was merged first): ask the dev with AskUserQuestion whether QA accepted what the draft shows now. Yes → `start <KEY> --accepted "<the dev's words>"`. Never on your own judgment.
3. **Write the storyboard** (the path `start` printed) from the files it lists: the Scenes table, the Optional scenes table and the `Query:` line (the comment in the file lists the kinds and actions). In this order:
   1. **An opening slide:** what's new, from brief.md § Asked and the plan's At a glance.
   2. **The theme editor (chrome), one feature at a time** (a section, a block, a settings group from contract.md): where it lives, what was added, how to use it, and what to watch out for, at surface level, from plan.md and report.md's edge-case rows ("it shows only on the collections picked; with none picked it shows nowhere"). The first editor scene also says this is a preview copy of their theme, and how they open the same editor on their live theme: Online Store › Themes › Customize.
   3. **Behaviour on the draft (chrome),** only where the result depends on a value the merchant enters (QA criteria whose result changes with a setting): change the setting and show the preview for different kinds of values (on/off, a short vs a long text). Everything is set back afterwards (step 7.4).
   4. **A short storefront tour:** the result as shoppers see it, with pages and selectors from report.md's PASS rows (the How column), so every selector has been measured. Desktop; mobile when the plan has a mobile difference. Admin pages for store setup (plan.md § Merchant steps after merge) are chrome scenes.
   5. **A closing slide:** where things live, starting with the way into the editor (Online Store › Themes › Customize), then the editor and admin paths.
   - **Prio:** P1 for every core change, never left out. P2 for an important behaviour or watch-out, P3 for nice to have. About 5 minutes is a soft cap: past it, move P3 scenes to Optional scenes, never P1.
   - **Optional scenes:** 3-5 rows the dev may add (O1, O2…), each with Prio, an estimated Sec and what it shows; no Say until picked.
   - Say is the merchant's language: the labels they see in the editor; no file names, selectors, ticket text, A/B tool, risks or open QA rows.
   - **Beats:** split each Say with " / " into one beat per thing the picture shows, in Show's order. Each beat plays with its own footage (a stretch of a storefront recording, or one still), so voice and picture stay in step; a storefront Show gets the same number of parts.
   - `Query:` takes the A/B tool's opt-out parameter from plan.md § QA setup, if there is one.
4. **Check it before the dev sees it.** You decide video details, not the dev.
   1. **Test content:** report.md and plan.md § QA setup name the values QA set (a "QA Headline", a test code). For each storefront page, `node .claude/kit/shopify.mjs fetch <KEY> <path> --find "<value>"`, and note which show and where. Editor settings are checked when you open them in step 7.
   2. **Review:** have the `video-reviewer` agent check the storyboard (give it `.claude/logs/<KEY>/`) and apply what it finds yourself. Don't show the dev its list. One pass.
   3. `node .claude/kit/video.mjs durations <KEY>`: makes the narration and writes each scene's real length into Sec.
5. **Hand it over in a few lines,** like this, and nothing more (only a point that would change what the client sees goes in too):

   > The storyboard is ready to check: `<path>`. 14 scenes, 3:30 (P1 only: 2:40). Optional scenes you can add: O1-O4 (in the file).
   >
   > **Before I record:**
   > - The draft still shows QA test text: "QA Headline 15%" and code QATEST10 in the banner, "QA inlay" in the tile. The client would see it. Replace it in the theme editor (on the draft), or tell me to film it as it is.
   > - For the editor scenes I'll open a Chrome tab when you say record and ask you once to give it a maximised window of its own: a bigger window gives sharper pictures.

   Leave out the test-content point when there is none. Then wait. The dev edits rows, picks optional scenes ("add O2": move it into Scenes with a Say, run `durations` again), or says to record.
6. **When the dev says record:** start `node .claude/kit/video.mjs record <KEY>` in the background (it makes the narration, records the storefront scenes and renders the slides). Meanwhile close every tab in your tab group (`tabs_close_mcp`), `tabs_context_mcp` with `createIfEmpty`, and navigate the new tab to the first chrome scene's page. The tab can land in the dev's own window, so say: "A Chrome tab, <its title>, just opened in the orange Claude tab group. If it shares a window with your tabs, drag it out by its tab so it gets a window of its own, maximise that window, and tell me." Wait for the answer and for `record`.
   - Cookie banners and app popups are hidden on their own; a theme popup needs a `hide`. A FAILED scene: fix its row and `record <KEY> --scene <N>`. A password page: make it a chrome scene.
   - No chrome scenes: run `record` in the foreground and skip step 7.
7. **Chrome scenes: one still per beat, in that window.** Read `.claude/kit/video-overlay.js` once; run its text after every page load. In the theme editor it lays the editor out at 1760x990, scaled into a 16:9 box in the middle of the tab: that box is what the stills show. Don't resize the window. For each scene:
   1. **Open the page in one `browser_batch`,** only when the scene is on another page than the last (the editor takes 8-40 s): navigate, wait, run the overlay text plus `;__kc.frame(<the screenshot's coordinate-frame width>)` with `javascript_tool`, then a screenshot (on the very first page, take one before `frame()` to learn the width). `frame()` returns `region`, the box in screenshot coordinates. The editor must show the draft's name with the **Draft** badge and a grey **Save**.
      - A login or 2FA page: ask the dev to log in in that tab, and wait. Another theme: navigate to the `editorUrl` `start` printed. A slide instead only if the dev says so.
      - The store's own popups (a newsletter popup after about 90 s) can cover the preview: close it with its ×, or reload the editor. Selecting a section doesn't always scroll the preview to it: scroll the preview (mouse wheel over it) until it's in view.
   2. **For each beat, set up what its words describe, then take its still.** Each click is a `computer` `left_click`, then a 1-2 s wait; the pointer stays where it clicked and shows in the still. `__kc.highlight({left, top, width, height})` frames something (`null` clears it). Then `computer` `zoom` with `region` = `frame()`'s region, `scale: 1`, `save_to_disk: true`: it saves the box at full resolution and prints the path. Look at it: it must show what the beat says.
      - **Zoom on what the voice talks about:** for a beat about settings (or a setting and its effect), `__kc.focus({left, top, width, height})` with that area and append the `@x,y,w,h` it returns to the beat's path; the video crops to it, at up to 2x. Keep a scene's first beat unzoomed so the viewer sees where they are. On an admin page focus each beat, or the still gets bars.
      - **Behaviour scenes:** type or toggle the value, wait until the preview shows it (2 s), and focus on the setting and the preview together; each kind of value gets its own beat.
      - A storefront scene in Chrome (password-protected store): the same, with stills; scroll and highlight with `javascript_tool` before each.
   3. `node .claude/kit/video.mjs still <KEY> <N> --shots "<path>[@x,y,w,h];<next beat's path>…"`: one image per beat, in order.
   4. **Leave the editor as it was:** set every changed setting back, then a screenshot: **Save** must be grey and every value you changed back. If not, close the editor tab and open it again (undo often leaves Save active, and reloading an editor with changes raises "Leave site?", which blocks Claude in Chrome). **Never click Save, Publish, Remove section, delete, or anything else that changes the store.** On admin pages, open and scroll only.
   5. **After the last chrome scene,** close the window's tabs (`tabs_close_mcp`).
8. `node .claude/kit/video.mjs assemble <KEY>` and read every sheet it lists under `frames` (one frame from the middle of each beat, labelled scene.beat). Check each frame against its beat's words:
   - it shows what the beat names (the setting, the section in the preview, the storefront element);
   - the editor is whole (top bar, sidebar labels not cut), settings on the right;
   - one pointer at most, and the caption doesn't cover what the beat talks about;
   - nothing else shows: no login page, no dev-only UI (an extension badge, a toolbar), no QA test text the dev didn't say to film.

   Retake a wrong chrome scene (step 7) or re-record a storefront scene (step 6), and assemble again. Say "each beat shows what it describes" only after checking every frame.
9. Tell the dev the video's path and length, and that they watch it before it goes to the client. AskUserQuestion: "It can go to the client", or "Change something" (description: "Write what to change in the text field, with the scene number or the time"). `node .claude/kit/video.mjs reviewed <KEY> --answer "<the dev's words>"` only for the first. Anything else, including "good, but…", is a change: edit the storyboard, redo those scenes, assemble, and ask again. A wish for how the kit makes videos also goes into `kit.mjs note`.

Sending it to the client is the dev's step.
