# Stator landing page

Static site for [statorjs.dev](https://statorjs.dev). Plain HTML + CSS,
no build step. Deployed to Netlify.

## Layout

```
apps/landing/
  index.html      ← single-page content
  styles.css      ← all styles, theme tokens for light/dark
  netlify.toml    ← publish config + headers
  package.json    ← workspace member, deploy scripts
```

## Local preview

Open `index.html` in a browser directly, or run a tiny static server so
relative paths and `localStorage` work consistently:

```bash
python3 -m http.server -d apps/landing 8080
# then visit http://localhost:8080
```

## Deploy

One-time:

```bash
cd apps/landing
netlify login          # if you haven't already
netlify link           # connect this directory to the statorjs.dev site
```

Push a deploy:

```bash
cd apps/landing
pnpm deploy            # → netlify deploy --prod --dir .
```

Preview a build without promoting it to production:

```bash
pnpm preview           # → netlify deploy --dir .   (returns a unique URL)
```

## Content notes

The page describes the framework as it exists today, with V1 plans split
out in the `§5 What works, what's planned` section. When the V1 work
lands (client machines, SFC compiler, typed events, etc.), move those
items from PLANNED to WORKING and update §2's code example if the
`defineMachine` shape has changed.
