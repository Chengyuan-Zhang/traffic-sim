// ================================================================
// models.js — hero canvas figure for models.html.
//
// Renders three sample residual-noise trajectories (white, AR(5),
// smooth GP via random Fourier features) with identical marginal
// variance so the eye compares *temporal structure*, not amplitude.
//
// Design notes (addressing review comments.md):
//   • Single linear render() pipeline; no double-paint (item 1.1).
//   • Static SVG fallback lives inside the <figure>; we upgrade to
//     canvas only after the script runs (item 1.2).
//   • Resize handling uses ResizeObserver + requestAnimationFrame
//     debouncing (item 1.3).
//   • Palette is read from CSS custom properties so the JS and CSS
//     share a single source of truth (item 3.2).
//   • No dead drawTrace helper, no duplicated font strings
//     (items 3.3, 3.4).
//   • IntersectionObserver defers the first paint until the hero is
//     on screen (item 4.3).
// ================================================================

(() => {
  "use strict";

  const cvs = document.getElementById("noiseFig");
  if (!cvs || !cvs.getContext) return;
  const fig = cvs.closest(".mdl-hero-fig");
  const ctx = cvs.getContext("2d");

  // ---------- palette (read from CSS; avoid duplication) ----------
  const css = getComputedStyle(document.documentElement);
  const COLORS = {
    white: (css.getPropertyValue("--c-white") || "#ff7675").trim(),
    ar:    (css.getPropertyValue("--c-ar")    || "#74b9ff").trim(),
    gp:    (css.getPropertyValue("--c-gp")    || "#55efc4").trim(),
    axis:  "#2f4258",                    // brighter grid (item 2.6)
    refLn: "#1f2d40",                    // ±2σ reference lines (item 2.7)
    text:  (css.getPropertyValue("--muted-body") || "#b4c2d4").trim(),
    panel: "#0f1a28",
  };
  const FONT_LABEL = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const FONT_AXIS  = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

  // ---------- seeded PRNG for a reproducible figure ----------
  function mulberry32(seed) {
    return function () {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    // Box–Muller: two uniforms → one standard normal.
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Pre-compute all three traces once (reused across resizes).
  const N = 400;
  const rng = mulberry32(7);

  const white = new Array(N);
  for (let i = 0; i < N; i++) white[i] = gauss(rng);

  function arInnovationScale(coeffs) {
    const impulse = [1];
    let sumSq = 1;
    for (let j = 1; j < 4096; j++) {
      let value = 0;
      for (let k = 0; k < coeffs.length; k++) {
        const lag = j - k - 1;
        if (lag >= 0) value += coeffs[k] * impulse[lag];
      }
      impulse[j] = value;
      sumSq += value * value;
    }
    return 1 / Math.sqrt(sumSq);
  }

  // AR(5) paper coefficients from Zhang et al. (2024), Table 1.
  const arCoeffs = [0.874, 0.580, -0.105, -0.315, -0.071];
  const arScale = arInnovationScale(arCoeffs);
  const arHist = new Array(arCoeffs.length).fill(0);
  const ar = new Array(N);
  for (let i = -600; i < N; i++) {
    let mean = 0;
    for (let k = 0; k < arCoeffs.length; k++) mean += arCoeffs[k] * arHist[k];
    const next = mean + arScale * gauss(rng);
    for (let k = arHist.length - 1; k > 0; k--) arHist[k] = arHist[k - 1];
    arHist[0] = next;
    if (i >= 0) ar[i] = next;
  }

  // Smooth GP approximation via random Fourier features with a small
  // Gaussian spectral density (RBF-like). Normalised to unit variance.
  const M = 40, ell = 28;
  const w = new Array(M), b = new Array(M);
  const amp = Math.sqrt(2 / M);
  for (let m = 0; m < M; m++) {
    w[m] = gauss(rng) / ell;
    b[m] = rng() * 2 * Math.PI;
  }
  const gp = new Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let m = 0; m < M; m++) s += Math.cos(w[m] * i + b[m]);
    gp[i] = amp * s;
  }

  // ---------- rendering ----------
  const PAD_LEFT = 54;                   // room for row labels
  const PAD_RIGHT = 18;
  const PAD_TOP = 4;
  const PAD_BOTTOM = 16;

  function drawLanes(cssW, cssH) {
    const rowH = (cssH - PAD_TOP - PAD_BOTTOM) / 3;

    // ±2σ reference bands (very faint) — give the y-dimension meaning
    // without cluttering the figure (items 2.7, 2.8).
    ctx.strokeStyle = COLORS.refLn;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 3]);
    for (let r = 0; r < 3; r++) {
      const yC = PAD_TOP + rowH * (r + 0.5);
      const amp2 = rowH * 0.28 * 2;      // ±2σ in the same amp scale as traces
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, yC - amp2); ctx.lineTo(cssW - PAD_RIGHT, yC - amp2);
      ctx.moveTo(PAD_LEFT, yC + amp2); ctx.lineTo(cssW - PAD_RIGHT, yC + amp2);
      ctx.stroke();
    }

    // Zero midline per lane (brighter, so the baseline of the residual is
    // clearly visible — item 2.6).
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = COLORS.axis;
    for (let r = 0; r < 3; r++) {
      const yC = PAD_TOP + rowH * (r + 0.5);
      ctx.beginPath();
      ctx.moveTo(PAD_LEFT, yC);
      ctx.lineTo(cssW - PAD_RIGHT, yC);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Row labels
    ctx.font = FONT_LABEL;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.white; ctx.fillText("White", 10, PAD_TOP + rowH * 0.5);
    ctx.fillStyle = COLORS.ar;    ctx.fillText("AR(5)", 10, PAD_TOP + rowH * 1.5);
    ctx.fillStyle = COLORS.gp;    ctx.fillText("GP",    10, PAD_TOP + rowH * 2.5);

    // y-axis anchor: one "±2σ" tick label at the top of the first lane
    // (item 2.8 — gives the vertical dimension meaning).
    ctx.font = FONT_AXIS;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.fillText("+2σ", PAD_LEFT - 4, PAD_TOP + rowH * 0.5 - rowH * 0.28 * 2 - 2);
    ctx.fillText("−2σ", PAD_LEFT - 4, PAD_TOP + rowH * 0.5 + rowH * 0.28 * 2 - 8);

    // x-axis hint
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("time →", cssW - PAD_RIGHT, cssH - 2);
  }

  function drawTrace(data, color, yCenter, amp, plotLeft, plotRight) {
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    const span = plotRight - plotLeft;
    for (let i = 0; i < N; i++) {
      const x = plotLeft + (i / (N - 1)) * span;
      const y = yCenter - data[i] * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function render() {
    const dpr  = window.devicePixelRatio || 1;
    const cssW = cvs.clientWidth  || 520;
    const cssH = cvs.clientHeight || 260;

    cvs.width  = Math.max(1, Math.round(cssW * dpr));
    cvs.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(0, 0, cssW, cssH);

    drawLanes(cssW, cssH);

    const rowH = (cssH - PAD_TOP - PAD_BOTTOM) / 3;
    const amp = rowH * 0.28;
    drawTrace(white, COLORS.white, PAD_TOP + rowH * 0.5, amp, PAD_LEFT, cssW - PAD_RIGHT);
    drawTrace(ar,    COLORS.ar,    PAD_TOP + rowH * 1.5, amp, PAD_LEFT, cssW - PAD_RIGHT);
    drawTrace(gp,    COLORS.gp,    PAD_TOP + rowH * 2.5, amp, PAD_LEFT, cssW - PAD_RIGHT);
  }

  // rAF-debounced resize; one paint per animation frame no matter how
  // many resize events fire in between (item 1.3).
  let rafId = 0;
  function requestRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  // ---------- first paint deferred until on-screen ----------
  let hydrated = false;
  function hydrate() {
    if (hydrated) return;
    hydrated = true;
    if (fig) fig.setAttribute("data-hydrated", "true");
    render();
    // Prefer ResizeObserver (fires only on size changes, and not on
    // every scroll/layout tick) over window resize events.
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => requestRender());
      ro.observe(cvs);
    } else {
      window.addEventListener("resize", requestRender, { passive: true });
    }
  }

  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) { hydrate(); io.disconnect(); return; }
      },
      { rootMargin: "200px" }
    );
    io.observe(cvs);
  } else {
    // Ancient browsers: just render immediately.
    hydrate();
  }
})();
