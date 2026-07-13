# create-stator

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
