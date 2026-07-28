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
// A later review found several assertions here that could never fail — a
// spectral radius by power iteration on a non-symmetric companion matrix, a
// cyclic-order check built on a sum that is identically the circumference, and
// a clip bound read back from the module it was meant to police. Add a case
// here before fixing anything subtle, and check it by mutation: an assertion
// that has never been seen to fail is not yet evidence of anything.
'use strict';

const path = require('path');
const { loadModule } = require('./browser-stub');

const REPO = path.resolve(__dirname, '..');

// Internals exposed for white-box checks. Keep this list small and stable.
const SIM_INTERNALS = `{
  params, step, initCars, circumference, ringGap, equilibriumSpeed,
  maxFeasibleCars, arInnovationSigma, whiteNoise, arNoise, sampleDriverMultipliers,
  AR_COEFFS, AR_MARGINAL, FRAME_DT, PRESETS, HETERO_CHOL, HETERO_CLIP,
  get cars() { return cars; }
}`;
const CMP_INTERNALS = `{
  params, stepSim, resetAll, FRAME_DT,
  SIGMA_WHITE, SIGMA_GP, SIGMA_AR, AR_COEFFS,
  get sims() { return sims; }
}`;

// Deterministic generator for the test side, so a run is reproducible even
// where the module under test is asked to use its own seeded stream.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand) {
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const TEST_SEED = 20260728;

// ---------------------------------------------------------------------------
const results = [];
function check(name, passed, detail) {
  results.push({ name, passed: !!passed });
  const tag = passed ? 'ok  ' : 'FAIL';
  console.log(`${tag} ${name}${detail ? `\n       ${detail}` : ''}`);
}
function section(title) { console.log(`\n--- ${title} ---`); }

// Every module is booted with a fixed seed unless a test asks for another, so
// the suite is reproducible and a marginal failure means a real regression.
function withSeed(hash) {
  if (hash && /(^|&)seed=/.test(hash)) return hash;
  return hash ? `${hash}&seed=${TEST_SEED}` : `seed=${TEST_SEED}`;
}
function openSim(hash) {
  return loadModule(REPO, 'simulation.js', 'index.html',
    { expose: SIM_INTERNALS, hash: withSeed(hash) }).internals;
}
function openCmp(hash) {
  return loadModule(REPO, 'compare.js', 'compare.html',
    { expose: CMP_INTERNALS, hash: withSeed(hash) }).internals;
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

  // AR_MARGINAL should be the stationary std per unit innovation std. Drive
  // the shipped arNoise() rather than re-implementing the recursion here: a
  // re-implementation would keep passing even if the real generator broke,
  // which is exactly how the site's original sigma defect went unnoticed.
  let worst = 0;
  const detail = [];
  for (const p of Object.keys(PAPER_RHO)) {
    sim.params.arOrder = Number(p);
    // With sigma = AR_MARGINAL[p] the innovation scale is exactly 1, so the
    // stationary std of the process should come back as AR_MARGINAL[p].
    sim.params.gpSigma = sim.AR_MARGINAL[p];
    const car = {};
    let sumSq = 0, count = 0;
    for (let t = 0; t < 120000; t++) {
      const value = sim.arNoise(car, sim.FRAME_DT);
      if (t > 3000) { sumSq += value * value; count++; }
    }
    const rel = Math.abs(Math.sqrt(sumSq / count) - sim.AR_MARGINAL[p]) / sim.AR_MARGINAL[p];
    worst = Math.max(worst, rel);
    detail.push(`p${p} ${(rel * 100).toFixed(1)}%`);
  }
  check('AR_MARGINAL matches the stationary std of the shipped generator',
        worst < 0.06, `max relative error ${(worst * 100).toFixed(1)}%  (${detail.join(', ')})`);
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
  // Identity, not position: after sorting, modular distances always sum to one
  // circumference, so a check built on that sum can never fail. Track which
  // vehicle object sits where and require the cyclic sequence to stay a
  // rotation of the original.
  const order = new Map(sim.cars.map((c, i) => [c, i]));
  const n = sim.cars.length;
  let worstGap = Infinity;
  let overlapping = 0;
  let reordered = 0;
  let ownGapViolations = 0;

  for (let t = 0; t < steps; t++) {
    sim.step(sim.params.dtStep);
    const L = sim.circumference();
    const cars = sim.cars.slice().sort((a, b) => a.s - b.s);
    for (let i = 0; i < n; i++) {
      const lead = cars[(i + 1) % n];
      const centre = (((lead.s - cars[i].s) % L) + L) % L;
      const gap = centre - carLength;
      if (gap < worstGap) worstGap = gap;
      if (gap < -1e-9) overlapping++;
      // Each driver keeps its own standstill distance under heterogeneity.
      const ownS0 = sim.params.s0 * cars[i].m.s0;
      if (gap < ownS0 - 1e-6) ownGapViolations++;
    }
    const seq = cars.map((c) => order.get(c));
    const start = seq.indexOf(0);
    for (let j = 0; j < n; j++) {
      if (seq[(start + j) % n] !== j) { reordered++; break; }
    }
  }

  check(`${label}: bumper gaps stay non-negative`, worstGap >= -1e-9,
        `worst gap ${worstGap.toFixed(4)} m over ${steps} steps, ${overlapping} overlapping pair-steps`);
  check(`${label}: vehicles never change places`, reordered === 0,
        `${reordered} steps where the cyclic vehicle order was not a rotation of the original`);
  check(`${label}: each driver's own s0 is respected`, ownGapViolations === 0,
        `${ownGapViolations} pair-steps below the follower's own standstill distance`);
}

stressRing('defaults, GP noise', { numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 0.2, noiseMode: 'gp' }, 3000);
stressRing('AR noise at maximum sigma', { numCars: 30, radius: 120, dtStep: 0.05, gpSigma: 1.0, noiseMode: 'ar', arOrder: 5 }, 3000);
stressRing('largest integration step', { numCars: 30, radius: 120, dtStep: 2.0, gpSigma: 1.0, noiseMode: 'ar', arOrder: 1 }, 400);
stressRing('densest feasible ring', { numCars: 57, radius: 60, dtStep: 0.2, gpSigma: 0.6, noiseMode: 'gp' }, 1500);
stressRing('heterogeneous drivers', {
  numCars: 37, radius: 128, dtStep: 0.2, gpSigma: 0.3,
  noiseMode: 'gp', hetero: 0.25, initialSpeed: 11.6,
}, 1500);
// Dense enough that the clamp actually fires, so the per-driver s0 check is not
// vacuous: with heterogeneity on, a follower that stops must keep its OWN
// standstill distance, not the population one.
stressRing('heterogeneous jam', {
  numCars: 60, radius: 120, dtStep: 0.1, gpSigma: 1.0,
  noiseMode: 'ar', arOrder: 1, hetero: 0.2,
}, 3000);

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
  // Measured through the shipped arNoise(), not a copy of the recursion.
  const sim = openSim();
  const sigma = 0.2;
  Object.assign(sim.params, { gpSigma: sigma, noiseMode: 'ar' });
  const spread = [];
  for (const p of [1, 4, 7]) {
    sim.params.arOrder = p;
    const car = {};
    let sumSq = 0, count = 0;
    for (let t = 0; t < 120000; t++) {
      const value = sim.arNoise(car, sim.FRAME_DT);
      if (t > 3000) { sumSq += value * value; count++; }
    }
    spread.push(Math.sqrt(sumSq / count));
  }
  check('the sigma slider is the marginal std for every AR order',
        spread.every((s) => Math.abs(s - sigma) / sigma < 0.08),
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
  // With heterogeneity on, the bound has to use the widest s0 a driver can
  // draw. Using the population s0 would let the ring start already overlapping
  // for the unluckiest draw.
  const sim = openSim();
  Object.assign(sim.params, { numCars: 80, radius: 60, hetero: 0.4 });
  sim.initCars();
  const s0Max = sim.params.s0 * Math.exp(2 * 0.4);
  const feasible = Math.floor(sim.circumference() / (sim.params.carLength + s0Max));
  check('the feasible packing accounts for the widest s0 a driver can draw',
        sim.params.numCars <= feasible,
        `widest s0 ${s0Max.toFixed(2)} m allows ${feasible} vehicles; ` +
        `the simulation kept ${sim.params.numCars}`);
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
  // The papers model heterogeneity as ln(theta_d) ~ N(ln theta, Sigma):
  // log-normal, with the population value as the median. Draws are CLIPPED at
  // +/-2 sd, so the multiplier's extremes must land exactly on exp(+/-2*sd) —
  // that is what separates the real construction from a linear 1 + sd*z, which
  // would have almost the same mean and spread but bounds of 1 +/- 2*sd.
  const sim = openSim();
  const sd = 0.2;
  sim.params.hetero = sd;
  const draws = { v0: [], s0: [], T: [], a: [], b: [] };
  const N = 6000;
  for (let i = 0; i < N; i++) {
    const m = sim.sampleDriverMultipliers();
    for (const k of Object.keys(draws)) draws[k].push(m[k]);
  }

  const hiBound = Math.exp(2 * sd);
  const loBound = Math.exp(-2 * sd);
  // Hard-coded, not read back from the module: taking the bound from
  // sim.HETERO_CLIP would make this assertion self-consistent and therefore
  // blind to a change in the clip itself.
  check('the clip stays at the documented +/-2 sd', sim.HETERO_CLIP === 2,
        `HETERO_CLIP = ${sim.HETERO_CLIP}`);
  const maxima = Object.keys(draws).map((k) => Math.max(...draws[k]));
  const minima = Object.keys(draws).map((k) => Math.min(...draws[k]));
  check('multipliers are exp of a clipped normal, on every parameter',
        maxima.every((v) => Math.abs(v - hiBound) < 1e-9) &&
        minima.every((v) => Math.abs(v - loBound) < 1e-9),
        `bounds hit: [${minima.map((v) => v.toFixed(4)).join(', ')}] .. ` +
        `[${maxima.map((v) => v.toFixed(4)).join(', ')}]  (exact: ${loBound.toFixed(4)}, ${hiBound.toFixed(4)})`);

  const logSd = {};
  const logMean = {};
  for (const k of Object.keys(draws)) {
    const logs = draws[k].map(Math.log);
    logMean[k] = logs.reduce((x, y) => x + y, 0) / logs.length;
    logSd[k] = stdev(logs);
  }
  // Clipping at +/-2 shrinks the realised sd to about 0.96 of nominal.
  const expected = sd * 0.9594;
  check('every parameter varies, with the median preserved',
        Object.keys(draws).every((k) =>
          Math.abs(logMean[k]) < 0.05 && Math.abs(logSd[k] - expected) / expected < 0.12),
        Object.keys(draws).map((k) => `${k}: sd ${logSd[k].toFixed(3)}`).join(', ') +
        `  (expected ${expected.toFixed(3)})`);

  // arXiv:2210.03571 SV-B1 reports the signs of the strong posterior
  // correlations. Independent draws would contradict the paper's own finding.
  const REPORTED = [
    ['T', 'v0', +1], ['T', 'b', +1], ['a', 'b', +1],
    ['v0', 's0', -1], ['v0', 'a', -1], ['s0', 'T', -1], ['s0', 'a', -1], ['s0', 'b', -1],
  ];
  function corr(x, y) {
    const mx = x.reduce((a, c) => a + c, 0) / x.length;
    const my = y.reduce((a, c) => a + c, 0) / y.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      sxy += (x[i] - mx) * (y[i] - my);
      sxx += (x[i] - mx) ** 2;
      syy += (y[i] - my) ** 2;
    }
    return sxy / Math.sqrt(sxx * syy);
  }
  const logs = {};
  for (const k of Object.keys(draws)) logs[k] = draws[k].map(Math.log);
  const wrongSign = REPORTED.filter(([p, q, s]) => {
    const r = corr(logs[p], logs[q]);
    return Math.sign(r) !== s || Math.abs(r) < 0.15;
  });
  check('parameter draws carry the correlation signs the paper reports',
        wrongSign.length === 0,
        wrongSign.length
          ? wrongSign.map(([p, q]) => `(${p},${q}) = ${corr(logs[p], logs[q]).toFixed(3)}`).join(', ')
          : REPORTED.map(([p, q]) => `(${p},${q}) ${corr(logs[p], logs[q]).toFixed(2)}`).join('  '));

  const off = openSim();
  off.params.hetero = 0;
  off.initCars();
  const identical = off.cars.every((c) =>
    ['v0', 's0', 'T', 'a', 'b'].every((k) => c.m[k] === 1));
  check('heterogeneity off leaves every driver identical', identical);
}

{
  // What heterogeneity does is regime-dependent, and the site says so. At the
  // recommended parameters the ring is stable either way; at the papers' own
  // calibrated theta the IDENTICAL ring is the unstable one and a spread damps
  // its collective wave. An earlier version of this test ran only 400 s at the
  // default theta and "confirmed" a general claim that does not hold.
  function ringSpeedSpread(theta, hetero) {
    const sim = openSim('seed=4242');
    Object.assign(sim.params, theta, {
      numCars: 37, radius: 128, dtStep: 0.2, gpSigma: 0, hetero,
      noiseMode: 'gp', initialSpeed: 11.6, delta: 4,
    });
    sim.initCars();
    const series = [];
    for (let t = 0; t < 15000; t++) {              // the papers' own 3000 s
      sim.step(0.2);
      if (t > 2500) series.push(sim.cars.reduce((a, c) => a + c.v, 0) / sim.cars.length);
    }
    return stdev(series);
  }
  const REC = { v0: 33.3, s0: 2.0, T: 1.6, a: 1.5, b: 1.67 };
  const MA = { v0: 16.92, s0: 3.54, T: 1.18, a: 0.55, b: 2.15 };

  const recFlat = ringSpeedSpread(REC, 0);
  const recHet = ringSpeedSpread(REC, 0.15);
  // "Stable" means the residual fluctuation is negligible, not exactly zero:
  // heterogeneous drivers settle at slightly different speeds, so the ring
  // average carries a tiny offset. Four orders of magnitude below the
  // unstable case is the point.
  check('at the recommended parameters the noise-free ring is stable either way',
        recFlat < 1e-3 && recHet < 1e-3,
        `identical ${recFlat.toExponential(1)}, spread 0.15 ${recHet.toExponential(1)} m/s`);

  const maFlat = ringSpeedSpread(MA, 0);
  const maHet = ringSpeedSpread(MA, 0.15);
  check("at the MA-IDM posterior mean the identical ring is the unstable one",
        maFlat > 1.0 && maHet < maFlat / 3,
        `identical ${maFlat.toFixed(3)} m/s, spread 0.15 ${maHet.toFixed(3)} m/s ` +
        `— heterogeneity damps it ${(maFlat / maHet).toFixed(1)}x`);
}

// ===========================================================================
section('paper-scenario presets');

{
  // Values quoted from arXiv:2210.03571 SVI-C / Table I and arXiv:2307.03340
  // S4.3.2 / Table 1. `hetero` is deliberately excluded: it is the one number
  // in a preset that no paper supplies.
  const EXPECTED = {
    'ma-homog': {
      radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'white',
      v0: 33.3, s0: 2.0, T: 1.6, a: 1.5, b: 1.67, delta: 4, gpSigma: 0.204, hetero: 0,
    },
    'ma-hetero': {
      radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'gp',
      v0: 16.92, s0: 3.54, T: 1.18, a: 0.55, b: 2.15, delta: 4,
      gpSigma: 0.202, gpEll: 1.435, gpKernel: 'rbf',
    },
    'dr-dense': {
      radius: 128, numCars: 37, dtStep: 0.2, initialSpeed: 11.6, noiseMode: 'ar',
      v0: 27.10, s0: 2.84, T: 1.24, a: 0.81, b: 3.42, delta: 4,
      arOrder: 5, gpSigma: 0.143,
    },
  };
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const page = loadModule(REPO, 'simulation.js', 'index.html', { expose: SIM_INTERNALS });
    const select = page.el('preset');
    select.value = name;
    select.dispatch('change');
    const got = page.internals.params;
    const wrong = Object.keys(expected).filter((k) => Math.abs(got[k] - expected[k]) > 1e-9 && got[k] !== expected[k]);
    check(`preset "${name}" applies the published setup exactly`,
          wrong.length === 0,
          wrong.length
            ? wrong.map((k) => `${k}: ${got[k]} != ${expected[k]}`).join(', ')
            : `${Object.keys(expected).length} values match`);

    // The sliders must be able to hold what the preset asked for. The stub
    // emulates the browser's range snapping, so a step that is too coarse
    // shows up here rather than silently in a real page.
    const snapped = ['radius', 'v0', 's0', 'T', 'a', 'b', 'gpSigma', 'gpEll', 'hetero', 'dtStep']
      .filter((k) => k in got && Math.abs(parseFloat(page.el(k).value) - got[k]) > 1e-9);
    check(`preset "${name}" round-trips through the sliders`, snapped.length === 0,
          snapped.length
            ? snapped.map((k) => `${k}: slider ${page.el(k).value} vs ${got[k]}`).join(', ')
            : 'no value was snapped');
  }

  const page = loadModule(REPO, 'simulation.js', 'index.html', { expose: SIM_INTERNALS });
  const select = page.el('preset');
  select.value = 'ma-hetero';
  select.dispatch('change');
  check('the active preset is recorded so a link can restore it',
        page.internals.params.preset === 'ma-hetero',
        `params.preset = ${page.internals.params.preset}`);

  // The scenario's initial speed has to reach the vehicles, not merely sit in
  // params: the papers pin it at 11.6 m/s, well off the equilibrium branch.
  const speeds = page.internals.cars.map((c) => c.v);
  check("the preset's published initial speed reaches the vehicles",
        speeds.length > 0 && speeds.every((v) => Math.abs(v - 11.6) < 1e-9),
        `initial speeds span [${Math.min(...speeds).toFixed(3)}, ${Math.max(...speeds).toFixed(3)}] m/s`);

  // A manual edit must leave the scenario rather than keep its label and its
  // hidden pinned initial speed.
  const v0El = page.el('v0');
  v0El.value = '30';
  v0El.dispatch('input');
  check('editing a slider leaves the preset and releases the pinned speed',
        page.internals.params.preset === 'custom' && page.internals.params.initialSpeed === 0,
        `preset = ${page.internals.params.preset}, initialSpeed = ${page.internals.params.initialSpeed}`);

  // A preset carried in the URL must come back as that preset.
  const restored = loadModule(REPO, 'simulation.js', 'index.html',
    { expose: SIM_INTERNALS, hash: 'preset=dr-dense&initialSpeed=11.6' });
  check('a preset survives a URL round-trip',
        restored.internals.params.preset === 'dr-dense' && restored.el('preset').value === 'dr-dense',
        `params.preset = ${restored.internals.params.preset}, dropdown = ${restored.el('preset').value}`);
}

// ===========================================================================
const failed = results.filter((r) => !r.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length ? 1 : 0);
