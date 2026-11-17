// Runs in the storefront page: checks one viewport of design-checks.json against what rendered.
// Ported from shadow-drip-exps' style-checker (check-properties, check-spacing): same normalisation and tolerances.
// kit.mjs design-audit <KEY> <viewport> wraps it into a file QA runs with browser_run_code_unsafe.
// `env` exists for the kit's self-test; in the page the defaults are used.
function designAudit(spec, env) {
  env = env || {
    q: (s) => document.querySelector(s),
    qa: (s) => Array.from(document.querySelectorAll(s)),
    style: (el) => getComputedStyle(el),
    rect: (el) => el.getBoundingClientRect(),
    vw: () => innerWidth,
  };
  // rgb()/rgba() anywhere in a value (colours, borders, shadows) → #rrggbb; a partly transparent one keeps its alpha.
  const hex = (m, r, g, b, a) => {
    if (a !== undefined && Number(a) === 0) return 'transparent';
    const h = '#' + [r, g, b].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
    return a !== undefined && Number(a) < 1 ? `${h}/${Number(a)}` : h;
  };
  const norm = (prop, v) => {
    if (prop === 'font-family') return String(v).replace(/["']/g, '').split(',')[0].trim().toLowerCase();
    let s = String(v).trim().toLowerCase().replace(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g, hex);
    // An unset letter-spacing computes to "normal"; Figma writes it as 0px.
    if (prop === 'letter-spacing' && s === 'normal') s = '0px';
    return s.replace(/(-?[\d.]+)px/g, (_, n) => `${Math.round(Number(n))}px`);
  };
  // px tolerance per property; anything else must match exactly after normalising.
  const TOL = { 'font-size': 1, 'line-height': 2, 'letter-spacing': 1, gap: 2, 'row-gap': 2, 'column-gap': 2, 'border-radius': 2,
    width: 5, height: 5, 'max-width': 5, 'min-height': 5 };
  const tol = (prop) => TOL[prop] ?? (/^(padding|margin)/.test(prop) ? 2 : undefined);
  const close = (prop, want, got) => {
    const t = tol(prop);
    if (t === undefined) return want === got;
    const a = want.match(/-?[\d.]+/g) || [];
    const b = got.match(/-?[\d.]+/g) || [];
    return a.length > 0 && a.length === b.length && a.every((n, i) => Math.abs(Number(n) - Number(b[i])) <= t);
  };
  const out = { checked: 0, passed: 0, failures: [], missing: [] };
  const fail = (name, what, expected, actual) => out.failures.push({ name, what, expected, actual });
  const count = (ok, name, what, expected, actual) => { out.checked++; if (ok) out.passed++; else fail(name, what, expected, actual); };
  // Themes often render a desktop and a mobile copy and hide one: measure the visible one.
  const find = (name, sel) => {
    const el = sel ? env.qa(sel).find((x) => env.rect(x).width > 0) || env.q(sel) : null;
    if (!el) out.missing.push(`${name}: ${sel || '(no selector)'}`);
    return el;
  };

  for (const e of spec.elements || []) {
    const el = find(e.name, e.selector);
    if (!el) continue;
    const cs = env.style(el);
    for (const [prop, want] of Object.entries(e.fixed || {})) {
      const got = norm(prop, cs.getPropertyValue(prop));
      count(close(prop, norm(prop, want), got), e.name, prop, norm(prop, want), got);
    }
    if (e.fill === 'parent' && el.parentElement) {
      const p = env.rect(el.parentElement);
      const ps = env.style(el.parentElement);
      const inner = p.width - parseFloat(ps.getPropertyValue('padding-left') || 0) - parseFloat(ps.getPropertyValue('padding-right') || 0);
      const w = env.rect(el).width;
      count(Math.abs(w - inner) <= 2, e.name, 'fills its parent', `${Math.round(inner)}px`, `${Math.round(w)}px`);
    }
  }

  const near = (want, got) => Math.abs(want - got) <= 2;
  for (const s of spec.spacing || []) {
    const vertical = (s.axis || 'vertical') === 'vertical';
    if (s.type === 'siblingGap') {
      const a = find(s.name, s.from);
      const b = find(s.name, s.to);
      if (!a || !b) continue;
      const ra = env.rect(a);
      const rb = env.rect(b);
      const gap = vertical ? rb.top - ra.bottom : rb.left - ra.right;
      count(near(s.expected, gap), s.name, 'gap', `${s.expected}px`, `${Math.round(gap)}px`);
    } else if (s.type === 'trackGap') {
      const kids = env.qa(`${s.container} > *`);
      if (kids.length < 2) { out.missing.push(`${s.name}: fewer than 2 children in ${s.container}`); continue; }
      for (let i = 1; i < kids.length; i++) {
        const a = env.rect(kids[i - 1]);
        const b = env.rect(kids[i]);
        const gap = vertical ? b.top - a.bottom : b.left - a.right;
        count(near(s.expected, gap), s.name, `gap ${i}–${i + 1}`, `${s.expected}px`, `${Math.round(gap)}px`);
      }
    } else if (s.type === 'containerPad' || s.type === 'toViewport') {
      const outer = s.type === 'containerPad' ? find(s.name, s.container) : null;
      const inner = s.type === 'containerPad' ? (outer && find(s.name, s.child ? `${s.container} ${s.child}` : `${s.container} > *`)) : find(s.name, s.element);
      if (!inner || (s.type === 'containerPad' && !outer)) continue;
      const o = outer ? env.rect(outer) : { top: 0, left: 0, right: env.vw(), bottom: Infinity };
      const r = env.rect(inner);
      const got = { top: r.top - o.top, right: o.right - r.right, bottom: o.bottom - r.bottom, left: r.left - o.left };
      for (const [side, want] of Object.entries(s.sides || {})) {
        if (want === null || want === undefined) continue;
        count(near(want, got[side]), s.name, side, `${want}px`, `${Math.round(got[side])}px`);
      }
    } else {
      out.missing.push(`${s.name}: unknown spacing type "${s.type}"`);
    }
  }
  out.verdict = out.missing.length || out.failures.length ? 'FAIL' : 'PASS';
  out.viewport = env.vw();
  return out;
}
