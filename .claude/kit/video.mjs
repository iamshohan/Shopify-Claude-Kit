#!/usr/bin/env node
// Walkthrough video for the client, from a task QA accepted: storefront scenes recorded on the draft theme in a hidden
// browser, theme-editor and admin scenes as stills from the dev's own Chrome (one per beat, slowly zoomed), slides for
// the rest. Each scene is narrated (Microsoft neural voice) and captioned; one MP4 comes out.
// /shopify-video <KEY> runs it. The tools live once per machine in ~/.shopify-kit/video, outside every repo.
//   setup                                        install the recorder, ffmpeg and the voice (the dev runs it, once)
//   check                                        are they installed, and does the voice answer?
//   start <KEY> [--accepted "<dev's words>"]     can this task be filmed? creates storyboard.md. --accepted: Gate 2 was
//                                                held outside the kit, so the tracker never reached handoff
//   durations <KEY>                              narration for every scene; writes each scene's seconds into the Sec column
//   record <KEY> [--scene N]                     narration for every scene, then the storefront scenes and slides
//   overlay                                      prints the path of the cursor script for the Chrome tab
//   still <KEY> <N> --shots "<img>[@x,y,w,h];…"  a chrome scene's stills, one image per beat (the Say's " / " parts):
//                                                Claude in Chrome's saved zooms; "@x,y,w,h" (from __kc.focus) crops to
//                                                part of it
//   assemble <KEY>                               join the scenes into video/<KEY>-walkthrough.unreviewed.mp4, and
//                                                video/frames-N.png (a frame per beat, six a sheet) for the agent's check
//   reviewed <KEY> --answer "<dev's words>"      the dev watched it: drops .unreviewed from the name
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
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
const CAPTION_SAFE = 0.8; // two caption lines and their box cover about the bottom 18%: what's talked about stays above
const LEAD = 0.3, TAIL = 0.3; // seconds of picture before the voice starts and after it ends (the mp3s add ~0.3 s each)
const GAP = 0.2; // between two beats of a scene, on top of the mp3s' own silence
const RATE = '-10%'; // the voice's default runs near 200 words a minute; clients follow better nearer 170
const FPS = 25; // the storefront recorder captures at 25: another output rate repeats frames and motion judders
const ZOOM = 0.05; // a still's slow zoom over its beat: enough to read as motion, not enough to cut anything off
const DESKTOP = { width: 1440, height: 810 }; // 16:9, the picture's shape
const MOBILE = { width: 390, height: 844 };
const TILE = { w: 960, h: 540 }; // check frames: half the picture, so a sheet of six stays near full size when read

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
  const m = String(where).trim().match(/^(\S*?)\s*(?:@(desktop|mobile))?$/i);
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
  // Split at a sentence end followed by a space: matching sentences skipped what didn't match ("$49." of "$49.99").
  const sentences = say.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
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
 * Seconds of media in a file. Recordings are read to the end, copied rather than decoded (0.1 s instead of 1.5 s for
 * 25 s of webm): a browser recording has no duration header.
 */
function seconds(file) {
  const head = /\.(mkv|webm)$/i.test(file) ? '' : spawnSync(ffmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  const d = head.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (d) return d[1] * 3600 + d[2] * 60 + Number(d[3]);
  const all = [...(spawnSync(ffmpegBin(), ['-hide_banner', '-i', file, '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '').matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
  return all ? all[1] * 3600 + all[2] * 60 + Number(all[3]) : 0;
}

/** An image's size in pixels, from ffmpeg's description of it, or null. */
function imageSize(file) {
  const m = (spawnSync(ffmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '').match(/Stream[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const nn = (n) => String(n).padStart(2, '0');

/** The voice library puts the text into SSML as it is: an "&" or "<" in a Say failed every narration. */
export const ssmlText = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

async function narration(dir, voice, say) {
  const file = join(dir, `${hash(`${voice}\0${RATE}\0${say}`)}.mp3`);
  if (!existsSync(file)) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await dep('msedge-tts');
    // Each call writes "audio.mp3" into its folder, so parallel calls need folders of their own, even for the same text.
    const tmp = join(dir, `tmp-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(tmp, ssmlText(say), { rate: RATE });
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

/**
 * '--shots "<img>@x,y,w,h;<img>"': one image per beat, split by ";". A path's "@x,y,w,h" crops its still to that part,
 * as fractions of the image: what __kc.focus() returns. → [{ file, focus: [x, y, w, h] | null }]
 */
export function parseShots(text) {
  const beats = String(text || '').split(';').map((g) => g.trim());
  if (beats.some((g) => !g)) throw new Error('--shots takes one saved image per beat, in order, split by ";": --shots "<path>[@x,y,w,h];<path>…"');
  return beats.map((g) => {
    const m = g.match(/^(.*?)@([^@]*)$/);
    const focus = m ? m[2].split(',').map(Number) : null;
    if (focus && (focus.length !== 4 || focus.some((v) => !(v >= 0 && v <= 1)) || !(focus[2] > 0 && focus[3] > 0))) throw new Error(`"@${m[2]}" should be four fractions x,y,w,h: paste what __kc.focus() returned`);
    return { file: (m ? m[1] : g).trim().replace(/^["']|["']$/g, ''), focus };
  });
}

/**
 * The crop for a zoomed still or stretch, in its pixels: the focus box widened to the picture's shape, so the zoom
 * fills it, and to at least half the image, so text isn't blown up past 2x. The box sits above the bottom fifth,
 * where the captions go: centred, they covered the field being talked about (CHE-865). Even numbers, inside the image.
 */
export function focusCrop([fx, fy, fw, fh], width, height) {
  const aspect = W / PIC;
  let w = Math.max(fw * width, fh * height * aspect, width / 2);
  let h = w / aspect;
  if (h > height) { h = height; w = h * aspect; }
  w = Math.min(w, width);
  const cx = (fx + fw / 2) * width, cy = (fy + fh / 2) * height;
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  const above = Math.min((fy + fh) * height - h * CAPTION_SAFE, fy * height);
  const x = Math.min(Math.max(0, cx - w / 2), width - w), y = Math.min(Math.max(0, cy - h / 2, above), height - h);
  return { x: even(x), y: even(y), w: even(w), h: even(h) };
}

/**
 * The filtergraph that cuts a recording ([0:v]) into its kept stretches, beat by beat, ending unlabelled (the caller
 * appends the look). Every stretch is fitted to the picture on its own, so a zoom keeps its shape on a recording that
 * isn't 16:9, and its pixel shape is set: concat refuses stretches whose pixel shapes differ.
 */
export function footageGraph(stretches, line, footage) {
  const chains = [];
  let c = 0;
  line.forEach((g, i) => {
    const ids = stretches.filter((p) => p.beat === i).map((p) => {
      chains.push(`[0:v]trim=start=${p.from.toFixed(3)}:end=${(p.from + p.length).toFixed(3)},setpts=PTS-STARTPTS${p.crop ? `,crop=${p.crop.w}:${p.crop.h}:${p.crop.x}:${p.crop.y}` : ''},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1[c${c}]`);
      return `[c${c++}]`;
    });
    // Footage shorter than its beat holds its last frame until the voice is done.
    chains.push(`${ids.join('')}concat=n=${ids.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${(g.length - footage[i] + 0.2).toFixed(2)},trim=duration=${g.length.toFixed(3)},setpts=PTS-STARTPTS[b${i}]`);
  });
  return `${chains.join(';')};${line.map((_, i) => `[b${i}]`).join('')}concat=n=${line.length}:v=1:a=0`;
}

/**
 * The filtergraph for a chrome scene's stills (input i is beat i's image, looped): each cropped to its focus, fitted to
 * the picture and zoomed in slowly over its beat, then joined, ending unlabelled. Fitted at twice the picture's size
 * first: zoompan moves in whole pixels, so a slow zoom at 1x steps visibly.
 */
export function stillsGraph(stills, line) {
  return stills.map((s, i) => {
    const frames = Math.max(1, Math.round(line[i].length * FPS));
    return `[${i}:v]${s.crop ? `crop=${s.crop.w}:${s.crop.h}:${s.crop.x}:${s.crop.y},` : ''}scale=${2 * W}:${2 * H}:force_original_aspect_ratio=decrease:flags=lanczos,`
      + `pad=${2 * W}:${2 * H}:(ow-iw)/2:(oh-ih)/2:color=${BG},setsar=1,zoompan=z='1+${ZOOM}*on/${frames}':d=1:x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':s=${W}x${H}:fps=${FPS},`
      + `trim=duration=${line[i].length.toFixed(3)},setpts=PTS-STARTPTS[b${i}]`;
  }).join(';') + `;${stills.map((_, i) => `[b${i}]`).join('')}concat=n=${stills.length}:v=1:a=0`;
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
  const groups = showBeats(scene.show);
  await ctx.addInitScript({ path: OVERLAY });
  await ctx.addInitScript(HIDE_APPS);
  // As an init script, so a click that opens another page keeps them (addStyleTag lasted one page).
  const hides = groups.flat().filter((x) => x.op === 'hide').map((o) => `${o.arg}{display:none!important}`).join('');
  if (hides) {
    await ctx.addInitScript(`(() => {
      if (window.top !== window) return;
      const add = () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(hides)}; document.documentElement.appendChild(s); };
      if (document.documentElement) add(); else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); add(); } }).observe(document, { childList: true });
    })();`);
  }
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (/\/password/.test(page.url())) throw new Error('the storefront is password-protected: make this a chrome scene (the dev\'s Chrome is logged in), or ask the dev to lift the password while recording');
    const theme = await page.evaluate(() => window.Shopify?.theme && { id: window.Shopify.theme.id, role: window.Shopify.theme.role });
    if (!theme || String(theme.id) !== String(t.st.draft.themeId) || theme.role === 'main') throw new Error(`the page rendered ${theme ? `theme ${theme.id} (${theme.role})` : 'no Shopify theme'}, not the draft ${t.st.draft.themeId}`);
    await page.waitForFunction(() => window.__kc, null, { timeout: 5000 }).catch(() => { throw new Error('the cursor overlay didn\'t load on this page'); });
    await page.waitForTimeout(600);
    const tFlash = await page.evaluate(() => window.__kc.flash());
    await page.waitForTimeout(900);
    // A beat's footage starts with its first visible action, not when the code starts on it: on a busy page, finding the
    // element took 1.4 s, and the voice talked over a still picture while the action came late (CHE-865, measured).
    let beatStart = null;
    const go = () => { beatStart ??= Date.now(); };
    const target = async (sel) => {
      // The first visible match: a hidden twin (a mobile-only copy, a closed drawer) failed two CHE-865 scenes.
      const el = page.locator(sel).filter({ visible: true }).first();
      if (!(await el.count())) throw new Error(`no visible element matches "${sel}"`);
      go();
      // 40% down rather than centred, so a tall element's lower part stays above the captions.
      await el.evaluate((e) => {
        const r = e.getBoundingClientRect();
        window.scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight * 0.4, behavior: 'smooth' });
      });
      // Clicking where a smooth scroll or a late image left the element a moment ago missed it: wait for it to settle.
      let b = null;
      for (let i = 0; i < 25; i++) {
        await page.waitForTimeout(100);
        const next = await el.boundingBox();
        if (b && next && Math.abs(next.y - b.y) < 1 && Math.abs(next.x - b.x) < 1) break;
        b = next;
      }
      if (!b) throw new Error(`"${sel}" isn't visible`);
      // Inside a scrolling box (a drawer, a slider) the window scroll doesn't reach it.
      const vp = page.viewportSize();
      if (b.y < 0 || b.y + b.height / 2 > vp.height) {
        await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
        await page.waitForTimeout(700);
        b = await el.boundingBox();
        if (!b) throw new Error(`"${sel}" isn't visible`);
      }
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const act = async ({ op, arg }) => {
      if (op === 'hide') return;
      await page.evaluate(() => window.__kc.highlight(null));
      if (op === 'wait') { go(); return page.waitForTimeout(arg * 1000); }
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
      beatStart = null;
      for (const o of ops) await act(o);
      const tStart = beatStart ?? Date.now();
      const hold = tStart + needs[i] * 1000 - Date.now();
      if (hold > 0) await page.waitForTimeout(hold);
      spans.push([tStart, Date.now()]);
    }
    // Closing straight after the last frame cut it short in tests.
    await page.waitForTimeout(400);
    const tEnd = Date.now();
    await ctx.close();
    const raw = await page.video().path();
    // Where the flash is in the recording ties its time to the clock. Without it, the length has to do: the recording
    // starts a little after the page opened, but it also comes out shorter than the time it spanned.
    const flashAt = findFlash(raw);
    const offset = flashAt === null ? (tEnd - t0) / 1000 - seconds(raw) : (tFlash - t0) / 1000 - flashAt;
    const file = join(t.scenes, `${nn(scene.n)}.webm`);
    renameSync(raw, file);
    return { kind: 'storefront', file, synced: flashAt !== null, parts: spans.map(([a, b], beat) => ({ from: Math.max(0, (a - t0) / 1000 - offset), length: (b - a) / 1000, beat })) };
  } finally {
    await ctx.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Seconds into a recording where the overlay's magenta flash first shows (its first 40 s, at 25 fps), or null. */
function findFlash(file) {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-t', '40', '-i', file, '-vf', `fps=${FPS},scale=16:9`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  return flashFrame(r.stdout || Buffer.alloc(0), 16 * 9);
}

/** The time of the first frame that is mostly magenta, in raw rgb24 frames of `pixels` pixels at FPS, or null. */
export function flashFrame(buf, pixels) {
  const size = pixels * 3;
  for (let f = 0; (f + 1) * size <= buf.length; f++) {
    let hits = 0;
    for (let i = f * size; i < (f + 1) * size; i += 3) if (buf[i] >= 200 && buf[i + 1] <= 60 && buf[i + 2] >= 200) hits++;
    if (hits > pixels * 0.6) return f / FPS;
  }
  return null;
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
    const out = { tools: DEPS, recorder: has('playwright-core'), ffmpeg: Boolean(ffmpegBin()), voice: has('msedge-tts') };
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
  // Only filming needs the draft: after cleanup, captions can still be fixed and the video still marked as reviewed.
  const why = ['start', 'record', 'still'].includes(cmd) && filmable(t.st);
  if (why) fail(`${key} can't be filmed: ${why}`);
  mkdirSync(t.vdir, { recursive: true });

  if (cmd === 'start') {
    if (!has('playwright-core') || !has('msedge-tts') || !ffmpegBin()) fail('The video tools aren\'t installed on this machine. Ask the dev to run, once:\n  ! node .claude/kit/video.mjs setup');
    if (!existsSync(t.storyboard)) writeFileSync(t.storyboard, readFileSync(join(KIT_DIR, 'templates', 'storyboard.md'), 'utf8').replaceAll('{{KEY}}', key));
    // A GitHub-connected draft is never pushed by the kit: only verify records its commit.
    const drafted = t.st.draft.lastPushedCommit || t.st.draft.verifiedCommit;
    const warn = t.st.qa?.commit && drafted && t.st.qa.commit !== drafted
      ? `The draft is at ${drafted.slice(0, 7)}, QA accepted ${t.st.qa.commit.slice(0, 7)}: the video may show unaccepted code.` : null;
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
        if (s.kind === 'chrome') { row.status = saved(s.n) ? 'taken earlier' : `stills in Chrome: still ${key} ${s.n} --shots "…"`; out.push(row); continue; }
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
    print({ scenes: out, next: out.some((r) => r.status === 'FAILED') ? 'fix the storyboard row, then: record --scene N' : `chrome scenes' stills, then: assemble ${key}` });
    return;
  }

  // A chrome scene: one image per beat, Claude in Chrome's saved zooms of the editor's box. Copied in, since its
  // screenshot folder is temporary; a crop for each "@x,y,w,h".
  if (cmd === 'still') {
    const s = sceneOf(rawScene);
    if (s.kind !== 'chrome') fail(`Scene ${s.n} is a ${s.kind} scene; record records it.`);
    if (!ffmpegBin()) fail('ffmpeg is missing: ! node .claude/kit/video.mjs setup');
    let shots;
    try { shots = parseShots(args.flags.shots); } catch (e) { fail(e.message); }
    const beats = beatsOf(s.say).length;
    if (shots.length !== beats) fail(`--shots has ${shots.length} image(s) and the scene's Say ${beats} beat(s): one image per beat, in order, split by ";".`);
    // Every shot is checked before anything is replaced: a retake may reuse this scene's own earlier still, and a typo
    // mustn't leave the scene without images.
    const sized = shots.map((shot) => {
      if (!existsSync(shot.file)) fail(`No image at ${shot.file}: give the path the zoom's save_to_disk printed.`);
      return { shot, size: imageSize(shot.file) || fail(`${shot.file} isn't an image ffmpeg can read.`) };
    });
    const staged = sized.map(({ shot }, i) => { const tmp = join(t.scenes, `${nn(s.n)}-${i + 1}.new.png`); ff(['-i', shot.file, '-frames:v', '1', '-update', '1', tmp]); return tmp; });
    for (const f of readdirSync(t.scenes)) if (f.startsWith(`${nn(s.n)}-`) && f.endsWith('.png') && !f.endsWith('.new.png')) rmSync(join(t.scenes, f));
    const stills = sized.map(({ shot, size }, i) => {
      const file = join(t.scenes, `${nn(s.n)}-${i + 1}.png`);
      renameSync(staged[i], file);
      return { file, w: size.w, h: size.h, ...(shot.focus ? { crop: focusCrop(shot.focus, size.w, size.h) } : {}) };
    });
    save(s.n, { kind: 'chrome', stills });
    // The zoom saves the box at the screen's pixels: a small one means a small window, and a soft video.
    const small = stills.map((x, i) => (x.w < 1200 ? `beat ${i + 1}: ${x.w}x${x.h}` : null)).filter(Boolean);
    return print({
      scene: s.n, stills: stills.length, zoomed: stills.filter((x) => x.crop).length,
      ...(small.length ? { warning: `Small stills (${small.join(', ')}) come out soft. Was the zoom's region frame()'s box, at scale 1? A bigger Chrome window gives sharper ones.` } : {}),
    });
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
        fail(`Scene ${s.n} (chrome) has no stills yet: still ${key} ${s.n} --shots "…", or change its Kind to slide and run record --scene ${s.n}.`);
      }
      const beats = voice.beats;
      // A still lasts as long as its beat's voice; a recording (storefront, or a chrome scene recorded before stills)
      // brings its own footage.
      const stills = shot.stills || null;
      if (stills && stills.length !== beats.length) fail(`Scene ${s.n}: its Say has ${beats.length} beat(s), its stills ${stills.length}. Take them again: still ${key} ${s.n} --shots "…"`);
      const stretches = shot.parts || [];
      // Recordings from before beats carry none on their stretches: they were one beat.
      const beatOf = (p) => p.beat ?? 0;
      const footage = beats.map((_, i) => stretches.filter((p) => beatOf(p) === i).reduce((sum, p) => sum + p.length, 0));
      if (!stills && shot.kind !== 'slide' && (stretches.some((p) => beatOf(p) >= beats.length) || footage.some((v) => !v))) {
        fail(`Scene ${s.n}: its Say has ${beats.length} beat(s), its recording ${Math.max(0, ...stretches.map((p) => beatOf(p) + 1))}. ${s.kind === 'chrome' ? `Take its stills: still ${key} ${s.n} --shots "…"` : `Record it again: record ${key} --scene ${s.n}`}.`);
      }
      const line = beatTimeline(beats.map((x) => x.seconds), footage);
      const total = line.reduce((sum, g) => sum + g.length, 0);
      // A part is re-encoded only when what goes into it changed, so fixing one scene doesn't redo the rest. The shot's
      // save time is in it: a slide re-rendered to the same file kept its old picture without it.
      const out = join(t.build, `${nn(s.n)}-${hash(JSON.stringify({ shot, voice: beats.map((x) => x.file), say: s.say, captions: board.captions, v: 5 }))}.mp4`);
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
        if (stills) video = `${stillsGraph(stills, line)},${look}`;
        else if (shot.kind !== 'slide') video = `${footageGraph(stretches.map((p) => ({ ...p, beat: beatOf(p) })), line, footage)},${look}`;
        // The picture's inputs first (a still per beat, or one file), then a voice file per beat.
        const pictures = stills ? stills.flatMap((x, i) => ['-loop', '1', '-framerate', String(FPS), '-t', (line[i].length + 0.2).toFixed(2), '-i', x.file])
          : [...(shot.kind === 'slide' ? ['-loop', '1', '-t', total.toFixed(2)] : []), '-i', shot.file];
        const first = stills ? stills.length : 1;
        // Each beat's voice starts with its footage, and silence fills the rest of the beat. The voice files come out
        // near -21 LUFS; +5 dB puts the video near -16, where web video sits.
        const audio = beats.map((_, i) => {
          const ms = Math.round((line[i].voiceAt - line[i].start) * 1000);
          return `[${first + i}:a]volume=5dB,adelay=${ms}|${ms},apad=whole_dur=${line[i].length.toFixed(3)},atrim=duration=${line[i].length.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`;
        }).join(';') + `;${beats.map((_, i) => `[a${i}]`).join('')}concat=n=${beats.length}:v=0:a=1[a]`;
        ff([...pictures, ...beats.flatMap((x) => ['-i', x.file]), '-filter_complex',
          `${video};${audio}`,
          '-map', '[v]', '-map', '[a]', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', out], { cwd: t.build });
      }
      parts.push(out);
      report.push({ scene: s.n, kind: s.kind, seconds: Number(total.toFixed(1)) });
      // A frame from the middle of each beat, labelled "scene.beat": one per scene missed a preview showing the wrong
      // section (CHE-865). One ffmpeg pass per scene.
      for (const f of readdirSync(t.build)) if (f.startsWith(`frame-${nn(s.n)}-`)) rmSync(join(t.build, f));
      const picks = line.map((g) => Math.round((g.start + g.length / 2) * FPS));
      ff(['-i', out, '-vf', `select='${picks.map((n) => `eq(n\\,${n})`).join('+')}',scale=${TILE.w}:${TILE.h}`, '-fps_mode', 'passthrough', join(t.build, `frame-${nn(s.n)}-%d.png`)]);
      line.forEach((_, i) => { const png = join(t.build, `frame-${nn(s.n)}-${i + 1}.png`); if (existsSync(png)) tiles.push({ png, label: `${s.n}.${i + 1}` }); });
    }
    const list = join(t.build, 'list.txt');
    writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    for (const f of readdirSync(t.vdir)) if (/-walkthrough(\.unreviewed)?\.mp4$/.test(f)) rmSync(join(t.vdir, f));
    const final = join(t.vdir, `${key}-walkthrough.unreviewed.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', final]);
    // Sheets of six, two per row, each tile labelled: a single sheet of every scene reached the agent shrunk to 355 px
    // tiles, too small to see a cut-off label or a second pointer.
    for (const f of readdirSync(t.vdir)) if (/^frames(-\d+)?\.png$/.test(f)) rmSync(join(t.vdir, f));
    const frames = [];
    for (let i = 0; i < tiles.length; i += 6) {
      const sheet = tiles.slice(i, i + 6);
      const file = join(t.vdir, `frames-${frames.length + 1}.png`);
      const label = (k, x) => `[${k}:v]drawtext=text='${x.label}':expansion=none:${font}:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=10:x=14:y=14[l${k}]`;
      const graph = sheet.length === 1 ? `${label(0, sheet[0])};[l0]null`
        : `${sheet.map((x, k) => label(k, x)).join(';')};${sheet.map((_, k) => `[l${k}]`).join('')}xstack=inputs=${sheet.length}:layout=${sheet.map((_, k) => `${(k % 2) * TILE.w}_${Math.floor(k / 2) * TILE.h}`).join('|')}:fill=black`;
      ff([...sheet.flatMap((x) => ['-i', x.png]), '-filter_complex', graph, '-frames:v', '1', '-update', '1', file]);
      frames.push(file);
    }
    return print({ video: final, seconds: Number(seconds(final).toFixed(1)), scenes: report, frames, framesOrder: 'one frame from the middle of each beat, labelled scene.beat, six per sheet' });
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
  const shotsBad = (text) => { try { parseShots(text); return null; } catch (e) { return e.message; } };
  const checks = [
    ['storyboard: header lines', b.voice === 'en-US-AndrewNeural' && b.query === 'ablyft_opt_out=true'],
    ['storyboard: three scenes with kinds', b.scenes.map((s) => s.kind).join() === 'slide,storefront,chrome'],
    ['storyboard: an escaped pipe stays in the cell', b.scenes[1].show.endsWith('.b|c')],
    ['storyboard: unknown kind refused', /isn't one of/.test(bad(board.replace('| chrome |', '| video |')))],
    ['storyboard: empty Say refused', /Say is empty/.test(bad(board.replace('Change it here.', '')))],
    ['storyboard: unknown action refused', /isn't an action/.test(bad(board.replace('hide .popup', 'type hello')))],
    ['storyboard: no rows refused', /no scenes/.test(bad('Voice: x\n'))],
    ['show: wait needs seconds', (() => { try { parseShow('wait soon'); return false; } catch { return true; } })()],
    ['beats: " / " splits a Say, none is one beat', beatsOf('One. / Two, on/off. / Three.').length === 3 && beatsOf('Just one.').length === 1],
    ['beats: shorter footage is held, a shorter voice gets silence', (() => { const l = beatTimeline([2, 3], [5, 1]); return l[0].length === 5 && l[0].voiceAt === LEAD && l[1].start === 5 && Math.abs(l[1].length - (3 + TAIL)) < 1e-9 && l[1].voiceAt === 5; })()],
    ['beats: a storefront Show needs one part per beat', /2 beat/.test(bad(board.replace('Tap it.', 'Tap it. / Then this.')) || '') && !bad(board.replace('Tap it.', 'Tap it. / Then this.').replace('click .b\\|c', 'click .b\\|c / wait 1'))],
    ['shots: one image per beat, a focus only where given; a Windows path keeps its drive', (() => {
      const s = parseShots('C:\\Temp\\shots\\a.png@0.1,0.2,0.5,0.4; "C:\\Temp\\shots\\b.png"');
      return s.length === 2 && s[0].file === 'C:\\Temp\\shots\\a.png' && s[0].focus.join() === '0.1,0.2,0.5,0.4' && s[1].file === 'C:\\Temp\\shots\\b.png' && s[1].focus === null;
    })()],
    ['shots: an empty beat or a focus that isn\'t four fractions is refused', /one saved image per beat/.test(shotsBad('a.png;') || '') && /four fractions/.test(shotsBad('a.png@0.1,1.4,0.5,0.4') || '') && /four fractions/.test(shotsBad('a.png@0.1,0.2') || '')],
    ['storyboard: captions are on unless Captions: off', b.captions === true && parseStoryboard(board.replace('Query:', 'Captions: Off\nQuery:')).captions === false],
    ['where: mobile path', storefrontWhere('cart @mobile').path === '/cart' && storefrontWhere('cart @mobile').mobile],
    ['where: home is the root', storefrontWhere('home @desktop').path === '/'],
    ['where: a URL is refused', (() => { try { storefrontWhere('https://evil.example/x'); return false; } catch { return true; } })()],
    ['where: protocol-relative refused', (() => { try { storefrontWhere('//evil.example/x'); return false; } catch { return true; } })()],
    ['url: draft theme always set', sceneUrl('s.myshopify.com', 42, '/products/x', 'preview_theme_id=1&a=b') === 'https://s.myshopify.com/products/x?a=b&preview_theme_id=42'],
    ['url: stays on the store', new URL(sceneUrl('s.myshopify.com', 42, '/x')).host === 's.myshopify.com'],
    ['captions: at most two lines each', caps.every((c) => c.text.split('\n').length <= 2 && c.text.split('\n').every((l) => l.length <= 70))],
    ['captions: cover the narration exactly', Math.abs(caps.at(-1).to - 10) < 1e-9 && caps[0].from === 0],
    ['zoom: a narrow panel widens to the picture\'s shape, inside the image', (() => { const c = focusCrop([0.75, 0.1, 0.2, 0.3], 1864, 798); return c.w === 932 && c.h === 524 && c.x + c.w <= 1864 && c.y >= 0 && Math.abs(c.w / c.h - W / PIC) < 0.02; })()],
    ['zoom: never past 2x', focusCrop([0.4, 0.4, 0.05, 0.05], 1000, 500).w >= 500],
    ['storyboard: Prio and Sec columns by name; optional rows aren\'t scenes', (() => {
      const v2 = 'Voice: x\n\n| # | Prio | Kind | Where | Show | Say | Sec |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | P1 | slide | New | A | Hi. | |\n| 2 | p2 | chrome | Editor | open | Do it. | 9 |\n\n## Optional scenes\n\n| # | Prio | Sec | Shows |\n| --- | --- | --- | --- |\n| O1 | P3 | 10 | more |\n';
      const p = parseStoryboard(v2);
      const filled = withSeconds(v2, { 1: 4.4, 2: 12.6 });
      return p.scenes.length === 2 && p.scenes[1].prio === 'P2' && p.scenes[1].say === 'Do it.' && /\| 1 \| P1 \| slide \| New \| A \| Hi\. \| 4 \|/.test(filled) && /\| Do it\. \| 13 \|/.test(filled) && filled.includes('| O1 | P3 | 10 | more |');
    })()],
    ['storyboard: an unknown Prio refused', /isn't P1, P2 or P3/.test(bad(board.replace('| # | Kind |', '| # | Prio | Kind |').replace('| --- | --- |', '| --- | --- | --- |').replace('| 1 | slide', '| 1 | P9 | slide').replace('| 2 | storefront', '| 2 | P1 | storefront').replace('| 3 | chrome', '| 3 | P1 | chrome')))],
    ['captions: a price or a domain keeps all its text', (() => { const t = captionChunks('Orders over $49.99 ship free. See example.com now! Done.', 6).map((c) => c.text).join(' '); return t === 'Orders over $49.99 ship free. See example.com now! Done.'; })()],
    ['sync: the flash is found by its frame, and only a mostly magenta frame counts', (() => {
      const frame = (magenta) => { const b = Buffer.alloc(16 * 9 * 3, 30); for (let i = 0; i < magenta * 3; i += 3) { b[i] = 255; b[i + 1] = 0; b[i + 2] = 255; } return b; };
      return flashFrame(Buffer.concat([frame(0), frame(40), frame(144), frame(144)]), 144) === 2 / FPS && flashFrame(frame(40), 144) === null;
    })()],
    ['voice: "&" and "<" are escaped for SSML', ssmlText('Shipping & returns <50 dollars') === 'Shipping &amp; returns &lt;50 dollars'],
    ['where: no space before @mobile', storefrontWhere('products/x@mobile').path === '/products/x' && storefrontWhere('products/x@mobile').mobile],
    ['zoom: what\'s talked about stays above the captions', (() => { const f = [0.4, 0.3, 0.1, 0.4], c = focusCrop(f, 1920, 1080); return (f[1] + f[3]) * 1080 - c.y <= 0.8 * c.h + 2 && f[1] * 1080 >= c.y; })()],
    ['footage: every stretch fitted to the picture with square pixels', (() => { const g = footageGraph([{ from: 0, length: 2, beat: 0 }, { from: 3, length: 2, beat: 0, crop: { x: 0, y: 0, w: 904, h: 508 } }], [{ start: 0, length: 4.5 }], [4]); return (g.match(/setsar=1/g) || []).length === 2 && (g.match(/pad=1920:1080/g) || []).length === 2; })()],
    // The pixel-shape clash only shows on input with a set shape, so run it where ffmpeg is.
    ['footage: a zoomed and a plain stretch join in ffmpeg', !ffmpegBin() || (() => {
      const g = footageGraph([{ from: 0, length: 1, beat: 0 }, { from: 1.5, length: 1, beat: 0, crop: { x: 2, y: 216, w: 904, h: 508 } }, { from: 3, length: 1, beat: 1, crop: { x: 0, y: 0, w: 700, h: 394 } }], [{ start: 0, length: 2.2 }, { start: 2.2, length: 1.2 }], [2, 1]);
      try { ff(['-f', 'lavfi', '-i', 'testsrc=s=1406x790:d=5:r=25', '-filter_complex', `${g}[v]`, '-map', '[v]', '-f', 'null', '-']); return true; } catch { return false; }
    })()],
    ['stills: each beat cropped where focused, fitted, zoomed slowly, and joined', (() => {
      const g = stillsGraph([{ w: 1568, h: 881 }, { w: 1568, h: 881, crop: { x: 2, y: 100, w: 784, h: 440 } }], [{ start: 0, length: 2 }, { start: 2, length: 3 }]);
      return (g.match(/zoompan=/g) || []).length === 2 && /\[1:v\]crop=784:440:2:100,/.test(g) && /on\/50'/.test(g) && /on\/75'/.test(g) && /concat=n=2:v=1:a=0$/.test(g);
    })()],
    // Stills of another shape than the picture (an admin page, a crop) and odd sizes, as Claude in Chrome saves them.
    ['stills: two looped images of other sizes become one picture of the beats\' length in ffmpeg', !ffmpegBin() || (() => {
      const dir = join(DEPS, `selftest-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      try {
        const a = join(dir, 'a.png'), b = join(dir, 'b.png'), out = join(dir, 'v.mp4');
        ff(['-f', 'lavfi', '-i', 'testsrc=s=1567x881', '-frames:v', '1', a]);
        ff(['-f', 'lavfi', '-i', 'testsrc=s=1225x437', '-frames:v', '1', b]);
        const line = [{ start: 0, length: 1.2 }, { start: 1.2, length: 0.8 }];
        const g = stillsGraph([{ file: a, w: 1567, h: 881, crop: focusCrop([0.6, 0.1, 0.3, 0.3], 1567, 881) }, { file: b, w: 1225, h: 437 }], line);
        ff([...[a, b].flatMap((f, i) => ['-loop', '1', '-framerate', String(FPS), '-t', (line[i].length + 0.2).toFixed(2), '-i', f]), '-filter_complex', `${g},format=yuv420p[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', out]);
        const head = spawnSync(ffmpegBin(), ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr || '';
        return /1920x1080/.test(head) && Math.abs(seconds(out) - 2) < 0.15;
      } catch { return false; } finally { rmSync(dir, { recursive: true, force: true }); }
    })()],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  console.log(`${checks.length - failed.length}/${checks.length} video self-tests passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => fail(e.message));
