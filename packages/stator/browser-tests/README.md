# Browser tests

Real-browser tests for behavior the happy-dom vitest suite **cannot** verify —
chiefly HTML parser insertion modes (tables, `<select>`, `<ul>`), which happy-dom
does not implement. A bug that only manifests under real parsing passes in
happy-dom, so these run against an actual browser.

Run: `pnpm test:browser`

## How it works (zero install)

Uses the **system Chrome** binary with `--dump-dom` — no Playwright/Puppeteer, no
browser download. Each test bundles the real client code (e.g. `src/wire/apply.ts`)
with esbuild, loads a page that exercises it, and inspects the post-script DOM that
`--dump-dom` serializes. A test writes `data-result="PASS"` (or a failure reason)
onto `<html>` and exits non-zero on failure.

Requires a Chrome at `/Applications/Google Chrome.app` (macOS). CI integration
(Chrome-in-image, or a Playwright harness) is a follow-up — today this is a local
gate for the region-marker DOM work.

## Tests

- `tables.mjs` — comment-marker regions in a real `<table>`: keyed
  insert/remove/move/replace keep rows correct and inside `<tbody>` (a `<span>`
  wrapper would be foster-parented out). The acceptance test for the
  region-markers migration.
