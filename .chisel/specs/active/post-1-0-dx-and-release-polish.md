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

1. **TodoMVC starter — DONE 2026-07-12.** `--template todomvc`: official
   todomvc-app-css vendored (canonical look = comparable code, per Tony),
   TodosMachine with unit tests IN the template (teaches the testing guide),
   draft-input island (keystrokes stay client-side; Enter commits one typed
   dispatch, clears only on `committed`), zero-JS in-place editing (dblclick
   → EDIT_START → server branch flips the row to a form → native Enter
   submit → POST + navigate), filters as links. Wire-verified cold against
   published 1.1.0. **Templates relocated (Tony: the create-astro model):**
   first-party templates live at repo-root `examples/` as WORKSPACE MEMBERS
   (CI runs their tests/typechecks; workspace linking gives in-repo type
   resolution natively — the devDeps hack was retired same-day), and
   create-stator FETCHES via giget at scaffold time
   (`gh:statorjs/stator/examples/<name>`, `--ref` for branches, any
   `github:user/repo/path` for community templates — network-required by
   decision; `.gitignore` survives GitHub tarballs so the `_gitignore` hack
   died too). Templates update on every push, no republish. STATOR_RANGE
   const pins the scaffolded dep (workspace:* rewritten at stamp).
   Live-verified: giget fetch from main → install → tests → serve.
   create-stator 1.2.0 publish pending.
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
