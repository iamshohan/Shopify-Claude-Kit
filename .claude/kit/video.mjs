#!/usr/bin/env node
// Walkthrough video for the client, from a task QA accepted: storefront scenes recorded on the draft theme in a hidden
// browser, theme-editor and admin scenes recorded from the dev's own Chrome (a screen recording while Claude in Chrome
// clicks), slides for the rest. Each scene is narrated (Microsoft neural voice) and captioned; one MP4 comes out.
// /shopify-video <KEY> runs it. The tools live once per machine in ~/.shopify-kit/video, outside every repo.
//   setup                                        install the recorder, ffmpeg and the voice (the dev runs it, once)
//   check                                        are they installed, and does the voice answer?
//   start <KEY> [--accepted "<dev's words>"]     can this task be filmed? creates storyboard.md. --accepted: Gate 2 was
//                                                held outside the kit, so the tracker never reached handoff
//   record <KEY> [--scene N]                     narration for every scene, then the storefront scenes and slides
//   overlay                                      prints the path of the cursor script for the Chrome tab
//   chrome-start <KEY> <N>                       find the tab on screen by its corner marks, start recording the screen
//   chrome-stop <KEY> <N> --keep <a-b,c-d>       stop, and keep the stretches between the scene's Date.now() marks
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
const KINDS = ['slide', 'storefront', 'chrome'];
const DEFAULT_VOICE = 'en-US-AvaNeural';
// 1920x1080 frame: the picture fits the top 900 px, captions get the band below.
const W = 1920, PIC = 900, H = 1080, BG = '0x1f2124';
const LEAD = 0.3, TAIL = 0.5; // seconds of picture before the voice starts and after it ends (the mp3s add ~0.3 s each)
const RATE = '-10%'; // the voice's default runs near 200 words a minute; walkthroughs read better nearer 170
const FPS = 25; // both recorders capture at 25: another output rate repeats frames and motion judders
const DESKTOP = { width: 1440, height: 675 }; // 16:7.5, the picture area's shape
const MOBILE = { width: 390, height: 844 };

// ── Storyboard ──

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** The storyboard's header lines and scene rows. Throws on a row the recorder couldn't follow. */
export function parseStoryboard(text) {
  const header = (name) => (text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi'))?.[1] || '').trim();
  const scenes = text.split(/\r?\n/).filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => {
    const [n, kind, where, show, say] = cells(l);
    return { n: Number(n), kind: kind.toLowerCase(), where, show: show || '', say: say || '' };
  });
  const problems = [];
  if (!scenes.length) problems.push('no scenes: add rows to the table');
  scenes.forEach((s, i) => {
    if (!KINDS.includes(s.kind)) problems.push(`scene ${s.n}: Kind "${s.kind}" isn't one of ${KINDS.join(', ')}`);
    if (!s.say) problems.push(`scene ${s.n}: Say is empty`);
    if (i && s.n <= scenes[i - 1].n) problems.push(`scene ${s.n}: numbers must go up`);
    if (s.kind === 'storefront') { try { parseShow(s.show); storefrontWhere(s.where); } catch (e) { problems.push(`scene ${s.n}: ${e.message}`); } }
  });
  if (problems.length) throw new Error(problems.join('\n'));
  return { voice: header('Voice') || DEFAULT_VOICE, query: header('Query'), scenes };
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
  // The overlay puts the marks 28 px in from the corners, past Claude in Chrome's tinted edge, so the box is clean.
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

/** Narration for every scene, four at a time: { [scene number]: { file, seconds } }. */
async function narrateAll(dir, voice, scenes) {
  const out = {};
  const queue = [...scenes];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) { const s = queue.shift(); out[s.n] = await narration(dir, voice, s.say); }
  }));
  return out;
}

/** The screen recording's start in wall-clock ms: when its first progress line was seen, minus the time it reports. */
export function captureStart(log, seenAt) {
  const m = log.match(/time=(\d+):(\d+):([\d.]+)/);
  return m ? seenAt - Math.round((m[1] * 3600 + m[2] * 60 + Number(m[3])) * 1000) : seenAt;
}

/** "--keep 1000-5000,9000-12000" (the scene's Date.now() marks) → stretches in ms. */
export function parseKeep(text) {
  const parts = String(text || '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => p.split('-').map(Number));
  if (!parts.length || parts.some(([a, b]) => !(a > 0 && b > a))) throw new Error('--keep takes start-end pairs of the Date.now() marks, e.g. --keep 1700000000000-1700000009000');
  if (parts.some(([a], i) => i && a < parts[i - 1][1])) throw new Error('--keep stretches must be in order and not overlap');
  return parts;
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
    body{margin:0;width:${W}px;height:${PIC}px;display:flex;flex-direction:column;justify-content:center;padding:0 160px;box-sizing:border-box;
      font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;background:#f6f6f7;color:#1f2124}
    h1{font-size:72px;font-weight:650;margin:0 0 48px;letter-spacing:-.5px}
    ul{margin:0;padding:0;list-style:none}
    li{font-size:40px;line-height:1.35;margin:0 0 22px;padding-left:44px;position:relative}
    li:before{content:'';position:absolute;left:0;top:.5em;width:16px;height:16px;border-radius:50%;background:#2c6ecb}
  </style></head><body><h1>${escapeHtml(scene.where)}</h1><ul>${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul></body></html>`;
}

async function recordStorefront(browser, t, scene, board, voiceSeconds) {
  const { path, mobile } = storefrontWhere(scene.where);
  const url = sceneUrl(t.cfg.store, t.st.draft.themeId, path, board.query);
  const vp = mobile ? MOBILE : DESKTOP;
  const tmp = join(t.scenes, `tmp-${nn(scene.n)}`);
  rmSync(tmp, { recursive: true, force: true });
  const ctx = await browser.newContext({
    viewport: vp, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
    recordVideo: { dir: tmp, size: mobile ? { width: vp.width * 2, height: vp.height * 2 } : vp },
  });
  await ctx.addInitScript({ path: OVERLAY });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (/\/password/.test(page.url())) throw new Error('the storefront is password-protected: make this a chrome scene (the dev\'s Chrome is logged in), or ask the dev to lift the password while recording');
    const theme = await page.evaluate(() => window.Shopify?.theme && { id: window.Shopify.theme.id, role: window.Shopify.theme.role });
    if (!theme || String(theme.id) !== String(t.st.draft.themeId) || theme.role === 'main') throw new Error(`the page rendered ${theme ? `theme ${theme.id} (${theme.role})` : 'no Shopify theme'}, not the draft ${t.st.draft.themeId}`);
    await page.waitForFunction(() => window.__kc, null, { timeout: 5000 }).catch(() => { throw new Error('the cursor overlay didn\'t load on this page'); });
    const ops = parseShow(scene.show);
    for (const o of ops.filter((x) => x.op === 'hide')) await page.addStyleTag({ content: `${o.arg}{display:none!important}` });
    await page.evaluate(() => window.__kc.marks(false));
    await page.waitForTimeout(1200);
    const tStart = Date.now();
    const target = async (sel) => {
      const el = page.locator(sel).first();
      if (!(await el.count())) throw new Error(`no element matches "${sel}"`);
      await el.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      await page.waitForTimeout(900);
      const b = await el.boundingBox();
      if (!b) throw new Error(`"${sel}" isn't visible`);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    for (const { op, arg } of ops) {
      if (op === 'hide') continue;
      await page.evaluate(() => window.__kc.highlight(null));
      if (op === 'wait') { await page.waitForTimeout(arg * 1000); continue; }
      const at = await target(arg);
      if (op === 'scroll') { await page.waitForTimeout(600); continue; }
      if (op === 'highlight') { await page.evaluate((s) => window.__kc.highlight(s), arg); await page.waitForTimeout(1400); continue; }
      await page.evaluate(([x, y]) => window.__kc.move(x, y), [at.x, at.y]);
      if (op === 'hover') { await page.mouse.move(at.x, at.y); await page.waitForTimeout(1200); continue; }
      await page.evaluate(() => window.__kc.ripple());
      if (mobile) await page.touchscreen.tap(at.x, at.y); else await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(1500);
    }
    const hold = tStart + (LEAD + voiceSeconds + TAIL) * 1000 - Date.now();
    if (hold > 0) await page.waitForTimeout(hold);
    const tEnd = Date.now();
    // Closing straight after the last frame cut it short in tests.
    await page.waitForTimeout(400);
    await ctx.close();
    const raw = await page.video().path();
    const length = seconds(raw);
    // The recording starts a little after the page opened; its length says how much.
    const late = (Date.now() - t0) / 1000 - length;
    const file = join(t.scenes, `${nn(scene.n)}.webm`);
    renameSync(raw, file);
    return { kind: 'storefront', file, parts: [{ from: Math.max(0, (tStart - t0) / 1000 - late), length: (tEnd - tStart) / 1000 }] };
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
      try { const { chromium } = await dep('playwright-core'); const b = await chromium.launch({ channel: 'chrome', headless: true }); await b.close(); out.chrome = true; } catch (e) { out.chrome = false; out.chromeProblem = e.message.split('\n')[0]; }
    }
    out.ready = Boolean(out.recorder && out.ffmpeg && out.voiceAnswers && out.chrome);
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

  if (cmd === 'record') {
    const only = args.flags.scene ? [sceneOf(args.flags.scene)] : board.scenes;
    const out = [];
    const voices = Object.fromEntries(Object.entries(await narrateAll(t.voice, board.voice, only)).map(([n, v]) => [n, v.seconds]));
    const visual = only.filter((s) => s.kind !== 'chrome');
    let browser;
    if (visual.length) { const { chromium } = await dep('playwright-core'); browser = await chromium.launch({ channel: 'chrome', headless: true }); }
    try {
      for (const s of only) {
        const row = { scene: s.n, kind: s.kind, voice: Number(voices[s.n].toFixed(1)) };
        if (s.kind === 'chrome') { row.status = saved(s.n) ? 'recorded earlier' : `record it in Chrome: chrome-start ${key} ${s.n}`; out.push(row); continue; }
        try {
          if (s.kind === 'slide') {
            const page = await browser.newPage({ viewport: { width: W, height: PIC } });
            await page.setContent(slideHtml(s));
            const file = join(t.scenes, `${nn(s.n)}.png`);
            await page.screenshot({ path: file });
            await page.close();
            save(s.n, { kind: 'slide', file });
          } else save(s.n, await recordStorefront(browser, t, s, board, voices[s.n]));
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
    const voice = await narration(t.voice, board.voice, s.say);
    const grab = spawnSync(ffmpegBin(), ['-hide_banner', '-f', 'gdigrab', '-draw_mouse', '0', '-i', 'desktop', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 256 * 1024 * 1024 });
    // "Capturing whole desktop as 3840x1373x32 at (-1920,-293)": the grab's size, and where its corner is on screen.
    const desk = String(grab.stderr).match(/desktop as (\d+)x(\d+)\S* at \((-?\d+),(-?\d+)\)/);
    if (grab.status !== 0 || !desk) fail('Couldn\'t grab the screen.');
    const area = findMarks(grab.stdout, Number(desk[1]), Number(desk[2]));
    if (area.problem) fail(`Can't find the Chrome tab: ${area.problem}`);
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
    return print({ recording: true, scene: s.n, voice: Number(voice.seconds.toFixed(1)), minimumSceneSeconds: Number((LEAD + voice.seconds + TAIL).toFixed(1)) });
  }

  if (cmd === 'chrome-stop') {
    const s = sceneOf(rawScene);
    const capPath = join(t.scenes, `${nn(s.n)}.capture.json`);
    if (!existsSync(capPath)) fail(`No recording running for scene ${s.n}: chrome-start ${key} ${s.n}`);
    const cap = JSON.parse(readFileSync(capPath, 'utf8'));
    try { process.kill(cap.pid); } catch { /* it ended at its cap */ }
    await new Promise((r) => setTimeout(r, 800));
    rmSync(capPath);
    let keep;
    try { keep = parseKeep(args.flags.keep); } catch (e) { fail(e.message); }
    const length = seconds(cap.file);
    // The first 0.2 s of each stretch can still hold the corner marks being switched off.
    const parts = keep.map(([a, b]) => ({ from: (a - cap.startedAt) / 1000 + 0.2, length: (b - a) / 1000 - 0.2 }));
    const bad = parts.find((p) => p.from < 0 || p.from + p.length > length + 0.3);
    if (bad) fail(`A stretch (${bad.from.toFixed(1)} s in, ${bad.length.toFixed(1)} s long) doesn't fit the ${length.toFixed(1)} s recording. Record the scene again.`);
    save(s.n, { kind: 'chrome', file: cap.file, parts, area: cap.area });
    return print({ scene: s.n, kept: `${parts.reduce((a, p) => a + p.length, 0).toFixed(1)} s of ${length.toFixed(1)} s` });
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
      const footage = stretches.reduce((a, p) => a + p.length, 0);
      const total = Math.max(footage, LEAD + voice.seconds + TAIL);
      // A part is re-encoded only when what goes into it changed, so fixing one scene doesn't redo the rest.
      const out = join(t.build, `${nn(s.n)}-${hash(JSON.stringify({ shot: { ...shot, at: null }, voice: voice.file, say: s.say, v: 2 }))}.mp4`);
      if (!existsSync(out)) {
        for (const f of readdirSync(t.build)) if (f.startsWith(`${nn(s.n)}-`) && f.endsWith('.mp4')) rmSync(join(t.build, f));
        const caps = captionChunks(s.say, voice.seconds).map((c, i) => {
          writeFileSync(join(t.build, `${nn(s.n)}-${i}.txt`), c.text);
          return `drawtext=textfile='${nn(s.n)}-${i}.txt':expansion=none:${font}:fontsize=40:fontcolor=white:line_spacing=12:x=(w-text_w)/2:y=${PIC}+(${H - PIC}-text_h)/2:enable='between(t,${(LEAD + c.from).toFixed(2)},${(LEAD + c.to).toFixed(2)})'`;
        });
        const look = `scale=${W}:${PIC}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(${PIC}-ih)/2:color=${BG},${caps.join(',')},fps=${FPS},format=yuv420p[v]`;
        const video = shot.kind === 'slide'
          ? `[0:v]${look}`
          : `${stretches.map((p, i) => `[0:v]trim=start=${p.from.toFixed(3)}:end=${(p.from + p.length).toFixed(3)},setpts=PTS-STARTPTS[c${i}]`).join(';')};`
            + `${stretches.map((_, i) => `[c${i}]`).join('')}concat=n=${stretches.length}:v=1:a=0,tpad=stop_mode=clone:stop_duration=${(total - footage + 0.2).toFixed(2)},${look}`;
        // The voice files come out near -21 LUFS; +5 dB puts the video near -16, where web video sits.
        ff([...(shot.kind === 'slide' ? ['-loop', '1', '-t', total.toFixed(2)] : []), '-i', shot.file, '-i', voice.file, '-filter_complex',
          `${video};[1:a]volume=5dB,adelay=${LEAD * 1000}|${LEAD * 1000},apad[a]`,
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
    ['marks: a covered corner is refused', /only some/.test(covered.problem || '')],
    ['marks: none on screen', /no corner marks/.test(scr([]).problem || '')],
  ];
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  console.log(`${checks.length - failed.length}/${checks.length} video self-tests passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => fail(e.message));
