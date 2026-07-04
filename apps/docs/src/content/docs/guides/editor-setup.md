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

Until the Marketplace listing is live, install from the repo's `.vsix`:

```bash
cd editors/vscode
pnpm install && pnpm package
code --install-extension stator-vscode-*.vsix
```

The extension resolves `@statorjs/language-server` and your workspace's
`typescript` automatically.

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
