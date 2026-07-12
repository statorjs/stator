---
title: Editor setup
description: "Syntax highlighting and language intelligence for .stator files in VS Code."
sidebar:
  order: 15
---

The Stator VS Code extension gives `.stator` files syntax highlighting
(frontmatter as TS, template as JSX, `<style>` as CSS, `<script>` as TS) and
a Volar-based language server: completions, hover, go-to-definition, and
diagnostics across all regions, powered by the real TypeScript and CSS
services.

## Install

Search for **"Stator"** in your editor's extensions view, or install
directly:

- **VS Code**: [`statorjs.stator-vscode` on the Marketplace](https://marketplace.visualstudio.com/items?itemName=statorjs.stator-vscode)
- **VSCodium / Cursor / Gitpod / Theia / code-server**: [`statorjs/stator-vscode` on Open VSX](https://open-vsx.org/extension/statorjs/stator-vscode)
- **Manual**: grab the `.vsix` from the
  [latest release](https://github.com/statorjs/stator/releases/latest) and
  use *Extensions → ⋯ → Install from VSIX*.

The extension is self-contained (bundled language server and TypeScript).
When your workspace has its own `typescript` installed, templates type-check
against that version instead of the bundled one.

## Project setup the tooling expects

Two things make types flow end to end (a `create-stator` project has both):

- **`stator-env.d.ts`** — the ambient `*.stator` module declaration, so TS
  can type `import Page from './page.stator'`.
- **`pnpm sync`** (`syncTypes`) — generates a `.stator/types/` mirror of
  per-component `.d.ts` files, so imports of your components get their real
  prop types instead of the permissive fallback. Wire it into `typecheck`
  (`tsx sync.ts && tsc --noEmit`) and run it after adding components.

## Other editors

The language server is editor-agnostic (`@statorjs/language-server` ships a
`stator-language-server` binary speaking LSP over stdio). Any editor with an
LSP client can use it — point the client at the binary and associate the
`stator` language id with `*.stator`. The TextMate grammar in
`editors/vscode/syntaxes/` works in any TextMate-compatible highlighter.

## Troubleshooting

**"The Stator Language Server crashed 5 times… will not be restarted"** in
the Output panel: the language client stops retrying for the rest of the
session once it trips this limit — and that tripped state survives extension
updates. After installing a new extension version, **fully quit and reopen
the editor**; a window reload or extension-host restart isn't always enough.

To watch the server: `View → Output` → "Stator Language Server" in the
dropdown. For request-level tracing, set `"stator.trace.server": "verbose"`
in settings.
