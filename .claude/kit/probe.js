/**
 * QA probe library — measures what RENDERS, not what the CSS claims.
 * Margins collapse, gaps override, ancestors clip, media queries miss.
 * getBoundingClientRect is the source of truth; getComputedStyle is a hint.
 *
 *   __qa.env()                  viewport/url/zoom/Shopify.theme — proves the state you think you're in
 *   __qa.live('TOKEN')          is the change actually in this page at all
 *   __qa.see('.cta')            visible, or hidden/clipped/covered — and by what
 *   __qa.text('.cta')           textContent (the copy), innerText (as rendered) and text-transform
 *   __qa.css('.cta', ['color','font-size'])      normalised computed values
 *   __qa.why('.cta','height')   which rule won; whether yours is declared at all
 *   __qa.gap('.a','.b')         rendered distance between two elements
 *   __qa.pad('.card','.title')  rendered padding, all four sides
 *   __qa.gutter('.hero')        rendered distance to each viewport edge
 *   __qa.overflow()             what sticks out horizontally
 *   __qa.shift()                content that jumped during load (CLS + culprits)
 *   await __qa.motion('.slider', 600)     did it actually move
 *   __qa.snap() -> act -> __qa.diff()     what an interaction really changed
 *   __qa.errors()               console errors + failed requests since injection
 *   __qa.report()               the ledger — every call, its value, its caveats
 *   __qa.reset()                clear the ledger between criteria
 *
 * Lives on window — RE-INJECT after every navigation or reload.
 * errors() only sees what happened after injection; inject, then reload, then read.
 * Playwright: page.addScriptTag({ path: '<this file>' }) — costs zero context.
 *
 * A probe that knows its own answer is shaky says so. A non-empty `caveats`
 * blocks a PASS exactly the way an empty `How` column does — the alternative
 * is a clean-looking number the model treats as authoritative.
 *
 * After editing: `node .claude/kit/kit.mjs build-probe` regenerates probe.init.js and probe.inject.js.
 */
(() => {

  // ── Helpers ──

  const V = '1.0';
  const px = (n) => Math.round(n * 10) / 10;
  const one = (s) => document.querySelector(s);
  const all = (s) => Array.from(document.querySelectorAll(s));

  const tag = (el) => !el ? null : el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : '');

  // The node's key in snap()/diff(): tag chain up to 6 levels, with a sibling index where tags repeat.
  const path = (el) => {
    const p = [];
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d++ < 6) {
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      p.unshift(tag(n) + (sibs.length > 1 ? ':' + sibs.indexOf(n) : ''));
      n = n.parentElement;
    }
    return p.join('>');
  };

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height),
             top: px(r.top), right: px(r.right), bottom: px(r.bottom), left: px(r.left) };
  };

  // Alpha below 1 stays as a fourth byte (rgba(0,0,0,0.5) → #00000080): dropping it let a 50% overlay
  // pass as opaque black. Opaque colours keep the plain #rrggbb that QA criteria are written in.
  const hex = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(c || '');
    if (!m) return c;
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (alpha === 0) return 'transparent';
    const bytes = [m[1], m[2], m[3]];
    if (alpha < 1) bytes.push(Math.round(alpha * 255));
    return '#' + bytes.map((v) => (+v).toString(16).padStart(2, '0')).join('');
  };

  const norm = (prop, v) => {
    v = String(v);
    if (prop.includes('color')) return hex(v);
    if (prop === 'font-family') return v.replace(/["']/g, '').split(',')[0].trim().toLowerCase();
    if (/^-?[\d.]+px$/.test(v)) return px(parseFloat(v)) + 'px';
    return v;
  };

  const miss = (sel) => ({ sel, verdict: 'ABSENT', detail: 'no element matches this selector', caveats: [] });

  // ── Page state: env, live ──

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Which theme rendered the page: the URL can't say, the preview cookie survives redirects.
  // role 'main' is the live theme; a draft is 'unpublished'.
  const theme = () => {
    const t = window.Shopify && window.Shopify.theme;
    return t ? { id: t.id, name: t.name, role: t.role } : null;
  };

  // innerWidth includes the scrollbar, clientWidth does not. Media queries use
  // clientWidth, so a ~15px gap here explains "the breakpoint didn't fire".
  const env = () => ({
    url: location.href,
    theme: theme(),
    innerWidth: innerWidth, clientWidth: document.documentElement.clientWidth,
    innerHeight: innerHeight, dpr: devicePixelRatio,
    // visualViewport.scale is real pinch-zoom. outerWidth/innerWidth is NOT —
    // under viewport emulation it compares the real window to the emulated one.
    zoom: visualViewport ? px(visualViewport.scale) : null,
    scrollY: Math.round(scrollY), readyState: document.readyState,
    reducedMotion: reduced(),
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    bodyClass: (document.body.className || '').slice(0, 200),
    caveats: [
      document.readyState !== 'complete' ? 'page still loading — geometry will move' : null,
      !theme() ? 'no Shopify.theme — not loaded yet, or not a Shopify storefront page' : null,
      reduced() ? 'prefers-reduced-motion is ACTIVE — animation checks may correctly read as static' : null,
    ].filter(Boolean),
  });

  // Is the code under test even in this page? Everything downstream is fiction
  // if this says NOT FOUND.
  const live = (token) => {
    const inDOM = document.documentElement.outerHTML.includes(token);
    let inCSS = false, unreadable = 0;
    for (const ss of document.styleSheets) {
      try {
        if ([...ss.cssRules].some((r) => r.cssText.includes(token))) { inCSS = true; break; }
      } catch { unreadable++; }
    }
    const inJS = [...document.scripts].some(
      (s) => (s.src || '').includes(token) || (s.textContent || '').includes(token));
    return { token, inDOM, inCSS, inJS, crossOriginSheets: unreadable,
             verdict: (inDOM || inCSS || inJS) ? 'LIVE'
               : 'NOT FOUND — the change may not be in this page; resolve before QAing anything' };
  };

  // ── Visibility and styles: see, css, why ──

  // Present is not the same as visible.
  const see = (sel, max = 5) => {
    const els = all(sel);
    if (!els.length) return miss(sel);
    return { sel, found: els.length,
             caveats: els.length > max
               ? ['checked ' + max + ' of ' + els.length + ' matches — the rest are UNTESTED'] : [],
             instances: els.slice(0, max).map((el, i) => {
      const r = box(el), cs = getComputedStyle(el), why = [];
      if (!r.w || !r.h) why.push('zero-size ' + r.w + 'x' + r.h);
      if (cs.display === 'none') why.push('display:none');
      if (cs.visibility === 'hidden') why.push('visibility:hidden');
      if (parseFloat(cs.opacity) === 0) why.push('opacity:0');
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (!/hidden|clip|scroll/.test(pcs.overflow + pcs.overflowX + pcs.overflowY)) continue;
        const pr = p.getBoundingClientRect();
        if (r.right <= pr.left + 1 || r.left >= pr.right - 1 || r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1)
          why.push('clipped by ' + tag(p) + ' (overflow:' + pcs.overflow + ')');
      }
      // Only meaningful once the element is otherwise renderable — the centre of
      // a zero-size or already-clipped element lands on whatever else is painted
      // there, which reads as a bogus "covered by".
      let covered = null;
      if (!why.length) {
        const cx = r.left + r.w / 2, cy = r.top + r.h / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
          why.push('centre outside viewport (scroll to it first)');
        } else {
          const hit = document.elementFromPoint(cx, cy);
          if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
            covered = tag(hit);
            why.push('covered by ' + covered);
          }
        }
      }
      return { i, el: tag(el), box: r, covered, verdict: why.length ? 'HIDDEN' : 'VISIBLE', why };
    }) };
  };

  // Copy is compared with textContent: innerText applies text-transform, so a CSS-uppercased
  // "Add to cart" reads as "ADD TO CART" and fails a criterion that quotes the ticket.
  const text = (sel, max = 3) => {
    const els = all(sel);
    if (!els.length) return miss(sel);
    const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const instances = els.slice(0, max).map((el, i) => ({
      i, el: tag(el), textContent: clip(el.textContent), innerText: clip(el.innerText),
      textTransform: getComputedStyle(el).textTransform,
    }));
    // Not a caveat: the copy check itself is sound, as long as it reads textContent.
    const transformed = instances.some((x) => x.textTransform !== 'none' && x.textContent !== x.innerText);
    return { sel, found: els.length, instances,
             note: transformed ? 'innerText is text-transformed — compare copy with textContent' : null,
             caveats: els.length > max ? ['checked ' + max + ' of ' + els.length + ' matches — the rest are UNTESTED'] : [] };
  };

  const css = (sel, props, max = 3) => {
    const els = all(sel);
    if (!els.length) return miss(sel);
    return { sel, found: els.length,
             caveats: els.length > max
               ? ['checked ' + max + ' of ' + els.length + ' matches — the rest are UNTESTED'] : [],
             instances: els.slice(0, max).map((el, i) => {
      const cs = getComputedStyle(el), out = { i, el: tag(el) };
      for (const p of [].concat(props)) out[p] = norm(p, cs.getPropertyValue(p));
      return out;
    }) };
  };

  // Distinguishes "my rule never reached the page" from "my rule lost".
  const why = (sel, prop) => {
    const el = one(sel);
    if (!el) return miss(sel);
    const hits = [], unreadable = [];
    const walk = (rules, media) => {
      for (const r of rules) {
        if (r.media) { walk(r.cssRules || [], r.conditionText || r.media.mediaText); continue; }
        if (r.cssRules && !r.selectorText) { walk(r.cssRules, media); continue; }
        if (!r.selectorText || !r.style || !r.style.getPropertyValue(prop)) continue;
        let m = false;
        try { m = el.matches(r.selectorText); } catch { continue; }
        if (!m) continue;
        hits.push({ selector: r.selectorText, value: r.style.getPropertyValue(prop),
                    important: r.style.getPropertyPriority(prop) === 'important',
                    media: media || null, mediaActive: media ? matchMedia(media).matches : true });
      }
    };
    for (const ss of document.styleSheets) {
      try { walk(ss.cssRules, null); }
      catch { unreadable.push(ss.href ? ss.href.split('/').pop() : 'inline'); }
    }
    const inline = el.style.getPropertyValue(prop);
    return { sel, prop, used: norm(prop, getComputedStyle(el).getPropertyValue(prop)),
             inline: inline || null, declaredBy: hits, crossOriginSheets: unreadable,
             caveats: [
               unreadable.length
                 ? unreadable.length + ' stylesheet(s) unreadable (cross-origin) — declaredBy may be INCOMPLETE, so "NOT DECLARED" is not conclusive'
                 : null,
               hits.some((h) => !h.mediaActive)
                 ? 'some matching rules sit in media queries that are INACTIVE at this viewport — that is usually correct, not a bug'
                 : null,
             ].filter(Boolean),
             verdict: (hits.length || inline) ? 'DECLARED'
               : 'NOT DECLARED ANYWHERE — the rule never reached this page' };
  };

  // ── Geometry: gap, pad, gutter, overflow ──

  const gap = (selA, selB) => {
    const a = one(selA), b = one(selB);
    if (!a) return miss(selA);
    if (!b) return miss(selB);
    const ra = box(a), rb = box(b);
    return { a: selA, b: selB, boxA: ra, boxB: rb,
             vertical: px(rb.top - ra.bottom), horizontal: px(rb.left - ra.right),
             overlaps: !(rb.left >= ra.right || rb.right <= ra.left || rb.top >= ra.bottom || rb.bottom <= ra.top),
             widthDelta: px(rb.w - ra.w) };
  };

  const pad = (selContainer, selChild) => {
    const c = one(selContainer), k = one(selChild);
    if (!c) return miss(selContainer);
    if (!k) return miss(selChild);
    const rc = box(c), rk = box(k);
    return { container: selContainer, child: selChild,
             top: px(rk.top - rc.top), right: px(rc.right - rk.right),
             bottom: px(rc.bottom - rk.bottom), left: px(rk.left - rc.left) };
  };

  // A boxed parent can be narrower than the viewport, so "padding:16px" still
  // renders as a 50px gap. Measure against the viewport, not the parent.
  const gutter = (sel) => {
    const el = one(sel);
    if (!el) return miss(sel);
    const r = box(el), vw = document.documentElement.clientWidth, vh = innerHeight;
    return { sel, box: r, viewport: { w: vw, h: vh },
             left: px(r.left), right: px(vw - r.right), top: px(r.top), bottom: px(vh - r.bottom) };
  };

  // scrollWidth is the verdict; offenders are leads — a child of a scroll
  // container legitimately exceeds the viewport.
  const overflow = () => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    for (const el of all('body *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const over = Math.max(r.right - vw, -r.left, 0);
      if (over > 1) out.push({ el: tag(el), left: px(r.left), right: px(r.right), over: px(over) });
    }
    return { viewport: vw, scrollWidth: document.documentElement.scrollWidth,
             horizontalScroll: document.documentElement.scrollWidth > vw + 1,
             caveats: out.length
               ? ['offenders are LEADS, not verdicts — a child of a legitimate scroll container exceeds the viewport by design. horizontalScroll is the actual verdict.']
               : [],
             offenders: out.sort((a, b) => b.over - a.over).slice(0, 10) };
  };

  // ── Motion ──

  // NEVER read getComputedStyle(transform) to check animation — mid-transition
  // it returns the start value, so a working slider reads as static.
  const motion = (sel, ms = 600) => {
    const el = one(sel);
    if (!el) return Promise.resolve(miss(sel));
    const sample = () => {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return { t: Math.round(performance.now()), x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height),
               transform: cs.transform, opacity: cs.opacity,
               scrollLeft: px(el.scrollLeft), scrollTop: px(el.scrollTop) };
    };
    return new Promise((res) => {
      const frames = [sample()], t0 = performance.now();
      const tick = () => {
        frames.push(sample());
        if (performance.now() - t0 < ms) return requestAnimationFrame(tick);
        const keys = ['x', 'y', 'w', 'h', 'transform', 'opacity', 'scrollLeft', 'scrollTop'];
        const changed = keys.filter((k) => new Set(frames.map((f) => String(f[k]))).size > 1);
        const step = Math.max(1, Math.floor(frames.length / 4));
        const elapsed = performance.now() - t0;
        const fps = Math.round((frames.length / elapsed) * 1000);
        const rm = reduced();
        res({ sel, ms, samples: frames.length, fps, reducedMotion: rm, changed,
              verdict: changed.length ? 'MOVED' : 'STATIC — nothing changed over ' + ms + 'ms',
              caveats: [
                // Without this, correctly-honoured reduce-motion reads as a defect
                // and the agent files a FAIL against working code.
                rm && !changed.length
                  ? 'prefers-reduced-motion is ACTIVE — STATIC may be correct behaviour here, NOT a defect. Verify with the preference off before failing this.'
                  : null,
                changed.length && fps < 30
                  ? 'sampled at ~' + fps + 'fps — motion is present but may be stuttering, or the tab was backgrounded'
                  : null,
                frames.length < 5 ? 'only ' + frames.length + ' samples — too few to judge' : null,
              ].filter(Boolean),
              trace: frames.filter((_, i) => i % step === 0 || i === frames.length - 1) });
      };
      requestAnimationFrame(tick);
    });
  };

  // ── Interaction diff: snap, diff ──
  // snap() keeps one snapshot; diff() compares the page against it after an action.

  let saved = null;

  const capture = (sel) => {
    const root = one(sel);
    if (!root) return null;
    const map = {};
    for (const el of [root, ...root.querySelectorAll('*')].slice(0, 4000)) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      map[path(el)] = [px(r.x), px(r.y), px(r.width), px(r.height), cs.display, cs.visibility, cs.opacity,
                       (el.textContent || '').trim().slice(0, 40)];
    }
    return map;
  };

  const snap = (sel = 'body') => {
    const map = capture(sel);
    if (!map) return miss(sel);
    saved = { sel, map };
    return { sel, nodes: Object.keys(map).length, verdict: 'SNAPPED' };
  };

  const diff = (max = 25) => {
    if (!saved) return { verdict: 'NO SNAPSHOT — call __qa.snap() before the action' };
    const after = capture(saved.sel), before = saved.map;
    const F = ['x', 'y', 'w', 'h', 'display', 'visibility', 'opacity', 'text'];
    const added = [], removed = [], changed = [];
    for (const k of Object.keys(after)) if (!(k in before)) added.push(k);
    for (const k of Object.keys(before)) {
      if (!(k in after)) { removed.push(k); continue; }
      const d = {};
      before[k].forEach((v, i) => { if (String(v) !== String(after[k][i])) d[F[i]] = [v, after[k][i]]; });
      if (Object.keys(d).length) changed.push(Object.assign({ el: k }, d));
    }
    const capped = Object.keys(after).length >= 4000;
    return { scope: saved.sel,
             verdict: (added.length + removed.length + changed.length) ? 'CHANGED' : 'NOTHING CHANGED',
             caveats: [
               capped ? 'hit the 4000-node capture cap — changes outside the first 4000 nodes are UNTESTED. Scope snap() to a container.' : null,
               (added.length + removed.length + changed.length) > max
                 ? 'more changes than the ' + max + ' shown — list is truncated' : null,
             ].filter(Boolean),
             counts: { added: added.length, removed: removed.length, changed: changed.length },
             added: added.slice(0, max), removed: removed.slice(0, max), changed: changed.slice(0, max) };
  };

  // ── Layout shift ──

  // Every other probe measures a point in time. This one catches content that
  // was correct WHEN MEASURED but jumped during load — a late banner, a font
  // swap, an unsized lazy image. `buffered: true` replays shifts that happened
  // before injection, so it still works when injected into an already-loaded
  // page. The buffer hangs off window so re-injecting does not double-count.
  let shiftSupported = true;
  if (!window.__qaShifts) {
    window.__qaShifts = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput) continue;   // user-initiated movement is not a defect
          window.__qaShifts.push({
            value: Math.round(e.value * 1e4) / 1e4,
            at: Math.round(e.startTime),
            sources: Array.from(e.sources || []).slice(0, 3).map((s) => ({
              el: s.node && s.node.nodeType === 1 ? tag(s.node) : String(s.node || 'unknown'),
              movedY: s.previousRect && s.currentRect ? px(s.currentRect.y - s.previousRect.y) : null,
              movedX: s.previousRect && s.currentRect ? px(s.currentRect.x - s.previousRect.x) : null,
              grewH: s.previousRect && s.currentRect ? px(s.currentRect.height - s.previousRect.height) : null,
            })),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch { shiftSupported = false; }
  }

  const shift = () => {
    if (!shiftSupported)
      return { verdict: 'UNSUPPORTED — layout-shift is Chromium-only',
               caveats: ['no layout-shift observer in this browser; load-time jank is UNTESTED'] };
    const all = window.__qaShifts;
    const total = Math.round(all.reduce((a, s) => a + s.value, 0) * 1e4) / 1e4;
    return {
      cls: total, count: all.length,
      verdict: !all.length ? 'NO SHIFT RECORDED'
        : total < 0.1 ? 'MINOR SHIFT (cls ' + total + ')'
        : 'LAYOUT SHIFTED (cls ' + total + ')',
      worst: [...all].sort((a, b) => b.value - a.value).slice(0, 5),
      caveats: [
        !all.length
          ? 'nothing recorded — if the probe was injected after load, reload with it in place before trusting this'
          : null,
        document.readyState !== 'complete' ? 'page still loading — more shifts may follow' : null,
      ].filter(Boolean),
    };
  };

  // ── Errors ──
  // Listeners start at injection; nothing earlier is captured.

  const log = { errors: [], rejections: [], consoleErrors: [] };
  addEventListener('error', (e) => log.errors.push({
    msg: String(e.message || (e.error && e.error.message) || e.type),
    src: e.filename || (e.target && (e.target.src || e.target.href)) || null,
    line: e.lineno || null,
  }), true);
  addEventListener('unhandledrejection', (e) => log.rejections.push(String(e.reason)));
  const _ce = console.error.bind(console);
  console.error = (...a) => { log.consoleErrors.push(a.map(String).join(' ').slice(0, 300)); _ce(...a); };

  // responseStatus is 0 for cross-origin requests without CORS and missing in some browsers,
  // so an empty failedRequests is not proof that nothing failed.
  const errors = () => Object.assign({
    since: 'probe injection — anything before it is not captured',
  }, log, {
    failedRequests: performance.getEntriesByType('resource')
      .filter((r) => r.responseStatus >= 400)
      .map((r) => ({ url: r.name, status: r.responseStatus })).slice(0, 20),
  });

  // ── The ledger ──

  // Every probe call records itself. The report's `How` column is then emitted
  // from what actually ran, instead of being a cell the model is trusted to
  // fill in honestly — the difference between a rule and a mechanism.
  const ledger = [];

  const fmtArg = (a) =>
    typeof a === 'string' ? "'" + a + "'" : (a && typeof a === 'object') ? JSON.stringify(a) : String(a);

  // The value has to be citable on its own — a truncated JSON blob is not a
  // measurement anyone can check. Shapes are tested most specific first: several
  // results share keys (`verdict`, `viewport`), so the order of these checks matters.
  const digest = (r) => {
    if (!r || typeof r !== 'object') return String(r);
    if ('cls' in r) return `${r.verdict} shifts=${r.count}`;
    if ('counts' in r)
      return `${r.verdict} added=${r.counts.added} removed=${r.counts.removed} changed=${r.counts.changed}`;
    if (r.verdict) return String(r.verdict).slice(0, 90);
    if (r.instances) {
      const v = r.instances.map((i) => i.verdict).filter(Boolean);
      if (v.length) return v.join(' | ').slice(0, 90);
      const { i, el, ...props } = r.instances[0];             // css(): the props are the value
      return Object.entries(props).map(([k, x]) => k + '=' + x).join(' ').slice(0, 120);
    }
    if ('horizontalScroll' in r)
      return `horizontalScroll=${r.horizontalScroll} scrollWidth=${r.scrollWidth} viewport=${r.viewport}`;
    if ('vertical' in r) return `vertical=${r.vertical}px horizontal=${r.horizontal}px overlaps=${r.overlaps}`;
    if ('container' in r) return `top=${r.top} right=${r.right} bottom=${r.bottom} left=${r.left}`;
    if ('viewport' in r) return `gutters l=${r.left} r=${r.right} t=${r.top} b=${r.bottom}`;
    if ('innerWidth' in r)
      return `${r.clientWidth}x${r.innerHeight} rm=${r.reducedMotion} theme=${r.theme ? r.theme.id + '/' + r.theme.role : 'none'} ${r.url}`;
    const { caveats, ...rest } = r;
    return JSON.stringify(rest).slice(0, 120);
  };

  const push = (call, r) => {
    ledger.push({ n: ledger.length + 1, call, value: digest(r),
                  caveats: (r && r.caveats) || [],
                  at: new Date().toISOString().slice(11, 19) });
    return r;
  };

  const record = (name, fn) => (...args) => {
    const call = '__qa.' + name + '(' + args.map(fmtArg).join(', ') + ')';
    const out = fn(...args);
    return (out && typeof out.then === 'function') ? out.then((r) => push(call, r)) : push(call, out);
  };

  const report = () => ({
    calls: ledger.length,
    rows: ledger,
    // A caveat means the probe does not trust its own answer. Treat these the
    // way an empty How column is treated: they block a PASS.
    unresolved: ledger.filter((e) => e.caveats.length).map((e) => ({ call: e.call, caveats: e.caveats })),
    note: 'Cite `call` verbatim in the How column. A criterion with no row here cannot be PASS; a row with caveats cannot be PASS until they are resolved.',
  });

  const reset = () => { ledger.length = 0; return { verdict: 'LEDGER CLEARED' }; };

  // ── window.__qa ──
  // Every probe goes through record(), so the ledger sees it; report, reset, tag and box are not recorded.

  const api = { env, live, see, text, css, why, gap, pad, gutter, overflow, shift, motion, snap, diff, errors };
  const wrapped = {};
  for (const k of Object.keys(api)) wrapped[k] = record(k, api[k]);

  window.__qa = Object.assign({ V }, wrapped, { report, reset, tag, box });
  return { probe: V, injected: true, url: location.href, viewport: innerWidth + 'x' + innerHeight };
})();
