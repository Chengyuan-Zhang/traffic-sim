# traffic-sim

An interactive **ring-road traffic simulation** running entirely in the browser.
Cars drive around a circular track using the [Intelligent Driver Model (IDM)](https://en.wikipedia.org/wiki/Intelligent_driver_model).
With enough density — or a small perturbation — stop-and-go waves emerge spontaneously,
reproducing the classic [Sugiyama experiment](https://en.wikipedia.org/wiki/Traffic_flow#Sugiyama_experiment).

## Live demo

Once GitHub Pages is enabled for this repo, the site is served at:

<https://chengyuan-zhang.github.io/traffic-sim/>

## Running locally

No build step is required. Just open `index.html` in a browser, or serve the folder:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Enabling GitHub Pages

1. Push the repo to GitHub (already done if you're reading this there).
2. In the repo on GitHub, go to **Settings → Pages**.
3. Under *Build and deployment*, choose **Source: Deploy from a branch**.
4. Select **Branch: `main`** and **Folder: `/ (root)`**, then **Save**.
5. Wait ~1 minute and visit the URL shown on that page.

An empty `.nojekyll` file is included so GitHub Pages serves the files as-is
without running Jekyll.

## Controls

- **Number of cars** — density on the ring.
- **Desired speed v₀** — speed each driver targets in free flow.
- **Safe time headway T** — larger = more cautious following.
- **Max acceleration a / Comfortable braking b** — IDM tuning.
- **Ring radius** — changes track length (density changes with it).
- **Sim speed** — time multiplier for the integration.
- **Perturb** — forces one random car to brake hard for 2 s, seeding a jam wave.
- **Reset / Pause** — self-explanatory.

## Files

- `index.html` — page layout and controls
- `styles.css` — styling
- `simulation.js` — IDM integration and canvas rendering
- `.nojekyll` — tells GitHub Pages not to process with Jekyll
