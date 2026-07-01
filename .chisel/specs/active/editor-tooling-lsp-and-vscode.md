---
title: Editor tooling — LSP and VSCode extension
status: draft
created: 2026-06-30
updated: 2026-06-30
area: tooling
---

## What and Why

`.stator` files author with no editor support today — plain text, no highlighting,
no completions, no diagnostics until you run the compiler. This spec plans the
editor tooling: a **Volar-based language server** plus a **VSCode extension**, so
`.stator` gets the same class of experience as `.astro` / `.vue`.

The prior-art instinct ("Astro forked Svelte's language server") is the *2021*
story — it held because both are HTML-first templates. Astro, Vue, and MDX have
since converged on **[Volar.js](https://volarjs.dev)**, a framework built for
exactly our situation: a host file that embeds other languages (TS frontmatter +
JSX-flavored template + scoped CSS + client TS). Volar generates **virtual files**
per region, hands each to the *real* language service (TS, CSS), and remaps
positions back to the source. That is the target.

The twist in our favor: a `.stator` **template is JSX-first, not HTML-first**, so
the thing to lean on is **TypeScript's own JSX language service**, not Svelte's
HTML machinery — a materially easier starting point than Astro/Svelte had.

## Scope: what's in the tooling v1

**In (tooling v1):**

- **Phase 0 — Syntax highlighting.** A TextMate grammar (frontmatter fence → TS,
  body → JSX, `<style>` → CSS, `<script>` → TS) + language configuration, shipped
  in a minimal VSCode extension. No LSP. Adapt Astro's `.astro` grammar (MIT).
- **Phase 1 — Volar language server.** A Volar language plugin producing virtual
  code per region; federate the TS and CSS services. Delivers completions,
  diagnostics, hover, go-to-definition, and rename across all regions — mostly for
  free from the TS service. Plus a Volar TS plugin so a project's `tsserver`
  resolves `.stator` imports (Vue/Astro "takeover"-style).

**Deferred to post-launch follow-ups:**

- **Phase 2 — Stator-specific intelligence.** Surface compiler diagnostics
  (capability errors, malformed inline `<script>`, `child="x"` slot validation);
  typed `read(machine, sel)` selector completions; directive-attribute
  completions (`on:` / `bind:` / `class:list`); machine event-union autocomplete
  in `send` / `dispatch`.
- **Phase 3 — Formatting + polish.** `prettier-plugin-stator` (mirroring
  `prettier-plugin-astro`), Emmet in the template, references.

**Why this line.** Phases 0–1 are *structural* — region splitting, virtual-TSX
generation, federated TS/CSS services — and stay valid across language changes.
Phases 2–3 encode deep Stator-specific semantics (directive shapes, selector
typing, formatting rules) and are the **most at risk of rework** if the syntax or
reactivity model shifts after Stator 1.0. Landing 0–1 makes the toolset feel
mostly complete; holding 2–3 until the language settles avoids building polish on
a moving target.

## Success Criteria (tooling v1)

- `.stator` files are syntax-highlighted in VSCode (all four regions), with
  bracket matching and comment toggling.
- The language server gives, across frontmatter / template / client `<script>`:
  TS completions, hover, go-to-definition, rename, and real type diagnostics —
  including cross-file component props (via the existing `.stator.d.ts`).
- `<style>` blocks get CSS completions and diagnostics.
- A project's `tsserver` understands `import X from './x.stator'` (takeover).
- The virtual-code mapping is accurate: completions and squiggles land on the
  right source positions.

## Constraints

- **Build on Volar.** Don't hand-roll embedded-language mapping or fork the
  outdated HTML-first servers; Volar is the framework the ecosystem standardized
  on and solves the mapping/federation problem directly.
- **The compiler is the single source of truth.** The language server must reuse
  `splitStator` (region detection) and the same TSX parse the compiler uses, so
  the LS and the compiler never disagree about `.stator` syntax. Drift between
  compiler and language server is the classic embedded-tooling failure; sharing
  the front end prevents it.
- **Prerequisite — a mapped virtual-TSX "language emit" in the compiler.** Today
  the compiler *rewrites* source for runtime and emits **no source maps** (it
  tracks offsets for diagnostics only). Phase 1 needs a second emit target: a
  virtual `.tsx` whose positions map back to the `.stator` offsets, distinct from
  the runtime emit (Astro does exactly this — a separate `.astro`→`.tsx` for the
  LS). This is the gating piece of work and is independently useful.
- **Lean on TS's JSX service.** The template already parses as TSX
  (`lowerTemplate` uses `ts.ScriptKind.TSX`), and directives parse as namespaced
  JSX attributes (`on:click`, `bind:value`, `class:list`) — verified during the
  `is:inline` work (only the dropped `|lazy` pipe failed to parse). So the virtual
  TSX is close to the source, not a heavy transform.
- **Editor-agnostic by construction.** The language server is a **standalone
  package** (`@statorjs/language-server`) speaking LSP over stdio; the VSCode
  extension is just one thin client. This is what lets vim/nvim/emacs/helix/zed
  use it. Never couple language logic into the VSCode extension.
- **Self-contained for VSCodium / Open VSX / web.** The extension bundles its
  server and TypeScript, with **no dependency on marketplace-only extensions** and
  no reliance on VSCode's proprietary built-in TS extension. This keeps a single
  `.vsix` publishable to both the MS Marketplace and the Open VSX Registry, and
  runnable in forks (VSCodium, code-server) and the web.

## Approach

1. **Phase 0 grammar.** Fork Astro's `.astro` TextMate grammar; swap the
   frontmatter/body handling for our fence + JSX. Ship extension = grammar +
   `language-configuration.json`. Independent of the compiler; ~1–2 days.
2. **Language-emit mode** in the compiler: `splitStator` → per-region virtual code
   with offset mappings (frontmatter → TS module scope; template → mapped TSX;
   `<style>` → CSS; client `<script>` → TS).
3. **Volar language plugin** consuming that emit; register the TS and CSS services;
   expose diagnostics/completions/hover/def/rename.
4. **VSCode extension**: LSP client + grammar + language config + a Volar TS plugin
   for import resolution. Runs anywhere via LSP; VSCode is the primary target.

## Distribution and editor support

- **Two marketplaces, one artifact.** Package once (`.vsix`); publish to the
  **MS Marketplace** via `vsce` and the **Open VSX Registry** (what VSCodium,
  code-server, Gitpod, Theia default to) via `ovsx`. CI runs both on release with
  separate tokens/namespaces. The only design cost is the self-contained
  constraint above — no marketplace-only extension dependencies.
- **Other editors via the standalone server.** Any LSP client launches
  `@statorjs/language-server --stdio`:
  - **nvim** — an `nvim-lspconfig` server entry (and a `mason.nvim` package for
    install), mirroring the existing `astro` / `volar` entries.
  - **emacs** — `eglot` / `lsp-mode` server registration for `.stator`.
  - **helix / zed / sublime** — `languages.toml` / LSP config pointing at the
    server binary.
- **Cross-file typing off VSCode** needs the companion **TS server plugin**
  (`@statorjs/typescript-plugin`, the `@vue/typescript-plugin` analog) wired into
  the editor's `typescript-language-server`, so `.ts`/`.tsx` files importing
  `.stator` resolve types. VSCode gets this via the extension; other editors
  configure it once. Same split Vue ships.

## Alternatives Considered

- **Fork Svelte's / Astro's original HTML-first language server.** Rejected —
  that era predates Volar and assumes an HTML-first template; our JSX-first body
  makes TS's JSX service the better lean.
- **A `tsserver` plugin only (no Volar).** Rejected — it can type the script/
  frontmatter but not federate CSS or map the template regions; reinvents what
  Volar provides.
- **Hand-rolled LSP.** Rejected — re-implements embedded-language mapping that
  Volar already does well.

## Open Questions

- **Language-emit vs runtime-emit sharing.** How much of `lowerTemplate` can be
  reused for the mapped TSX vs. a parallel mapping-aware pass — and where the
  offset mappings are produced (MagicString-style, or TS transform with a
  position table).
- **Takeover mode** specifics for the `tsserver` plugin (mirroring Vue/Astro).
- **Release track.** [[stator-1-0-implementation-plan]] defers "editor LSP beyond
  syntax highlighting" to 1.x and lists syntax highlighting under Phase 6 polish.
  This spec refines that: is tooling-v1 (phases 0–1) part of the 1.0 launch, or a
  fast follow on the 1.x track? Phase 0 can ship independently at any time.

## Implementation Notes

Not started. Phase 0 (highlighting) is a standalone quick win with zero framework
changes and removes the worst of the current authoring experience; it can land
whenever. Phases 1–2 are the substantive project, gated on the mapped virtual-TSX
language-emit mode. Prior art to fork/lean on: **Volar.js** (framework),
**`@astrojs/language-server` + `astro-vscode`** (closest analog, MIT),
**`@vue/language-tools`** (Volar reference), **`prettier-plugin-astro`** and
Astro's `.astro` grammar.
