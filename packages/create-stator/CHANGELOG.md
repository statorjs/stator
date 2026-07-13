# create-stator

## 1.3.0

### Minor Changes

- 415c181: Scaffolding now offers to finish the job: an "install dependencies?" prompt
  that detects whether you launched via pnpm, npm, yarn, or bun (and installs
  with that), and a "initialize a git repository?" prompt (init + initial
  commit). Next-steps output uses your package manager's real commands and
  skips what's already done. Flags for scripts and CI: `--install/--no-install`,
  `--git/--no-git`, and `-y`/`--yes` to accept all defaults; non-interactive
  runs without flags skip both.
- b9ffd1c: Two more first-party templates: `desksmith` (the tutorial's finished app —
  catalog, cart, checkout, a client theme island) and `live-poll` (shared
  app-machine state pushed to every visitor over SSE — the smallest example of
  cross-session live views). The full reference storefront remains scaffoldable
  directly: `--template github:statorjs/stator/apps/store`.
- 8739e88: New `with-auth` template: a notice board with accounts — guarded login
  (wrong password is literally `committed: false`), hash-at-the-edge
  registration, role- and ownership-guarded actions, per-user durable state,
  and session rotation on login/logout. Requires Node 24 (`node:sqlite`).

## 1.2.0

### Minor Changes

- Templates are fetched, not embedded — and there are two of them now.

  - **New `todomvc` template**: the classic app with the official stylesheet,
    server-owned todos (reload-proof), a draft-input island, zero-JS in-place
    editing, filters as links, and unit tests included.
  - First-party templates now live in the monorepo's `examples/` directory and
    are downloaded at scaffold time, so they improve with every push — no
    scaffolder release required. `--template` also accepts any giget source
    (`github:user/repo/path`) for community templates, and `--ref` pins
    first-party fetches to a branch or tag. Scaffolding now requires network
    access.
  - Interactive prompts (clack): directory, template picker, spinner,
    next-steps summary. Fully non-interactive when arguments are passed.
