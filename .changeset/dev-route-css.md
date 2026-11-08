---
"@statorjs/stator": major
---

`stator dev` serves scoped CSS the way production does. Each route links its own stylesheet at the URL `stator build` writes it to (`/static/css/routes/index.stator.css`), holding only the components that route's imports reach, and the sheet is byte-for-byte the one the build writes. Dev used to link one `/static/components.css` with every component's CSS in the app, so a rule from a component on one route could style another route's markup in dev and not in production. `/static/components.css` is no longer served; a test or tool that fetched it should follow the page's `<link rel="stylesheet">` instead.
