# traffic-sim — an interactive ring-road traffic simulator

> Phantom traffic jams, in your browser. The Intelligent Driver Model on a
> circular road, with three published stochastic driver-noise models.

[![Live demo](https://img.shields.io/badge/demo-live-4fc3f7)](https://chengyuan-zhang.github.io/traffic-sim/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-lightgrey)](#running-locally)
[![DOI](https://img.shields.io/badge/DOI-10.1109%2FTITS.2024.3354102-blue)](https://doi.org/10.1109/TITS.2024.3354102)
[![DOI](https://img.shields.io/badge/DOI-10.1016%2Fj.trc.2024.104719-blue)](https://doi.org/10.1016/j.trc.2024.104719)

**[▶ Open the simulator](https://chengyuan-zhang.github.io/traffic-sim/)** ·
[Compare noise models](https://chengyuan-zhang.github.io/traffic-sim/compare.html) ·
[Motivation & models](https://chengyuan-zhang.github.io/traffic-sim/models.html)

An interactive **stochastic ring-road traffic simulator** that runs entirely in the
browser. Cars drive around a circular track using the
[Intelligent Driver Model (IDM)](https://en.wikipedia.org/wiki/Intelligent_driver_model)
of Treiber, Hennecke & Helbing (2000), and you can switch on three different
**driver-noise models** taken from recent research on Bayesian car-following
calibration. Even without obstacles, small perturbations grow into
stop-and-go waves — the classic
[Sugiyama experiment](https://en.wikipedia.org/wiki/Traffic_flow#Sugiyama_experiment).

Inspired by Dr. [Martin Treiber](https://mtreiber.de/)'s pioneering work on
stochastic car-following and his interactive
[traffic-simulation.de](https://traffic-simulation.de/).

## Live demo

<https://chengyuan-zhang.github.io/traffic-sim/>

## Running locally

No build step is required. Open `index.html` directly, or serve the folder:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Tests

```bash
node tests/invariants.js   # physics, presets and noise-process invariants
node tests/seo.js          # metadata, structured data and crawl files
```

Zero dependencies, no framework. `tests/browser-stub.js` fakes enough of the
DOM and canvas APIs to boot `simulation.js` and `compare.js` under Node, so the
assertions run against the code that actually ships rather than a copy of it.

The suite covers the things that are easy to break silently: the published
constants from each paper and every value in the presets, AR(p) stationarity
and marginal scale, ring geometry (no overlaps, no overtaking, even at the
extremes of the sliders), Δt-invariance of the noise, the correlation structure
of each residual, equilibrium initialisation, the feasible-packing limit, and
hostile URL parameters. Deterministic, about fifteen seconds.

`tests/seo.js` covers the discoverability metadata, which rots more quietly
still: titles and descriptions that outgrow their useful length, a canonical
that drifts from `og:url`, a renamed section that silently breaks a table-of-
contents anchor, a new page that never reaches the sitemap. Its strictest
assertion is that every question, answer, how-to step and glossary definition
in the JSON-LD appears **verbatim in the visible text** of the page that
carries it — structured data that promises something the page does not say is
the one search-engine offence that gets a site penalised rather than ignored,
and it is exactly what an edit to the prose introduces without anyone
noticing.

## What's implemented

### Deterministic baseline — IDM

The acceleration of every car follows

$$
\dot v_n \;=\; a\left[\,1 - \left(\tfrac{v_n}{v_0}\right)^{\delta}
     - \left(\tfrac{s^\*(v_n,\Delta v_n)}{s_n}\right)^2\,\right],
\quad
s^\*(v,\Delta v) \;=\; s_0 + v\,T + \tfrac{v\,\Delta v}{2\sqrt{ab}}.
$$

The simulator ships with a representative highway-style parameter set chosen for
this demo: $v_0=33$ m/s, $T=1.5$ s, $s_0=2.0$ m, $a=1.2$ m/s², $b=1.5$ m/s²,
$\delta=4$. These are *not* a verbatim row from any published table. For
reference, two commonly cited sets differ from it and from each other:

| Source | $v_0$ | $s_0$ | $T$ | $a$ | $b$ | $\delta$ |
| --- | --- | --- | --- | --- | --- | --- |
| Treiber & Kesting (2013), *Traffic Flow Dynamics*, **Table 11.2** (IDM, highway) | 120 km/h | 2 m | 1.0 s | 1.0 m/s² | 1.5 m/s² | 4 |
| $\theta_\text{rec}$ used as the prior in both calibration papers | 33.3 m/s | 2.0 m | 1.6 s | 1.5 m/s² | 1.67 m/s² | 4 |

(Table 11.1 of that book is the simplified Gipps model, not the IDM.) The
posterior means the two papers actually recover from HighD are lower still —
e.g. $\theta=[16.92, 3.54, 1.18, 0.55, 2.15]$ for the hierarchical MA-IDM.

### Stochastic extensions — driver-noise models

On top of IDM you can add a time-correlated acceleration noise $\eta_n(t)$
so that $\dot v_n = f_\text{IDM} + \eta_n(t)$. Three models are available:

| Mode | Noise model | Reference |
| --- | --- | --- |
| **Gaussian process (MA-IDM)** | $\eta_n(t) \sim \mathcal{GP}(0, k(\cdot,\cdot))$ with a stationary kernel. The paper calibrates a squared-exponential (RBF) kernel and notes Matérn-5/2 as an alternative; Matérn-3/2 and 1/2 are extensions added for this demo. Sampled here by a random-Fourier-feature approximation ($M=32$), not the paper's conditional-Gaussian scheme. Lengthscale $\ell$ and noise scale $\sigma$ are exposed as sliders. | Zhang & Sun (2024), *"Bayesian Calibration of the Intelligent Driver Model"*, **IEEE T-ITS** — [arXiv:2210.03571](https://arxiv.org/abs/2210.03571) |
| **AR(p) — dynamic regression** | Autoregressive noise $\eta_t = \sum_{i=1}^p \rho_i\,\eta_{t-i} + \varepsilon_t$, updated on the paper's 0.2 s (5 fps) grid. Coefficients $\rho_i$ for $p=1,\ldots,7$ are the posterior means reported in Table 1 of the paper, which also lists $p=8$; the paper compares covariance functions up to $p=10$ and recommends $p\approx4$–$6$. | Zhang, Wang & Sun (2024), *"Calibrating Car-Following Models via Bayesian Dynamic Regression"*, **Transportation Research Part C (ISTTT25)** — [arXiv:2307.03340](https://arxiv.org/abs/2307.03340) |
| **White noise (B-IDM)** | I.i.d. Gaussian $\eta_t\sim\mathcal N(0,\sigma^2)$ — the baseline Bayesian IDM. | Zhang & Sun (2024), same as above |

### Traffic-flow diagnostics

- Live **average speed**, **flow**, and **density** for a user-selected
  measuring arc on the ring.
- **Time series** of average speed and flow.
- A **fundamental diagram** (flow vs. density) whose axes auto-scale to fit the
  samples currently held in the buffer — you never have to tune the range
  manually. The connected line is the measuring arc's time trajectory; the
  faint dots are a spatial cross-section from four sub-bins and are
  deliberately left unconnected.

## Paper scenarios

The **Preset** control loads the ring-road setups from the two papers. All three
use the geometry both papers state — a 128 m radius (circumference ≈ 804 m),
37 vehicles, an initial speed of 11.6 m/s and Δt = 0.2 s — after
[Sugiyama et al. (2008)](https://doi.org/10.1088/1367-2630/10/3/033001):

| Preset | $\theta = [v_0, s_0, T, \alpha, \beta]$ | Noise |
| --- | --- | --- |
| MA-IDM ring — recommended θ (Fig. 10a) | $[33.3, 2.0, 1.6, 1.5, 1.67]$ | White, $\sigma = 0.204$ |
| MA-IDM ring — calibrated θ (Fig. 10b) | $[16.92, 3.54, 1.18, 0.55, 2.15]$ | GP, $\sigma_k = 0.202$, $\ell = 1.435$ s |
| Dynamic-IDM ring — dense (Fig. 10c) | $[27.10, 2.84, 1.24, 0.81, 3.42]$ | AR(5), marginal $\sigma = 0.143$ |

Two caveats. The MA-IDM paper says Fig. 10(a) uses "random white noise" but
never states its level; the 0.204 m/s² above is that paper's own
population-level Bayesian IDM value from Table I. And Fig. 10(b)/(c)
additionally sample $\theta$ per vehicle from the fitted posterior, which this
demo does not — every driver here shares one $\theta$.

The contrast is still worth watching: with the recommended parameters the ring
stays close to uniform, while at either paper's calibrated parameters it goes
unstable and forms stop-and-go waves on its own.

## Controllable parameters

Everything is adjustable from the sidebar while the simulation is running.

**Traffic & road**

| Control | Range | Meaning |
| --- | --- | --- |
| Preset | Custom / three paper scenarios | Jumps to the ring setups published in the two papers (see above). |
| Number of cars | 5 – 80 | Vehicles on the ring. Capped at the feasible packing $N(\ell_\text{car}+s_0)\le 2\pi R$. |
| Ring radius (m) | 60 – 250 | Track length $L = 2\pi R$; density $= N/L$. |

**IDM parameters**

| Control | Default | Meaning |
| --- | --- | --- |
| Desired speed $v_0$ (m/s) | 33 | Free-flow target speed. |
| Safe time headway $T$ (s) | 1.5 | Desired time gap to leader. |
| Minimum gap $s_0$ (m) | 2.0 | Bumper-to-bumper gap at standstill. |
| Max acceleration $a$ (m/s²) | 1.2 | Comfortable acceleration. |
| Comfortable braking $b$ (m/s²) | 1.5 | Comfortable deceleration. |

**Integration & playback**

| Control | Range | Meaning |
| --- | --- | --- |
| Sim speed | 0.25× – 10× | Wall-clock multiplier. |
| Integration step $\Delta t$ (s) | 0.02 – 2.0 | Euler time-step. All three *noise processes* are $\Delta t$-invariant: white noise and the AR(p) innovations live on the papers' fixed 0.2 s (5 fps) grid, and the GP is evaluated in continuous time. The *integration* is not — above roughly 0.2 s the Euler scheme itself introduces visible error, so keep $\Delta t$ small for anything quantitative. |

**Measuring region (density / flow / FD)**

| Control | Range | Meaning |
| --- | --- | --- |
| Center angle (°) | 0 – 359 | Where the measurement arc sits on the ring (click/drag on the canvas also works). |
| Arc span (°) | 10 – 360 | Angular width of the arc. |

**Driver-noise model**

| Control | Range | Meaning |
| --- | --- | --- |
| Noise model | GP / AR(p) / White | Switches between MA-IDM, dynamic-regression IDM, and B-IDM. |
| $\sigma$ — noise scale (m/s²) | 0 – 1.0 | **Marginal** std of the acceleration residual $\eta$. It means the same thing in all three modes: for AR(p) the innovation is divided by the Yule–Walker factor (6.8× at $p=1$ up to 10.3× at $p=7$) so that the resulting process has this marginal std, making the three models directly comparable. |
| Kernel (GP only) | RBF, Matérn 5/2, 3/2, 1/2 | Shape of the GP covariance. |
| $\ell$ — lengthscale (s) (GP only) | 0.1 – 5.0 | Temporal correlation length. |
| AR order $p$ (AR only) | 1 – 7 | Uses the paper's posterior-mean $\rho$ vectors (Table 1 also reports $p=8$). |

**Actions**

- **Perturb** — forces one random car to brake for 2 s (seeds a jam wave).
- **Reset** / **Pause**.
- **Copy link** — copies a URL whose `#` fragment encodes every slider value,
  so you can share or bookmark a specific configuration. Set `seed=<int>` in
  the URL (non-zero) to make the run fully reproducible via a seeded PRNG.

**Keyboard shortcuts:** `Space` pause, `P` perturb, `R` reset.

## Compare-models page

[`compare.html`](compare.html) runs all three noise models *side-by-side* on
three lockstep ring roads sharing the same initial conditions and IDM
parameters. Useful for seeing how `η(t)`'s temporal structure translates into
macroscopic jam waves. It plots:

- Three mini ring canvases.
- The `η(t)` trace of a single tagged car per mode.
- The autocorrelation **ACF(τ)** of `η(t)` — the quantity that most clearly
  distinguishes white noise (no correlation) from AR(p) and GP.
- Overlaid fundamental diagrams (flow vs density) per model.
- A summary-metrics table (empirical σ, lag-1 ρ, effective correlation time,
  std of avg ring speed, % time jammed).

Each model uses its own posterior-mean σ from Table 1 of the respective
paper; the *Noise scale* slider multiplies all three by the same factor, so
`1×` runs each model at **its own paper-calibrated noise scale**. That is not
the same as reproducing the papers: the ring geometry, the IDM parameters and
the posterior heterogeneity all differ from the papers' experiments (which use
$R=128$ m, an initial speed of 11.6 m/s, 32–37 vehicles, $\Delta t=0.2$ s and
per-driver parameters drawn from the joint posterior). Note also that σ for AR
is an *innovation* scale, so the three rings do not share a common marginal
variance — read the page as "each model as calibrated", not as a controlled
equal-variance experiment.

## Motivation & models page

[`models.html`](models.html) is a long-form explainer of the science behind
the simulator: why the calibration residual of a deterministic IDM is not
white noise, and how MA-IDM (Gaussian-process driver noise) and DR-IDM (AR(p)
driver noise) differ in their assumptions and parameters.
Includes a hero figure with three sample residual traces, the IDM equations
typeset with MathJax, per-paper "at a glance" cards, and a side-by-side
comparison table.

## Questions people ask

<details>
<summary><b>Why do traffic jams form on a ring road with no bottleneck?</b></summary>

Because dense car-following is unstable. Each driver reacts to the car ahead
with a delay and with imperfect precision, so a small speed fluctuation is
amplified rather than damped as it travels back through the queue. Past a
critical density the amplification wins and the disturbance grows into a
stopped cluster that moves backwards against the traffic. Sugiyama et al.
showed this with real drivers on a real circular track in 2008.
</details>

<details>
<summary><b>What is driver noise, and why does its colour matter?</b></summary>

Driver noise is the acceleration residual left over after a deterministic
model is fitted to a real trajectory — everything the equation does not
explain. On HighD it has a standard deviation around 0.2 m/s² and stays
correlated for several seconds, so it is not white. Colour matters because a
car-following chain is a low-pass amplifier: white noise is high-frequency
jitter that largely averages out, while correlated noise puts the same
variance into the low frequencies the chain amplifies into jams.
</details>

<details>
<summary><b>What is the difference between MA-IDM, DR-IDM and B-IDM?</b></summary>

All three add a random residual to the same IDM acceleration and differ only
in the process generating it. **B-IDM** uses i.i.d. Gaussian noise with no
memory. **DR-IDM** uses an AR(p) process, so the residual is a weighted sum of
its own recent past plus an innovation. **MA-IDM** uses a Gaussian process with
a stationary kernel, so memory is set smoothly by a lengthscale ℓ ≈ 1.4 s
rather than by a fixed number of lags.
</details>

<details>
<summary><b>Can I reproduce an exact run?</b></summary>

Yes. **Copy link** encodes every control in the URL fragment; adding
`seed=<int>` (non-zero) seeds the random-number stream as well, which makes
the run reproducible bit for bit.
</details>

<details>
<summary><b>Does this reproduce the results in the papers?</b></summary>

No — see [Known limitations](#known-limitations) below. It is a
research-*inspired* teaching demo, and every deviation from the papers is
listed there rather than glossed over.
</details>

## Known limitations

This is a research-*inspired* teaching demo, not a reproduction of either
paper. Worth knowing before drawing conclusions from it:

- Every driver shares one parameter vector. Both papers' ring experiments draw
  per-driver parameters from the fitted posterior, which is not published.
- Integration is semi-implicit Euler; both papers use the ballistic update
  $x(t+\Delta t)=x+v\Delta t+\tfrac12 a\Delta t^2$.
- Acceleration noise passes through a `5·tanh(η/5)` soft saturation that is not
  in any of the displayed equations. Inert at the default σ, noticeable at large σ.
- A hard clamp keeps the bumper-to-bumper gap at or above $s_0$. It is a safety
  net, not physics, and at large σ or large $\Delta t$ it can dominate.
- The GP uses $M=32$ random Fourier features, which match the target covariance
  in expectation only. The papers use conditional Gaussian sampling.
- Flow is density × space-mean speed on the measuring arc, not detector
  crossings or Edie's generalised definitions.
- Matérn 3/2 and 1/2, and AR orders outside the paper's recommended
  $p\approx4$–$6$, are exposed for exploration rather than taken from the papers.

## Files

- `index.html` — main-simulator page layout and controls
- `compare.html` — side-by-side noise-model comparison page
- `models.html` — motivation, model equations, and paper summaries
- `404.html` — friendly Not-Found page for GitHub Pages
- `styles.css` — shared styling for all pages
- `models.css` — page-local styles for `models.html`
- `simulation.js` — IDM integration, three noise models, and canvas rendering
- `compare.js` — lockstep IDM × 3 with per-model paper-calibrated sigmas
- `models.js` — hero canvas figure for `models.html`
- `page.js` — small shared page-glue script (Copy-BibTeX, mailto obfuscation)
- `tests/browser-stub.js` — minimal DOM/canvas stub that boots the modules under Node
- `tests/invariants.js` — invariant and regression tests (`node tests/invariants.js`)
- `tests/seo.js` — metadata, structured-data and crawl-file tests (`node tests/seo.js`)
- `robots.txt` — crawl policy, including an explicit opt-in for AI crawlers
- `sitemap.xml` — the three indexable URLs, with `lastmod`
- `llms.txt` — a condensed, quotable map of the site for language models
- `CITATION.cff` — machine-readable citation metadata (GitHub renders it)
- `site.webmanifest`, `icon.svg` — installable-app metadata and a crawlable favicon
- `.nojekyll` — tells GitHub Pages not to process with Jekyll

## Discoverability

Each page carries a JSON-LD `@graph` describing itself, the software, the
author and the four cited papers as linked entities, plus an `FAQPage`, a
`HowTo` and a `DefinedTermSet` whose text is generated from the visible
sections and checked against them by `tests/seo.js`.

**One caveat worth knowing.** Crawlers read `robots.txt` only from the origin
root, and this site is served from a GitHub Pages *project* path. The file
that is actually obeyed is therefore
`https://chengyuan-zhang.github.io/robots.txt`, which belongs to the
`chengyuan-zhang.github.io` user-site repository, not to this one. The
`robots.txt` here is the authoritative copy of the policy and becomes live as
written if traffic-sim ever moves to its own domain; until then, the user-site
repo needs at least:

```
User-agent: *
Allow: /

Sitemap: https://chengyuan-zhang.github.io/traffic-sim/sitemap.xml
```

`llms.txt` is an origin-root convention too, so the same applies: a tool that
goes looking for one will try `https://chengyuan-zhang.github.io/llms.txt`.
The copy here is complete and correct for anything handed the path directly —
and it is what makes the site quotable rather than merely readable — but for
automatic discovery the user-site repo should carry a copy or a pointer to it.

`sitemap.xml` has no such problem: a sitemap may live in any directory as long
as it only lists URLs at or below itself, so this one is valid where it sits
and can be submitted directly to Google Search Console and Bing Webmaster
Tools.

**Repository topics.** GitHub topics are a real discovery surface and are set
through the repository settings, not through any file here. Suggested set:
`traffic-simulation`, `intelligent-driver-model`, `car-following`,
`traffic-flow`, `stochastic-processes`, `bayesian-calibration`,
`gaussian-process`, `ring-road`, `stop-and-go-waves`, `javascript`,
`canvas`, `simulation`, `transportation-research`.

## Contact

**Chengyuan Zhang** — Ph.D. candidate, Department of Civil Engineering,
McGill University, Montréal, QC, Canada.

- Email: <enzozcy@gmail.com>
- Homepage: <https://chengyuan-zhang.github.io/>
- Google Scholar: <https://scholar.google.com/citations?user=4Zgj2BkAAAAJ&hl=en>
- ORCID: <https://orcid.org/0000-0001-8463-7380>
- GitHub: [@Chengyuan-Zhang](https://github.com/Chengyuan-Zhang)
- LinkedIn: [cy-zhang](https://www.linkedin.com/in/cy-zhang)

Feel free to reach out for collaboration or questions about the underlying
methodology.

## Citation

GitHub reads [`CITATION.cff`](CITATION.cff), so the repository's **Cite this
repository** button produces a correct reference in APA or BibTeX. If this
simulator is useful in your work, please cite the two underlying papers:

> Zhang, C., & Sun, L. (2024). **Bayesian Calibration of the Intelligent Driver
> Model.** *IEEE Transactions on Intelligent Transportation Systems*, 25(8),
> 9308–9320.
> doi:[10.1109/TITS.2024.3354102](https://doi.org/10.1109/TITS.2024.3354102).
> [arXiv:2210.03571](https://arxiv.org/abs/2210.03571)

> Zhang, C., Wang, W., & Sun, L. (2024). **Calibrating Car-Following Models via
> Bayesian Dynamic Regression.** *Transportation Research Part C: Emerging
> Technologies*, 168, 104719 (ISTTT25).
> doi:[10.1016/j.trc.2024.104719](https://doi.org/10.1016/j.trc.2024.104719).
> [arXiv:2307.03340](https://arxiv.org/abs/2307.03340)

BibTeX:

```bibtex
@article{zhang2024bayesian,
  title   = {Bayesian Calibration of the Intelligent Driver Model},
  author  = {Zhang, Chengyuan and Sun, Lijun},
  journal = {IEEE Transactions on Intelligent Transportation Systems},
  volume  = {25},
  number  = {8},
  pages   = {9308--9320},
  year    = {2024},
  doi     = {10.1109/TITS.2024.3354102}
}

@article{zhang2024calibrating,
  title   = {Calibrating Car-Following Models via Bayesian Dynamic Regression},
  author  = {Zhang, Chengyuan and Wang, Wenshuo and Sun, Lijun},
  journal = {Transportation Research Part C: Emerging Technologies},
  volume  = {168},
  pages   = {104719},
  year    = {2024},
  doi     = {10.1016/j.trc.2024.104719}
}
```

Please also consider citing the original IDM paper:

> Treiber, M., Hennecke, A., & Helbing, D. (2000). **Congested traffic states
> in empirical observations and microscopic simulations.** *Physical Review E*,
> 62(2), 1805–1824.
> doi:[10.1103/PhysRevE.62.1805](https://doi.org/10.1103/PhysRevE.62.1805)

The ring-road scenario the presets reproduce follows:

> Sugiyama, Y., Fukui, M., Kikuchi, M., Hasebe, K., Nakayama, A., Nishinari, K.,
> Tadaki, S., & Yukawa, S. (2008). **Traffic jams without bottlenecks —
> experimental evidence for the physical mechanism of the formation of a jam.**
> *New Journal of Physics*, 10(3), 033001.
> doi:[10.1088/1367-2630/10/3/033001](https://doi.org/10.1088/1367-2630/10/3/033001)

## License

MIT — see [`LICENSE`](LICENSE).
