---
'@statorjs/stator': patch
---

Data routes recognize the `.css` extension (`theme.css.ts` → `/theme.css`, served as `text/css`). A generated stylesheet — a design system's tokens, a per-tenant theme — no longer needs a raw `Response` that gives up the free ETag/304 and derived Cache-Control.
