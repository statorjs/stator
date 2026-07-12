# Post-1.0: DX, starters, and release-flow polish

The "fun list" (Tony, 2026-07-12) — quality-of-life work now that 1.0 is
out. Not gated; ship piecewise.

## In flight (built, pending Tony's editor verification + commit)

- Dev banner (local/network links, version, inventory line) + graceful
  SIGINT/SIGTERM exit — no more ELIFECYCLE error on Ctrl+C. Prod keeps
  structured logs, exits 0 on deploy rollover.
- create-stator: clack flow (intro/text/select/spinner/note/outro),
  `--template` flag, templates/ dir layout, starter README with the mental
  model. Non-interactive when args given.
- tsconfig fix EVERYWHERE (store/template/example/poll): `include`
  **/*.stator, `jsx: preserve`, DOM.Iterable — .stator files were typed by
  the INFERRED project (default resolution can't read package exports →
  "cannot find StatorElement" phantom squiggles, editor-only). Owed: an
  editor-setup troubleshooting entry for existing projects.

## Queued

1. **TodoMVC starter/example** — second create-stator template (select is
   already plumbed). The Stator story: todos survive reload server-side,
   keyed rows, forms doctrine, filters as URL query. Small, testable, the
   lingua-franca comparison app.
2. **Changesets** (Tony 2026-07-12): adopt @changesets/cli for the three
   npm packages + a CI publish workflow (version-packages PR → merge →
   publish with NPM_TOKEN). Notes from first look: our root CHANGELOG.md is
   hand-written narrative — decide whether changesets' generated per-package
   changelogs replace it or feed it; the editor extension is NOT
   npm-published (vsce/ovsx) so it stays outside changesets — script its
   bump/publish separately or leave manual; ignore private workspace apps
   in config. Pairs well with the pre-push hook (changeset-check in CI).
3. **Plimsoll positioning**: reference app, NOT a starter (decided — too
   opinionated to gut; starters stay minimal+todomvc).
4. Sandal plate redraw (content, eternal).
