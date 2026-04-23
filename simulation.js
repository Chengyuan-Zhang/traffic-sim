(() => {
  "use strict";

  // ---------- Seeded PRNG (mulberry32) ----------
  // seed = 0 means "unseeded" (use Math.random); any positive int gives reproducibility.
  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rand = Math.random;

  // ---------- HiDPI canvas scaling ----------
  const DPR = Math.max(1, window.devicePixelRatio || 1);
  function fitCanvas(c, cssW, cssH) {
    c.style.width = cssW + "px";
    c.style.height = cssH + "px";
    c.width = Math.max(1, Math.floor(cssW * DPR));
    c.height = Math.max(1, Math.floor(cssH * DPR));
    c._w = cssW;
    c._h = cssH;
    c.getContext("2d").setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ---------- Perceptually-uniform, color-blind-safe colormap (Viridis) ----------
  // Five-stop sampling; linear-interpolated. Used for (1) car speed on the ring,
  // (2) per-pixel speed in the time-space diagram. Matches the CSS gradient in
  // index.html's `.speed-legend` bar so the legend reads the same as the map.
  const VIRIDIS = [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]];
  function viridis(t) {
    t = Math.max(0, Math.min(0.999, t || 0));
    const idx = t * (VIRIDIS.length - 1);
    const i = Math.floor(idx);
    const f = idx - i;
    const a = VIRIDIS[i], b = VIRIDIS[i + 1] || a;
    return [
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ];
  }
  function viridisCss(t) {
    const [r, g, b] = viridis(t);
    return `rgb(${r},${g},${b})`;
  }

  const canvas = document.getElementById("road");
  const ctx = canvas.getContext("2d");

  const params = {
    numCars: 30,
    // IDM defaults from Treiber & Kesting (2013), Traffic Flow Dynamics,
    // Table 11.1 — recommended highway-traffic values.
    v0: 33,        // desired speed (m/s)   [~120 km/h]
    T: 1.5,        // safe time headway (s)
    a: 1.2,        // max acceleration (m/s^2)
    b: 1.5,        // comfortable deceleration (m/s^2)
    s0: 2.0,       // minimum jam spacing (m)
    delta: 4,      // IDM exponent
    carLength: 4.5,
    radius: 120,   // meters
    speedMul: 1.0,
    dtStep: 0.05,  // integration step size (s)
    // GP driver noise (arXiv:2210.03571) with choice of kernel
    gpSigma: 0.20,      // output scale (m/s^2)  [MA-IDM: σ_k = 0.202]
    gpEll: 1.4,         // lengthscale (seconds) [MA-IDM: ℓ = 1.44 s]
    gpKernel: "rbf",    // "rbf" | "matern52" | "matern32" | "matern12"
    noiseMode: "gp",    // "gp" | "ar" | "white"
    arOrder: 2,         // AR(p) order; uses paper-calibrated ρ for this order

    // Measuring region on the ring (in degrees; 0 = top, clockwise).
    regionCenter: 0,
    regionSpan: 90,

    // Seeded PRNG: 0 = unseeded (Math.random); any positive int reproduces a run.
    seed: 0,
  };

  // ---------- Load params from URL hash + localStorage (URL > storage > defaults) ----------
  const STRING_KEYS = new Set(["gpKernel", "noiseMode"]);
  function coerceParam(k, v) {
    if (STRING_KEYS.has(k)) return String(v);
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  try {
    const stored = JSON.parse(localStorage.getItem("traffic-sim-params") || "{}");
    for (const [k, v] of Object.entries(stored)) {
      if (k in params) params[k] = coerceParam(k, v);
    }
  } catch (_) { /* ignore corrupted localStorage */ }
  try {
    const hash = new URLSearchParams((location.hash || "").slice(1));
    for (const [k, v] of hash.entries()) {
      if (k in params) params[k] = coerceParam(k, v);
    }
  } catch (_) { /* ignore malformed hash */ }
  if (params.seed && params.seed > 0) rand = mulberry32(params.seed | 0);

  // Debounced URL + localStorage sync.
  let _writeStateT = 0;
  function scheduleWriteState() {
    clearTimeout(_writeStateT);
    _writeStateT = setTimeout(() => {
      try {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) q.set(k, String(v));
        history.replaceState(null, "", "#" + q.toString());
        localStorage.setItem("traffic-sim-params", JSON.stringify(params));
      } catch (_) { /* best-effort */ }
    }, 200);
  }

  // AR coefficients calibrated on HighD (5 fps) in arXiv:2307.03340, Table 1.
  // Keys = AR order p; values = [rho_1, rho_2, ..., rho_p].
  // When noise mode is "ar", sigma controls the innovation std (the paper's
  // calibrated sigma_eta ~ 0.019 m/s^2 is too small for a visible toy sim).
  const AR_COEFFS = {
    1: [0.989],
    2: [1.234, -0.247],
    3: [1.123,  0.425, -0.572],
    4: [0.901,  0.590, -0.149, -0.377],
    5: [0.874,  0.580, -0.105, -0.315, -0.071],
    6: [0.902,  0.632, -0.100, -0.427, -0.217,  0.181],
    7: [0.866,  0.690, -0.001, -0.413, -0.378, -0.032,  0.248],
  };

  // Paper downsamples HighD to 5 fps, so 1 frame = 0.2 s (used by AR update cadence)
  const FRAME_DT = 0.2;

  // Random Fourier Features for a zero-mean GP with RBF kernel
  //   k(t,t') = sigma^2 * exp(-(t-t')^2 / (2*ell^2))
  // Approximated by  eps(t) = sigma * sqrt(2/M) * sum_m cos(w_m * t + b_m),
  //   with w_m ~ N(0, 1/ell^2), b_m ~ U(0, 2*pi).
  // This gives a stationary process with the RBF kernel (Bochner's theorem).
  const GP_M = 32;
  let simTime = 0;  // shared continuous clock fed to the GP

  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Student-t sampler with integer df via Z / sqrt(W/df), W ~ chi-sq(df)
  function studentT(df) {
    let w = 0;
    for (let i = 0; i < df; i++) { const z = randn(); w += z * z; }
    return randn() * Math.sqrt(df / w);
  }

  // Spectral-density sampler for the chosen kernel (scale 1/ell).
  // RBF:      S(w) ∝ exp(-w^2 * ell^2 / 2)              →  w ~ N(0, 1/ell^2)
  // Matern-ν: S(w) ∝ (2ν/ell^2 + w^2)^{-(ν+1/2)}        →  w = T / ell,  T ~ t(2ν)
  function sampleOmega(ell, kernel) {
    const inv = 1 / Math.max(0.01, ell);
    switch (kernel) {
      case "matern12": return studentT(1) * inv;   // exponential / OU
      case "matern32": return studentT(3) * inv;
      case "matern52": return studentT(5) * inv;
      case "rbf":
      default:         return randn() * inv;
    }
  }

  function sampleGPFeatures(ell, kernel) {
    const omegas = new Float32Array(GP_M);
    const phases = new Float32Array(GP_M);
    for (let m = 0; m < GP_M; m++) {
      omegas[m] = sampleOmega(ell, kernel);
      phases[m] = rand() * 2 * Math.PI;
    }
    return { omegas, phases };
  }

  function gpNoise(car) {
    // MA-IDM: sigma * sqrt(2/M) * sum cos(w_m * t + b_m)
    let s = 0;
    const om = car.gp.omegas, ph = car.gp.phases;
    for (let m = 0; m < GP_M; m++) {
      s += Math.cos(om[m] * simTime + ph[m]);
    }
    return params.gpSigma * Math.sqrt(2 / GP_M) * s;
  }

  function whiteNoise() {
    // B-IDM baseline: i.i.d. Gaussian at each sim step
    return params.gpSigma * randn();
  }

  // AR(p) with fixed paper coefficients: eps_t = sum_k rho_k * eps_{t-k} + innov
  // Updates at the paper's 5 fps cadence (FRAME_DT = 0.2 s). Innovation std = sigma.
  function arNoise(car, dt) {
    const rho = AR_COEFFS[params.arOrder] || AR_COEFFS[1];
    const p = rho.length;
    if (!car.arHist || car.arHist.length !== p) car.arHist = new Array(p).fill(0);
    car.arAccum = (car.arAccum || 0) + dt;
    while (car.arAccum >= FRAME_DT) {
      let mean = 0;
      for (let k = 0; k < p; k++) mean += rho[k] * car.arHist[k];
      const next = mean + params.gpSigma * randn();
      // shift history: arHist[0] is the most recent
      for (let k = p - 1; k > 0; k--) car.arHist[k] = car.arHist[k - 1];
      car.arHist[0] = next;
      car.arAccum -= FRAME_DT;
    }
    return car.arHist[0];
  }

  function resampleAllGP() {
    for (const c of cars) c.gp = sampleGPFeatures(params.gpEll, params.gpKernel);
  }

  let cars = [];        // {s: position along ring (m), v: speed (m/s), color, perturb?}
  let paused = false;
  let lastTime = performance.now();

  // ---------- setup ----------
  function circumference() { return 2 * Math.PI * params.radius; }

  function colorFor(i, n) {
    const hue = Math.round((i / n) * 360);
    return `hsl(${hue}, 70%, 60%)`;
  }

  function initCars() {
    cars = [];
    const L = circumference();
    const n = params.numCars;
    const spacing = L / n;
    for (let i = 0; i < n; i++) {
      cars.push({
        s: i * spacing,
        v: params.v0 * 0.8,
        color: colorFor(i, n),
        perturbUntil: 0,
        gp: sampleGPFeatures(params.gpEll, params.gpKernel),
        arHist: [],
        arAccum: 0,
      });
    }
    simTime = 0;
  }

  // ---------- IDM ----------
  function idmAccel(v, vLead, gap) {
    const { v0, T, a, b, s0, delta } = params;
    const deltaV = v - vLead;
    const sStar = s0 + Math.max(0, v * T + (v * deltaV) / (2 * Math.sqrt(a * b)));
    const safeGap = Math.max(gap, 0.01);
    return a * (1 - Math.pow(v / v0, delta) - Math.pow(sStar / safeGap, 2));
  }

  function step(dt) {
    const L = circumference();
    cars.sort((c1, c2) => c1.s - c2.s);
    const n = cars.length;
    const accels = new Array(n);

    for (let i = 0; i < n; i++) {
      const me = cars[i];
      const lead = cars[(i + 1) % n];
      let gap = lead.s - me.s - params.carLength;
      if (gap < 0) gap += L;
      let acc = idmAccel(me.v, lead.v, gap);

      // Driver noise: GP (MA-IDM), AR(1), or white (B-IDM baseline).
      // Soft-saturate at ±5 m/s²: a human driver physically cannot impose larger
      // acceleration errors, and this keeps large-σ runs bounded without solely
      // relying on the hard overlap clamp below. tanh is smooth & symmetric.
      if (params.gpSigma > 0) {
        let eta;
        if (params.noiseMode === "white") eta = whiteNoise();
        else if (params.noiseMode === "ar") eta = arNoise(me, dt);
        else eta = gpNoise(me);
        const ETAMAX = 5.0;
        acc += Math.tanh(eta / ETAMAX) * ETAMAX;
      }

      if (me.perturbUntil > 0) {
        acc = Math.min(acc, -4.0);
        me.perturbUntil -= dt;
      }
      accels[i] = acc;
    }

    for (let i = 0; i < n; i++) {
      const c = cars[i];
      c.v = Math.max(0, c.v + accels[i] * dt);
      c.s = (c.s + c.v * dt) % L;
      if (c.s < 0) c.s += L;
    }

    // Hard clamp: physically prevent overlap. Even with noise or large dt,
    // bumper-to-bumper gap must stay >= s0. If a follower has caught up,
    // pull it back to lead.s - carLength - s0 and drop its speed to match.
    const minGap = params.s0;
    for (let i = 0; i < n; i++) {
      const me = cars[i];
      const lead = cars[(i + 1) % n];
      let gap = lead.s - me.s - params.carLength;
      if (gap < 0) gap += L;
      if (gap < minGap) {
        let target = lead.s - params.carLength - minGap;
        if (target < 0) target += L;
        me.s = target;
        if (me.v > lead.v) me.v = lead.v;
      }
    }
    simTime += dt;
  }

  // ---------- rendering ----------
  function draw() {
    const W = canvas._w || canvas.width, H = canvas._h || canvas.height;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    // scale: fit ring to canvas with margin
    const margin = 50;
    const scale = Math.min(W, H) / 2 - margin;
    // pixel radius corresponds to params.radius meters (center of lane)
    const rPix = scale;
    const laneHalfPix = Math.max(12, rPix * 0.08);

    // road
    ctx.save();
    ctx.strokeStyle = "#2b3644";
    ctx.lineWidth = laneHalfPix * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rPix, 0, Math.PI * 2);
    ctx.stroke();

    // edges
    ctx.strokeStyle = "#3b4a5c";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rPix + laneHalfPix, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, rPix - laneHalfPix, 0, Math.PI * 2);
    ctx.stroke();

    // dashed center line
    ctx.setLineDash([8, 10]);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rPix, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Quadrant ticks — faint, outside the lane edge; 0°=top labelled boldly.
    ctx.font = "11px -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tickLabels = [
      { deg: 0,   text: "0°",   bold: true  },
      { deg: 90,  text: "90°",  bold: false },
      { deg: 180, text: "180°", bold: false },
      { deg: 270, text: "270°", bold: false },
    ];
    for (const t of tickLabels) {
      const a = (t.deg / 180) * Math.PI - Math.PI / 2;
      const r0 = rPix - laneHalfPix;
      const r1 = rPix + laneHalfPix;
      const rL = rPix + laneHalfPix + 16;
      ctx.strokeStyle = t.bold ? "rgba(255,183,77,0.9)" : "rgba(230,237,243,0.3)";
      ctx.lineWidth = t.bold ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + r0 * Math.cos(a), cy + r0 * Math.sin(a));
      ctx.lineTo(cx + r1 * Math.cos(a), cy + r1 * Math.sin(a));
      ctx.stroke();
      ctx.fillStyle = t.bold ? "#ffb74d" : "rgba(230,237,243,0.5)";
      ctx.fillText(t.text, cx + rL * Math.cos(a), cy + rL * Math.sin(a));
    }

    // Direction-of-travel chevrons along the road (cars run clockwise: 0° → 90° → 180° → 270° → 0°).
    ctx.strokeStyle = "rgba(230,237,243,0.35)";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 - Math.PI / 2 + Math.PI / 8;
      const bx = cx + rPix * Math.cos(a), by = cy + rPix * Math.sin(a);
      const tx = -Math.sin(a), ty = Math.cos(a); // tangent, clockwise
      const nx = Math.cos(a),  ny = Math.sin(a); // outward normal
      const size = Math.min(7, laneHalfPix * 0.4);
      ctx.beginPath();
      ctx.moveTo(bx - tx * size + nx * size * 0.5, by - ty * size + ny * size * 0.5);
      ctx.lineTo(bx + tx * size, by + ty * size);
      ctx.lineTo(bx - tx * size - nx * size * 0.5, by - ty * size - ny * size * 0.5);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
    ctx.restore();

    // measuring region: highlight arc on the road
    {
      const L = circumference();
      const sCenter = (params.regionCenter / 360) * L;
      const halfLen = (params.regionSpan / 720) * L; // span/2 in meters
      const metersToRadLocal = (m) => (m / L) * Math.PI * 2;
      const a0 = metersToRadLocal(sCenter - halfLen) - Math.PI / 2;
      const a1 = metersToRadLocal(sCenter + halfLen) - Math.PI / 2;
      ctx.save();
      ctx.strokeStyle = "rgba(255, 183, 77, 0.55)";
      ctx.lineWidth = laneHalfPix * 2 + 6;
      ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.arc(cx, cy, rPix, a0, a1);
      ctx.stroke();
      // end markers
      ctx.strokeStyle = "#ffb74d";
      ctx.lineWidth = 2;
      for (const a of [a0, a1]) {
        const xIn = cx + (rPix - laneHalfPix - 4) * Math.cos(a);
        const yIn = cy + (rPix - laneHalfPix - 4) * Math.sin(a);
        const xOut = cx + (rPix + laneHalfPix + 4) * Math.cos(a);
        const yOut = cy + (rPix + laneHalfPix + 4) * Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(xIn, yIn);
        ctx.lineTo(xOut, yOut);
        ctx.stroke();
      }
      ctx.restore();
    }

    // cars
    const L = circumference();
    const metersToRad = (m) => (m / L) * Math.PI * 2;
    const carLenRad = metersToRad(params.carLength);
    const carWidthPix = laneHalfPix * 0.75;

    for (const c of cars) {
      const theta = metersToRad(c.s) - Math.PI / 2; // start at top
      const x = cx + rPix * Math.cos(theta);
      const y = cy + rPix * Math.sin(theta);

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(theta + Math.PI / 2);

      // Viridis colormap: dark (slow) → bright (fast). Color-blind-safe and
      // perceptually uniform; matches the `.speed-legend` gradient above the ring.
      const ratio = Math.max(0, Math.min(1, c.v / params.v0));
      ctx.fillStyle = viridisCss(ratio);

      const lenPix = Math.max(6, rPix * carLenRad);
      const x0 = -carWidthPix / 2, y0 = -lenPix / 2;
      // Rounded-rect body (roundRect is supported on all evergreen browsers).
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x0, y0, carWidthPix, lenPix, Math.min(3, carWidthPix / 2));
      else ctx.rect(x0, y0, carWidthPix, lenPix);
      ctx.fill();

      // Leading-edge indicator (lighter stripe at the front of the car, so direction
      // of travel is visible even for stopped cars).
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(x0, y0, carWidthPix, Math.max(1, lenPix * 0.18));

      // Perturbed highlight: bright yellow outline + glow pulse while braking.
      if (c.perturbUntil > 0) {
        const pulse = 0.5 + 0.5 * Math.sin(simTime * 10);
        ctx.shadowColor = "rgba(255,235,59,0.9)";
        ctx.shadowBlur = 6 + 6 * pulse;
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x0, y0, carWidthPix, lenPix, Math.min(3, carWidthPix / 2));
        else ctx.rect(x0, y0, carWidthPix, lenPix);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      ctx.restore();
    }

    // center label
    ctx.fillStyle = "rgba(230,237,243,0.55)";
    ctx.font = "14px -apple-system, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`radius ${params.radius} m`, cx, cy - 8);
    ctx.fillText(`${cars.length} cars`, cx, cy + 12);
  }

  // ---------- stats ----------
  const statAvg = document.getElementById("statAvg");
  const statMin = document.getElementById("statMin");
  const statDens = document.getElementById("statDens");
  const statFlow = document.getElementById("statFlow");

  // Is a car (at arclength s) inside the measuring region?
  function inRegion(s, L) {
    const sCenter = (params.regionCenter / 360) * L;
    const halfLen = (params.regionSpan / 720) * L;
    let d = ((s - sCenter) % L + L) % L;
    if (d > L / 2) d -= L;
    return Math.abs(d) <= halfLen;
  }

  function updateStats() {
    if (!cars.length) return;
    const L = circumference();
    const sCenter = (params.regionCenter / 360) * L;
    const halfLen = (params.regionSpan / 720) * L;
    const regionLen = 2 * halfLen; // meters; may equal L when span = 360

    // Collect cars in region and ring-wide stats (min/avg displayed for context)
    let sumAll = 0, mnAll = Infinity;
    let nReg = 0, sumVReg = 0, mnVReg = Infinity;
    for (const c of cars) {
      sumAll += c.v;
      if (c.v < mnAll) mnAll = c.v;
      if (inRegion(c.s, L)) {
        nReg++;
        sumVReg += c.v;
        if (c.v < mnVReg) mnVReg = c.v;
      }
    }
    const avgAll = sumAll / cars.length;
    const avgReg = nReg > 0 ? sumVReg / nReg : 0;
    const densPerKm = regionLen > 0 ? (nReg / regionLen) * 1000 : 0;
    const flowPerHr = densPerKm * avgReg * 3.6;

    statAvg.textContent = avgAll.toFixed(1);
    statMin.textContent = (mnAll === Infinity ? 0 : mnAll).toFixed(1);
    statDens.textContent = densPerKm.toFixed(1);
    statFlow.textContent = Math.round(flowPerHr);

    // Live a11y label for the canvas (low-frequency update — matches stats cadence).
    canvas.setAttribute(
      "aria-label",
      `Ring road; ${cars.length} cars; average speed ${avgAll.toFixed(1)} m/s; ` +
      `density ${densPerKm.toFixed(1)} cars per km; flow ${Math.round(flowPerHr)} cars per hour.`
    );

    // Region-scoped time series
    chartData.speed.push(avgReg);
    chartData.flow.push(flowPerHr);
    chartData.density.push(densPerKm);

    // Fundamental diagram: split the measuring region into sub-bins so we
    // get a scatter (otherwise a single region gives one point per update).
    const NBINS = 4;
    const binLen = regionLen / NBINS;
    if (binLen > 0) {
      const counts = new Array(NBINS).fill(0);
      const sums = new Array(NBINS).fill(0);
      for (const c of cars) {
        if (!inRegion(c.s, L)) continue;
        // position within region: 0 at left (sCenter - halfLen) -> regionLen
        let offset = ((c.s - (sCenter - halfLen)) % L + L) % L;
        if (offset > regionLen) offset = regionLen; // safety
        let b = Math.floor(offset / binLen);
        if (b >= NBINS) b = NBINS - 1;
        counts[b]++;
        sums[b] += c.v;
      }
      for (let b = 0; b < NBINS; b++) {
        if (counts[b] === 0) continue;
        const kLocal = (counts[b] / binLen) * 1000;
        const vLocal = sums[b] / counts[b];
        const qLocal = kLocal * vLocal * 3.6;
        chartData.fd.push({ k: kLocal, q: qLocal });
      }
    }
    trimBuffers();
  }

  // ---------- charts ----------
  const MAX_POINTS = 600; // ~ last 20s at 30fps updates, but we throttle below
  const chartData = {
    speed: [],
    flow: [],
    density: [],
    fd: [],
  };
  function trimBuffers() {
    for (const k of ["speed", "flow", "density"]) {
      const arr = chartData[k];
      if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
    }
    // FD scatter: cap at 2000 so the per-frame polyline stays cheap on long runs.
    const fd = chartData.fd;
    if (fd.length > 2000) fd.splice(0, fd.length - 2000);
  }

  const cSpeed = document.getElementById("chartSpeed");
  const cFlow = document.getElementById("chartFlow");
  const cDens = document.getElementById("chartDensity");
  const cFD = document.getElementById("chartFD");
  const cST = document.getElementById("chartST");
  const xSpeed = cSpeed.getContext("2d");
  const xFlow = cFlow.getContext("2d");
  const xDens = cDens.getContext("2d");
  const xFD = cFD.getContext("2d");
  const xST = cST.getContext("2d");

  function drawAxes(cx, w, h, yMax, yLabel, color) {
    cx.fillStyle = "#0e1620";
    cx.fillRect(0, 0, w, h);
    // grid
    cx.strokeStyle = "rgba(255,255,255,0.07)";
    cx.lineWidth = 1;
    cx.beginPath();
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      cx.moveTo(30, y); cx.lineTo(w - 6, y);
    }
    cx.stroke();
    // y-axis labels
    cx.fillStyle = "rgba(230,237,243,0.55)";
    cx.font = "10px -apple-system, Segoe UI, sans-serif";
    cx.textAlign = "right";
    cx.textBaseline = "middle";
    for (let i = 0; i <= 4; i++) {
      const y = (h * i) / 4;
      const v = yMax * (1 - i / 4);
      cx.fillText(formatTick(v), 26, y === 0 ? 8 : y === h ? h - 8 : y);
    }
    // axis line
    cx.strokeStyle = "rgba(255,255,255,0.15)";
    cx.beginPath();
    cx.moveTo(30, 0); cx.lineTo(30, h);
    cx.moveTo(30, h - 0.5); cx.lineTo(w, h - 0.5);
    cx.stroke();
  }

  function formatTick(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    if (v >= 100) return v.toFixed(0);
    if (v >= 10) return v.toFixed(0);
    return v.toFixed(1);
  }

  function drawLineChart(canvas, cx, data, color, yMaxHint, opts) {
    const w = canvas._w || canvas.width, h = canvas._h || canvas.height;
    const yMax = Math.max(yMaxHint, ...(data.length ? data : [1])) * 1.1 || 1;
    drawAxes(cx, w, h, yMax);

    if (data.length < 2) return;
    const x0 = 30, plotW = w - x0 - 6;
    cx.strokeStyle = color;
    cx.lineWidth = 1.5;
    cx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = x0 + (i / (MAX_POINTS - 1)) * plotW;
      const y = h - (data[i] / yMax) * h;
      if (i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();

    // fill under curve
    cx.lineTo(x0 + ((data.length - 1) / (MAX_POINTS - 1)) * plotW, h);
    cx.lineTo(x0, h);
    cx.closePath();
    const grad = cx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "55");
    grad.addColorStop(1, color + "00");
    cx.fillStyle = grad;
    cx.fill();

    // Time-axis labels at the left and right edges of the trace so the viewer
    // knows the time span of the visible buffer (~ 60 s at 10 Hz update).
    // opts.windowSec lets callers override the label; default MAX_POINTS / 10Hz.
    const windowSec = (opts && opts.windowSec) || Math.round(MAX_POINTS / 10);
    cx.fillStyle = "rgba(230,237,243,0.45)";
    cx.font = "10px -apple-system, Segoe UI, sans-serif";
    cx.textBaseline = "bottom";
    cx.textAlign = "left";
    cx.fillText(`t \u2212 ${windowSec} s`, x0 + 2, h - 2);
    cx.textAlign = "right";
    cx.fillText("now", w - 4, h - 2);

    // Current-value readout pinned to the top-right of the plot.
    const latest = data[data.length - 1];
    if (Number.isFinite(latest)) {
      cx.fillStyle = color;
      cx.textAlign = "right";
      cx.textBaseline = "top";
      cx.font = "bold 12px -apple-system, Segoe UI, sans-serif";
      const txt = latest >= 100 ? Math.round(latest).toString() : latest.toFixed(1);
      cx.fillText(txt, w - 4, 2);
    }
  }

  // Auto-scale FD axes to fit ALL points currently in the buffer, with a
  // small headroom and rounded to a "nice" tick. Grows instantly so outliers
  // remain visible; shrinks gently so the axis doesn't jitter.
  const fdAxes = { maxK: 40, maxQ: 600 };
  function niceCeil(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    let niced;
    if (m <= 1) niced = 1;
    else if (m <= 2) niced = 2;
    else if (m <= 2.5) niced = 2.5;
    else if (m <= 5) niced = 5;
    else niced = 10;
    return niced * p;
  }
  // Cached IDM equilibrium curve for the FD overlay. We recompute only when
  // an IDM parameter changes — not per frame. Capped at ρ_j (physical jam
  // density), NOT extended to maxK with a fake zero-flow tail.
  let fdEq = { key: "", pts: [] };
  function computeEquilibriumCurve() {
    const { v0, T, a, s0, delta, carLength } = params;
    const key = `${v0}|${T}|${a}|${s0}|${delta}|${carLength}`;
    if (fdEq.key === key) return fdEq.pts;
    if (!(v0 > 0 && T > 0 && a > 0 && s0 >= 0 && delta > 0 && carLength > 0)) {
      fdEq = { key, pts: [] };
      return fdEq.pts;
    }
    // ρ_j: jam density (cars/km). Cannot pack closer than carLength + s0.
    const rhoJamPerM = 1 / (carLength + s0);
    const rhoJamPerKm = rhoJamPerM * 1000;
    const N = 80;
    const pts = [{ k: 0, q: 0 }]; // explicit origin
    for (let i = 1; i <= N; i++) {
      const rhoPerKm = (i / N) * rhoJamPerKm;
      const rhoPerM = rhoPerKm / 1000;
      const s = 1 / rhoPerM - carLength; // available spacing (m)
      if (s <= s0) {
        pts.push({ k: rhoPerKm, q: 0 });
        continue;
      }
      // f(v) = 1 - (v/v0)^δ - ((s0 + v*T)/s)^2; strictly decreasing on [0, v0].
      let lo = 0, hi = v0;
      for (let b = 0; b < 40; b++) {
        const m = 0.5 * (lo + hi);
        const f = 1 - Math.pow(m / v0, delta) - Math.pow((s0 + m * T) / s, 2);
        if (f > 0) lo = m; else hi = m;
      }
      const ve = 0.5 * (lo + hi);
      pts.push({ k: rhoPerKm, q: rhoPerKm * ve * 3.6 });
    }
    fdEq = { key, pts };
    return fdEq.pts;
  }

  function updateFDAxes() {
    const pts = chartData.fd;
    let mk = 0, mq = 0;
    for (const p of pts) { if (p.k > mk) mk = p.k; if (p.q > mq) mq = p.q; }
    // Include equilibrium curve extent so the reference curve is always visible.
    for (const p of computeEquilibriumCurve()) {
      if (p.k > mk) mk = p.k;
      if (p.q > mq) mq = p.q;
    }
    const targetK = Math.max(40, niceCeil(mk * 1.1));
    const targetQ = Math.max(600, niceCeil(mq * 1.1));
    // Grow instantly to show new extremes; shrink gently to avoid flicker.
    fdAxes.maxK = targetK > fdAxes.maxK ? targetK : fdAxes.maxK + 0.05 * (targetK - fdAxes.maxK);
    fdAxes.maxQ = targetQ > fdAxes.maxQ ? targetQ : fdAxes.maxQ + 0.05 * (targetQ - fdAxes.maxQ);
  }

  function drawFD() {
    const w = cFD._w || cFD.width, h = cFD._h || cFD.height;
    updateFDAxes();
    const maxK = fdAxes.maxK;
    const maxQ = fdAxes.maxQ;
    drawAxes(xFD, w, h, maxQ);

    const x0 = 30, plotW = w - x0 - 6;
    const kToX = (k) => x0 + (k / maxK) * plotW;
    const qToY = (q) => h - (q / maxQ) * h;

    // Equilibrium IDM curve: dashed reference overlay, drawn first so scatter
    // sits on top of it.
    const eq = computeEquilibriumCurve();
    if (eq.length >= 2) {
      xFD.save();
      xFD.setLineDash([5, 4]);
      xFD.strokeStyle = "rgba(230,237,243,0.55)";
      xFD.lineWidth = 1.4;
      xFD.beginPath();
      for (let i = 0; i < eq.length; i++) {
        const p = eq[i];
        const x = kToX(p.k), y = qToY(p.q);
        if (i === 0) xFD.moveTo(x, y); else xFD.lineTo(x, y);
      }
      xFD.stroke();
      xFD.restore();
      // Label at the peak
      let peakIdx = 0;
      for (let i = 1; i < eq.length; i++) if (eq[i].q > eq[peakIdx].q) peakIdx = i;
      const peak = eq[peakIdx];
      xFD.fillStyle = "rgba(230,237,243,0.55)";
      xFD.font = "10px -apple-system, Segoe UI, sans-serif";
      xFD.textAlign = "left";
      xFD.textBaseline = "bottom";
      xFD.fillText("IDM equilibrium q(ρ)", kToX(peak.k) + 6, Math.max(12, qToY(peak.q) - 4));
    }

    // Hysteresis polyline: connect the (decimated) trajectory so the (ρ, q)
    // loop during jam formation/dissipation is visible. Faint for the long
    // tail, bolder for the last ~40 points so recent motion is easy to follow.
    const pts = chartData.fd;
    const n = pts.length;
    const TAIL = 40;
    // Decimate older points when the buffer grows to keep the polyline cheap.
    const stride = n > 600 ? Math.ceil(n / 600) : 1;
    if (n > 2) {
      xFD.strokeStyle = "rgba(79,195,247,0.18)";
      xFD.lineWidth = 1;
      xFD.beginPath();
      let started = false;
      for (let i = 0; i < Math.max(0, n - TAIL); i += stride) {
        const p = pts[i];
        const x = kToX(p.k), y = qToY(p.q);
        if (!started) { xFD.moveTo(x, y); started = true; }
        else xFD.lineTo(x, y);
      }
      if (n > TAIL) {
        const p = pts[n - TAIL - 1];
        xFD.lineTo(kToX(p.k), qToY(p.q));
      }
      xFD.stroke();
      // Bold recent trace
      xFD.strokeStyle = "rgba(79,195,247,0.6)";
      xFD.lineWidth = 1.5;
      xFD.beginPath();
      const startRecent = Math.max(0, n - TAIL);
      for (let i = startRecent; i < n; i++) {
        const p = pts[i];
        const x = kToX(p.k), y = qToY(p.q);
        if (i === startRecent) xFD.moveTo(x, y); else xFD.lineTo(x, y);
      }
      xFD.stroke();
    }

    // Scatter — older points fade (alpha = 0.15 → 0.85 over the buffer).
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const t = n > 1 ? i / (n - 1) : 1;
      const alpha = 0.15 + 0.6 * t;
      xFD.fillStyle = `rgba(79,195,247,${alpha.toFixed(3)})`;
      xFD.beginPath();
      xFD.arc(kToX(p.k), qToY(p.q), 2.2, 0, Math.PI * 2);
      xFD.fill();
    }
    // highlight latest
    if (n > 0) {
      const p = pts[n - 1];
      xFD.strokeStyle = "#ffb74d";
      xFD.lineWidth = 2;
      xFD.beginPath();
      xFD.arc(kToX(p.k), qToY(p.q), 4.5, 0, Math.PI * 2);
      xFD.stroke();
    }
    // x-axis labels
    xFD.fillStyle = "rgba(230,237,243,0.55)";
    xFD.font = "10px -apple-system, Segoe UI, sans-serif";
    xFD.textAlign = "center";
    xFD.textBaseline = "bottom";
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const x = x0 + frac * plotW;
      xFD.fillText(formatTick(maxK * frac), x, h - 2);
    }
    xFD.textAlign = "left";
    xFD.fillText("density →", x0 + 4, 12);
    xFD.save();
    xFD.translate(10, h / 2);
    xFD.rotate(-Math.PI / 2);
    xFD.textAlign = "center";
    xFD.fillText("flow", 0, 0);
    xFD.restore();
  }

  // Time–space diagram: x = time (older → newer), y = position on the ring
  const stBuf = document.createElement("canvas");
  stBuf.width = 600;   // columns = time samples (newest at right)
  stBuf.height = 240;  // rows = position bins
  const xSTBuf = stBuf.getContext("2d", { willReadFrequently: true });
  xSTBuf.fillStyle = "#0e1620";
  xSTBuf.fillRect(0, 0, stBuf.width, stBuf.height);

  function pushSTRow() {
    if (!cars.length) return;
    const L = circumference();
    const rows = stBuf.height;
    const binSum = new Float32Array(rows);
    const binCnt = new Uint16Array(rows);
    for (const c of cars) {
      const idx = Math.min(rows - 1, Math.floor((c.s / L) * rows));
      binSum[idx] += c.v;
      binCnt[idx]++;
    }
    // scroll left by 1 column
    const img = xSTBuf.getImageData(1, 0, stBuf.width - 1, stBuf.height);
    xSTBuf.putImageData(img, 0, 0);
    // build the new rightmost column; fill empty bins from the column to the left
    const x = stBuf.width - 1;
    const leftCol = xSTBuf.getImageData(x - 1, 0, 1, rows).data;
    const colImg = xSTBuf.createImageData(1, rows);
    for (let i = 0; i < rows; i++) {
      if (binCnt[i] === 0) {
        colImg.data[i * 4]     = leftCol[i * 4];
        colImg.data[i * 4 + 1] = leftCol[i * 4 + 1];
        colImg.data[i * 4 + 2] = leftCol[i * 4 + 2];
        colImg.data[i * 4 + 3] = 255;
        continue;
      }
      const v = binSum[i] / binCnt[i];
      const ratio = Math.max(0, Math.min(1, v / params.v0));
      const [r, g, b] = viridis(ratio);
      colImg.data[i * 4]     = r;
      colImg.data[i * 4 + 1] = g;
      colImg.data[i * 4 + 2] = b;
      colImg.data[i * 4 + 3] = 255;
    }
    xSTBuf.putImageData(colImg, x, 0);
  }

  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function drawST() {
    const W = cST._w || cST.width, H = cST._h || cST.height;
    xST.fillStyle = "#0e1620";
    xST.fillRect(0, 0, W, H);
    xST.imageSmoothingEnabled = false;
    // Layout: 30 px left gutter for y-axis labels, 16 px bottom gutter for x-axis label.
    const plotX = 30, plotY = 0;
    const plotW = W - plotX, plotH = H - 16;
    xST.drawImage(stBuf, plotX, plotY, plotW, plotH);

    // Measuring-region band overlay — connects the orange arc on the ring to
    // a horizontal band on the ST diagram. Position 0 is the top of the ring
    // (y = top of the plot); position increases clockwise downward.
    const centerFrac = ((params.regionCenter % 360) + 360) % 360 / 360;
    const halfFrac = (params.regionSpan / 2) / 360;
    xST.fillStyle = "rgba(255,183,77,0.14)";
    // Band may wrap across the top/bottom of the plot (ring is periodic).
    const y1 = plotY + (centerFrac - halfFrac) * plotH;
    const y2 = plotY + (centerFrac + halfFrac) * plotH;
    // Draw one or two rectangles to handle wrap.
    const draw = (yA, yB) => {
      const a = Math.max(plotY, Math.min(plotY + plotH, yA));
      const b = Math.max(plotY, Math.min(plotY + plotH, yB));
      if (b > a) xST.fillRect(plotX, a, plotW, b - a);
    };
    if (y1 < plotY)          { draw(y1 + plotH, plotY + plotH); draw(plotY, y2); }
    else if (y2 > plotY + plotH) { draw(y1, plotY + plotH); draw(plotY, y2 - plotH); }
    else                     { draw(y1, y2); }

    // Y-axis orientation ticks: 0° at top, 180° middle, 360° bottom.
    xST.fillStyle = "rgba(230,237,243,0.55)";
    xST.font = "10px -apple-system, Segoe UI, sans-serif";
    xST.textAlign = "right";
    xST.textBaseline = "top";
    xST.fillText("0°", plotX - 4, 2);
    xST.textBaseline = "middle";
    xST.fillText("180°", plotX - 4, plotY + plotH / 2);
    xST.textBaseline = "bottom";
    xST.fillText("360°", plotX - 4, plotY + plotH - 2);

    // Bottom x-axis label
    xST.fillStyle = "rgba(230,237,243,0.55)";
    xST.textAlign = "center";
    xST.textBaseline = "bottom";
    xST.fillText("time (old → now)", plotX + plotW / 2, H - 3);
    // Rotated y-axis label
    xST.save();
    xST.translate(10, H / 2);
    xST.rotate(-Math.PI / 2);
    xST.textAlign = "center";
    xST.textBaseline = "middle";
    xST.fillText("position on ring", 0, 0);
    xST.restore();
  }

  function drawCharts() {
    drawLineChart(cSpeed, xSpeed, chartData.speed, "#4fc3f7", params.v0);
    drawLineChart(cFlow, xFlow, chartData.flow, "#81c784", 800);
    drawLineChart(cDens, xDens, chartData.density, "#ffb74d", 80);
    drawFD();
    drawST();
  }

  // ---------- loop ----------
  let chartAccum = 0;
  let stAccum = 0;
  let physAccum = 0;   // accumulates sim-time until the next integration step
  function tick(now) {
    const rawDt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (!paused) {
      const simDt = rawDt * params.speedMul;
      physAccum += simDt;
      // Advance the physics in discrete user-sized Δt steps.
      // Cap total work per frame so a sudden big Δt increase cannot freeze the tab.
      let work = 0;
      while (physAccum >= params.dtStep && work < 200) {
        step(params.dtStep);
        physAccum -= params.dtStep;
        work++;
      }
      chartAccum += simDt;
      stAccum += simDt;
    }
    draw();
    updateStats();

    if (stAccum >= 0.25) {
      pushSTRow();
      stAccum = 0;
    }
    if (now - lastChartDraw > 100) {
      drawCharts();
      lastChartDraw = now;
    }
    requestAnimationFrame(tick);
  }
  let lastChartDraw = 0;

  function resetCharts() {
    chartData.speed.length = 0;
    chartData.flow.length = 0;
    chartData.density.length = 0;
    chartData.fd.length = 0;
    xSTBuf.fillStyle = "#0e1620";
    xSTBuf.fillRect(0, 0, stBuf.width, stBuf.height);
  }

  // ---------- UI wiring ----------
  function bindRange(id, key, fmt = (v) => v) {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + "Val");
    // Apply loaded value (URL hash / localStorage) to the input before first read.
    if (params[key] !== undefined) el.value = String(params[key]);
    const update = (isUser) => {
      const v = parseFloat(el.value);
      params[key] = v;
      const label = fmt(v);
      if (valEl) valEl.textContent = label;
      el.setAttribute("aria-valuetext", String(label));
      if (isUser) scheduleWriteState();
    };
    el.addEventListener("input", () => update(true));
    update(false);
  }

  bindRange("numCars", "numCars", (v) => String(v | 0));
  bindRange("v0", "v0");
  bindRange("T", "T", (v) => v.toFixed(1));
  bindRange("s0", "s0", (v) => v.toFixed(1));
  bindRange("a", "a", (v) => v.toFixed(1));
  bindRange("b", "b", (v) => v.toFixed(1));
  bindRange("radius", "radius");
  bindRange("speedMul", "speedMul", (v) => v.toFixed(2) + "×");
  bindRange("dtStep", "dtStep", (v) => v.toFixed(2));
  bindRange("regionCenter", "regionCenter", (v) => String(v | 0) + "°");
  bindRange("regionSpan", "regionSpan", (v) => String(v | 0) + "°");
  bindRange("gpSigma", "gpSigma", (v) => v.toFixed(2));
  bindRange("gpEll", "gpEll", (v) => v.toFixed(1));

  // AR order dropdown (not a range slider)
  const arOrderEl = document.getElementById("arOrder");
  const arOrderVal = document.getElementById("arOrderVal");
  if (params.arOrder) arOrderEl.value = String(params.arOrder);
  function applyArOrder() {
    params.arOrder = parseInt(arOrderEl.value, 10);
    arOrderVal.textContent = params.arOrder;
    for (const c of cars) { c.arHist = []; c.arAccum = 0; }
    scheduleWriteState();
  }
  arOrderEl.addEventListener("change", applyArOrder);
  applyArOrder();

  // Changing lengthscale or kernel requires resampling frequencies
  document.getElementById("gpEll").addEventListener("change", resampleAllGP);
  const gpKernelEl = document.getElementById("gpKernel");
  if (params.gpKernel) gpKernelEl.value = params.gpKernel;
  gpKernelEl.addEventListener("change", () => {
    params.gpKernel = gpKernelEl.value;
    resampleAllGP();
    scheduleWriteState();
  });

  // Noise model toggle — show only the controls relevant to the chosen model,
  // and swap the inline citation so the user knows which paper each noise comes from.
  const noiseModeEl = document.getElementById("noiseMode");
  const ellRow = document.getElementById("ellRow");
  const kernelRow = document.getElementById("kernelRow");
  const arRow = document.getElementById("arRow");
  const modeCite = document.getElementById("modeCite");
  const CITE = {
    gp: 'Gaussian-process driver noise with a stationary kernel, from '
      + '<a href="https://arxiv.org/abs/2210.03571" target="_blank" rel="noopener">Zhang &amp; Sun (2024) — MA-IDM</a>. '
      + 'Realized here via M = 32 random Fourier features per car.',
    ar: 'AR(p) noise with posterior-mean coefficients ρ from Table 1 of '
      + '<a href="https://arxiv.org/abs/2307.03340" target="_blank" rel="noopener">Zhang, Wang &amp; Sun (2024) — dynamic-regression IDM</a>, '
      + 'calibrated on HighD at 5 fps. σ here is the innovation std σ<sub>η</sub>.',
    white: 'I.i.d. Gaussian driver noise — the Bayesian IDM (B-IDM) baseline '
      + 'used for comparison in both Zhang &amp; Sun (2024) and Zhang, Wang &amp; Sun (2024).',
  };
  if (params.noiseMode) noiseModeEl.value = params.noiseMode;
  function applyNoiseMode() {
    params.noiseMode = noiseModeEl.value;
    const isGP = params.noiseMode === "gp";
    ellRow.style.display    = isGP ? "" : "none";
    kernelRow.style.display = isGP ? "" : "none";
    arRow.style.display     = params.noiseMode === "ar" ? "" : "none";
    if (modeCite) modeCite.innerHTML = CITE[params.noiseMode] || "";
    scheduleWriteState();
  }
  noiseModeEl.addEventListener("change", applyNoiseMode);
  applyNoiseMode();

  // Click / drag on the ring canvas to place the measuring-region center.
  // Angle convention: 0° = top, clockwise (matches drawing and params.regionCenter).
  const regionCenterEl = document.getElementById("regionCenter");
  function setRegionFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    if (x * x + y * y < 100) return; // ignore tiny clicks near center
    // atan2 with flipped y; add 90° so 0° = top, then wrap to [0, 360)
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    deg = ((deg % 360) + 360) % 360;
    regionCenterEl.value = Math.round(deg);
    regionCenterEl.dispatchEvent(new Event("input", { bubbles: true }));
  }
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    setRegionFromEvent(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) setRegionFromEvent(e); });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  // numCars & radius need reinit
  document.getElementById("numCars").addEventListener("change", initCars);
  document.getElementById("radius").addEventListener("change", initCars);

  document.getElementById("perturb").addEventListener("click", () => {
    if (!cars.length) return;
    const idx = Math.floor(rand() * cars.length);
    cars[idx].perturbUntil = 2.0; // seconds of hard braking
  });

  document.getElementById("reset").addEventListener("click", () => { initCars(); resetCharts(); });

  const pauseBtn = document.getElementById("pause");
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });

  // Respect users who ask for reduced motion (WCAG 2.3.3). Start paused so the
  // ring animation doesn't trigger vestibular discomfort; they can opt in.
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paused = true;
      pauseBtn.textContent = "Play";
    }
  } catch (_) { /* non-supporting browser */ }

  // "Copy link" button — serialises current params to the URL and copies it.
  const copyLinkBtn = document.getElementById("copyLink");
  if (copyLinkBtn) {
    copyLinkBtn.addEventListener("click", async () => {
      // Force-flush pending URL sync before reading location.href.
      clearTimeout(_writeStateT);
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) q.set(k, String(v));
      history.replaceState(null, "", "#" + q.toString());
      const url = location.href;
      try { await navigator.clipboard.writeText(url); }
      catch (_) { /* fallback */
        const ta = document.createElement("textarea");
        ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (__) {}
        document.body.removeChild(ta);
      }
      const orig = copyLinkBtn.textContent;
      copyLinkBtn.textContent = "Copied ✓";
      setTimeout(() => { copyLinkBtn.textContent = orig; }, 1600);
    });
  }

  // Keyboard shortcuts — useful for seminar / presentation demos.
  document.addEventListener("keydown", (e) => {
    // Ignore if the user is typing in a control.
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === " " || e.code === "Space") { e.preventDefault(); pauseBtn.click(); }
    else if (e.key === "p" || e.key === "P") { document.getElementById("perturb").click(); }
    else if (e.key === "r" || e.key === "R") { document.getElementById("reset").click(); }
  });

  function setCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(200, Math.floor(Math.min(rect.width, rect.height)));
    fitCanvas(canvas, size, size);
    // Resize chart canvases to match their rendered CSS size (charts are width:100%).
    for (const c of [cSpeed, cFlow, cDens, cFD, cST]) {
      const r = c.getBoundingClientRect();
      const w = Math.max(50, Math.floor(r.width));
      // Preserve the aspect ratio from the HTML width/height attributes.
      const origW = Number(c.getAttribute("width")) || c.width;
      const origH = Number(c.getAttribute("height")) || c.height;
      const h = Math.max(50, Math.floor(w * (origH / origW)));
      fitCanvas(c, w, h);
    }
  }
  window.addEventListener("resize", setCanvasSize);
  // Re-fit on DPR changes (user dragging window between monitors).
  if (window.matchMedia) {
    try {
      const mq = window.matchMedia(`(resolution: ${DPR}dppx)`);
      if (mq && mq.addEventListener) mq.addEventListener("change", setCanvasSize);
    } catch (_) { /* older browsers */ }
  }
  setCanvasSize();

  initCars();
  requestAnimationFrame((t) => { lastTime = t; tick(t); });
})();
