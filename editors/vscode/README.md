# Stator for VS Code

Language support for [`.stator`](https://github.com/statorjs/stator) single-file
components.

## Status

**Phase 0 — syntax highlighting.** This release highlights the four regions of a
`.stator` file:

- the `---` frontmatter fence → TypeScript
- the JSX-flavored template body → TSX
- `<style>` blocks → CSS
- `<script>` blocks → TypeScript

Full language features (completions, diagnostics, hover, go-to-definition) arrive
with the Volar-based language server in Phase 1 — see the
`editor-tooling-lsp-and-vscode` spec.

## Installation

- **VS Code** — the Microsoft Marketplace.
- **VSCodium / code-server / Gitpod / Theia** — the [Open VSX Registry](https://open-vsx.org).

The same `.vsix` is published to both.

## Editors beyond VS Code

The forthcoming language server is a standalone LSP binary, so vim/nvim, emacs,
Helix, Zed, and Sublime will be able to use it directly. See the spec for the
per-editor wiring.
