// The app kit's QA probe, for kit-browser: browser_run_code_unsafe with filename ".claude/kit/qa-probe.init.js" (no code).
// It defines window.__aq on every page from then on, and on the pages already open; measure with browser_evaluate.
// Checkout and admin extensions render through Shopify's own components, with generated class names and shadow roots,
// so everything here finds elements by their text and looks through open shadow roots.
//   __aq.env()                    width, url, which checkout layout (one-page or three steps), collapsed summaries
//   __aq.copies('Sicher bei')     every element showing that text: visible or hidden, where, inside which summary
//   __aq.expand()                 opens every collapsed order summary / details (mobile one-page shows the summary twice)
//   __aq.box('Sicher bei', ['font-size','color'])   the block's rect and computed styles (getComputedStyle form)
//   __aq.gap('Kostenlose Retoure', 'Ersatz oder Reparatur')   rendered distance between two texts
//   __aq.wraps('WhatsApp Support')  whether a text runs onto a second line
//   __aq.overflow()               what sticks out of the viewport horizontally
//   __aq.links('Sicher bei')      links and buttons inside the block that holds the text: name, href, target
//   __aq.images('Sicher bei')     images inside that block: rendered vs natural size, data: or hosted
//   __aq.compare(frame)           one frame of design-checks.json against the page: PASS/FAIL/MISSING per element and gap
async (page) => {
  const probe = () => {
    const deep = (root = document) => {
      const out = [];
      const walk = (node) => {
        for (const el of node.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
      };
      walk(root);
      return out;
    };
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const own = (el) => norm([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
    // Text as shown: without script, style and JSON blobs (checkout pages carry their data in script tags).
    const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
    const shown = (el) => (SKIP.has(el.tagName) ? '' : [...el.childNodes].map((n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 ? shown(n) : '')).join(' '));
    // The innermost elements whose text contains the needle (an ancestor repeats it, so only the deepest count).
    const byText = (text) => {
      const t = norm(text).toLowerCase();
      const hits = deep().filter((el) => !SKIP.has(el.tagName) && norm(shown(el)).toLowerCase().includes(t));
      return hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    };
    const hiddenBy = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode()?.host) {
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return `display:none on <${n.tagName.toLowerCase()}>`;
        if (cs.visibility === 'hidden') return `visibility:hidden on <${n.tagName.toLowerCase()}>`;
        if (Number(cs.opacity) === 0) return `opacity:0 on <${n.tagName.toLowerCase()}>`;
        if (n.tagName === 'DETAILS' && !n.open && !n.querySelector(':scope > summary')?.contains(el)) return 'inside a closed <details>';
        if (n.getAttribute?.('aria-hidden') === 'true') return `aria-hidden on <${n.tagName.toLowerCase()}>`;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 'zero size';
      // Screen-reader-only text (a 1px clipped box) and content an overflow:hidden ancestor cuts off read as visible
      // in the DOM but aren't on screen.
      const cs = getComputedStyle(el);
      if (/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath) || (r.width <= 1 && r.height <= 1)) return 'screen-reader only (clipped to 1px)';
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ns = getComputedStyle(n);
        if (!/hidden|clip/.test(ns.overflow + ns.overflowX + ns.overflowY)) continue;
        const p = n.getBoundingClientRect();
        if (r.bottom <= p.top || r.top >= p.bottom || r.right <= p.left || r.left >= p.right) return `cut off by <${n.tagName.toLowerCase()}> (overflow hidden)`;
      }
      return null;
    };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
    // The nearest landmark a block sits in: an aside, a labelled region, a summary or a heading above it.
    const where = (el) => {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode()?.host) {
        const label = n.getAttribute?.('aria-label') || (n.tagName === 'ASIDE' && 'aside') || (n.tagName === 'DETAILS' && `details: ${norm(n.querySelector('summary')?.textContent).slice(0, 40)}`);
        if (label) return label;
      }
      return null;
    };
    // The visible copy first: a collapsed summary's copy can't be measured.
    const first = (text) => { const all = byText(text); return all.find((el) => !hiddenBy(el)) || all[0] || null; };
    const LANDMARK = /^(BODY|MAIN|ASIDE|FORM|HEADER|FOOTER|NAV|DETAILS)$/;
    // The container a block's text lives in: up from the text while the parent is no landmark and holds under 400
    // characters (a block's own texts; an order summary or a page holds far more).
    const block = (text) => {
      let el = first(text);
      if (!el) return null;
      while (el.parentElement && !LANDMARK.test(el.parentElement.tagName) && !el.parentElement.getAttribute('aria-label') && norm(shown(el.parentElement)).length < 400) el = el.parentElement;
      return el;
    };
    const css = (el, props) => { const cs = getComputedStyle(el); return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])); };
    window.__aq = {
      env: () => {
        const text = norm(document.body?.innerText).toLowerCase();
        const steps = /information|informationen/.test(text) && /shipping|versand/.test(text) && /payment|zahlung/.test(text) && deep().some((el) => el.tagName === 'NAV' && /breadcrumb/i.test(el.getAttribute('aria-label') || ''));
        // "one page" only when shipping and the pay button share the page; anything else is unknown, not a guess.
        const onePage = /shipping|versand|livraison|envío/.test(text) && /pay now|jetzt (kaufen|bezahlen)|bestellung abschließen|complete order|payer|payer maintenant|pagar/.test(text);
        return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href, readyState: document.readyState,
          checkout: /\/checkouts?\//.test(location.pathname) ? (steps ? 'three steps (breadcrumbs)' : onePage ? 'one page' : 'unknown: look at the page') : null,
          collapsed: deep().filter((el) => (el.tagName === 'DETAILS' && !el.open) || el.getAttribute('aria-expanded') === 'false').map((el) => norm(el.textContent).slice(0, 50)).slice(0, 10) };
      },
      copies: (text) => byText(text).map((el) => ({ tag: el.tagName.toLowerCase(), visible: !hiddenBy(el), hiddenBy: hiddenBy(el), rect: hiddenBy(el) ? null : rect(el), inside: where(el), text: norm(shown(el)).slice(0, 80) })),
      expand: () => {
        let n = 0;
        for (const d of deep().filter((el) => el.tagName === 'DETAILS' && !el.open)) { d.open = true; n++; }
        for (const b of deep().filter((el) => el.getAttribute('aria-expanded') === 'false' && /summary|bestell|order/i.test(el.textContent || ''))) { b.click(); n++; }
        return `${n} opened; run __aq.env() again`;
      },
      box: (text, props = ['font-size', 'line-height', 'font-weight', 'color', 'background-color', 'border-radius', 'padding', 'gap']) => {
        const el = first(text);
        return el ? { tag: el.tagName.toLowerCase(), rect: rect(el), hiddenBy: hiddenBy(el), css: css(el, props) } : `no element shows "${text}"`;
      },
      gap: (a, b) => {
        const A = first(a); const B = first(b);
        if (!A || !B) return `not found: ${!A ? a : b}`;
        const ra = A.getBoundingClientRect(); const rb = B.getBoundingClientRect();
        return { vertical: Math.round(rb.top - ra.bottom), horizontal: Math.round(rb.left - ra.right) };
      },
      wraps: (text) => {
        const el = first(text);
        if (!el) return `no element shows "${text}"`;
        const cs = getComputedStyle(el);
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        // The content box: a padded button isn't two lines.
        const h = el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
        return { lines: Math.max(1, Math.round(h / lh)), lineHeight: lh, width: Math.round(el.getBoundingClientRect().width) };
      },
      // One frame of design-checks.json against the page: each element found by its text, each fixed value compared
      // (colours as hex, sizes within 1px), each spacing as a rendered gap. Run at the frame's width.
      compare: (frame) => {
        // Colours as #rrggbb (#rrggbbaa when not opaque, so a half-transparent colour can't pass for a solid one).
        const hex = (v) => {
          const s = String(v).trim().toLowerCase();
          const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
          if (m) { const a = m[4] === undefined ? 1 : Number(m[4]); return a === 0 ? 'transparent' : `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}${a < 1 ? Math.round(a * 255).toString(16).padStart(2, '0') : ''}`; }
          if (/^#[0-9a-f]{3}$/.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join('')}`;
          if (/^#[0-9a-f]{8}$/.test(s) && s.endsWith('ff')) return s.slice(0, 7);
          return s;
        };
        const same = (got, want, prop) => {
          const g = hex(got); const w = hex(want); const gn = parseFloat(g); const wn = parseFloat(w);
          if (g === w) return true;
          if (/letter-spacing/.test(prop) && [g, w].every((x) => x === 'normal' || parseFloat(x) === 0)) return true;
          if (/font-family/.test(prop)) return g.split(',')[0].replace(/["']/g, '').trim() === w.split(',')[0].replace(/["']/g, '').trim();
          // A unitless line height (1.5) is a multiple of the font size; computed styles give px.
          if (/line-height/.test(prop) && /^[\d.]+$/.test(w)) return Math.abs(gn - wn * parseFloat(gotSize)) <= 1;
          return (/^-?[\d.]+px$/.test(w) && Math.abs(gn - wn) <= 1) || (/^\d+$/.test(w) && gn === wn);
        };
        let gotSize = '16px';
        const out = [];
        if (frame?.width && Math.abs(innerWidth - frame.width) > 1) out.push({ name: 'viewport', verdict: 'FAIL', got: `${innerWidth}px`, want: `${frame.width}px: resize first` });
        for (const e of frame?.elements || []) {
          if (!e.text) { out.push({ name: e.name, verdict: 'SKIPPED', note: 'no text to find it by' }); continue; }
          const el = first(e.text);
          if (!el || hiddenBy(el)) { out.push({ name: e.name, verdict: 'MISSING', note: el ? hiddenBy(el) : `no element shows "${e.text}"` }); continue; }
          const got = css(el, [...Object.keys(e.fixed || {}), 'font-size']);
          gotSize = got['font-size'];
          const bad = Object.entries(e.fixed || {}).filter(([p, w]) => !same(got[p], w, p)).map(([p, w]) => `${p}: ${hex(got[p])} (want ${w})`);
          out.push({ name: e.name, verdict: bad.length ? 'FAIL' : 'PASS', ...(bad.length ? { got: bad.join('; ') } : {}) });
        }
        // between names elements of this frame (by name, resolved to their text) or gives texts directly. Only gaps
        // between two elements are measured; a padding or an edge distance is judged on a screenshot.
        const textOf = (n) => (frame?.elements || []).find((e) => e.name === n)?.text || n;
        for (const s of frame?.spacing || []) {
          if (s.kind && !/gap/i.test(s.kind)) { out.push({ name: s.name, verdict: 'SKIPPED', note: `${s.kind}: measure on a screenshot or with __aq.box` }); continue; }
          const [a, b] = (s.between || []).map(textOf);
          const A = a && first(a); const B = b && first(b);
          if (!A || !B) { out.push({ name: s.name, verdict: 'MISSING', note: `not found: ${!A ? a : b}` }); continue; }
          const ra = A.getBoundingClientRect(); const rb = B.getBoundingClientRect();
          const gap = Math.round(rb.top >= ra.bottom - 1 ? rb.top - ra.bottom : rb.left - ra.right);
          out.push({ name: s.name, verdict: Math.abs(gap - s.expected) <= 1 ? 'PASS' : 'FAIL', got: `${gap}px`, want: `${s.expected}px` });
        }
        return out;
      },
      overflow: () => deep().filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1) && !hiddenBy(el); })
        .slice(0, 10).map((el) => ({ tag: el.tagName.toLowerCase(), text: (own(el) || norm(el.textContent)).slice(0, 40), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) })),
      links: (text) => { const b = block(text); return b ? deep(b).filter((el) => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link')
        .map((el) => ({ tag: el.tagName.toLowerCase(), name: norm(el.getAttribute('aria-label') || el.textContent).slice(0, 60), href: el.getAttribute('href'), target: el.getAttribute('target'), rect: rect(el) })) : `no block shows "${text}"`; },
      images: (text) => { const b = block(text); return b ? deep(b).filter((el) => el.tagName === 'IMG')
        .map((el) => ({ alt: el.alt, src: el.src.startsWith('data:') ? `data: (${Math.round(el.src.length / 1024)} KB)` : el.src.slice(0, 100), rendered: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`, natural: `${el.naturalWidth}x${el.naturalHeight}`, loaded: el.complete && el.naturalWidth > 0 })) : `no block shows "${text}"`; },
    };
  };
  await page.context().addInitScript(probe);
  for (const p of page.context().pages()) await p.evaluate(probe).catch(() => {});
  return 'probe ready: __aq on this and every later page';
}
