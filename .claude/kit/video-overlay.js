// Walkthrough video overlay: a drawn cursor, a click ripple, a highlight box and the corner marks video.mjs uses to
// find the tab on screen. Real clicks from Claude in Chrome or Playwright don't move a visible pointer, so viewers
// would otherwise not see what was clicked. Runs in the top frame only: the theme editor is a cross-origin iframe,
// and the overlay sits above it. Safe to run twice.
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
  // Shopify's "You are previewing" bar: not for the client's eyes, and it covers the bottom corner marks.
  const hide = document.createElement('style');
  hide.textContent = '#PBarNextFrameWrapper,#preview-bar-iframe{display:none!important}';
  document.documentElement.appendChild(hide);
  const el = (css, html = '') => { const d = document.createElement('div'); d.style.cssText = `position:fixed;display:block!important;${css}`; d.innerHTML = html; root.appendChild(d); return d; };
  const cursor = el('left:0;top:0;width:30px;height:30px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))',
    '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>');
  const box = el('display:none;border:3px solid #2c6ecb;border-radius:8px;box-shadow:0 0 0 9999px rgba(0,0,0,.28);transition:all .35s');
  box.style.setProperty('display', 'none', 'important');
  // Pure magenta squares near the viewport's corners: video.mjs looks for them in a screen grab and records the box
  // between them. 28 px in, because Claude in Chrome tints about 26 px of the tab's edge.
  const marks = ['left:28px;top:28px', 'right:28px;top:28px', 'left:28px;bottom:28px', 'right:28px;bottom:28px'].map((p) => el(`${p};width:14px;height:14px;background:#ff00ff`));
  // For the dev, not the viewer: it sits in the strip above the top marks, which the screen recording leaves out.
  const badge = el('display:none;top:4px;left:50%;transform:translateX(-50%);height:20px;line-height:20px;padding:0 10px;border-radius:10px;background:#d72c0d;color:#fff;font:600 12px/20px system-ui,sans-serif;white-space:nowrap',
    '● Recording');
  badge.style.setProperty('display', 'none', 'important');
  let x = innerWidth / 2;
  let y = innerHeight / 2;
  let scale = 1;
  const place = () => { cursor.style.transform = `translate(${x - 4}px,${y - 2}px)`; };
  place();
  window.__kc = {
    /**
     * Screenshot coordinates → CSS pixels: pass the width of the screenshot's coordinate frame once. Only Chrome scenes
     * call it, so it also shows the recording badge there (storefront scenes record the whole page and never call it).
     */
    frame(shotWidth) { scale = innerWidth / shotWidth; badge.style.setProperty('display', 'block', 'important'); return scale; },
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
    /** A rect in screenshot coordinates → "@x,y,w,h", its place in the box between the marks: append it to that stretch in --keep. */
    focus({ left, top, width, height }) {
      const bw = innerWidth - 56, bh = innerHeight - 56;
      const f = [(left * scale - 28) / bw, (top * scale - 28) / bh, (width * scale) / bw, (height * scale) / bh].map((v) => Math.min(1, Math.max(0, v)).toFixed(3));
      return `@${f.join(',')}`;
    },
    marks(on) { for (const m of marks) m.style.setProperty('display', on ? 'block' : 'none', 'important'); return Date.now(); },
    now: () => Date.now(),
  };
  return 'ready';
})();
