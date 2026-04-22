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

Defaults follow Treiber & Kesting (2013), *Traffic Flow Dynamics*, Table 11.1
(recommended highway values): $v_0=33.3$ m/s, $T=1.5$ s, $s_0=2.0$ m,
$a=1.2$ m/s², $b=1.5$ m/s², $\delta=4$.

### Stochastic extensions — driver-noise models

On top of IDM you can add a time-correlated acceleration noise $\eta_n(t)$
so that $\dot v_n = f_\text{IDM} + \eta_n(t)$. Three models are available:

| Mode | Noise model | Reference |
| --- | --- | --- |
| **Gaussian process (MA-IDM)** | $\eta_n(t) \sim \mathcal{GP}(0, k(\cdot,\cdot))$ with a stationary kernel (RBF / Matérn-5/2 / 3/2 / 1/2). Lengthscale $\ell$ and noise scale $\sigma$ are exposed as sliders. | Zhang & Sun (2024), *"Bayesian Calibration of the Intelligent Driver Model via Gaussian Processes"*, **IEEE T-ITS** — [arXiv:2210.03571](https://arxiv.org/abs/2210.03571) |
| **AR(p) — dynamic regression** | Autoregressive noise $\eta_t = \sum_{i=1}^p \rho_i\,\eta_{t-i} + \varepsilon_t$. Coefficients $\rho_i$ for $p=1,\ldots,7$ are the posterior means reported in Table of the paper. | Zhang, Wang & Sun (2024), *"Calibrating Car-Following Models via Bayesian Dynamic Regression"*, **Transportation Research Part C (ISTTT25)** — [arXiv:2307.03340](https://arxiv.org/abs/2307.03340) |
| **White noise (B-IDM)** | I.i.d. Gaussian $\eta_t\sim\mathcal N(0,\sigma^2)$ — the baseline Bayesian IDM. | Zhang & Sun (2024), same as above |

### Traffic-flow diagnostics

- Live **average speed**, **flow**, and **density** for a user-selected
  measuring arc on the ring.
- **Time series** of average speed and flow.
- A **fundamental diagram** (flow vs. density) whose axes auto-scale to fit all
  collected samples — you never have to tune the range manually.

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
| Integration step $\Delta t$ (s) | 0.02 – 2.0 | Euler time-step. Noise is re-sampled every $\Delta t$. |

**Measuring region (density / flow / FD)**

| Control | Range | Meaning |
| --- | --- | --- |
| Center angle (°) | 0 – 359 | Where the measurement arc sits on the ring (click/drag on the canvas also works). |
| Arc span (°) | 10 – 360 | Angular width of the arc. |

**Driver-noise model**

| Control | Range | Meaning |
| --- | --- | --- |
| Noise model | GP / AR(p) / White | Switches between MA-IDM, dynamic-regression IDM, and B-IDM. |
| $\sigma$ — noise scale (m/s²) | 0 – 1.0 | Marginal std. of acceleration noise. |
| Kernel (GP only) | RBF, Matérn 5/2, 3/2, 1/2 | Shape of the GP covariance. |
| $\ell$ — lengthscale (s) (GP only) | 0.1 – 5.0 | Temporal correlation length. |
| AR order $p$ (AR only) | 1 – 7 | Uses the paper's posterior-mean $\rho$ vectors. |

**Actions**

- **Perturb** — forces one random car to brake for 2 s (seeds a jam wave).
- **Reset** / **Pause**.

## Files

- `index.html` — page layout and controls
- `styles.css` — styling
- `simulation.js` — IDM integration, noise models, and canvas rendering
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
> Model.** *IEEE Transactions on Intelligent Transportation Systems.*
> doi:[10.1109/TITS.2024.3354102](https://doi.org/10.1109/TITS.2024.3354102).
> [arXiv:2210.03571](https://arxiv.org/abs/2210.03571)

> Zhang, C., Wang, W., & Sun, L. (2024). **Calibrating Car-Following Models via
> Bayesian Dynamic Regression.** *Transportation Research Part C: Emerging
> Technologies*, 104719 (ISTTT25).
> doi:[10.1016/j.trc.2024.104719](https://doi.org/10.1016/j.trc.2024.104719).
> [arXiv:2307.03340](https://arxiv.org/abs/2307.03340)

BibTeX:

```bibtex
@article{zhang2024bayesian,
  title   = {Bayesian Calibration of the Intelligent Driver Model},
  author  = {Zhang, Chengyuan and Sun, Lijun},
  journal = {IEEE Transactions on Intelligent Transportation Systems},
  year    = {2024},
  doi     = {10.1109/TITS.2024.3354102}
}

@article{zhang2024calibrating,
  title   = {Calibrating Car-Following Models via Bayesian Dynamic Regression},
  author  = {Zhang, Chengyuan and Wang, Wenshuo and Sun, Lijun},
  journal = {Transportation Research Part C: Emerging Technologies},
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
