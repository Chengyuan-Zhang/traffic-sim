(() => {
  "use strict";

  const canvas = document.getElementById("road");
  const ctx = canvas.getContext("2d");

  const params = {
    numCars: 30,
    v0: 20,        // desired speed (m/s)
    T: 1.5,        // safe time headway (s)
    a: 1.0,        // max acceleration (m/s^2)
    b: 2.0,        // comfortable deceleration (m/s^2)
    s0: 2.0,       // minimum spacing (m)
    delta: 4,      // IDM exponent
    carLength: 4.5,
    radius: 120,   // meters
    speedMul: 1.0,
    dtStep: 0.05,  // integration step size (s)
    // GP driver noise (arXiv:2210.03571) with choice of kernel
    gpSigma: 0.0,       // output scale (m/s^2); 0 disables noise
    gpEll: 5.0,         // lengthscale (seconds); paper: ~5 s for humans
    gpKernel: "rbf",    // "rbf" | "matern52" | "matern32" | "matern12"
    noiseMode: "gp",    // "gp" | "ar" | "white"
    arOrder: 2,         // AR(p) order; uses paper-calibrated ρ for this order
  };

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
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
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
      phases[m] = Math.random() * 2 * Math.PI;
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

      // Driver noise: GP (MA-IDM), AR(1), or white (B-IDM baseline)
      if (params.gpSigma > 0) {
        if (params.noiseMode === "white") acc += whiteNoise();
        else if (params.noiseMode === "ar") acc += arNoise(me, dt);
        else acc += gpNoise(me);
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
    simTime += dt;
  }

  // ---------- rendering ----------
  function draw() {
    const W = canvas.width, H = canvas.height;
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
    ctx.restore();

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

      // color by speed: interpolate from red (slow) to green (v0)
      const ratio = Math.max(0, Math.min(1, c.v / params.v0));
      const hue = Math.round(ratio * 120); // 0=red, 120=green
      ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;

      const lenPix = Math.max(6, rPix * carLenRad);
      ctx.fillRect(-carWidthPix / 2, -lenPix / 2, carWidthPix, lenPix);

      // perturbed highlight
      if (c.perturbUntil > 0) {
        ctx.strokeStyle = "#ffeb3b";
        ctx.lineWidth = 2;
        ctx.strokeRect(-carWidthPix / 2, -lenPix / 2, carWidthPix, lenPix);
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

  function updateStats() {
    if (!cars.length) return;
    let sum = 0, mn = Infinity;
    for (const c of cars) { sum += c.v; if (c.v < mn) mn = c.v; }
    const avg = sum / cars.length;
    const densPerKm = (cars.length / circumference()) * 1000;
    const flowPerHr = densPerKm * avg * 3.6; // cars/km * km/h
    statAvg.textContent = avg.toFixed(1);
    statMin.textContent = mn.toFixed(1);
    statDens.textContent = densPerKm.toFixed(1);
    statFlow.textContent = Math.round(flowPerHr);

    // feed chart buffers
    chartData.speed.push(avg);
    chartData.flow.push(flowPerHr);
    chartData.density.push(densPerKm);
    chartData.fd.push({ k: densPerKm, q: flowPerHr });
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
    // FD scatters are kept indefinitely (reset only via the Reset button)
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

  function drawLineChart(canvas, cx, data, color, yMaxHint) {
    const w = canvas.width, h = canvas.height;
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
  }

  function drawFD() {
    const w = cFD.width, h = cFD.height;
    // dynamic y-scale from current data, plus theoretical max guidance
    const maxK = Math.max(80, ...chartData.fd.map(p => p.k)) * 1.1;
    const maxQ = Math.max(1200, ...chartData.fd.map(p => p.q)) * 1.1;
    drawAxes(xFD, w, h, maxQ);

    const x0 = 30, plotW = w - x0 - 6;
    // scatter: older points fade
    const n = chartData.fd.length;
    for (let i = 0; i < n; i++) {
      const p = chartData.fd[i];
      const x = x0 + (p.k / maxK) * plotW;
      const y = h - (p.q / maxQ) * h;
      xFD.fillStyle = "rgba(79,195,247,0.85)";
      xFD.beginPath();
      xFD.arc(x, y, 2.2, 0, Math.PI * 2);
      xFD.fill();
    }
    // highlight latest
    if (n > 0) {
      const p = chartData.fd[n - 1];
      const x = x0 + (p.k / maxK) * plotW;
      const y = h - (p.q / maxQ) * h;
      xFD.strokeStyle = "#ffb74d";
      xFD.lineWidth = 2;
      xFD.beginPath();
      xFD.arc(x, y, 4.5, 0, Math.PI * 2);
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
      const hue = Math.round(ratio * 120);
      const [r, g, b] = hslToRgb(hue / 360, 0.8, 0.25 + 0.35 * ratio);
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
    xST.fillStyle = "#0e1620";
    xST.fillRect(0, 0, cST.width, cST.height);
    xST.imageSmoothingEnabled = false;
    // leave 30 px on the left for y-axis label and 16 px at the bottom for x-axis label
    xST.drawImage(stBuf, 30, 0, cST.width - 30, cST.height - 16);
    // labels
    xST.fillStyle = "rgba(230,237,243,0.55)";
    xST.font = "10px -apple-system, Segoe UI, sans-serif";
    xST.textAlign = "center";
    xST.fillText("time (old → now)", (cST.width - 30) / 2 + 30, cST.height - 4);
    xST.save();
    xST.translate(10, cST.height / 2);
    xST.rotate(-Math.PI / 2);
    xST.textAlign = "center";
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
    const update = () => {
      const v = parseFloat(el.value);
      params[key] = v;
      valEl.textContent = fmt(v);
    };
    el.addEventListener("input", update);
    update();
  }

  bindRange("numCars", "numCars", (v) => String(v | 0));
  bindRange("v0", "v0");
  bindRange("T", "T", (v) => v.toFixed(1));
  bindRange("a", "a", (v) => v.toFixed(1));
  bindRange("b", "b", (v) => v.toFixed(1));
  bindRange("radius", "radius");
  bindRange("speedMul", "speedMul", (v) => v.toFixed(2) + "×");
  bindRange("dtStep", "dtStep", (v) => v.toFixed(2));
  bindRange("gpSigma", "gpSigma", (v) => v.toFixed(2));
  bindRange("gpEll", "gpEll", (v) => v.toFixed(1));

  // AR order dropdown (not a range slider)
  const arOrderEl = document.getElementById("arOrder");
  const arOrderVal = document.getElementById("arOrderVal");
  function applyArOrder() {
    params.arOrder = parseInt(arOrderEl.value, 10);
    arOrderVal.textContent = params.arOrder;
    // Reset per-car AR history so the change takes effect cleanly
    for (const c of cars) { c.arHist = []; c.arAccum = 0; }
  }
  arOrderEl.addEventListener("change", applyArOrder);
  applyArOrder();

  // Changing lengthscale or kernel requires resampling frequencies
  document.getElementById("gpEll").addEventListener("change", resampleAllGP);
  const gpKernelEl = document.getElementById("gpKernel");
  gpKernelEl.addEventListener("change", () => {
    params.gpKernel = gpKernelEl.value;
    resampleAllGP();
  });

  // Noise model toggle — show only the controls relevant to the chosen model
  const noiseModeEl = document.getElementById("noiseMode");
  const ellRow = document.getElementById("ellRow");
  const kernelRow = document.getElementById("kernelRow");
  const arRow = document.getElementById("arRow");
  function applyNoiseMode() {
    params.noiseMode = noiseModeEl.value;
    const isGP = params.noiseMode === "gp";
    ellRow.style.display    = isGP ? "" : "none";
    kernelRow.style.display = isGP ? "" : "none";
    arRow.style.display     = params.noiseMode === "ar" ? "" : "none";
  }
  noiseModeEl.addEventListener("change", applyNoiseMode);
  applyNoiseMode();

  // numCars & radius need reinit
  document.getElementById("numCars").addEventListener("change", initCars);
  document.getElementById("radius").addEventListener("change", initCars);

  document.getElementById("perturb").addEventListener("click", () => {
    if (!cars.length) return;
    const idx = Math.floor(Math.random() * cars.length);
    cars[idx].perturbUntil = 2.0; // seconds of hard braking
  });

  document.getElementById("reset").addEventListener("click", () => { initCars(); resetCharts(); });

  const pauseBtn = document.getElementById("pause");
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
  });

  function setCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(200, Math.floor(Math.min(rect.width, rect.height)));
    canvas.width = size;
    canvas.height = size;
  }
  window.addEventListener("resize", setCanvasSize);
  setCanvasSize();

  initCars();
  requestAnimationFrame((t) => { lastTime = t; tick(t); });
})();
