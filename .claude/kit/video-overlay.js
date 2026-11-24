// Walkthrough video overlay: a drawn cursor, a click ripple and a highlight box for storefront recordings (Playwright's
// clicks don't move a visible pointer, so viewers would otherwise not see what was clicked), and for chrome scenes'
// stills the theme editor laid out in a 16:9 box. In Chrome the cursor stays hidden: Claude in Chrome draws its own, in a
// closed shadow root no page can style, and two pointers showed (CHE-865). Runs in the top frame only: the theme editor
// is a cross-origin iframe, and the overlay sits above it. Safe to run twice.
(function kitOverlay() {
  if (window.top !== window || window.__kc) return 'ready';
  // As a Playwright init script it runs before the page has an <html> element to attach to: wait for it.
  if (!document.documentElement) {
    new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); kitOverlay(); } }).observe(document, { childList: true });
    return 'waiting';
  }
  const root = document.createElement('div');
  root.setAttribute('data-kit-video', '');
  root.style.cssText = 'position:fixed;inset:0;width:auto;height:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block!important';
  document.documentElement.appendChild(root);
  // The top layer sits above anything the page stacks, however high its z-index: an open settings panel hid the marks.
  try { root.popover = 'manual'; root.showPopover(); } catch { /* older browser: the z-index has to do */ }
  // Shopify's "You are previewing" bar: not for the client's eyes.
  const hide = document.createElement('style');
  hide.textContent = '#PBarNextFrameWrapper,#preview-bar-iframe{display:none!important}';
  document.documentElement.appendChild(hide);
  const el = (css, html = '') => { const d = document.createElement('div'); d.style.cssText = `position:fixed;display:block!important;${css}`; d.innerHTML = html; root.appendChild(d); return d; };
  const cursor = el('left:0;top:0;width:30px;height:30px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))',
    '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  const box = el('display:none;border:3px solid #2c6ecb;border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);transition:all .35s');
  box.style.setProperty('display', 'none', 'important');
  // The theme editor is one cross-origin iframe filling the admin page. Laid out at 1760x990 and scaled into a 16:9 box,
  // it keeps its wide layout (settings on the right: it docks them under the sections below about 1640 px) at any window
  // size and on any screen scaling, and the video needs no window resize. Measured on a real editor: clicks, hovers and
  // wheel scrolls land where the screenshot shows them, and 100vh inside is the 990.
  const EDITOR = 'iframe[src*="/themes/"][src*="/editor"]';
  const STAGE = { width: 1760, height: 990 };
  const stageCss = document.createElement('style');
  document.documentElement.appendChild(stageCss);
  // What a still shows: 28 px in from the tab's edge, because Claude in Chrome tints about 26 px of it.
  const area = () => {
    const iw = innerWidth - 56, ih = innerHeight - 56;
    if (!document.querySelector(EDITOR)) return { left: 28, top: 28, width: iw, height: ih, scale: 0 };
    const s = Math.min(iw / STAGE.width, ih / STAGE.height);
    const width = Math.floor(STAGE.width * s), height = Math.floor(STAGE.height * s);
    return { left: Math.round((innerWidth - width) / 2), top: Math.round((innerHeight - height) / 2), width, height, scale: s };
  };
  const layout = () => {
    const b = area();
    stageCss.textContent = b.scale ? `${EDITOR}{position:fixed!important;left:${b.left}px!important;top:${b.top}px!important;width:${STAGE.width}px!important;height:${STAGE.height}px!important;max-width:none!important;max-height:none!important;margin:0!important;transform:scale(${b.scale})!important;transform-origin:0 0!important}` : '';
    return b;
  };
  layout();
  addEventListener('resize', layout);
  let chrome = false;
  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let scale = 1;
  const place = () => { cursor.style.transform = `translate(${x - 4}px,${y - 2}px)`; };
  place();
  window.__kc = {
    /**
     * Screenshot coordinates → CSS pixels: pass the width of the screenshot's coordinate frame once. Only chrome scenes
     * call it, so it also hides the drawn cursor and lays the editor out (it may load after the overlay ran). Returns
     * region, the box a still shows, in screenshot coordinates: the zoom action's region.
     */
    frame(shotWidth) {
      scale = innerWidth / shotWidth;
      chrome = true;
      cursor.style.setProperty('display', 'none', 'important');
      const b = layout();
      return { scale, region: [b.left, b.top, b.left + b.width, b.top + b.height].map((v) => Math.round(v / scale)) };
    },
    move(tx, ty, ms = 650) {
      const [sx, sy, ex, ey, t0] = [x, y, tx * scale, ty * scale, performance.now()];
      return new Promise((done) => {
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms);
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
          x = sx + (ex - sx) * e; y = sy + (ey - sy) * e; place();
          if (k < 1) requestAnimationFrame(step); else done(Date.now());
        };
        requestAnimationFrame(step);
      });
    },
    ripple() {
      if (chrome) return; // Claude in Chrome rings its own pointer on a click.
      const r = el(`left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #2c6ecb;transition:transform .5s,opacity .5s;transform:scale(.3)`);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.25)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 700);
    },
    /** A CSS selector, or a rect {left, top, width, height} in screenshot coordinates like move(); null clears it. */
    highlight(target) {
      const r = typeof target === 'string' ? document.querySelector(target)?.getBoundingClientRect()
        : target && { left: target.left * scale, top: target.top * scale, width: target.width * scale, height: target.height * scale };
      if (!r) { box.style.setProperty('display', 'none', 'important'); return false; }
      Object.assign(box.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      box.style.setProperty('display', 'block', 'important');
      return true;
    },
    /** A rect in screenshot coordinates → "@x,y,w,h", its place in frame()'s box: append it to that beat's image in --shots. */
    focus({ left, top, width, height }) {
      const b = area();
      const f = [(left * scale - b.left) / b.width, (top * scale - b.top) / b.height, (width * scale) / b.width, (height * scale) / b.height].map((v) => Math.min(1, Math.max(0, v)).toFixed(3));
      return `@${f.join(',')}`;
    },
    /**
     * Fills the page magenta for 300 ms; resolves with the time it was painted. Storefront scenes find it in the
     * recording to line footage up with the clock: the recording's length was off by 1.4 s.
     */
    flash() {
      const f = el('left:0;top:0;right:0;bottom:0;background:#ff00ff');
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => { done(Date.now()); setTimeout(() => f.remove(), 300); })));
    },
  };
  return 'ready';
})();
