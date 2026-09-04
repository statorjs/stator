---
"@statorjs/stator": minor
---

`stator build` now works out what `dist/` needs from your app's module graph instead of copying every top-level directory that wasn't on a denylist.

The old rule guessed at the shape of your project, and guessed wrong in both directions. A directory the app never imports came along for the ride — an uploads folder, a JSON cache a deploy script maintains, a folder of design notes — so runtime data got duplicated into the build artifact on every build. Meanwhile a root-level file a module genuinely opens did **not** come along, because the copy step only ever handled directories: an `import.meta.url`-relative SQLite file resolved inside `dist/`, found nothing, and SQLite created an empty database. The app booted, looked healthy, and had lost every row. Our own `with-auth` example shipped that bug.

One pass now walks the graph from the entry points the framework itself loads — every file under `routes/` and `machines/`, plus a root-level `middleware.ts`, `boot.ts` and `stator.config.*` — and everything else is copied because it was reached. `templates/` and `lib/` land in `dist/` because your routes import them, not because of what they are called, so renaming or adding a directory needs no configuration. `static/` still comes along, since the framework serves it by path.

- Resolution is the bundler's own, so a tsconfig `paths` alias, an extensionless specifier, an `index.ts` and an `exports` map all behave exactly as they do at runtime. A regex over import statements cannot see a path alias; this can.
- `.stator` files are compiled during the walk, so frontmatter imports are followed like any other import — a `lib/` module reached only by a template is found.
- Copying is per top-level directory, which is what lets a data file nothing imports ride along with its neighbours: a JSON fixture read with `readFile`, a mail template beside the module that reads it. A root-level file opened through a literal `new URL('../app.db', import.meta.url)` is copied too.
- The build prints what it decided — `copied: …`, and `not copied: …` for directories nothing reached — because a copy set derived from code should be visible rather than inferred from what turns up in `dist/`.
- **`build.include`** in `stator.config.ts` names anything no import graph can see, such as a directory read through a path built at runtime.
- **An `import()` the build cannot follow now fails the build**, naming each file and line. A string literal is followed; a template literal with a fixed prefix has every match included; only a fully computed specifier is opaque, and a `dist/` built around one is missing a module that some request will reach. Make it analysable, list what it reaches in `build.include`, or set `build.untracedImports: 'warn'`.
- `resolveCopySet` is exported from `@statorjs/stator/build` for tooling. `BuildConfig.dirs` still overrides the copy set outright.
- `stator build` is now covered on Windows and macOS in CI, not just Linux — a new build smoke runs beside the dev-loop smoke on all three. Resolution is where platforms diverge, and the failure it guards is silent: get containment wrong and every app file looks external, so the build "succeeds" and ships a `dist/` holding nothing but `static/`.

Upgrading: an app that relied on a directory being copied *incidentally* — never imported, but read at runtime through a computed path — needs it in `build.include`. The build's `not copied:` line tells you which directories are candidates.
