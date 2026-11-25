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
      return r.width === 0 || r.height === 0 ? 'zero size' : null;
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
        return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href, readyState: document.readyState,
          checkout: /\/checkouts?\//.test(location.pathname) ? (steps ? 'three steps (breadcrumbs)' : 'one page') : null,
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
        const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.2;
        return { lines: Math.round(el.getBoundingClientRect().height / lh), lineHeight: lh, width: Math.round(el.getBoundingClientRect().width) };
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
