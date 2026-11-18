// Walkthrough video overlay: a drawn cursor, a click ripple, a highlight box and the corner marks video.mjs uses to
// find the tab on screen. Real clicks from Claude in Chrome or Playwright don't move a visible pointer, so viewers
// would otherwise not see what was clicked. Runs in the top frame only: the theme editor is a cross-origin iframe,
// and the overlay sits above it. Safe to run twice.
(() => {
  if (window.top !== window || window.__kc) return 'ready';
  const root = document.createElement('div');
  root.setAttribute('data-kit-video', '');
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block!important';
  document.documentElement.appendChild(root);
  // Shopify's "You are previewing" bar: not for the client's eyes, and it covers the bottom corner marks.
  const hide = document.createElement('style');
  hide.textContent = '#PBarNextFrameWrapper,#preview-bar-iframe{display:none!important}';
  document.documentElement.appendChild(hide);
  const el = (css, html = '') => { const d = document.createElement('div'); d.style.cssText = `position:fixed;display:block!important;${css}`; d.innerHTML = html; root.appendChild(d); return d; };
  const cursor = el('left:0;top:0;width:30px;height:30px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))',
    '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  const box = el('display:none;border:3px solid #2c6ecb;border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);transition:all .35s');
  box.style.setProperty('display', 'none', 'important');
  // Pure magenta squares at the viewport's corners: video.mjs looks for them in a screen grab to crop the recording.
  const marks = ['left:0;top:0', 'right:0;top:0', 'left:0;bottom:0', 'right:0;bottom:0'].map((p) => el(`${p};width:14px;height:14px;background:#ff00ff`));
  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let scale = 1;
  const place = () => { cursor.style.transform = `translate(${x - 4}px,${y - 2}px)`; };
  place();
  window.__kc = {
    /** Screenshot coordinates → CSS pixels: pass the width of the screenshot's coordinate frame once. */
    frame(shotWidth) { scale = innerWidth / shotWidth; return scale; },
    move(tx, ty, ms = 900) {
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
      const r = el(`left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;border:3px solid #2c6ecb;transition:transform .5s,opacity .5s;transform:scale(.3)`);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.25)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 700);
    },
    /** A CSS selector (storefront) or a rect in CSS pixels; null clears it. */
    highlight(target) {
      const r = typeof target === 'string' ? document.querySelector(target)?.getBoundingClientRect() : target;
      if (!r) { box.style.setProperty('display', 'none', 'important'); return false; }
      Object.assign(box.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      box.style.setProperty('display', 'block', 'important');
      return true;
    },
    marks(on) { for (const m of marks) m.style.setProperty('display', on ? 'block' : 'none', 'important'); return Date.now(); },
    now: () => Date.now(),
  };
  return 'ready';
})();
