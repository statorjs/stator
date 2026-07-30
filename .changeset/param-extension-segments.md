---
"@statorjs/stator": minor
---

Param segments compose with the data-route extension convention: `routes/p/[id].json.ts` serves `/p/:id.json` — the captured param excludes the literal `.json` (lazily, so dotted ids resolve), and the suffixed route ranks above a bare `/p/:id` page at match time, so a page and its data twin coexist at one URL depth. A rest segment carrying a suffix is an error at discovery.
