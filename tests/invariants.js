// Invariant tests for the simulation engine.
//
//   node tests/invariants.js
//
// No dependencies and no test framework. Every assertion runs against the code
// that actually ships: `browser-stub.js` boots simulation.js / compare.js in a
// fake browser, optionally exposing their internals, so nothing here is a
// re-implementation of the physics.
//
// The suite exists because a review of an earlier round of fixes found two
// defects that all of "it parses", "it runs" and "it looks right" had missed:
//
//   * the overlap clamp compared a *modular* gap, which cannot represent an
//     inversion, so once a follower was pushed past its leader the pair looked
//     safe forever and vehicles drove through each other;
//   * holding the white residual over the papers' 0.2 s grid while sampling it
//     every 0.05 s turned "white" noise into a process with lag-1
//     autocorrelation 0.74, quietly destroying the comparison the site is for.
//
// Both are now covered below. Add a case here before fixing anything subtle.
'use strict';

const path = require('path');
const { loadModule } = require('./browser-stub');

const REPO = path.resolve(__dirname, '..');

// Internals exposed for white-box checks. Keep this list small and stable.
const SIM_INTERNALS = `{
  params, step, initCars, circumference, ringGap, equilibriumSpeed,
  maxFeasibleCars, arInnovationSigma, whiteNoise,
  AR_COEFFS, AR_MARGINAL, FRAME_DT,
  get cars() { return cars; }
}`;
const CMP_INTERNALS = `{
  params, stepSim, resetAll, FRAME_DT,
  SIGMA_WHITE, SIGMA_GP, SIGMA_AR, AR_COEFFS,
  get sims() { return sims; }
}`;

// ---------------------------------------------------------------------------
const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: !!passed });
  const tag = passed ? 'ok  ' : 'FAIL';
  console.log(`${tag} ${name}${detail ? `\n       ${detail}` : ''}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }

function openSim(hash) {
  return loadModule(REPO, 'simulation.js', 'index.html', { expose: SIM_INTERNALS, hash }).internals;
}
function openCmp(hash) {
  return loadModule(REPO, 'compare.js', 'compare.html', { expose: CMP_INTERNALS, hash }).internals;
}
function stdev(xs) {
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / xs.length);
}
function autocorr(xs, maxLag) {
  const n = xs.length;
  const mu = xs.reduce((a, b) => a + b, 0) / n;
  let c0 = 0;
  for (const v of xs) c0 += (v - mu) * (v - mu);
  c0 /= n;
  const out = [];
  for (let k = 1; k <= maxLag; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += (xs[i] - mu) * (xs[i + k] - mu);
    out.push((s / n) / c0);
  }
  return out;
}

// ===========================================================================
section('the modules boot and run');

for (const [js, html] of [['simulation.js', 'index.html'], ['compare.js', 'compare.html']]) {
  let error = null;
  let framesRun = 0;
  try {
    const page = loadModule(REPO, js, html);
    framesRun = page.frames(400);
  } catch (e) {
    error = e && e.stack ? e.stack.split('\n')[0] : String(e);
  }
  check(`${js} initialises and renders without throwing`, !error && framesRun > 0,
        error || `${framesRun} animation frames driven`);
}

// ===========================================================================
section('published constants (arXiv:2307.03340 Table 1, arXiv:2210.03571 Table I)');

// Posterior means as printed in the papers. If a value here ever has to change,
// the paper changed — not the code.
const PAPER_RHO = {
  1: [0.989],
  2: [1.234, -0.247],
  3: [1.123, 0.425, -0.572],
  4: [0.901, 0.590, -0.149, -0.377],
  5: [0.874, 0.580, -0.105, -0.315, -0.071],
  6: [0.902, 0.632, -0.100, -0.427, -0.217, 0.181],
  7: [0.866, 0.690, -0.001, -0.413, -0.378, -0.032, 0.248],
};
const PAPER_SIGMA_ETA = { 1: 0.019, 2: 0.019, 3: 0.017, 4: 0.016, 5: 0.016, 6: 0.015, 7: 0.014 };
const PAPER_SIGMA_K = 0.202;      // MA-IDM kernel output scale
const PAPER_SIGMA_EPS = 0.240;    // Bayesian IDM (p = 0) white residual

{
  const sim = openSim();
  const cmp = openCmp();
  let mismatch = null;
  for (const p of Object.keys(PAPER_RHO)) {
    for (const table of [sim.AR_COEFFS, cmp.AR_COEFFS]) {
      const got = table[p] || [];
      const want = PAPER_RHO[p];
      if (got.length !== want.length || want.some((v, i) => Math.abs(v - got[i]) > 1e-12)) {
        mismatch = `p=${p}: [${got}] != [${want}]`;
      }
    }
  }
  check('AR coefficients match Table 1 for p = 1..7 in both engines', !mismatch, mismatch);

  const sigmaBad = Object.keys(PAPER_SIGMA_ETA)
    .filter((p) => Math.abs(cmp.SIGMA_AR[p] - PAPER_SIGMA_ETA[p]) > 1e-12);
  check('AR innovation sigmas match Table 1', sigmaBad.length === 0,
        sigmaBad.length ? `orders ${sigmaBad}` : 'p = 1..7');

  check('GP and white sigmas match the papers',
        Math.abs(cmp.SIGMA_GP - PAPER_SIGMA_K) < 1e-12 &&
        Math.abs(cmp.SIGMA_WHITE - PAPER_SIGMA_EPS) < 1e-12,
        `sigma_k = ${cmp.SIGMA_GP}, sigma_eps = ${cmp.SIGMA_WHITE}`);

  check('the AR update runs on the papers\' 5 fps grid',
        sim.FRAME_DT === 0.2 && cmp.FRAME_DT === 0.2, `FRAME_DT = ${sim.FRAME_DT} s`);
}

// ===========================================================================
section('AR(p) stationarity and marginal scale');

{
  const sim = openSim();
  // Stability of an AR(p) recursion is exactly "the impulse response decays".
  // Drive the recursion with a single unit impulse and no further innovations;
  // a non-stationary vector would grow without bound instead.
  function impulseDecay(rho) {
    const p = rho.length;
    const hist = new Array(p).fill(0);
    hist[0] = 1;
    let peak = 1;
    for (let t = 0; t < 20000; t++) {
      let next = 0;
      for (let k = 0; k < p; k++) next += rho[k] * hist[k];
      for (let k = p - 1; k > 0; k--) hist[k] = hist[k - 1];
      hist[0] = next;
      if (Math.abs(next) > peak) peak = Math.abs(next);
      if (!Number.isFinite(next)) return { decayed: false, peak: Infinity, final: next };
    }
    return { decayed: Math.abs(hist[0]) < 1e-6, peak, final: Math.abs(hist[0]) };
  }
  const orders = Object.keys(PAPER_RHO);
  const outcomes = orders.map((p) => impulseDecay(PAPER_RHO[p]));
  check('every published coefficient vector is stationary',
        outcomes.every((o) => o.decayed),
        outcomes.map((o, i) => `p${orders[i]} -> ${o.final.toExponential(1)}`).join(', '));

  // AR_MARGINAL should be the stationary std per unit innovation std.
  let worst = 0;
  const detail = [];
  for (const p of Object.keys(PAPER_RHO)) {
    const rho = PAPER_RHO[p];
    const hist = new Array(rho.length).fill(0);
    let sumSq = 0, count = 0;
    for (let t = 0; t < 200000; t++) {
      let mean = 0;
      for (let k = 0; k < rho.length; k++) mean += rho[k] * hist[k];
      let u = 0, v = 0;
      while (!u) u = Math.random();
      while (!v) v = Math.random();
      const next = mean + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      for (let k = rho.length - 1; k > 0; k--) hist[k] = hist[k - 1];
      hist[0] = next;
      if (t > 5000) { sumSq += next * next; count++; }
    }
    const rel = Math.abs(Math.sqrt(sumSq / count) - sim.AR_MARGINAL[p]) / sim.AR_MARGINAL[p];
    worst = Math.max(worst, rel);
    detail.push(`p${p} ${(rel * 100).toFixed(1)}%`);
  }
  check('AR_MARGINAL matches a Monte-Carlo estimate of the stationary std',
        worst < 0.05, `max relative error ${(worst * 100).toFixed(1)}%  (${detail.join(', ')})`);
}

// ===========================================================================
section('ring geometry: no overlaps, no overtaking');

// The clamp is the site's only collision handling. It must hold even in
// configurations a visitor can reach by dragging sliders to their extremes.
function stressRing(label, config, steps) {
  const sim = openSim();
  Object.assign(sim.params, config);
  sim.initCars();
  const carLength = sim.params.carLength;
  let worstGap = Infinity;
  let overlapping = 0;
  let inverted = 0;

  for (let t = 0; t < steps; t++) {
    sim.step(sim.params.dtStep);
    const L = sim.circumference();
    const cars = sim.cars.slice().sort((a, b) => a.s - b.s);
    // Modular centre distances around a well-ordered ring sum to exactly L.
    // Anything else means the cyclic order has been broken.
    let loop = 0;
    for (let i = 0; i < cars.length; i++) {
      const lead = cars[(i + 1) % cars.length];
      const centre = (((lead.s - cars[i].s) % L) + L) % L;
      loop += centre;
      const gap = centre - carLength;
      if (gap < worstGap) worstGap = gap;
      if (gap < -1e-9) overlapping++;
    }
    if (Math.abs(loop - L) > 1e-6) inverted++;
  }

  check(`${label}: bumper gaps stay non-negative`, worstGap >= -1e-9,
        `worst gap ${worstGap.toFixed(4)} m over ${steps} steps, ${overlapping} overlapping pair-steps`);
  check(`${label}: cyclic order is preserved`, inverted === 0, `${inverted} steps with a broken order`);
}

stressRing('defaults, GP noise', { numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 0.2, noiseMode: 'gp' }, 3000);
stressRing('AR noise at maximum sigma', { numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 1.0, noiseMode: 'ar', arOrder: 5 }, 3000);
stressRing('largest integration step', { numCars: 30, radius: 120, dtStep: 2.0, gpSigma: 1.0, noiseMode: 'ar', arOrder: 1 }, 400);
stressRing('densest feasible ring', { numCars: 57, radius: 60, dtStep: 0.2, gpSigma: 0.6, noiseMode: 'gp' }, 1500);
stressRing('heterogeneous drivers', {
  numCars: 37, radius: 128, dtStep: 0.2, gpSigma: 0.3,
  noiseMode: 'gp', hetero: 0.25, initialSpeed: 11.6,
}, 1500);

{
  const sim = openSim();
  const L = sim.circumference();
  const carLength = sim.params.carLength;
  // The case the old code got wrong: a leader still ahead but closer than one
  // vehicle length. Subtracting the length before taking the modulo turned that
  // -1.6 m overlap into a gap of nearly a full lap, so IDM saw an empty road
  // and the clamp saw nothing to fix.
  const overlapping = sim.ringGap(17.0, 14.1, L);
  const normal = sim.ringGap(50, 40, L);
  const wrapped = sim.ringGap(5, L - 10, L);
  check('ringGap reports an overlap as a negative gap',
        Math.abs(overlapping - (2.9 - carLength)) < 1e-9 &&
        Math.abs(normal - (10 - carLength)) < 1e-9 &&
        Math.abs(wrapped - (15 - carLength)) < 1e-9,
        `overlapping ${overlapping.toFixed(2)} m, normal ${normal.toFixed(2)} m, ` +
        `across the seam ${wrapped.toFixed(2)} m`);
}

// ===========================================================================
section('noise processes');

{
  // Sigma is documented as the marginal standard deviation in every mode. If
  // AR ever goes back to using it as an innovation scale, the process becomes
  // roughly nine times noisier than the other two at the same slider value.
  const sim = openSim();
  const sigma = 0.2;
  sim.params.gpSigma = sigma;
  const spread = [];
  for (const p of [1, 4, 7]) {
    sim.params.arOrder = p;
    const rho = sim.AR_COEFFS[p];
    const innov = sim.arInnovationSigma();
    const hist = new Array(p).fill(0);
    let sumSq = 0, count = 0;
    for (let t = 0; t < 200000; t++) {
      let mean = 0;
      for (let k = 0; k < p; k++) mean += rho[k] * hist[k];
      let u = 0, v = 0;
      while (!u) u = Math.random();
      while (!v) v = Math.random();
      const next = mean + innov * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      for (let k = p - 1; k > 0; k--) hist[k] = hist[k - 1];
      hist[0] = next;
      if (t > 5000) { sumSq += next * next; count++; }
    }
    spread.push(Math.sqrt(sumSq / count));
  }
  check('the sigma slider is the marginal std for every AR order',
        spread.every((s) => Math.abs(s - sigma) / sigma < 0.06),
        `p = 1, 4, 7 give ${spread.map((s) => s.toFixed(4)).join(', ')} against a target of ${sigma}`);
}

{
  // White noise lives on the papers' 0.2 s grid. Its *integrated* effect must
  // not depend on the integration step, or the Δt slider silently changes the
  // physics rather than just the accuracy.
  const sim = openSim();
  const sigma = 0.5, horizon = 100, replicates = 200;
  const expected = sigma * Math.sqrt(sim.FRAME_DT * horizon);
  sim.params.gpSigma = sigma;
  const measured = {};
  for (const dt of [0.02, 0.05, 0.2, 0.5, 2.0]) {
    let sumSq = 0;
    for (let r = 0; r < replicates; r++) {
      const car = {};
      let dv = 0;
      for (let t = 0; t < Math.round(horizon / dt); t++) dv += sim.whiteNoise(car, dt) * dt;
      sumSq += dv * dv;
    }
    measured[dt] = Math.sqrt(sumSq / replicates);
  }
  const worst = Math.max(...Object.values(measured).map((v) => Math.abs(v - expected) / expected));
  check('white-noise power is independent of the integration step',
        worst < 0.15,
        Object.entries(measured).map(([k, v]) => `dt=${k}: ${v.toFixed(3)}`).join('  ') +
        `  (theory ${expected.toFixed(3)}, worst deviation ${(worst * 100).toFixed(1)}%)`);
}

{
  // The compare page's entire premise is that white has no memory and the other
  // two do. Recording faster than the residual is defined would show white with
  // a lag-1 autocorrelation of 0.74 purely as a sampling artefact.
  const cmp = openCmp();
  cmp.resetAll();
  for (let t = 0; t < 12000; t++) for (const s of cmp.sims) cmp.stepSim(s, 0.05);
  const byMode = {};
  for (const mode of ['white', 'ar', 'gp']) {
    byMode[mode] = autocorr(cmp.sims.find((s) => s.mode === mode).etaHist, 4);
  }
  check('the recorded white residual is uncorrelated',
        Math.max(...byMode.white.map(Math.abs)) < 0.08,
        `ACF(1..4) = ${byMode.white.map((v) => v.toFixed(3)).join(', ')}`);
  check('the recorded AR and GP residuals are correlated',
        byMode.ar[0] > 0.5 && byMode.gp[0] > 0.5,
        `AR ${byMode.ar[0].toFixed(3)}, GP ${byMode.gp[0].toFixed(3)} at lag 1`);
}

{
  // The AR state is linear in its innovations, so a sigma change can be applied
  // exactly. Without that the slider takes ~100 s of simulated time to bite.
  const sim = openSim();
  Object.assign(sim.params, { numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 0.2, noiseMode: 'ar', arOrder: 1 });
  sim.initCars();
  for (let t = 0; t < 3000; t++) sim.step(0.05);
  sim.params.gpSigma = 0.6;
  for (let t = 0; t < 10; t++) sim.step(0.05);   // half a second later
  const now = Math.sqrt(sim.cars.reduce((a, c) => a + c.arHist[0] * c.arHist[0], 0) / sim.cars.length);
  check('a sigma change reaches the AR state immediately',
        now > 0.35, `marginal std 0.5 s after a 0.2 -> 0.6 change: ${now.toFixed(3)}`);
}

// ===========================================================================
section('initial conditions and limits');

{
  const sim = openSim();
  sim.initCars();
  const spacing = sim.circumference() / sim.params.numCars;
  const expected = sim.equilibriumSpeed(spacing - sim.params.carLength);
  const actual = sim.cars.reduce((a, c) => a + c.v, 0) / sim.cars.length;
  check('vehicles start on the IDM equilibrium branch',
        Math.abs(actual - expected) < 1e-6 && expected > 1,
        `initial speed ${actual.toFixed(4)} m/s, equilibrium ${expected.toFixed(4)} m/s`);
}

{
  // N vehicles of length l with a minimum gap s0 need N*(l+s0) of road.
  const sim = openSim();
  Object.assign(sim.params, { numCars: 80, radius: 60 });
  sim.initCars();
  const feasible = Math.floor(sim.circumference() / (sim.params.carLength + sim.params.s0));
  check('an infeasible packing is refused',
        sim.params.numCars <= feasible,
        `radius 60 m holds ${feasible} vehicles; the simulation kept ${sim.params.numCars}`);
}

{
  // A runtime-widened slider must not produce a value the URL validator rejects.
  const sim = openSim('radius=250&s0=0.5&carLength=1&numCars=80');
  sim.initCars();
  check('the vehicle count stays inside the documented range',
        sim.params.numCars >= 5 && sim.params.numCars <= 80,
        `numCars = ${sim.params.numCars} (geometry would allow ${sim.maxFeasibleCars()})`);
}

// ===========================================================================
section('hostile parameters');

// The hash and localStorage are user-controlled. dtStep = 0 used to spin the
// stepping loop forever; an unsupported AR order threw on the first frame.
const HOSTILE = [
  ['simulation.js', 'index.html', 'dtStep=0'],
  ['simulation.js', 'index.html', 'arOrder=8'],
  ['simulation.js', 'index.html', 'numCars=100000'],
  ['simulation.js', 'index.html', 'radius=-5'],
  ['simulation.js', 'index.html', 'gpKernel=../../etc/passwd'],
  ['simulation.js', 'index.html', 'noiseMode=bogus'],
  ['compare.js', 'compare.html', 'dtStep=0'],
  ['compare.js', 'compare.html', 'arOrder=8'],
  ['compare.js', 'compare.html', 'noiseScale=-3'],
];
for (const [js, html, hash] of HOSTILE) {
  let error = null;
  try {
    loadModule(REPO, js, html, { hash }).frames(60);
  } catch (e) {
    error = e && e.stack ? e.stack.split('\n')[0] : String(e);
  }
  check(`${js} survives #${hash}`, !error, error);
}

// ===========================================================================
section('the claim the site is built on');

{
  // Correlated residuals should disturb the flow more than white ones of the
  // same marginal scale. Common random numbers across the three modes, so the
  // comparison is paired rather than a single noisy draw.
  const seeds = [11, 22, 33];
  const totals = { white: 0, gp: 0, ar: 0 };
  for (const seed of seeds) {
    for (const mode of ['white', 'gp', 'ar']) {
      const sim = openSim('seed=' + seed);
      Object.assign(sim.params, {
        numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 0.4, noiseMode: mode, arOrder: 2,
      });
      sim.initCars();
      const series = [];
      for (let t = 0; t < 6000; t++) {
        sim.step(0.05);
        if (t > 2000) series.push(sim.cars.reduce((a, c) => a + c.v, 0) / sim.cars.length);
      }
      totals[mode] += stdev(series) / seeds.length;
    }
  }
  check('correlated noise disturbs the flow more than white noise of equal marginal scale',
        totals.gp > totals.white && totals.ar > totals.white,
        `sd of mean ring speed: white ${totals.white.toFixed(3)}, ` +
        `GP ${totals.gp.toFixed(3)}, AR(2) ${totals.ar.toFixed(3)} m/s`);
}

// ===========================================================================
section('driver heterogeneity');

{
  // The papers model heterogeneity as ln(θ_d) ~ N(ln θ, Σ): log-normal, with
  // the population value as the median. Draws are truncated at ±2 sd, which
  // shrinks the realised spread to about 0.88 of the nominal value.
  const sim = openSim();
  Object.assign(sim.params, { numCars: 80, radius: 250, hetero: 0.2 });
  sim.initCars();
  const logs = sim.cars.map((c) => Math.log(c.m.v0));
  const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sdLog = stdev(logs);
  check('per-driver parameters are log-normal about the population value',
        Math.abs(meanLog) < 0.12 && sdLog > 0.09 && sdLog < 0.27,
        `mean of log-multiplier ${meanLog.toFixed(3)} (target 0), sd ${sdLog.toFixed(3)} ` +
        `(nominal 0.20, ~0.18 after truncation)`);

  const off = openSim();
  off.params.hetero = 0;
  off.initCars();
  const identical = off.cars.every((c) =>
    ['v0', 's0', 'T', 'a', 'b'].every((k) => c.m[k] === 1));
  check('heterogeneity off leaves every driver identical', identical);
}

{
  // The mechanism the papers point at: with identical drivers a ring stays
  // perfectly uniform, so any dispersion must come from the noise. Give the
  // drivers different parameters and dispersion appears with no noise at all.
  function finalSpeedSpread(hetero) {
    const sim = openSim('seed=7');
    Object.assign(sim.params, {
      numCars: 37, radius: 128, dtStep: 0.2, gpSigma: 0, hetero, initialSpeed: 11.6,
    });
    sim.initCars();
    for (let t = 0; t < 2000; t++) sim.step(0.2);   // 400 s
    return stdev(sim.cars.map((c) => c.v));
  }
  const homogeneous = finalSpeedSpread(0);
  const heterogeneous = finalSpeedSpread(0.15);
  check('heterogeneous drivers disperse a noise-free ring, identical drivers do not',
        homogeneous < 1e-9 && heterogeneous > 0.1,
        `speed sd after 400 s with no noise: identical ${homogeneous.toExponential(1)} m/s, ` +
        `heterogeneous ${heterogeneous.toFixed(3)} m/s`);
}

// ===========================================================================
section('paper-scenario presets');

{
  // Ring geometry quoted from arXiv:2210.03571 SVI-C and arXiv:2307.03340 S4.3.2.
  const EXPECTED = {
    'ma-homog':  { radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'white', hetero: 0 },
    'ma-hetero': { radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'gp' },
    'dr-dense':  { radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'ar', arOrder: 5 },
  };
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const page = loadModule(REPO, 'simulation.js', 'index.html', { expose: SIM_INTERNALS });
    const select = page.el('preset');
    select.value = name;
    select.dispatch('change');
    const got = page.internals.params;
    const wrong = Object.keys(expected).filter((k) => got[k] !== expected[k]);
    check(`preset "${name}" applies the published ring setup`,
          wrong.length === 0,
          wrong.length
            ? wrong.map((k) => `${k}: ${got[k]} != ${expected[k]}`).join(', ')
            : `R = ${got.radius} m, N = ${got.numCars}, dt = ${got.dtStep} s, v0 = ${got.initialSpeed} m/s`);
  }

  // theta for the homogeneous scenario is the recommendation vector both papers
  // cite, [33.3, 2.0, 1.6, 1.5, 1.67] in the order [v0, s0, T, alpha, beta].
  const page = loadModule(REPO, 'simulation.js', 'index.html', { expose: SIM_INTERNALS });
  const select = page.el('preset');
  select.value = 'ma-homog';
  select.dispatch('change');
  const p = page.internals.params;
  check('the homogeneous preset uses theta_rec',
        p.v0 === 33.3 && p.s0 === 2.0 && p.T === 1.6 && p.a === 1.5 && p.b === 1.67,
        `[${p.v0}, ${p.s0}, ${p.T}, ${p.a}, ${p.b}]`);

  // Every preset value must survive a round trip through the sliders, or the
  // sidebar would silently show something the scenario did not ask for.
  const snapped = ['radius', 'v0', 's0', 'T', 'a', 'b', 'gpSigma', 'hetero']
    .filter((k) => Math.abs(parseFloat(page.el(k).value) - p[k]) > 1e-9);
  check('preset values round-trip through the sliders', snapped.length === 0,
        snapped.length ? `snapped: ${snapped.join(', ')}` : 'radius, IDM parameters, sigma, heterogeneity');

  // Selecting Custom must release the pinned initial speed.
  select.value = 'custom';
  select.dispatch('change');
  check('returning to Custom releases the pinned initial speed',
        page.internals.params.initialSpeed === 0,
        `initialSpeed = ${page.internals.params.initialSpeed}`);
}

// ===========================================================================
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
