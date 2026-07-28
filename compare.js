(() => {
  "use strict";

  // ---------- Seeded PRNG (mulberry32) ----------
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

  // ---------- HiDPI canvas helper ----------
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

  // ---------- Jet colormap (red = jam, blue = free-flow) ----------
  const JET = [[127,0,0],[255,0,0],[255,255,0],[0,255,255],[0,0,255],[0,0,143]];
  function jetCss(t) {
    t = Math.max(0, Math.min(0.999, t || 0));
    const idx = t * (JET.length - 1);
    const i = Math.floor(idx);
    const f = idx - i;
    const a = JET[i], b = JET[i + 1] || a;
    const r = Math.round(a[0] + (b[0] - a[0]) * f);
    const g = Math.round(a[1] + (b[1] - a[1]) * f);
    const bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return `rgb(${r},${g},${bl})`;
  }

  // ================================================================
  // Shared parameters + three sim instances running in lockstep.
  // ================================================================
  // Bump when a stored parameter's default or meaning changes, so that a
  // returning visitor's localStorage does not pin them to a stale value.
  // v2: GP lengthscale default 1.6 -> 1.44 s (the value the page cites).
  const PARAM_VERSION = 2;

  const params = {
    numCars: 30,
    radius: 120,
    v0: 33, T: 1.5, a: 1.2, b: 1.5, s0: 2.0, delta: 4,
    carLength: 4.5,
    dtStep: 0.05,
    speedMul: 5.0,
    // Dimensionless multiplier applied to each model's paper-calibrated sigma.
    // noiseScale = 1.0 runs each model at the posterior-mean sigma of Table 1 in
    // arXiv:2307.03340 (AR & white) and arXiv:2210.03571 (GP). It does NOT
    // reproduce the papers' ring experiments, which use R = 128 m, an initial
    // speed of 11.6 m/s, 32-37 vehicles, dt = 0.2 s and heterogeneous per-driver
    // parameters drawn from the joint posterior.
    noiseScale: 1.0,
    ell: 1.44,
    kernel: "rbf",
    arOrder: 5,
    seed: 0,
  };

  // ---------- Load params from URL hash + localStorage (URL > storage > defaults) ----------
  // Every field is validated against a typed schema before it is accepted.
  // Hash and localStorage are user-controlled: an out-of-range dtStep used to
  // make the stepping loop spin forever, and an unsupported arOrder threw on
  // the first frame.
  const PARAM_SCHEMA = {
    numCars:    { type: "int",  min: 10,   max: 60   },
    radius:     { type: "num",  min: 60,   max: 250  },
    v0:         { type: "num",  min: 1,    max: 60   },
    T:          { type: "num",  min: 0.1,  max: 5    },
    a:          { type: "num",  min: 0.1,  max: 5    },
    b:          { type: "num",  min: 0.1,  max: 10   },
    s0:         { type: "num",  min: 0,    max: 20   },
    delta:      { type: "num",  min: 1,    max: 10   },
    carLength:  { type: "num",  min: 1,    max: 20   },
    dtStep:     { type: "num",  min: 0.01, max: 0.5  },
    speedMul:   { type: "num",  min: 0.25, max: 10   },
    noiseScale: { type: "num",  min: 0,    max: 8    },
    ell:        { type: "num",  min: 0.1,  max: 5    },
    kernel:     { type: "enum", values: ["rbf", "matern52", "matern32", "matern12"] },
    arOrder:    { type: "enum", values: [1, 2, 3, 4, 5, 6, 7], numeric: true },
    seed:       { type: "int",  min: 0,    max: 2147483647 },
  };
  function coerceParam(k, v) {
    const spec = PARAM_SCHEMA[k];
    if (!spec) return undefined;
    if (spec.type === "enum") {
      const cand = spec.numeric ? Number(v) : String(v);
      return spec.values.includes(cand) ? cand : undefined;
    }
    let n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (spec.type === "int") n = Math.round(n);
    return Math.min(spec.max, Math.max(spec.min, n));
  }
  function applyStoredParams(src) {
    for (const [k, v] of src) {
      if (!(k in params)) continue;
      const c = coerceParam(k, v);
      if (c !== undefined) params[k] = c;
    }
  }
  try {
    const stored = JSON.parse(localStorage.getItem("traffic-sim-cmp-params") || "{}");
    // Bump PARAM_VERSION whenever a default changes meaning, so returning
    // visitors are not pinned to a stale value by their own localStorage.
    if (stored.__v === PARAM_VERSION) applyStoredParams(Object.entries(stored));
  } catch (_) { /* ignore */ }
  try {
    applyStoredParams(new URLSearchParams((location.hash || "").slice(1)).entries());
  } catch (_) { /* ignore */ }
  if (params.seed && params.seed > 0) rand = mulberry32(params.seed | 0);

  let _writeStateT = 0;
  function scheduleWriteState() {
    clearTimeout(_writeStateT);
    _writeStateT = setTimeout(() => {
      try {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) q.set(k, String(v));
        history.replaceState(null, "", "#" + q.toString());
        localStorage.setItem(
          "traffic-sim-cmp-params",
          JSON.stringify(Object.assign({ __v: PARAM_VERSION }, params))
        );
      } catch (_) { /* best-effort */ }
    }, 200);
  }

  // Posterior-mean sigmas from the calibration papers.
  //  - SIGMA_WHITE : B-IDM marginal std of η  (Zhang, Wang & Sun 2024, Table 1)
  //  - SIGMA_GP    : MA-IDM kernel output scale σ_k (Zhang & Sun 2024)
  //  - SIGMA_AR[p] : AR(p) innovation std σ_η (Zhang, Wang & Sun 2024, Table 1)
  // Note that SIGMA_AR values are innovation stds — the resulting process has a
  // larger *marginal* std that depends on ρ. Solving the Yule–Walker equations
  // gives a marginal std of ≈0.13–0.14 m/s² across p = 1…7, i.e. the same order
  // as SIGMA_GP (0.202) and SIGMA_WHITE (0.240) but not equal to them. The three
  // rings therefore compare "each model as calibrated", not equal variances.
  const SIGMA_WHITE = 0.240;
  const SIGMA_GP    = 0.202;
  const SIGMA_AR    = { 1: 0.019, 2: 0.019, 3: 0.017, 4: 0.016, 5: 0.016, 6: 0.015, 7: 0.014 };

  const MODES = [
    { id: "white", color: "#ff7675", canvasId: "ring-white" },
    { id: "ar",    color: "#74b9ff", canvasId: "ring-ar" },
    { id: "gp",    color: "#55efc4", canvasId: "ring-gp" },
  ];

  // AR coefficients — Table 1 of arXiv:2307.03340 (HighD, 5 fps).
  const AR_COEFFS = {
    1: [0.989],
    2: [1.234, -0.247],
    3: [1.123,  0.425, -0.572],
    4: [0.901,  0.590, -0.149, -0.377],
    5: [0.874,  0.580, -0.105, -0.315, -0.071],
    6: [0.902,  0.632, -0.100, -0.427, -0.217,  0.181],
    7: [0.866,  0.690, -0.001, -0.413, -0.378, -0.032,  0.248],
  };
  const FRAME_DT = 0.2;

  // Stationary standard deviation of the AR(p) process per unit innovation
  // standard deviation, from the Yule–Walker (discrete Lyapunov) solution for
  // the coefficient vectors above. Used to put the AR residual on the same
  // footing as the GP and white residuals when scaling the η panel.
  const AR_MARGINAL = {
    1: 6.7606, 2: 7.1656, 3: 8.5043, 4: 8.7932,
    5: 8.9104, 6: 9.4167, 7: 10.2738,
  };

  // Marginal (stationary) standard deviation of each residual process at the
  // current noise scale — the quantity that is actually comparable across modes.
  function marginalSigma(mode) {
    const s = params.noiseScale;
    if (mode === "white") return SIGMA_WHITE * s;
    if (mode === "gp") return SIGMA_GP * s;
    const p = params.arOrder;
    return (SIGMA_AR[p] || SIGMA_AR[1]) * (AR_MARGINAL[p] || AR_MARGINAL[1]) * s;
  }
  const GP_M = 32;

  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function studentT(df) {
    let w = 0;
    for (let i = 0; i < df; i++) { const z = randn(); w += z * z; }
    return randn() * Math.sqrt(df / w);
  }
  function sampleOmega(ell, kernel) {
    const inv = 1 / Math.max(0.01, ell);
    switch (kernel) {
      case "matern12": return studentT(1) * inv;
      case "matern32": return studentT(3) * inv;
      case "matern52": return studentT(5) * inv;
      default:         return randn() * inv;
    }
  }
  function sampleGPFeatures(ell, kernel) {
    const om = new Float32Array(GP_M), ph = new Float32Array(GP_M);
    for (let m = 0; m < GP_M; m++) {
      om[m] = sampleOmega(ell, kernel);
      ph[m] = rand() * 2 * Math.PI;
    }
    return { om, ph };
  }

  // ----------------------------------------------------------------
  // Sim instance
  // ----------------------------------------------------------------
  function circumference() { return 2 * Math.PI * params.radius; }
  function colorFor(i, n) { return `hsl(${Math.round((i / n) * 360)}, 70%, 60%)`; }

  function makeSim(mode) {
    return {
      mode,                 // "white" | "ar" | "gp"
      cars: [],
      simTime: 0,
      // tagged car's noise history (circular-ish, keep up to ETA_MAX)
      etaHist: [],
      // time series of average speed
      avgSpeedHist: [],
      // time-in-jam counters
      jamFrames: 0,
      totalFrames: 0,
      // FD scatter (region is the full ring here for simplicity; 4 sub-bins)
      fdData: [],
    };
  }

  const sims = MODES.map((m) => makeSim(m.id));
  let physAccum = 0;   // unconsumed simulation time, carried across frames

  // Clears the summary-metrics table. Called on user-initiated resets so a
  // paused page cannot keep displaying numbers from a previous run.
  function clearMetrics() {
    for (const r of METRIC_ROWS) {
      for (const m of ["white", "ar", "gp"]) {
        metricValues[r][m] = NaN;
        const cell = document.getElementById(`m-${r}-${m}`);
        if (cell) cell.textContent = "–";
      }
    }
  }

  function restartRun() {
    resetAll();
    clearMetrics();
    physAccum = 0;
  }

  function resetAll() {
    // Reject packings that cannot physically exist: N*(carLength + s0) <= L.
    // Without this the ring starts already overlapping and no amount of
    // collision handling can recover a valid single-lane state.
    const nMax = Math.min(PARAM_SCHEMA.numCars.max, maxFeasibleCars());
    if (params.numCars > nMax) {
      params.numCars = nMax;
      const el = document.getElementById("cmpN");
      const lbl = document.getElementById("cmpNVal");
      if (el) el.value = String(nMax);
      if (lbl) lbl.textContent = String(nMax);
    }
    const L = circumference();
    const n = params.numCars;
    const spacing = L / n;
    // Start on the IDM equilibrium branch for this density so the run is not
    // dominated by a relaxation transient from an arbitrary initial speed.
    const v0Init = equilibriumSpeed(spacing - params.carLength);
    // Identical initial placements across all three sims.
    const taggedIdx = 0;
    for (const sim of sims) {
      sim.cars = [];
      sim.simTime = 0;
      sim.etaHist.length = 0;
      sim.etaAccum = 0;
      sim.avgSpeedHist.length = 0;
      sim.jamFrames = 0;
      sim.totalFrames = 0;
      sim.fdData = [];
      for (let i = 0; i < n; i++) {
        sim.cars.push({
          s: i * spacing,
          v: v0Init,
          color: colorFor(i, n),
          perturbUntil: 0,
          gp: sampleGPFeatures(params.ell, params.kernel),
          // arNoise() builds the stationary state lazily, so only the AR ring
          // pays the burn-in and only on its first step.
          arHist: [],
          arAccum: 0,
          whiteVal: (SIGMA_WHITE * params.noiseScale) * randn(),
          whiteAccum: 0,
          tagged: i === taggedIdx,
          lastEta: 0,
        });
      }
    }
    fdAxes.maxK = 40; fdAxes.maxQ = 600;
  }

  function resampleAllGP() {
    for (const sim of sims) {
      for (const c of sim.cars) c.gp = sampleGPFeatures(params.ell, params.kernel);
    }
  }

  // ----------------------------------------------------------------
  // Noise models
  // ----------------------------------------------------------------
  function gpNoise(car, simTime) {
    let s = 0;
    const om = car.gp.om, ph = car.gp.ph;
    for (let m = 0; m < GP_M; m++) s += Math.cos(om[m] * simTime + ph[m]);
    const sigma = SIGMA_GP * params.noiseScale;
    return sigma * Math.sqrt(2 / GP_M) * s;
  }
  // White (B-IDM) noise. The paper's σ_ε is the standard deviation of a
  // residual defined on a 0.2 s (5 fps) grid, so the sample is *held* over that
  // interval instead of being redrawn every integration step. Redrawing every
  // Δt would make the physical noise power scale with Δt, which would make the
  // three noise models incomparable whenever the step size changes.
  function whiteNoise(car, dt) {
    const sigma = SIGMA_WHITE * params.noiseScale;
    if (car.whiteVal === undefined) {
      car.whiteVal = sigma * randn();
      car.whiteAccum = 0;
    }
    if (!(dt > 0)) return car.whiteVal;
    // Exact time average of the piecewise-constant residual over the step —
    // see simulation.js for why the pieces must be duration-weighted.
    let remaining = dt;
    let weighted = 0;
    let guard = 0;
    while (remaining > 1e-12 && guard++ < 100000) {
      const untilNextFrame = FRAME_DT - car.whiteAccum;
      const take = Math.min(remaining, untilNextFrame);
      weighted += car.whiteVal * take;
      car.whiteAccum += take;
      remaining -= take;
      if (car.whiteAccum >= FRAME_DT - 1e-12) {
        car.whiteAccum = 0;
        car.whiteVal = sigma * randn();
      }
    }
    return weighted / dt;
  }
  // AR(p) with the paper's coefficients. The stationary state is built lazily
  // on first use, and a sigma change is applied by rescaling the stored state
  // (the process is linear in its innovations, so this is exact).
  function arNoise(car, dt) {
    const rho = AR_COEFFS[params.arOrder] || AR_COEFFS[1];
    const p = rho.length;
    const sigmaInnov = (SIGMA_AR[params.arOrder] || SIGMA_AR[1]) * params.noiseScale;
    if (!car.arHist || car.arHist.length !== p) {
      car.arHist = stationaryArHistory(rho, sigmaInnov);
      car.arSigma = sigmaInnov;
    } else if (car.arSigma !== sigmaInnov) {
      if (car.arSigma > 0) {
        const k = sigmaInnov / car.arSigma;
        for (let i = 0; i < p; i++) car.arHist[i] *= k;
      } else {
        car.arHist = stationaryArHistory(rho, sigmaInnov);
      }
      car.arSigma = sigmaInnov;
    }
    car.arAccum = (car.arAccum || 0) + dt;
    while (car.arAccum >= FRAME_DT) {
      let mean = 0;
      for (let k = 0; k < p; k++) mean += rho[k] * car.arHist[k];
      const next = mean + sigmaInnov * randn();
      for (let k = p - 1; k > 0; k--) car.arHist[k] = car.arHist[k - 1];
      car.arHist[0] = next;
      car.arAccum -= FRAME_DT;
    }
    return car.arHist[0];
  }

  // Bumper-to-bumper gap from `me` to its leader on a ring of length L.
  // The modulo must be taken on the *centre* distance before subtracting the
  // vehicle length, otherwise a genuine overlap (centre distance < carLength)
  // is reported as a nearly-full-lap gap and neither IDM nor the overlap clamp
  // reacts to it. Returns a negative value when the two vehicles overlap.
  function ringGap(leadS, meS, L) {
    const centre = (((leadS - meS) % L) + L) % L;
    return centre - params.carLength;
  }

  // Largest vehicle count that physically fits: N*(carLength + s0) <= L.
  function maxFeasibleCars() {
    return Math.max(2, Math.floor(circumference() / (params.carLength + params.s0)));
  }

  // IDM equilibrium speed for a steady state with net gap `s` (Δv = 0).
  // Solves 1 - (v/v0)^δ - ((s0 + vT)/s)^2 = 0, which is strictly decreasing on
  // [0, v0]. Used so runs start on the equilibrium branch instead of relaxing
  // to it from an arbitrary initial speed.
  function equilibriumSpeed(s) {
    const { v0, T, s0, delta } = params;
    if (!(s > s0) || !(v0 > 0)) return 0;
    let lo = 0, hi = v0;
    for (let i = 0; i < 60; i++) {
      const m = 0.5 * (lo + hi);
      const f = 1 - Math.pow(m / v0, delta) - Math.pow((s0 + m * T) / s, 2);
      if (f > 0) lo = m; else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  // Draw an AR(p) state from (a close approximation of) its stationary
  // distribution. Starting from zeros biases early statistics low: with
  // ρ = [0.989] the process needs ~42 s to reach 99 % of its stationary
  // variance, which is longer than a typical visit. 1000 burn-in steps at
  // 0.2 s/step is ~200 s of process time and costs microseconds.
  function stationaryArHistory(rho, sigmaInnov) {
    const p = rho.length;
    const hist = new Array(p).fill(0);
    for (let t = 0; t < 1000; t++) {
      let mean = 0;
      for (let k = 0; k < p; k++) mean += rho[k] * hist[k];
      const next = mean + sigmaInnov * randn();
      for (let k = p - 1; k > 0; k--) hist[k] = hist[k - 1];
      hist[0] = next;
    }
    return hist;
  }

  function idmAccel(v, vLead, gap) {
    const { v0, T, a, b, s0, delta } = params;
    const deltaV = v - vLead;
    const sStar = s0 + Math.max(0, v * T + (v * deltaV) / (2 * Math.sqrt(a * b)));
    const safeGap = Math.max(gap, 0.01);
    return a * (1 - Math.pow(v / v0, delta) - Math.pow(sStar / safeGap, 2));
  }

  const ETA_MAX = 2000; // samples kept per sim (2000 × 0.2 s = 400 s)

  function stepSim(sim, dt) {
    const L = circumference();
    sim.cars.sort((c1, c2) => c1.s - c2.s);
    const n = sim.cars.length;
    const accels = new Array(n);
    for (let i = 0; i < n; i++) {
      const me = sim.cars[i];
      const lead = sim.cars[(i + 1) % n];
      const gap = ringGap(lead.s, me.s, L);
      let acc = idmAccel(me.v, lead.v, gap);
      let eta = 0;
      if (params.noiseScale > 0) {
        if (sim.mode === "white") eta = whiteNoise(me, dt);
        else if (sim.mode === "ar") eta = arNoise(me, dt);
        else eta = gpNoise(me, sim.simTime);
        // Soft-saturate at ±5 m/s² — see simulation.js for rationale.
        const ETAMAX = 5.0;
        eta = Math.tanh(eta / ETAMAX) * ETAMAX;
        acc += eta;
      }
      // Record the *applied* residual, so the η panel, its ACF and the metrics
      // describe the process that actually drives the cars.
      me.lastEta = eta;
      if (me.perturbUntil > 0) { acc = Math.min(acc, -4.0); me.perturbUntil -= dt; }
      accels[i] = acc;
    }
    // Unwrapped coordinates of the platoon at the start of the step (the array
    // was sorted by s above, so consecutive differences are the true gaps).
    const uPrev = new Array(n);
    uPrev[0] = sim.cars[0].s;
    for (let i = 1; i < n; i++) uPrev[i] = uPrev[i - 1] + (sim.cars[i].s - sim.cars[i - 1].s);

    const u = new Array(n);
    for (let i = 0; i < n; i++) {
      const c = sim.cars[i];
      c.v = Math.max(0, c.v + accels[i] * dt);
      u[i] = uPrev[i] + c.v * dt;
    }
    // Overlap clamp in UNWRAPPED coordinates. A modular gap cannot distinguish
    // "leader far ahead" from "leader now behind me" — once a follower is
    // pushed past its leader the modular gap wraps to ~L and the inversion
    // becomes permanent. See simulation.js for the full rationale.
    const cl = params.carLength;
    const minGap = params.s0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const leadU = (i === n - 1) ? u[0] + L : u[i + 1];
        if (leadU - u[i] - cl >= minGap) continue;
        u[i] = leadU - cl - minGap;
        const lead = sim.cars[(i + 1) % n];
        if (sim.cars[i].v > lead.v) sim.cars[i].v = lead.v;
      }
    }
    for (let i = 0; i < n; i++) {
      const s = u[i] % L;
      sim.cars[i].s = s < 0 ? s + L : s;
    }
    // Collect ring statistics *after* the clamp so the reported speeds match
    // the vehicles actually drawn.
    let sumV = 0, minV = Infinity;
    for (let i = 0; i < n; i++) {
      const v = sim.cars[i].v;
      sumV += v;
      if (v < minV) minV = v;
    }
    sim.simTime += dt;
    // Record stats
    const avgV = sumV / n;
    sim.avgSpeedHist.push(avgV);
    if (sim.avgSpeedHist.length > 4000) sim.avgSpeedHist.splice(0, sim.avgSpeedHist.length - 4000);
    sim.totalFrames++;
    if (minV < 3.0) sim.jamFrames++;
    // FD point — use full ring (L meters), 4 sub-arcs for scatter diversity
    for (let b = 0; b < 4; b++) {
      const a0 = (b / 4) * L, a1 = ((b + 1) / 4) * L;
      let inside = 0, speedSum = 0;
      for (const c of sim.cars) {
        if (c.s >= a0 && c.s < a1) { inside++; speedSum += c.v; }
      }
      if (inside > 0) {
        const lenKm = (a1 - a0) / 1000;
        const k = inside / lenKm;                  // veh/km
        const q = (speedSum / inside) * 3.6 * k;   // veh/hr
        sim.fdData.push({ k, q });
      }
    }
    if (sim.fdData.length > 4000) sim.fdData.splice(0, sim.fdData.length - 4000);
    // Tagged car's residual, recorded on the papers' 0.2 s (5 fps) grid — the
    // resolution at which all three processes are defined. Sampling faster than
    // that would show the white residual's zero-order hold as a spurious
    // short-lag correlation (ACF at 0.05 s would read 0.75) and contradict this
    // page's own "white noise has no memory" statement.
    sim.etaAccum = (sim.etaAccum || 0) + dt;
    let tagged = null;
    for (const c of sim.cars) { if (c.tagged) { tagged = c; break; } }
    while (sim.etaAccum >= FRAME_DT) {
      if (tagged) sim.etaHist.push(tagged.lastEta);
      sim.etaAccum -= FRAME_DT;
    }
    // Strict cap, not an amortised one: η is recorded at 5 Hz, so trimming
    // every sample is cheap, and a fixed window keeps the metrics comparable
    // instead of sawtoothing between one and two window lengths.
    if (sim.etaHist.length > ETA_MAX) sim.etaHist.splice(0, sim.etaHist.length - ETA_MAX);
  }

  // ================================================================
  // Rendering — 3 rings
  // ================================================================
  const ringCtx = {};
  for (const m of MODES) {
    const c = document.getElementById(m.canvasId);
    ringCtx[m.id] = { canvas: c, ctx: c.getContext("2d") };
  }

  function drawRing(mode) {
    const sim = sims.find((s) => s.mode === mode);
    const { canvas, ctx } = ringCtx[mode];
    const W = canvas._w || canvas.width, H = canvas._h || canvas.height;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const margin = 24;
    const rPix = Math.min(W, H) / 2 - margin;
    const laneHalf = Math.max(6, rPix * 0.07);

    ctx.strokeStyle = "#2b3644"; ctx.lineWidth = laneHalf * 2;
    ctx.beginPath(); ctx.arc(cx, cy, rPix, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#3b4a5c"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, rPix + laneHalf, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, rPix - laneHalf, 0, Math.PI * 2); ctx.stroke();

    const L = circumference();
    const carHalfPix = Math.max(3, laneHalf * 0.6);
    for (const c of sim.cars) {
      const theta = (c.s / L) * 2 * Math.PI - Math.PI / 2;
      const x = cx + rPix * Math.cos(theta);
      const y = cy + rPix * Math.sin(theta);
      // color by speed (jet: red = slow/jam, blue = fast/free-flow)
      const sp = Math.min(1, c.v / params.v0);
      ctx.fillStyle = jetCss(sp);
      ctx.beginPath(); ctx.arc(x, y, carHalfPix, 0, Math.PI * 2); ctx.fill();
      if (c.tagged) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, carHalfPix + 2, 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // ================================================================
  // Rendering — ETA trace, ACF, FD scatter
  // ================================================================
  const cEta = document.getElementById("chartEta");
  const xEta = cEta.getContext("2d");
  const cAcf = document.getElementById("chartAcf");
  const xAcf = cAcf.getContext("2d");
  const cFd  = document.getElementById("chartFdCmp");
  const xFd  = cFd.getContext("2d");

  function drawChartFrame(cx, w, h, xlabel, ylabel) {
    cx.clearRect(0, 0, w, h);
    cx.fillStyle = "#0f1620"; cx.fillRect(0, 0, w, h);
    cx.strokeStyle = "#273244"; cx.lineWidth = 1;
    cx.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (xlabel) {
      cx.fillStyle = "#7b8aa2"; cx.font = "11px system-ui,sans-serif";
      cx.textAlign = "right"; cx.fillText(xlabel, w - 6, h - 6);
    }
    if (ylabel) {
      cx.save(); cx.translate(12, 14); cx.fillStyle = "#7b8aa2";
      cx.font = "11px system-ui,sans-serif"; cx.fillText(ylabel, 0, 0); cx.restore();
    }
  }

  function drawEta() {
    const W = cEta._w || cEta.width, H = cEta._h || cEta.height;
    const windowSamples = 150;                  // 150 × 0.2 s = 30 s of history
    drawChartFrame(xEta, W, H, `time (s) — last ${Math.round(windowSamples * FRAME_DT)} s`, "η(t) (m/s²)");
    // y-range: symmetric around 0, sized from the largest *marginal* standard
    // deviation of the three processes at the current scale. (Using a hard-coded
    // floor of 1.0 here used to dominate the calibrated σ values of 0.24/0.20,
    // so the traces occupied only a few percent of the panel.)
    const refSigma = Math.max(
      marginalSigma("white"), marginalSigma("gp"), marginalSigma("ar")
    );
    const yr = Math.max(0.05, 3 * refSigma);
    const y0 = H / 2;
    const yScale = (H / 2 - 20) / yr;
    // zero line
    xEta.strokeStyle = "#273244"; xEta.beginPath();
    xEta.moveTo(40, y0); xEta.lineTo(W - 10, y0); xEta.stroke();
    // y-ticks
    xEta.fillStyle = "#7b8aa2"; xEta.font = "10px system-ui,sans-serif";
    xEta.textAlign = "right";
    xEta.fillText(yr.toFixed(2), 36, y0 - yr * yScale + 4);
    xEta.fillText("0", 36, y0 + 4);
    xEta.fillText((-yr).toFixed(2), 36, y0 + yr * yScale + 4);

    for (const m of MODES) {
      const sim = sims.find((s) => s.mode === m.id);
      const n = sim.etaHist.length;
      if (n < 2) continue;
      const start = Math.max(0, n - windowSamples);
      const len = n - start;
      xEta.strokeStyle = m.color; xEta.lineWidth = 1.2;
      xEta.beginPath();
      for (let i = 0; i < len; i++) {
        const x = 40 + (i / (windowSamples - 1)) * (W - 50);
        const y = y0 - sim.etaHist[start + i] * yScale;
        if (i === 0) xEta.moveTo(x, y); else xEta.lineTo(x, y);
      }
      xEta.stroke();
    }
  }

  // Empirical autocorrelation of a 1-D series up to maxLag.
  // Both the lag-k covariance and the variance are divided by n (the "biased"
  // estimator). Dividing the numerator by n-k while the denominator uses n, as
  // this function used to, inflates every lag by n/(n-k) and can return values
  // outside [-1, 1] at large lags.
  function acf(arr, maxLag) {
    const n = arr.length;
    if (n < maxLag + 2) return null;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += arr[i];
    mean /= n;
    let c0 = 0;
    for (let i = 0; i < n; i++) { const d = arr[i] - mean; c0 += d * d; }
    c0 /= n;
    if (c0 <= 1e-12) return null;
    const r = new Float64Array(maxLag + 1);
    r[0] = 1;
    for (let k = 1; k <= maxLag; k++) {
      let s = 0;
      for (let i = 0; i < n - k; i++) s += (arr[i] - mean) * (arr[i + k] - mean);
      r[k] = (s / n) / c0;
    }
    return { r, n, std: Math.sqrt(c0) };
  }

  function drawAcf() {
    const W = cAcf._w || cAcf.width, H = cAcf._h || cAcf.height;
    drawChartFrame(xAcf, W, H, "lag τ (s)", "ACF(τ)");
    // 12 s window: the DR-IDM residual is positively correlated over roughly
    // 0–5 s and *negatively* correlated over 5–10 s, which is the paper's
    // central empirical claim. A 6 s window with a −0.3 floor cut that off.
    const axisMaxSec = 12.0;
    // η is recorded on the 0.2 s grid, so that — not the integration step — is
    // the lag unit.
    const maxLag = Math.round(axisMaxSec / FRAME_DT);
    const padL = 46, padR = 12, padT = 14, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const yMin = -0.6, yMax = 1.0;
    const yMap = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;
    const xMap = (tau) => padL + (tau / axisMaxSec) * plotW;
    // gridlines
    xAcf.strokeStyle = "#273244"; xAcf.lineWidth = 1;
    for (const yv of [-0.5, 0, 0.5, 1.0]) {
      xAcf.beginPath(); xAcf.moveTo(padL, yMap(yv)); xAcf.lineTo(W - padR, yMap(yv)); xAcf.stroke();
      xAcf.fillStyle = "#7b8aa2"; xAcf.font = "10px system-ui,sans-serif"; xAcf.textAlign = "right";
      xAcf.fillText(yv.toFixed(1), padL - 4, yMap(yv) + 3);
    }
    xAcf.fillStyle = "#7b8aa2"; xAcf.textAlign = "center";
    for (const tv of [0, 2, 4, 6, 8, 10, 12]) {
      xAcf.fillText(tv.toString(), xMap(tv), H - 8);
    }
    // 95% confidence band for white noise (shortest available N)
    let nRef = Infinity;
    for (const m of MODES) {
      const sim = sims.find((s) => s.mode === m.id);
      if (sim.etaHist.length < nRef) nRef = sim.etaHist.length;
    }
    if (isFinite(nRef) && nRef > 10) {
      const ci = 1.96 / Math.sqrt(nRef);
      xAcf.fillStyle = "rgba(123,138,162,0.15)";
      xAcf.fillRect(padL, yMap(ci), plotW, yMap(-ci) - yMap(ci));
    }
    // Plot ACF for each mode. The plotted lag range grows with the available
    // sample size: estimates at lags approaching n are dominated by noise, so
    // we cap the drawn lag at n/4 and let the curve extend as data accumulates.
    for (const m of MODES) {
      const sim = sims.find((s) => s.mode === m.id);
      const kMax = Math.min(maxLag, Math.floor(sim.etaHist.length / 4));
      if (kMax < 2) continue;
      const res = acf(sim.etaHist, kMax);
      if (!res) continue;
      xAcf.strokeStyle = m.color; xAcf.lineWidth = 1.6;
      xAcf.beginPath();
      for (let k = 0; k <= kMax; k++) {
        const x = xMap(k * FRAME_DT);
        const y = yMap(Math.max(yMin, Math.min(yMax, res.r[k])));
        if (k === 0) xAcf.moveTo(x, y); else xAcf.lineTo(x, y);
      }
      xAcf.stroke();
    }
    // Legend
    legend(xAcf, W - padR - 170, padT + 4);
  }

  function legend(cx, x0, y0) {
    cx.font = "11px system-ui,sans-serif"; cx.textAlign = "left";
    const labels = [
      { t: "White — B-IDM",    c: "#ff7675" },
      { t: "AR(p) — DR-IDM",   c: "#74b9ff" },
      { t: "GP — MA-IDM",      c: "#55efc4" },
    ];
    labels.forEach((L, i) => {
      cx.fillStyle = L.c; cx.fillRect(x0, y0 + i * 16, 12, 2);
      cx.fillStyle = "#cfd7e3"; cx.fillText(L.t, x0 + 18, y0 + 4 + i * 16);
    });
  }

  // FD axes (auto-scale to fit all points across all sims)
  const fdAxes = { maxK: 40, maxQ: 600 };
  function niceCeil(v) {
    if (!isFinite(v) || v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / p;
    let n;
    if (m <= 1) n = 1; else if (m <= 2) n = 2;
    else if (m <= 2.5) n = 2.5; else if (m <= 5) n = 5; else n = 10;
    return n * p;
  }
  function updateFdAxes() {
    let mk = 0, mq = 0;
    for (const sim of sims) {
      for (const p of sim.fdData) {
        if (p.k > mk) mk = p.k;
        if (p.q > mq) mq = p.q;
      }
    }
    const tk = Math.max(40, niceCeil(mk * 1.1));
    const tq = Math.max(600, niceCeil(mq * 1.1));
    fdAxes.maxK = tk > fdAxes.maxK ? tk : fdAxes.maxK + 0.05 * (tk - fdAxes.maxK);
    fdAxes.maxQ = tq > fdAxes.maxQ ? tq : fdAxes.maxQ + 0.05 * (tq - fdAxes.maxQ);
  }

  function drawFd() {
    const W = cFd._w || cFd.width, H = cFd._h || cFd.height;
    drawChartFrame(xFd, W, H, "density k (veh/km)", "flow q (veh/hr)");
    updateFdAxes();
    const padL = 52, padR = 12, padT = 14, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xMap = (k) => padL + (k / fdAxes.maxK) * plotW;
    const yMap = (q) => padT + (1 - q / fdAxes.maxQ) * plotH;
    // gridlines
    xFd.strokeStyle = "#273244"; xFd.lineWidth = 1;
    for (let i = 1; i <= 4; i++) {
      const gx = padL + (i / 4) * plotW;
      xFd.beginPath(); xFd.moveTo(gx, padT); xFd.lineTo(gx, padT + plotH); xFd.stroke();
      xFd.fillStyle = "#7b8aa2"; xFd.font = "10px system-ui,sans-serif"; xFd.textAlign = "center";
      xFd.fillText(((i / 4) * fdAxes.maxK).toFixed(0), gx, H - 10);
    }
    for (let i = 1; i <= 4; i++) {
      const gy = padT + plotH - (i / 4) * plotH;
      xFd.beginPath(); xFd.moveTo(padL, gy); xFd.lineTo(W - padR, gy); xFd.stroke();
      xFd.fillStyle = "#7b8aa2"; xFd.textAlign = "right";
      xFd.fillText(((i / 4) * fdAxes.maxQ).toFixed(0), padL - 4, gy + 3);
    }
    // Points — draw recent subset
    for (const m of MODES) {
      const sim = sims.find((s) => s.mode === m.id);
      xFd.fillStyle = m.color + "99";
      const start = Math.max(0, sim.fdData.length - 1500);
      for (let i = start; i < sim.fdData.length; i++) {
        const p = sim.fdData[i];
        xFd.fillRect(xMap(p.k) - 1, yMap(p.q) - 1, 2, 2);
      }
    }
    legend(xFd, W - padR - 170, padT + 4);
  }

  // ================================================================
  // Metrics
  // ================================================================
  // Store raw numeric values by (metricKey, modeId) so we can re-normalise the
  // bar widths against the row's max on every update. Order of rows matches
  // the HTML <tbody> layout.
  const METRIC_ROWS = ["std", "ac1", "tau", "sv", "jam"];
  const METRIC_DIGITS = { std: 3, ac1: 3, tau: 2, sv: 2, jam: 1 };
  const metricValues = {};
  for (const r of METRIC_ROWS) metricValues[r] = { white: NaN, ar: NaN, gp: NaN };

  function writeMetric(row, mid, value) {
    metricValues[row][mid] = value;
    // Row max, ignoring NaN. Use absolute value so negative lag-1 AC
    // (possible in very anticorrelated AR realisations) still bars sensibly.
    let mx = 0;
    for (const m of ["white", "ar", "gp"]) {
      const v = Math.abs(metricValues[row][m]);
      if (Number.isFinite(v) && v > mx) mx = v;
    }
    for (const m of ["white", "ar", "gp"]) {
      const cell = document.getElementById(`m-${row}-${m}`);
      if (!cell) continue;
      const raw = metricValues[row][m];
      if (!Number.isFinite(raw)) { cell.textContent = "–"; continue; }
      const frac = mx > 0 ? Math.min(1, Math.abs(raw) / mx) : 0;
      const digits = METRIC_DIGITS[row];
      const txt = row === "jam" ? raw.toFixed(digits) + "%" : raw.toFixed(digits);
      cell.innerHTML = `<span class="mbar" style="--w:${(frac * 100).toFixed(1)}%"></span><span class="mnum">${txt}</span>`;
    }
  }

  function updateMetrics() {
    for (const m of MODES) {
      const sim = sims.find((s) => s.mode === m.id);
      const eta = sim.etaHist;
      const mid = m.id;
      if (eta.length < 20) continue;
      // std, ac1
      let mean = 0; for (const x of eta) mean += x; mean /= eta.length;
      let c0 = 0, c1 = 0;
      for (let i = 0; i < eta.length; i++) { const d = eta[i] - mean; c0 += d * d; }
      for (let i = 1; i < eta.length; i++) c1 += (eta[i - 1] - mean) * (eta[i] - mean);
      const var0 = c0 / eta.length;
      const ac1 = var0 > 1e-12 ? (c1 / eta.length) / var0 : 0;
      // effective correlation time τ = Δ * Σ r(k) for k>=0 until it drops below 0.05
      const maxLag = Math.min(Math.round(10 / FRAME_DT), eta.length - 2);
      const res = acf(eta, maxLag);
      let tauEff = 0;
      if (res) {
        for (let k = 0; k <= maxLag; k++) {
          if (res.r[k] < 0.05) break;
          tauEff += res.r[k];
        }
        tauEff *= FRAME_DT;
      }
      // Ring-speed std
      const asp = sim.avgSpeedHist;
      let spM = 0; for (const v of asp) spM += v; spM /= Math.max(1, asp.length);
      let spV = 0; for (const v of asp) spV += (v - spM) * (v - spM);
      const spStd = Math.sqrt(spV / Math.max(1, asp.length));
      // Jam fraction
      const jamFrac = sim.totalFrames ? (100 * sim.jamFrames / sim.totalFrames) : 0;

      writeMetric("std", mid, Math.sqrt(var0));
      writeMetric("ac1", mid, ac1);
      writeMetric("tau", mid, tauEff);
      writeMetric("sv",  mid, spStd);
      writeMetric("jam", mid, jamFrac);
      document.getElementById("avg-" + mid).textContent =
        (asp.length ? asp[asp.length - 1] : 0).toFixed(1);
    }
  }

  // ================================================================
  // UI wiring
  // ================================================================
  function bindRange(id, key, fmt) {
    const el = document.getElementById(id);
    const out = document.getElementById(id + "Val");
    if (params[key] !== undefined) el.value = String(params[key]);
    const sync = (isUser) => {
      const val = parseFloat(el.value);
      params[key] = val;
      const label = fmt ? fmt(val) : val;
      if (out) out.textContent = label;
      el.setAttribute("aria-valuetext", String(label));
      if (isUser) scheduleWriteState();
    };
    el.addEventListener("input", () => sync(true));
    sync(false);
  }
  bindRange("cmpN", "numCars");
  bindRange("cmpRadius", "radius");
  bindRange("cmpScale", "noiseScale", (v) => v.toFixed(1) + "×");
  bindRange("cmpEll", "ell", (v) => v.toFixed(2));
  bindRange("cmpSpeed", "speedMul", (v) => v + "×");

  document.getElementById("cmpN").addEventListener("change", restartRun);
  document.getElementById("cmpRadius").addEventListener("change", restartRun);

  // Keep the vehicle-count slider inside the physically feasible range:
  // no more than L / (carLength + s0) vehicles fit on a single-lane ring.
  const cmpNEl = document.getElementById("cmpN");
  const cmpNLbl = document.getElementById("cmpNVal");
  function syncFeasibleCars() {
    const nMax = Math.min(PARAM_SCHEMA.numCars.max, maxFeasibleCars());
    cmpNEl.max = String(nMax);
    if (params.numCars > nMax) {
      params.numCars = nMax;
      cmpNEl.value = String(nMax);
      if (cmpNLbl) cmpNLbl.textContent = String(nMax);
      resetAll();
    }
  }
  document.getElementById("cmpRadius").addEventListener("input", syncFeasibleCars);
  syncFeasibleCars();
  document.getElementById("cmpEll").addEventListener("change", () => {
    resampleAllGP();
  });
  const cmpKernelEl = document.getElementById("cmpKernel");
  if (params.kernel) cmpKernelEl.value = params.kernel;
  cmpKernelEl.addEventListener("change", (e) => {
    params.kernel = e.target.value;
    resampleAllGP();
    scheduleWriteState();
  });
  const cmpARel = document.getElementById("cmpAR");
  if (params.arOrder) cmpARel.value = String(params.arOrder);
  cmpARel.addEventListener("change", (e) => {
    params.arOrder = parseInt(e.target.value, 10);
    for (const sim of sims) {
      for (const c of sim.cars) {
        // Empty, not zero-filled: arNoise() rebuilds it from the stationary
        // distribution of the new order on first use.
        c.arHist = [];
        c.arAccum = 0;
      }
    }
    scheduleWriteState();
  });

  let paused = false;
  // Respect prefers-reduced-motion: start paused.
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      paused = true;
      const pb = document.getElementById("cmpPause");
      if (pb) pb.textContent = "Play";
    }
  } catch (_) { /* non-supporting browser */ }
  document.getElementById("cmpReset").addEventListener("click", restartRun);
  document.getElementById("cmpPause").addEventListener("click", (e) => {
    paused = !paused;
    e.target.textContent = paused ? "Resume" : "Pause";
  });
  document.getElementById("cmpPerturb").addEventListener("click", () => {
    // One shared vehicle index across all three rings — the whole point of the
    // page is that the rings differ only in their noise process, so the
    // disturbance must be applied at the same place in each.
    const nCars = sims[0] ? sims[0].cars.length : 0;
    if (!nCars) return;
    const idx = Math.floor(rand() * nCars);
    for (const sim of sims) {
      if (sim.cars[idx]) sim.cars[idx].perturbUntil = 2.0;
    }
  });

  // "Copy link" button.
  const cmpCopyLink = document.getElementById("cmpCopyLink");
  if (cmpCopyLink) {
    cmpCopyLink.addEventListener("click", async () => {
      clearTimeout(_writeStateT);
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) q.set(k, String(v));
      history.replaceState(null, "", "#" + q.toString());
      const url = location.href;
      try { await navigator.clipboard.writeText(url); }
      catch (_) {
        const ta = document.createElement("textarea");
        ta.value = url; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (__) {}
        document.body.removeChild(ta);
      }
      const orig = cmpCopyLink.textContent;
      cmpCopyLink.textContent = "Copied ✓";
      setTimeout(() => { cmpCopyLink.textContent = orig; }, 1600);
    });
  }

  // Keyboard shortcuts.
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === " " || e.code === "Space") { e.preventDefault(); document.getElementById("cmpPause").click(); }
    else if (e.key === "p" || e.key === "P") { document.getElementById("cmpPerturb").click(); }
    else if (e.key === "r" || e.key === "R") { document.getElementById("cmpReset").click(); }
  });

  // HiDPI fit for all canvases on window resize and at startup.
  function fitAllCanvases() {
    const allCanvases = [
      ...MODES.map((m) => ringCtx[m.id].canvas),
      cEta, cAcf, cFd,
    ];
    for (const c of allCanvases) {
      const r = c.getBoundingClientRect();
      const w = Math.max(50, Math.floor(r.width));
      const origW = Number(c.getAttribute("width")) || c.width;
      const origH = Number(c.getAttribute("height")) || c.height;
      const h = Math.max(50, Math.floor(w * (origH / origW)));
      fitCanvas(c, w, h);
    }
  }
  window.addEventListener("resize", fitAllCanvases);
  if (window.matchMedia) {
    try {
      const mq = window.matchMedia(`(resolution: ${DPR}dppx)`);
      if (mq && mq.addEventListener) mq.addEventListener("change", fitAllCanvases);
    } catch (_) {}
  }
  fitAllCanvases();

  // ================================================================
  // Main loop
  // ================================================================
  let lastTime = performance.now();
  function tick(now) {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    dt = Math.min(dt, 0.1) * params.speedMul;

    if (!paused) {
      // Fixed simulation clock: advance only in whole params.dtStep steps and
      // carry the remainder to the next frame. Executing a frame-sized partial
      // step (as this loop used to) makes the physics, the η sampling interval
      // and every time-based metric depend on the monitor refresh rate and the
      // playback multiplier.
      physAccum += dt;
      const sub = params.dtStep;
      let work = 0;
      while (physAccum >= sub && work < 200) {
        for (const sim of sims) stepSim(sim, sub);
        physAccum -= sub;
        work++;
      }
      // If we hit the work cap the tab cannot keep up; drop the backlog rather
      // than accumulate an unbounded debt.
      if (work >= 200) physAccum = 0;
    }
    for (const m of MODES) drawRing(m.id);
    // Throttle the analysis charts to ~10 Hz. drawAcf alone costs several ms
    // per call at a 12 s window, and running it every frame would let render
    // load compete with the physics.
    if (now - lastChartDraw > 100) {
      drawEta();
      drawAcf();
      drawFd();
      updateMetrics();
      lastChartDraw = now;
    }

    requestAnimationFrame(tick);
  }
  let lastChartDraw = 0;

  resetAll();
  requestAnimationFrame(tick);
})();
