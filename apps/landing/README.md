# Stator landing page

Static site for [statorjs.dev](https://statorjs.dev). Plain HTML + CSS,
no build step. Deployed to Netlify.

## Layout

```
apps/landing/
  index.html      ← single-page content
  styles.css      ← all styles, theme tokens for light/dark
  package.json    ← workspace member, optional deploy scripts
```

Deploy config (`base = "apps/landing"`, headers, etc.) lives in the
repo-root [`netlify.toml`](../../netlify.toml), not here. That root
config is what Netlify reads when it auto-deploys on push to `main`.

## Local preview

Open `index.html` in a browser directly, or run a tiny static server so
relative paths and `localStorage` work consistently:

```bash
python3 -m http.server -d apps/landing 8080
# then visit http://localhost:8080
```

## Deploy

The site is connected to this GitHub repo via the Netlify dashboard.
Pushes to `main` trigger an auto-deploy. No manual command needed for
the normal case.

For ad-hoc deploys from your machine (e.g. testing a config change
before pushing), the optional scripts in this package:

```bash
cd apps/landing
pnpm preview           # → netlify deploy --dir .   (returns a unique URL)
pnpm deploy            # → netlify deploy --prod --dir .  (promotes to prod)
```

Both expect `netlify login` + `netlify link` already done. The CLI
flow uses the root `netlify.toml`'s base/publish settings, so behavior
matches the git-integration path.

## Content notes

The page describes the framework as it exists today, with V1 plans split
out in the `§5 What works, what's planned` section. When the V1 work
lands (client machines, SFC compiler, typed events, etc.), move those
items from PLANNED to WORKING and update §2's code example if the
`defineMachine` shape has changed.
