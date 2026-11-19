#!/usr/bin/env node
// Walkthrough video for the client, from a task QA accepted: storefront scenes recorded on the draft theme in a hidden
// browser, theme-editor and admin scenes recorded from the dev's own Chrome (a screen recording while Claude in Chrome
// clicks), slides for the rest. Each scene is narrated (Microsoft neural voice) and captioned; one MP4 comes out.
// /shopify-video <KEY> runs it. The tools live once per machine in ~/.shopify-kit/video, outside every repo.
//   setup                                        install the recorder, ffmpeg and the voice (the dev runs it, once)
//   check                                        are they installed, and does the voice answer?
//   start <KEY> [--accepted "<dev's words>"]     can this task be filmed? creates storyboard.md. --accepted: Gate 2 was
//                                                held outside the kit, so the tracker never reached handoff
//   durations <KEY>                              narration for every scene; writes each scene's seconds into the Sec column
//   record <KEY> [--scene N]                     narration for every scene, then the storefront scenes and slides
//   overlay                                      prints the path of the cursor script for the Chrome tab
//   chrome-start <KEY> <N>                       find the tab on screen by its corner marks, start recording the screen
//   chrome-stop <KEY> <N> --keep <a-b,c-d@f;e-f> stop, and keep the stretches between the scene's Date.now() marks;
//                                                "@x,y,w,h" (from __kc.focus) zooms a stretch to part of the tab; ";"
//                                                splits the stretches by beat (the Say's " / " parts)
//   assemble <KEY>                               join the scenes into video/<KEY>-walkthrough.unreviewed.mp4, and
//                                                video/frames.png (one frame per scene) for the agent's check
//   reviewed <KEY> --answer "<dev's words>"      the dev watched it: drops .unreviewed from the name
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_DIR, LOGS, WIN, fail, normKey, now, parseArgs, print, readConfig, readState, run, writeState } from './lib.mjs';

const DEPS = process.env.SHOPIFY_KIT_VIDEO_DEPS || join(homedir(), '.shopify-kit', 'video');
// Pinned: a new recorder or voice release must not change every team video at once.
const PINS = { 'playwright-core': '1.65.1', 'ffmpeg-static': '5.3.0', 'msedge-tts': '2.1.1' };
const OVERLAY = join(KIT_DIR, 'video-overlay.js');
// App overlays that covered storefront scenes: cookie banners by their apps' ids, and any other origin's iframe fixed to the
// screen (review popups, chat bubbles). The theme's own fixed elements, a sticky header say, are same-origin and stay.
const APP_OVERLAYS = ['#pandectes-banner', '#shopify-pc__banner', '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '#cmpbox', '#cmpwrapper', '.cc-window', '#cookie-law-info-bar'];
const HIDE_APPS = `(() => {
  if (window.top !== window) return;
  const hide = (el) => el.style.setProperty('display', 'none', 'important');
  const fixed = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return true; return false; };
  const sweep = () => {
    if (!document.documentElement) return;
    if (!document.getElementById('kit-hide-apps')) { const s = document.createElement('style'); s.id = 'kit-hide-apps'; s.textContent = ${JSON.stringify(`${APP_OVERLAYS.join(',')}{display:none!important}`)}; document.documentElement.appendChild(s); }
    for (const f of document.querySelectorAll('iframe')) {
      let other = true;
      try { other = new URL(f.src || 'about:blank', location.href).origin !== location.origin; } catch {}
      if (other && f.src && fixed(f)) hide(f);
    }
  };
  setInterval(sweep, 400);
})();`;
const KINDS = ['slide', 'storefront', 'chrome'];
const DEFAULT_VOICE = 'en-US-AvaNeural';
// 1920x1080: the picture fills the frame, and captions sit over its bottom in a dark box. A band below the picture
// read as black space to the dev (CHE-865).
const W = 1920, H = 1080, PIC = H, BG = '0x1f2124';
const CAPTION_BOTTOM = 64; // px from the frame's bottom edge to the caption box's text
const LEAD = 0.3, TAIL = 0.3; // seconds of picture before the voice starts and after it ends (the mp3s add ~0.3 s each)
const GAP = 0.2; // between two beats of a scene, on top of the mp3s' own silence
const RATE = '-10%'; // the voice's default runs near 200 words a minute; clients follow better nearer 170
const FPS = 25; // both recorders capture at 25: another output rate repeats frames and motion judders
const DESKTOP = { width: 1440, height: 810 }; // 16:9, the picture's shape
const MOBILE = { width: 390, height: 844 };

// ── Storyboard ──

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Each numbered row's cells by its table's column names: Prio and Sec are optional, and older storyboards lack them. */
function sceneRows(text) {
  let names = ['#', 'kind', 'where', 'show', 'say'];
  const rows = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\|\s*#\s*\|/.test(line)) names = cells(line).map((c) => c.toLowerCase());
    else if (/^\|\s*\d+\s*\|/.test(line)) rows.push({ index, names, values: cells(line) });
  });
  return rows;
}

/** The storyboard's header lines and scene rows. Throws on a row the recorder couldn't follow. Optional scenes (O1, O2…) aren't rows. */
export function parseStoryboard(text) {
  const header = (name) => (text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi'))?.[1] || '').trim();
  const scenes = sceneRows(text).map(({ names, values }) => {
    const get = (name) => values[names.indexOf(name)] ?? '';
    return { n: Number(values[0]), prio: get('prio').toUpperCase(), kind: get('kind').toLowerCase(), where: get('where'), show: get('show'), say: get('say') };
  });
  const problems = [];
  if (!scenes.length) problems.push('no scenes: add rows to the table');
  scenes.forEach((s, i) => {
    if (!KINDS.includes(s.kind)) problems.push(`scene ${s.n}: Kind "${s.kind}" isn't one of ${KINDS.join(', ')}`);
    if (!s.say) problems.push(`scene ${s.n}: Say is empty`);
    if (s.prio && !/^P[123]$/.test(s.prio)) problems.push(`scene ${s.n}: Prio "${s.prio}" isn't P1, P2 or P3`);
    if (i && s.n <= scenes[i - 1].n) problems.push(`scene ${s.n}: numbers must go up`);
    if (s.kind === 'storefront') {
      try {
        const groups = showBeats(s.show), beats = beatsOf(s.say).length;
        storefrontWhere(s.where);
        if (groups.length !== beats) problems.push(`scene ${s.n}: Show has ${groups.length} part(s) and Say ${beats} beat(s); split both with " / ", one part per beat`);
      } catch (e) { problems.push(`scene ${s.n}: ${e.message}`); }
    }
  });
  if (problems.length) throw new Error(problems.join('\n'));
  return { voice: header('Voice') || DEFAULT_VOICE, query: header('Query'), captions: !/^off$/i.test(header('Captions')), scenes };
}

const OPS = ['hide', 'highlight', 'click', 'hover', 'scroll', 'wait'];
/** "highlight .a; click .b button; wait 2" → [{op, arg}]. */
export function parseShow(show) {
  return show.split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [op, ...rest] = s.split(/\s+/);
    const arg = rest.join(' ');
    if (!OPS.includes(op)) throw new Error(`"${op}" isn't an action (${OPS.join(', ')})`);
    if (op === 'wait' ? !(Number(arg) > 0) : !arg) throw new Error(`"${s}" needs ${op === 'wait' ? 'a number of seconds' : 'a selector'}`);
    return { op, arg: op === 'wait' ? Number(arg) : arg };
  });
}

/**
 * A Say's beats: " / " splits it into the parts that go with one piece of footage each, so the voice talks about what
 * the picture shows. No " / " is one beat.
 */
export const beatsOf = (text) => String(text).split(/\s+\/\s+/).map((b) => b.trim()).filter(Boolean);

/** A storefront Show's actions per beat: "highlight .a; wait 2 / click .b" → [[…], […]]. */
export const showBeats = (show) => beatsOf(show).map(parseShow);

/** Seconds each beat needs: its voice, LEAD before the first, GAP after each, TAIL after the last. */
export function beatNeeds(voiceSeconds) {
  return voiceSeconds.map((v, i) => (i ? 0 : LEAD) + v + (i === voiceSeconds.length - 1 ? TAIL : GAP));
}

/**
 * The scene's timeline: each beat lasts as long as its voice or its footage, whichever is longer. Shorter footage holds
 * its last frame; a shorter voice is followed by silence. → [{ start, length, voiceAt }] in seconds.
 */
export function beatTimeline(voiceSeconds, footageSeconds) {
  let t = 0;
  return beatNeeds(voiceSeconds).map((need, i) => {
    const seg = { start: t, length: Math.max(need, footageSeconds[i] || 0), voiceAt: t + (i ? 0 : LEAD) };
    t += seg.length;
    return seg;
  });
}

/** "products/x @mobile" → { path: '/products/x', mobile: true }. Only a path: the host always comes from the kit. */
export function storefrontWhere(where) {
  const m = String(where).trim().match(/^(\S*)\s*(?:@(desktop|mobile))?$/i);
  if (!m) throw new Error(`Where "${where}" should be a storefront path and @desktop or @mobile, e.g. "products/x @mobile"`);
  const raw = m[1] === 'home' ? '' : m[1];
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(raw)) throw new Error(`Where "${where}" must be a path on the store, not a URL`);
  return { path: '/' + raw.replace(/^\/+/, ''), mobile: (m[2] || '').toLowerCase() === 'mobile' };
}

/** The scene's URL: always the kit's store and the task's draft theme, whatever the storyboard says. */
export function sceneUrl(store, themeId, path, query = '') {
  const u = new URL(path, `https://${store}`);
  if (u.host !== store) throw new Error(`${path} leaves ${store}`);
  for (const [k, v] of new URLSearchParams(query.replace(/^\?/, ''))) if (k !== 'preview_theme_id') u.searchParams.set(k, v);
  u.searchParams.set('preview_theme_id', String(themeId));
  return u.toString();
}

/** Caption chunks of at most two lines, each shown for its share of the narration. */
export function captionChunks(say, seconds, perLine = 70) {
  const sentences = say.match(/[^.!?]+[.!?]*(\s+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [say];
  const chunks = [];
  for (const s of sentences) {
    const words = s.split(/\s+/);
    let lines = [''];
    for (const w of words) {
      if ((lines.at(-1) + ' ' + w).trim().length > perLine) {
        if (lines.length === 2) { chunks.push(lines.join('\n')); lines = ['']; }
        else lines.push('');
      }
      lines[lines.length - 1] = (lines.at(-1) + ' ' + w).trim();
    }
    if (lines[0]) chunks.push(lines.join('\n').trim());
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  let t = 0;
  return chunks.map((text) => { const d = (seconds * text.length) / total; const c = { text, from: t, to: t + d }; t += d; return c; });
}

/** Clamps stretches that end just past the recording, in place; returns the first that still doesn't fit. */
export function fitParts(parts, length) {
  // Stopping loses up to the last half second, so a closing mark can land just past the file's end.
  for (const p of parts) if (p.from + p.length > length && p.from + p.length <= length + 1) p.length = length - p.from;
  return parts.find((p) => p.from < 0 || p.length <= 0 || p.from + p.length > length);
}

/** Bounding box of the four magenta corner marks in an RGB screen grab, or why it can't be used. */
export function findMarks(buf, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  const hit = (i) => buf[i] >= 235 && buf[i + 1] <= 30 && buf[i + 2] >= 235;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!hit((y * width + x) * 3)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { problem: 'no corner marks on screen: is the Chrome tab in front and the overlay running?' };
  const near = (cx, cy) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < width && y < height && hit((y * width + x) * 3)) return true; } return false; };
  if (![[x0, y0], [x1, y0], [x0, y1], [x1, y1]].every(([x, y]) => near(x, y))) return { problem: 'only some corner marks are visible: something covers part of the Chrome tab' };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w < 400 || h < 300) return { problem: `the marked area is only ${w}x${h}: is the Chrome window that small?` };
  // The overlay keeps the marks at least 28 px in from the tab's edge, past Claude in Chrome's tint, so the box is clean.
  return { x: x0, y: y0, w: w - (w % 2), h: h - (h % 2) };
}

// ── Tools ──

const req = createRequire(join(DEPS, 'package.json'));
const has = (name) => { try { req.resolve(name); return true; } catch { return false; } };
async function dep(name) {
  if (!has(name)) fail(`The video tools aren't installed on this machine. Ask the dev to run, once:\n  ! node .claude/kit/video.mjs setup`);
  // playwright-core is CommonJS: its exports arrive under default.
  const m = await import(pathToFileURL(req.resolve(name)).href);
  return { ...(m.default || {}), ...m };
}
const ffmpegBin = () => { const p = has('ffmpeg-static') && req('ffmpeg-static'); return p && existsSync(p) ? p : null; };

function ff(args, { cwd } = {}) {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-y', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || r.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' ')}`);
  return r.stderr;
}

/**
 * Seconds of media in a file. Recordings are decoded to the end: a browser recording has no duration header, and a
 * screen recording stopped early keeps the length it was capped at.
 */
function seconds(file) {
  const head = /\.(mkv|webm)$/i.test(file) ? '' : spawnSync(ffmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  const d = head.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (d) return d[1] * 3600 + d[2] * 60 + Number(d[3]);
  const all = [...(spawnSync(ffmpegBin(), ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '').matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  return all ? all[1] * 3600 + all[2] * 60 + Number(all[3]) : 0;
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const nn = (n) => String(n).padStart(2, '0');

async function narration(dir, voice, say) {
  const file = join(dir, `${hash(`${voice}\0${RATE}\0${say}`)}.mp3`);
  if (!existsSync(file)) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await dep('msedge-tts');
    // Each call writes "audio.mp3" into its folder, so parallel calls need folders of their own.
    const tmp = join(dir, `tmp-${hash(say)}-${process.pid}`);
    mkdirSync(tmp, { recursive: true });
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(tmp, say, { rate: RATE });
      renameSync(audioFilePath, file);
    } finally { tts.close(); rmSync(tmp, { recursive: true, force: true }); }
  }
  return { file, seconds: seconds(file) };
}

/** A scene's narration, one clip per beat: { beats: [{ text, file, seconds }], seconds } (seconds: what the beats need). */
async function narrateScene(dir, voice, say) {
  const beats = [];
  for (const text of beatsOf(say)) beats.push({ text, ...(await narration(dir, voice, text)) });
  return { beats, seconds: beatNeeds(beats.map((b) => b.seconds)).reduce((a, b) => a + b, 0) };
}

/** Narration for every scene, four at a time: { [scene number]: narrateScene() }. */
async function narrateAll(dir, voice, scenes) {
  const out = {};
  const queue = [...scenes];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) { const s = queue.shift(); out[s.n] = await narrateScene(dir, voice, s.say); }
  }));
  return out;
}

/** The screen recording's start in wall-clock ms: when its first progress line was seen, minus the time it reports. */
export function captureStart(log, seenAt) {
  const m = log.match(/time=(\d+):(\d+):([\d.]+)/);
  return m ? seenAt - Math.round((m[1] * 3600 + m[2] * 60 + Number(m[3])) * 1000) : seenAt;
}

/**
 * "--keep 1000-5000,9000-12000@0.62,0.10,0.36,0.50" (the scene's Date.now() marks) → [[from, to, focus?]] in ms. A
 * stretch's "@x,y,w,h" zooms it to that part of the tab, as fractions of the recorded box: what __kc.focus() returns.
 */
export function parseKeep(text) {
  // Commas split stretches and also the focus fractions: a piece that starts "<n>-" begins a stretch.
  const pieces = String(text || '').split(',').map((p) => p.trim()).filter(Boolean)
    .reduce((acc, p) => (/^\d+-/.test(p) || !acc.length ? [...acc, p] : [...acc.slice(0, -1), `${acc.at(-1)},${p}`]), []);
  const parts = pieces.map((p) => {
    const [span, zoom] = p.split('@');
    const [a, b] = span.split('-').map(Number);
    const focus = zoom === undefined ? null : zoom.split(',').map(Number);
    if (focus && (focus.length !== 4 || focus.some((v) => !(v >= 0 && v <= 1)) || !(focus[2] > 0 && focus[3] > 0))) throw new Error(`"@${zoom}" should be four fractions x,y,w,h: paste what __kc.focus() returned`);
    return focus ? [a, b, focus] : [a, b];
  });
  if (!parts.length || parts.some(([a, b]) => !(a > 0 && b > a))) throw new Error('--keep takes start-end pairs of the Date.now() marks, e.g. --keep 1700000000000-1700000009000');
  if (parts.some(([a], i) => i && a < parts[i - 1][1])) throw new Error('--keep stretches must be in order and not overlap');
  return parts;
}

/** "--keep a-b,c-d@f;e-f": stretches per beat, the beats split by ";". → [[[from, to, focus?], …], …] */
export function parseKeepBeats(text) {
  const groups = String(text || '').split(';').map((g) => g.trim());
  if (groups.some((g) => !g)) throw new Error('--keep has an empty beat: every beat between ";" needs at least one stretch');
  const beats = groups.map(parseKeep);
  const flat = beats.flat();
  if (flat.some(([a], i) => i && a < flat[i - 1][1])) throw new Error('--keep stretches must be in order and not overlap');
  return beats;
}

/**
 * The crop for a zoomed stretch, in the recording's pixels: the focus box widened to the picture's shape, so the zoom
 * fills it, and to at least half the recording, so text isn't blown up past 2x. Even numbers, inside the recording.
 */
export function focusCrop([fx, fy, fw, fh], width, height) {
  const aspect = W / PIC;
  let w = Math.max(fw * width, fh * height * aspect, width / 2);
  let h = w / aspect;
  if (h > height) { h = height; w = h * aspect; }
  w = Math.min(w, width);
  const cx = (fx + fw / 2) * width, cy = (fy + fh / 2) * height;
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  const x = Math.min(Math.max(0, cx - w / 2), width - w), y = Math.min(Math.max(0, cy - h / 2), height - h);
  return { x: even(x), y: even(y), w: even(w), h: even(h) };
}

/** The storyboard with each scene's Sec cell set (seconds by scene number); rows without a Sec column stay as they are. */
export function withSeconds(text, seconds) {
  const lines = text.split(/\r?\n/);
  for (const { index, names, values } of sceneRows(text)) {
    const at = names.indexOf('sec');
    const n = Number(values[0]);
    if (at < 0 || seconds[n] === undefined) continue;
    const next = [...values];
    while (next.length <= at) next.push('');
    next[at] = String(Math.round(seconds[n]));
    lines[index] = `| ${next.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  }
  return lines.join('\n');
}

const fontArg = () => {
  const f = ['C:/Windows/Fonts/segoeui.ttf', '/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync);
  return f ? `fontfile='${f.replace(/:/g, '\\:')}'` : 'font=Sans';
};

// ── Task ──

function task(key) {
  const st = readState(key);
  const cfg = readConfig();
  const dir = join(LOGS, key);
  const vdir = join(dir, 'video');
  const paths = { dir, vdir, storyboard: join(dir, 'storyboard.md'), voice: join(vdir, 'voice'), scenes: join(vdir, 'scenes'), build: join(vdir, 'build') };
  return { st, cfg, ...paths };
}

/** Refuses a task whose draft can't show the accepted work. */
function filmable(st) {
  if (st.kind === 'investigation') return 'an investigation has no draft theme to film';
  if (!['handoff', 'done'].includes(st.stage) && !st.videoAccepted) {
    return `QA isn't accepted yet (stage: ${st.stage}). Film it after Gate 2. If QA and Gate 2 were held outside the kit, ask the dev, then: start ${st.key} --accepted "<the dev's words>"`;
  }
  if (!st.draft?.themeId) return 'the task has no draft theme';
  if (st.draft.deletedAt) return 'its draft theme was deleted at cleanup. Push the branch to a new draft first (shopify.mjs draft), or film by hand.';
  return null;
}

function storyboard(t) {
  if (!existsSync(t.storyboard)) fail(`No storyboard yet: node .claude/kit/video.mjs start ${t.st.key || ''}`.trim());
  try { return parseStoryboard(readFileSync(t.storyboard, 'utf8')); } catch (e) { fail(`storyboard.md:\n${e.message}`); }
}

// ── Storefront scenes and slides ──

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function slideHtml(scene) {
  const points = scene.show.split(' / ').map((s) => s.trim()).filter(Boolean).slice(0, 5);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;width:${W}px;height:${PIC}px;display:flex;flex-direction:column;justify-content:center;padding:0 160px 150px;box-sizing:border-box;
      font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;background:#f6f6f7;color:#1f2124}
    h1{font-size:72px;font-weight:650;margin:0 0 48px;letter-spacing:-.5px}
    ul{margin:0;padding:0;list-style:none}
    li{font-size:40px;line-height:1.35;margin:0 0 22px;padding-left:44px;position:relative}
    li:before{content:'';position:absolute;left:0;top:.5em;width:16px;height:16px;border-radius:50%;background:#2c6ecb}
  </style></head><body><h1>${escapeHtml(scene.where)}</h1><ul>${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></body></html>`;
}

async function recordStorefront(browser, t, scene, board, beatSeconds) {
  const { path, mobile } = storefrontWhere(scene.where);
  const url = sceneUrl(t.cfg.store, t.st.draft.themeId, path, board.query);
  const vp = mobile ? MOBILE : DESKTOP;
  const tmp = join(t.scenes, `tmp-${nn(scene.n)}`);
  rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: vp, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    // Playwright records CSS pixels and pads a larger size with grey, top-left: a 2x size left the phone a quarter of the
    // frame. At the viewport's size, assemble scales it to the picture's full height.
    recordVideo: { dir: tmp, size: vp },
  });
  await ctx.addInitScript({ path: OVERLAY });
  await ctx.addInitScript(HIDE_APPS);
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (/\/password/.test(page.url())) throw new Error('the storefront is password-protected: make this a chrome scene (the dev\'s Chrome is logged in), or ask the dev to lift the password while recording');
    const theme = await page.evaluate(() => window.Shopify?.theme && { id: window.Shopify.theme.id, role: window.Shopify.theme.role });
    if (!theme || String(theme.id) !== String(t.st.draft.themeId) || theme.role === 'main') throw new Error(`the page rendered ${theme ? `theme ${theme.id} (${theme.role})` : 'no Shopify theme'}, not the draft ${t.st.draft.themeId}`);
    await page.waitForFunction(() => window.__kc, null, { timeout: 5000 }).catch(() => { throw new Error('the cursor overlay didn\'t load on this page'); });
    const groups = showBeats(scene.show);
    for (const o of groups.flat().filter((x) => x.op === 'hide')) await page.addStyleTag({ content: `${o.arg}{display:none!important}` });
    await page.evaluate(() => window.__kc.marks(false));
    await page.waitForTimeout(1200);
    const target = async (sel) => {
      const el = page.locator(sel).first();
      if (!(await el.count())) throw new Error(`no element matches "${sel}"`);
      await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await page.waitForTimeout(700);
      const b = await el.boundingBox();
      if (!b) throw new Error(`"${sel}" isn't visible`);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const act = async ({ op, arg }) => {
      if (op === 'hide') return;
      await page.evaluate(() => window.__kc.highlight(null));
      if (op === 'wait') return page.waitForTimeout(arg * 1000);
      const at = await target(arg);
      // Short holds: the voice sets the scene's length anyway, and the dev found the first real video slow.
      if (op === 'scroll') return page.waitForTimeout(400);
      if (op === 'highlight') { await page.evaluate((sel) => window.__kc.highlight(sel), arg); return page.waitForTimeout(1000); }
      await page.evaluate(([x, y]) => window.__kc.move(x, y), [at.x, at.y]);
      if (op === 'hover') { await page.mouse.move(at.x, at.y); return page.waitForTimeout(900); }
      await page.evaluate(() => window.__kc.ripple());
      if (mobile) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(1100);
    };
    // Each beat's actions, then a hold until its voice is done, so the next beat's actions start with its words.
    const needs = beatNeeds(beatSeconds);
    const spans = [];
    for (const [i, ops] of groups.entries()) {
      const tStart = Date.now();
      for (const o of ops) await act(o);
      const hold = tStart + needs[i] * 1000 - Date.now();
      if (hold > 0) await page.waitForTimeout(hold);
      spans.push([tStart, Date.now()]);
    }
    // Closing straight after the last frame cut it short in tests.
    await page.waitForTimeout(400);
    await ctx.close();
    const raw = await page.video().path();
    const length = seconds(raw);
    // The recording starts a little after the page opened; its length says how much.
    const late = (Date.now() - t0) / 1000 - length;
    const file = join(t.scenes, `${nn(scene.n)}.webm`);
    renameSync(raw, file);
    return { kind: 'storefront', file, parts: spans.map(([a, b], beat) => ({ from: Math.max(0, (a - t0) / 1000 - late), length: (b - a) / 1000, beat })) };
  } finally {
    await ctx.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Commands ──

const args = parseArgs(process.argv.slice(2));
const [cmd, rawKey, rawScene] = args._;

async function main() {
  if (args.flags.selftest) return selftest();
  if (cmd === 'setup') {
    mkdirSync(DEPS, { recursive: true });
    if (!existsSync(join(DEPS, 'package.json'))) writeFileSync(join(DEPS, 'package.json'), '{ "private": true }\n');
    console.log(`Installing the video tools into ${DEPS} (about 100 MB, once per machine)…`);
    const npm = run('npm', ['install', '--no-audit', '--no-fund', ...Object.entries(PINS).map(([k, v]) => `${k}@${v}`)], { cwd: DEPS, shell: WIN });
    if (npm.code !== 0) fail(`npm install failed:\n${npm.stderr.trim().split(/\r?\n/).slice(-5).join('\n')}`);
    // Playwright records with its own small ffmpeg build; the npm ffmpeg does the cutting and joining.
    const pw = run('npx', ['--no', 'playwright-core', 'install', 'ffmpeg'], { cwd: DEPS, shell: WIN });
    if (pw.code !== 0) fail(`Installing Playwright's recorder failed:\n${pw.stderr.trim().split(/\r?\n/).slice(-5).join('\n')}`);
    if (!ffmpegBin()) fail('ffmpeg-static installed without its binary: npm skipped its install script. Run: npm install-scripts approve ffmpeg-static, then setup again.');
    console.log('Done. Check it with: node .claude/kit/video.mjs check');
    return;
  }
  if (cmd === 'check') {
    const out = { tools: DEPS, recorder: has('playwright-core'), ffmpeg: Boolean(ffmpegBin()), voice: has('msedge-tts'), screenRecording: WIN };
    if (out.voice && out.ffmpeg) {
      try { const tmp = join(DEPS, 'check'); mkdirSync(tmp, { recursive: true }); await narration(tmp, DEFAULT_VOICE, 'Check.'); rmSync(tmp, { recursive: true, force: true }); out.voiceAnswers = true; } catch (e) { out.voiceAnswers = false; out.voiceProblem = e.message; }
    }
    if (out.recorder) {
      try { const { chromium } = await dep('playwright-core'); const b = await chromium.launch({ channel: 'chrome', headless: true }); await b.close(); out.storefrontBrowser = true; } catch (e) { out.storefrontBrowser = false; out.storefrontBrowserProblem = e.message.split('\n')[0]; }
    }
    out.ready = Boolean(out.recorder && out.ffmpeg && out.voiceAnswers && out.storefrontBrowser);
    // A script can't see this session's tools: "ready" covers storefront scenes and slides only (CHE-865).
    out.editorScenes = 'need the Claude in Chrome tools in this session; the agent checks for them itself';
    if (!out.recorder || !out.ffmpeg || !out.voice) out.fix = '! node .claude/kit/video.mjs setup';
    if (!WIN) out.note = 'Chrome scenes (theme editor, admin) need Windows screen recording: on this machine they become slides.';
    print(out);
    process.exit(out.ready ? 0 : 2);
  }
  if (cmd === 'overlay') return print({ overlay: OVERLAY, use: 'Read this file and run its contents with javascript_tool in the Chrome tab, once per page load.' });

  const key = normKey(rawKey);
  const t = task(key);
  t.st.key = key;
  // Gate 2 held outside the kit (a push it couldn't make, a branch merged first): the dev's words stand in for the tracker.
  if (cmd === 'start' && args.flags.accepted !== undefined && !['handoff', 'done'].includes(t.st.stage)) {
    const answer = String(args.flags.accepted === true ? '' : args.flags.accepted).trim();
    if (!answer) fail('--accepted "<the dev\'s words>": the dev confirms QA and Gate 2 were done for what the draft shows.');
    t.st.videoAccepted = { answer, at: now(), stage: t.st.stage };
    t.st.history.push({ at: now(), event: 'video-accepted', stage: t.st.stage });
    writeState(key, t.st);
  }
  const why = filmable(t.st);
  if (why) fail(`${key} can't be filmed: ${why}`);
  mkdirSync(t.vdir, { recursive: true });

  if (cmd === 'start') {
    if (!has('playwright-core') || !has('msedge-tts') || !ffmpegBin()) fail('The video tools aren\'t installed on this machine. Ask the dev to run, once:\n  ! node .claude/kit/video.mjs setup');
    if (!existsSync(t.storyboard)) writeFileSync(t.storyboard, readFileSync(join(KIT_DIR, 'templates', 'storyboard.md'), 'utf8').replaceAll('{{KEY}}', key));
    const warn = t.st.qa?.commit && t.st.draft.lastPushedCommit && t.st.qa.commit !== t.st.draft.lastPushedCommit
      ? `The draft is at ${t.st.draft.lastPushedCommit.slice(0, 7)}, QA accepted ${t.st.qa.commit.slice(0, 7)}: the video may show unaccepted code.` : null;
    return print({
      storyboard: t.storyboard, previewUrl: t.st.draft.previewUrl, editorUrl: t.st.draft.editorUrl, draftName: t.st.draft.name || key,
      featurePrefix: t.st.featurePrefix, read: ['brief.md', 'plan.md', 'contract.md', 'report.md'].filter((f) => existsSync(join(t.dir, f))).map((f) => join(t.dir, f)),
      ...(warn ? { warning: warn } : {}),
    });
  }

  const board = storyboard(t);
  for (const d of [t.voice, t.scenes, t.build]) mkdirSync(d, { recursive: true });
  const sceneOf = (n) => board.scenes.find((s) => s.n === Number(n)) || fail(`No scene ${n} in storyboard.md.`);
  const saved = (n) => { const p = join(t.scenes, `${nn(n)}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
  const save = (n, v) => writeFileSync(join(t.scenes, `${nn(n)}.json`), JSON.stringify({ ...v, at: now() }, null, 2) + '\n');

  // Real lengths before the hand-over: the narration is made here (and cached for record), so the dev judges the pace.
  if (cmd === 'durations') {
    const voices = await narrateAll(t.voice, board.voice, board.scenes);
    const secs = Object.fromEntries(board.scenes.map((s) => [s.n, voices[s.n].seconds]));
    const text = readFileSync(t.storyboard, 'utf8');
    const next = withSeconds(text, secs);
    if (next !== text) writeFileSync(t.storyboard, next);
    const sum = (keep) => Math.round(board.scenes.filter(keep).reduce((a, s) => a + secs[s.n], 0));
    return print({
      scenes: board.scenes.map((s) => ({ scene: s.n, prio: s.prio || null, kind: s.kind, beats: voices[s.n].beats.length, seconds: Math.round(secs[s.n]) })),
      seconds: { all: sum(() => true), P1: sum((s) => s.prio === 'P1'), P2: sum((s) => s.prio === 'P2'), P3: sum((s) => s.prio === 'P3') },
      sec: next.includes('| Sec |') ? 'written to the Sec column' : 'no Sec column in this storyboard',
      note: 'The voice sets each length; a recorded scene runs at least this long.',
    });
  }

  if (cmd === 'record') {
    const only = args.flags.scene ? [sceneOf(args.flags.scene)] : board.scenes;
    const out = [];
    const voices = await narrateAll(t.voice, board.voice, only);
    const visual = only.filter((s) => s.kind !== 'chrome');
    let browser;
    if (visual.length) { const { chromium } = await dep('playwright-core'); browser = await chromium.launch({ channel: 'chrome', headless: true }); }
    try {
      for (const s of only) {
        const row = { scene: s.n, kind: s.kind, voice: Number(voices[s.n].seconds.toFixed(1)) };
        if (s.kind === 'chrome') { row.status = saved(s.n) ? 'recorded earlier' : `record it in Chrome: chrome-start ${key} ${s.n}`; out.push(row); continue; }
        try {
          if (s.kind === 'slide') {
            const page = await browser.newPage({ viewport: { width: W, height: PIC } });
            await page.setContent(slideHtml(s));
            const file = join(t.scenes, `${nn(s.n)}.png`);
            await page.screenshot({ path: file });
            await page.close();
            save(s.n, { kind: 'slide', file });
          } else save(s.n, await recordStorefront(browser, t, s, board, voices[s.n].beats.map((b) => b.seconds)));
          row.status = 'recorded';
        } catch (e) { row.status = 'FAILED'; row.problem = e.message.split('\n')[0]; }
        out.push(row);
      }
    } finally { await browser?.close(); }
    print({ scenes: out, next: out.some((r) => r.status === 'FAILED') ? 'fix the storyboard row, then: record --scene N' : `chrome scenes, then: assemble ${key}` });
    return;
  }

  if (cmd === 'chrome-start') {
    const s = sceneOf(rawScene);
    if (s.kind !== 'chrome') fail(`Scene ${s.n} is a ${s.kind} scene; record records it.`);
    if (!WIN) fail('Screen recording is Windows-only for now: change this scene to a slide.');
    if (!ffmpegBin()) fail('ffmpeg is missing: ! node .claude/kit/video.mjs setup');
    const voice = await narrateScene(t.voice, board.voice, s.say);
    const grab = spawnSync(ffmpegBin(), ['-hide_banner', '-f', 'gdigrab', '-draw_mouse', '0', '-i', 'desktop', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 256 * 1024 * 1024 });
    // "Capturing whole desktop as 3840x1373x32 at (-1920,-293)": the grab's size, and where its corner is on screen.
    const desk = String(grab.stderr).match(/desktop as (\d+)x(\d+)\S* at \((-?\d+),(-?\d+)\)/);
    if (grab.status !== 0 || !desk) fail('Couldn\'t grab the screen.');
    const area = findMarks(grab.stdout, Number(desk[1]), Number(desk[2]));
    if (area.problem) fail(`Can't find the Chrome tab: ${area.problem}`);
    // Smaller than this, the editor's settings can't be read even zoomed (a 1280x495 window in a real run).
    if (area.w < 1100 || area.h < 560) fail(`The Chrome tab is only ${area.w}x${area.h} on screen. Ask the dev to maximise its window on their main screen, then run chrome-start again.`);
    const file = join(t.scenes, `${nn(s.n)}.mkv`);
    const log = join(t.scenes, `${nn(s.n)}.capture.log`);
    // Matroska survives being stopped mid-write; the cap ends a recording nobody stopped. Only the tab's rectangle is
    // captured: grabbing the whole desktop and cropping dropped to 12 fps on two screens. chrome-stop kills ffmpeg, which
    // loses what it hasn't written: by default a cluster of ~5 s (a 16 s scene came out 10 s long). Half-second clusters,
    // flushed, and no encoder frame delay lose at most the last half second, after the scene's closing mark.
    const cap = Math.ceil(voice.seconds + 120);
    const child = spawn(ffmpegBin(), ['-hide_banner', '-y', '-f', 'gdigrab', '-draw_mouse', '0', '-framerate', '25',
      '-offset_x', String(area.x + Number(desk[3])), '-offset_y', String(area.y + Number(desk[4])), '-video_size', `${area.w}x${area.h}`, '-i', 'desktop', '-t', String(cap),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-flush_packets', '1', '-cluster_time_limit', '500', file],
    { detached: true, stdio: ['ignore', 'ignore', openSync(log, 'w')], windowsHide: true });
    child.unref();
    const until = Date.now() + 10000;
    let text = '';
    while (Date.now() < until && !/frame=\s*\d+/.test(text)) { await new Promise((r) => setTimeout(r, 50)); text = existsSync(log) ? readFileSync(log, 'utf8') : ''; }
    const seenAt = Date.now();
    if (!/frame=\s*\d+/.test(text)) { try { process.kill(child.pid); } catch {} fail(`The screen recording didn't start:\n${text.trim().split(/\r?\n/).slice(-3).join('\n')}`); }
    writeFileSync(join(t.scenes, `${nn(s.n)}.capture.json`), JSON.stringify({ pid: child.pid, startedAt: captureStart(text, seenAt), area, file }, null, 2));
    const needs = beatNeeds(voice.beats.map((b) => b.seconds));
    return print({
      recording: true, scene: s.n, minimumSceneSeconds: Number(voice.seconds.toFixed(1)),
      // The overlay fits the theme editor into a 16:9 box; an admin page keeps the tab's shape, and gets bars where unzoomed.
      warning: Math.abs(area.w / area.h - W / H) > 0.06 ? `The recorded area is ${area.w}x${area.h}, not 16:9 (not the theme editor), so unzoomed stretches get dark bars at the sides or top and bottom. Zoom (__kc.focus) where you can.` : undefined,
      beats: voice.beats.map((b, i) => ({ beat: i + 1, seconds: Number(needs[i].toFixed(1)), says: b.text })),
      keep: voice.beats.length > 1 ? `one group of stretches per beat, in order, split by ";": --keep "<beat 1>;<beat 2>…"` : undefined,
    });
  }

  if (cmd === 'chrome-stop') {
    const s = sceneOf(rawScene);
    const capPath = join(t.scenes, `${nn(s.n)}.capture.json`);
    if (!existsSync(capPath)) fail(`No recording running for scene ${s.n}: chrome-start ${key} ${s.n}`);
    const cap = JSON.parse(readFileSync(capPath, 'utf8'));
    // Stopped once already (a --keep was refused): the pid may belong to another process by now, and the file is kept,
    // so a corrected --keep doesn't cost a re-recording.
    if (!cap.stopped) {
      try { process.kill(cap.pid); } catch { /* it ended at its cap */ }
      await new Promise((r) => setTimeout(r, 800));
      writeFileSync(capPath, JSON.stringify({ ...cap, stopped: true }, null, 2));
    }
    let keep;
    try { keep = parseKeepBeats(args.flags.keep); } catch (e) { fail(e.message); }
    const beats = beatsOf(s.say).length;
    if (keep.length !== beats) fail(`--keep has ${keep.length} beat(s) and the scene's Say ${beats}: give one group of stretches per beat, split by ";". The recording is kept: run chrome-stop again.`);
    const length = seconds(cap.file);
    // The first 0.2 s of each stretch can still hold the corner marks being switched off.
    const parts = keep.flatMap((group, beat) => group.map(([a, b, focus]) => ({
      from: (a - cap.startedAt) / 1000 + 0.2, length: (b - a) / 1000 - 0.2, beat, ...(focus ? { crop: focusCrop(focus, cap.area.w, cap.area.h) } : {}),
    })));
    const bad = fitParts(parts, length);
    if (bad) fail(`A stretch (${bad.from.toFixed(1)} s in, ${bad.length.toFixed(1)} s long) doesn't fit the ${length.toFixed(1)} s recording, which spans __kc.now() ${Math.round(cap.startedAt)} to ${Math.round(cap.startedAt + length * 1000)}. Fix --keep and run chrome-stop again (the recording is kept), or record the scene again.`);
    rmSync(capPath);
    save(s.n, { kind: 'chrome', file: cap.file, parts, area: cap.area });
    return print({ scene: s.n, kept: `${parts.reduce((a, p) => a + p.length, 0).toFixed(1)} s of ${length.toFixed(1)} s`, zoomed: parts.filter((p) => p.crop).length });
  }

  if (cmd === 'assemble') {
    const font = fontArg();
    const voices = await narrateAll(t.voice, board.voice, board.scenes);
    const parts = [];
    const report = [];
    const tiles = [];
    for (const s of board.scenes) {
      const voice = voices[s.n];
      const shot = saved(s.n);
      if (!shot) {
        if (s.kind !== 'chrome') fail(`Scene ${s.n} isn't recorded yet: record ${key} --scene ${s.n}`);
        fail(`Scene ${s.n} (chrome) isn't recorded. Record it, or change its Kind to slide and run record --scene ${s.n}.`);
      }
      const stretches = shot.parts || [];
      const beats = voice.beats;
      // Recordings from before beats carry none on their stretches: they were one beat.
      const beatOf = (p) => p.beat ?? 0;
      const footage = beats.map((_, i) => stretches.filter((p) => beatOf(p) === i).reduce((sum, p) => sum + p.length, 0));
      if (shot.kind !== 'slide' && (stretches.some((p) => beatOf(p) >= beats.length) || footage.some((v) => !v))) {
        fail(`Scene ${s.n}: its Say has ${beats.length} beat(s), its recording ${Math.max(0, ...stretches.map((p) => beatOf(p) + 1))}. Record it again: ${s.kind === 'chrome' ? `chrome-start ${key} ${s.n}` : `record ${key} --scene ${s.n}`}.`);
      }
      const line = beatTimeline(beats.map((x) => x.seconds), footage);
      const total = line.reduce((sum, g) => sum + g.length, 0);
      // A part is re-encoded only when what goes into it changed, so fixing one scene doesn't redo the rest.
      const out = join(t.build, `${nn(s.n)}-${hash(JSON.stringify({ shot: { ...shot, at: null }, voice: beats.map((x) => x.file), say: s.say, captions: board.captions, v: 4 }))}.mp4`);
      if (!existsSync(out)) {
        for (const f of readdirSync(t.build)) if (f.startsWith(`${nn(s.n)}-`) && f.endsWith('.mp4')) rmSync(join(t.build, f));
        let k = 0;
        const caps = beats.flatMap((beat, i) => captionChunks(beat.text, beat.seconds).map((c) => {
          const name = `${nn(s.n)}-${k++}.txt`;
          writeFileSync(join(t.build, name), c.text);
          return `drawtext=textfile='${name}':expansion=none:${font}:fontsize=40:fontcolor=white:line_spacing=12:box=1:boxcolor=black@0.62:boxborderw=18:x=(w-text_w)/2:y=${H - CAPTION_BOTTOM}-text_h:enable='between(t,${(line[i].voiceAt + c.from).toFixed(2)},${(line[i].voiceAt + c.to).toFixed(2)})'`;
        }));
        const look = [`scale=${W}:${H}:force_original_aspect_ratio=decrease`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG}`, ...(board.captions ? caps : []), `fps=${FPS}`, 'format=yuv420p[v]'].join(',');
        let video = `[0:v]${look}`;
        if (shot.kind !== 'slide') {
          const chains = [];
          let c = 0;
          line.forEach((g, i) => {
            // A zoomed stretch is cropped and scaled back to the recording's size, so every stretch joins at one size.
            const ids = stretches.filter((p) => beatOf(p) === i).map((p) => {
              chains.push(`[0:v]trim=start=${p.from.toFixed(3)}:end=${(p.from + p.length).toFixed(3)},setpts=PTS-STARTPTS${p.crop ? `,crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y},scale=${shot.area.w}:${shot.area.h}:flags=lanczos` : ''}[c${c}]`);
              return `[c${c++}]`;
            });
            // Footage shorter than its beat holds its last frame until the voice is done.
            chains.push(`${ids.join('')}concat=n=${ids.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${(g.length - footage[i] + 0.2).toFixed(2)},trim=duration=${g.length.toFixed(3)},setpts=PTS-STARTPTS[b${i}]`);
          });
          video = `${chains.join(';')};${line.map((_, i) => `[b${i}]`).join('')}concat=n=${line.length}:v=1:a=0,${look}`;
        }
        // Each beat's voice starts with its footage, and silence fills the rest of the beat. The voice files come out
        // near -21 LUFS; +5 dB puts the video near -16, where web video sits.
        const audio = beats.map((_, i) => {
          const ms = Math.round((line[i].voiceAt - line[i].start) * 1000);
          return `[${i + 1}:a]volume=5dB,adelay=${ms}|${ms},apad=whole_dur=${line[i].length.toFixed(3)},atrim=duration=${line[i].length.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
        }).join(';') + `;${beats.map((_, i) => `[a${i}]`).join('')}concat=n=${beats.length}:v=0:a=1[a]`;
        ff([...(shot.kind === 'slide' ? ['-loop', '1', '-t', total.toFixed(2)] : []), '-i', shot.file, ...beats.flatMap((x) => ['-i', x.file]), '-filter_complex',
          `${video};${audio}`,
          '-map', '[v]', '-map', '[a]', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', out], { cwd: t.build });
      }
      parts.push(out);
      report.push({ scene: s.n, kind: s.kind, seconds: Number(total.toFixed(1)) });
      const png = join(t.build, `frame-${nn(s.n)}.png`);
      ff(['-ss', (total / 2).toFixed(2), '-i', out, '-frames:v', '1', '-vf', 'scale=640:-2', '-update', '1', png]);
      tiles.push(png);
    }
    const list = join(t.build, 'list.txt');
    writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    for (const f of readdirSync(t.vdir)) if (/-walkthrough(\.unreviewed)?\.mp4$/.test(f)) rmSync(join(t.vdir, f));
    const final = join(t.vdir, `${key}-walkthrough.unreviewed.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
    // One frame from the middle of each scene, two per row, for the agent's check.
    const frames = join(t.vdir, 'frames.png');
    if (tiles.length === 1) ff(['-i', tiles[0], '-frames:v', '1', '-update', '1', frames]);
    else ff([...tiles.flatMap((p) => ['-i', p]), '-filter_complex', `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${tiles.length}:layout=${tiles.map((_, i) => `${(i % 2) * 640}_${Math.floor(i / 2) * 360}`).join('|')}:fill=black`, '-frames:v', '1', '-update', '1', frames]);
    return print({ video: final, seconds: Number(seconds(final).toFixed(1)), scenes: report, frames, framesOrder: `two per row: scenes ${board.scenes.map((s) => s.n).join(', ')}` });
  }

  if (cmd === 'reviewed') {
    const answer = String(args.flags.answer || '').trim();
    if (!answer) fail('--answer "<the dev\'s words>" is required: the dev has to have watched it.');
    const from = join(t.vdir, `${key}-walkthrough.unreviewed.mp4`);
    if (!existsSync(from)) fail(`No unreviewed video: assemble ${key} first.`);
    const to = join(t.vdir, `${key}-walkthrough.mp4`);
    renameSync(from, to);
    appendFileSync(t.storyboard, `\n- ${now().slice(0, 16)} · ${seconds(to).toFixed(0)} s · watched by the dev: "${answer.replace(/\r?\n/g, ' ')}"\n`);
    return print({ video: to });
  }

  fail(`Unknown command "${cmd}". See the top of .claude/kit/video.mjs.`);
}

function selftest() {
  const board = `Voice: en-US-AndrewNeural\nQuery: ablyft_opt_out=true\n\n| # | Kind | Where | Show | Say |\n| --- | --- | --- | --- | --- |\n`
    + '| 1 | slide | What\'s new | A / B | Hello there. |\n| 2 | storefront | products/x @mobile | hide .popup; highlight .a; click .b\\|c | Tap it. |\n| 3 | chrome | Theme editor › Product | open the section | Change it here. |\n';
  const b = parseStoryboard(board);
  const bad = (text) => { try { parseStoryboard(text); return null; } catch (e) { return e.message; } };
  const caps = captionChunks('One short sentence. ' + 'word '.repeat(40).trim() + '.', 10);
  // A synthetic 40x30 screen with marks at (5,4)-(34,25): the found box must be exactly that, even-sized.
  const scr = (marks) => { const w = 600, h = 400, buf = Buffer.alloc(w * h * 3, 40); for (const [x, y] of marks) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) { const i = ((y + dy) * w + x + dx) * 3; buf[i] = 255; buf[i + 1] = 0; buf[i + 2] = 255; } return findMarks(buf, w, h); };
  const full = scr([[10, 20], [507, 20], [10, 357], [507, 357]]);
  const covered = scr([[10, 20], [507, 20], [10, 357]]);
  const checks = [
    ['storyboard: header lines', b.voice === 'en-US-AndrewNeural' && b.query === 'ablyft_opt_out=true'],
    ['storyboard: three scenes with kinds', b.scenes.map((s) => s.kind).join() === 'slide,storefront,chrome'],
    ['storyboard: an escaped pipe stays in the cell', b.scenes[1].show.endsWith('.b|c')],
    ['storyboard: unknown kind refused', /isn't one of/.test(bad(board.replace('| chrome |', '| video |')))],
    ['storyboard: empty Say refused', /Say is empty/.test(bad(board.replace('Change it here.', '')))],
    ['storyboard: unknown action refused', /isn't an action/.test(bad(board.replace('hide .popup', 'type hello')))],
    ['storyboard: no rows refused', /no scenes/.test(bad('Voice: x\n'))],
    ['show: wait needs seconds', (() => { try { parseShow('wait soon'); return false; } catch { return true; } })()],
    ['fit: a stretch 0.3 s past the end is clamped', (() => { const p = [{ from: 2, length: 3 }, { from: 6, length: 4.3 }]; return !fitParts(p, 10) && p[1].length === 4 && p[0].length === 3; })()],
    ['fit: 2 s past the end or a negative start is refused', Boolean(fitParts([{ from: 6, length: 6 }], 10)) && Boolean(fitParts([{ from: -1, length: 2 }], 10))],
    ['beats: " / " splits a Say, none is one beat', beatsOf('One. / Two, on/off. / Three.').length === 3 && beatsOf('Just one.').length === 1],
    ['beats: shorter footage is held, a shorter voice gets silence', (() => { const l = beatTimeline([2, 3], [5, 1]); return l[0].length === 5 && l[0].voiceAt === LEAD && l[1].start === 5 && Math.abs(l[1].length - (3 + TAIL)) < 1e-9 && l[1].voiceAt === 5; })()],
    ['beats: a storefront Show needs one part per beat', /2 beat/.test(bad(board.replace('Tap it.', 'Tap it. / Then this.')) || '') && !bad(board.replace('Tap it.', 'Tap it. / Then this.').replace('click .b\\|c', 'click .b\\|c / wait 1'))],
    ['keep: ";" groups stretches by beat, in order', (() => { const k = parseKeepBeats('1000-2000,3000-4000@0.1,0.1,0.5,0.5;5000-6000'); return k.length === 2 && k[0].length === 2 && k[1][0][0] === 5000; })()],
    ['keep: an empty beat or beats out of order are refused', (() => { try { parseKeepBeats('1000-2000;'); return false; } catch {} try { parseKeepBeats('5000-6000;1000-2000'); return false; } catch { return true; } })()],
    ['storyboard: captions are on unless Captions: off', b.captions === true && parseStoryboard(board.replace('Query:', 'Captions: Off\nQuery:')).captions === false],
    ['where: mobile path', storefrontWhere('cart @mobile').path === '/cart' && storefrontWhere('cart @mobile').mobile],
    ['where: home is the root', storefrontWhere('home @desktop').path === '/'],
    ['where: a URL is refused', (() => { try { storefrontWhere('https://evil.example/x'); return false; } catch { return true; } })()],
    ['where: protocol-relative refused', (() => { try { storefrontWhere('//evil.example/x'); return false; } catch { return true; } })()],
    ['url: draft theme always set', sceneUrl('s.myshopify.com', 42, '/products/x', 'preview_theme_id=1&a=b') === 'https://s.myshopify.com/products/x?a=b&preview_theme_id=42'],
    ['url: stays on the store', new URL(sceneUrl('s.myshopify.com', 42, '/x')).host === 's.myshopify.com'],
    ['captions: at most two lines each', caps.every((c) => c.text.split('\n').length <= 2 && c.text.split('\n').every((l) => l.length <= 70))],
    ['captions: cover the narration exactly', Math.abs(caps.at(-1).to - 10) < 1e-9 && caps[0].from === 0],
    ['marks: the box between the four corners', full.x === 10 && full.y === 20 && full.w === 500 && full.h === 340],
    ['capture start: first progress line minus its time', captureStart('frame=   12 fps=0.0 q=0.0 size=0kB time=00:00:00.48 bitrate', 10000) === 9520 && captureStart('time=N/A', 10000) === 10000],
    ['keep: pairs in order', JSON.stringify(parseKeep('10-20, 30-45')) === '[[10,20],[30,45]]'],
    ['keep: overlap refused', (() => { try { parseKeep('10-30,20-40'); return false; } catch { return true; } })()],
    ['keep: a reversed pair refused', (() => { try { parseKeep('30-10'); return false; } catch { return true; } })()],
    ['keep: a stretch takes a zoom, the next one starts after it', JSON.stringify(parseKeep('10-20@0.5,0.1,0.3,0.4, 30-45')) === '[[10,20,[0.5,0.1,0.3,0.4]],[30,45]]'],
    ['keep: a zoom needs four fractions', (() => { try { parseKeep('10-20@0.5,1.2,0.3,0.4'); return false; } catch { return true; } })()],
    ['zoom: a narrow panel widens to the picture\'s shape, inside the recording', (() => { const c = focusCrop([0.75, 0.1, 0.2, 0.3], 1864, 798); return c.w === 932 && c.h === 524 && c.x + c.w <= 1864 && c.y >= 0 && Math.abs(c.w / c.h - W / PIC) < 0.02; })()],
    ['zoom: never past 2x', focusCrop([0.4, 0.4, 0.05, 0.05], 1000, 500).w >= 500],
    ['storyboard: Prio and Sec columns by name; optional rows aren\'t scenes', (() => {
      const v2 = 'Voice: x\n\n| # | Prio | Kind | Where | Show | Say | Sec |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | P1 | slide | New | A | Hi. | |\n| 2 | p2 | chrome | Editor | open | Do it. | 9 |\n\n## Optional scenes\n\n| # | Prio | Sec | Shows |\n| --- | --- | --- | --- |\n| O1 | P3 | 10 | more |\n';
      const p = parseStoryboard(v2);
      const filled = withSeconds(v2, { 1: 4.4, 2: 12.6 });
      return p.scenes.length === 2 && p.scenes[1].prio === 'P2' && p.scenes[1].say === 'Do it.' && /\| 1 \| P1 \| slide \| New \| A \| Hi\. \| 4 \|/.test(filled) && /\| Do it\. \| 13 \|/.test(filled) && filled.includes('| O1 | P3 | 10 | more |');
    })()],
    ['storyboard: an unknown Prio refused', /isn't P1, P2 or P3/.test(bad(board.replace('| # | Kind |', '| # | Prio | Kind |').replace('| --- | --- |', '| --- | --- | --- |').replace('| 1 | slide', '| 1 | P9 | slide').replace('| 2 | storefront', '| 2 | P1 | storefront').replace('| 3 | chrome', '| 3 | P1 | chrome')))],
    ['marks: a covered corner is refused', /only some/.test(covered.problem || '')],
    ['marks: none on screen', /no corner marks/.test(scr([]).problem || '')],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  console.log(`${checks.length - failed.length}/${checks.length} video self-tests passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => fail(e.message));
