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
  };

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
      });
    }
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
  }

  // ---------- loop ----------
  function tick(now) {
    const rawDt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;
    if (!paused) {
      // sub-step for stability
      const dt = rawDt * params.speedMul;
      const sub = Math.max(1, Math.ceil(dt / 0.02));
      for (let i = 0; i < sub; i++) step(dt / sub);
    }
    draw();
    updateStats();
    requestAnimationFrame(tick);
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

  // numCars & radius need reinit
  document.getElementById("numCars").addEventListener("change", initCars);
  document.getElementById("radius").addEventListener("change", initCars);

  document.getElementById("perturb").addEventListener("click", () => {
    if (!cars.length) return;
    const idx = Math.floor(Math.random() * cars.length);
    cars[idx].perturbUntil = 2.0; // seconds of hard braking
  });

  document.getElementById("reset").addEventListener("click", initCars);

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
