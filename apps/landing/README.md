# Stator landing page

[statorjs.dev](https://statorjs.dev), built with Stator and deployed to Fly.io.

## Layout

```
apps/landing/
  routes/index.stator          the page
  routes/404.stator            not-found page
  templates/layout.stator      document shell, header, footer
  templates/round-trip.stator  hero demo (client island)
  templates/site-mark.stator   logo; its rotor turns once per demo event (client island)
  templates/theme-toggle.stator
  lib/cart-rules.ts            the demo cart's rules, as plain functions
  lib/demo-cart.ts             the cart as a session machine: tested, shown on the page, run by the hero
  static/site.css              design tokens and global styles, light and dark
  scripts/og-image.html        source of static/og-image.png (`pnpm --filter landing og`)
  tests/demo-cart.test.ts
```

## Run it

```bash
pnpm --filter landing dev      # http://localhost:3000
pnpm --filter landing test
pnpm --filter landing build && pnpm --filter landing start
```

Fonts are copied from the Fontsource packages into `static/fonts/` before `dev` and `build`.

## Caching

The home route declares no machine reads, so the production server sends
`Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300` and no session cookie. Keep it that
way: a session-machine read on this route would create a session per visitor and withdraw the header.

That is why the hero demo is a client island. It runs the cart in the browser and shows the events and patches
that would cross the wire in a server-rendered app.

## Deploy

From the repo root:

```bash
fly deploy . --config apps/landing/fly.toml --dockerfile apps/landing/Dockerfile
```
