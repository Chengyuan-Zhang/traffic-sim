# traffic-sim

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

## Controllable parameters

Everything is adjustable from the sidebar while the simulation is running.

**Traffic & road**

| Control | Range | Meaning |
| --- | --- | --- |
| Number of cars | 5 – 80 | Vehicles on the ring. |
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

## Known limitations

This is a research-*inspired* teaching demo, not a reproduction of either
paper. The things most worth knowing before drawing conclusions from it:

- Acceleration noise is passed through a `5·tanh(η/5)` soft saturation before
  it is applied, which is not part of any of the displayed equations. At the
  default σ it is inert; at large σ it noticeably compresses the tails.
- Integration is semi-implicit Euler; both papers use the ballistic update
  $x(t+\Delta t)=x+v\Delta t+\tfrac12 a\Delta t^2$.
- A hard overlap clamp keeps the bumper-to-bumper gap at or above $s_0$. It is
  a safety net, not physics — at large σ or large $\Delta t$ it can intervene
  often enough to dominate the dynamics.
- The GP is drawn with $M=32$ random Fourier features, which reproduce the
  target covariance in expectation; a single realisation deviates from it and
  is only approximately Gaussian. The papers use conditional Gaussian sampling.
- Flow is computed as density × space-mean speed on the measuring arc, not from
  detector crossings or Edie's generalised definitions. The four sub-bin points
  in the fundamental diagram are a spatial cross-section and are deliberately
  drawn unconnected; only the whole-arc series is a time trajectory.
- All drivers share one parameter vector. Both papers' ring experiments instead
  draw *heterogeneous* per-driver parameters from the joint posterior, which is
  one of their main contributions.
- Matérn 3/2 and 1/2 kernels, and AR orders above the paper's recommended
  $p\approx4$–$6$, are exposed for exploration; the papers calibrate the
  squared-exponential kernel and mention Matérn 5/2 only.

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
- `.nojekyll` — tells GitHub Pages not to process with Jekyll

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

If this simulator is useful in your work, please cite the two underlying
papers:

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

## License

MIT — see [`LICENSE`](LICENSE).
