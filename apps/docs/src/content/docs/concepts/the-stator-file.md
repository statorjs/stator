---
title: The .stator file
description: "The four regions of an SFC: frontmatter, template body, styles, and the client script."
sidebar:
  order: 4
---

A `.stator` file is Stator's single-file component. It has up to four regions, each with a clear job. The compiler splits them at the string level before any of them is parsed in detail.

## Four regions, one file

```astro
---
// 1. frontmatter — imports, props/reads, request/response
---
<!-- 2. template body — JSX-flavored markup -->

<style>/* 3. scoped styles */</style>

<script>/* 4. client component code */</script>
```

Only the body is required. A pure presentational component is just a body; a route adds frontmatter; an interactive island adds a `<script>`. The regions are independent — frontmatter runs on the server, the `<script>` runs in the browser, and the split between them *is* the [server/client boundary](/concepts/server-client-boundary/).

## The frontmatter fence

The `---` fences hold server-side setup: imports (machines are imported **type-only** in components), and the `Stator.*` markers that the compiler rewrites:

- **`Stator.props<P>()`** — a component's typed props. `const { cart } = Stator.props<{ cart: InstanceOf<typeof CartMachine> }>()`.
- **`Stator.reads([...])`** — a route's live machine instances, in order. Routes only.
- **`Stator.request` / `Stator.response`** — a route's request context and response surface (status, headers, cookies). Routes only.

The compiler enforces which markers are legal in which kind of file: `Stator.props` in a component, the route markers in a route, and it errors if you cross them.

## The template body

The body is JSX-flavored markup that the compiler lowers to an `html\`…\`` server template. It supports text, `{read(...)}` bindings, the `when`/`each`/`match` control-flow callbacks, [directives](/guides/directives/), and component invocation (a capitalized tag like `<CartPage>`). Multiple top-level nodes are fine — the compiler wraps them. See [Writing templates](/guides/templates/).

## `<style>` regions

A `<style>` block is component-scoped: the compiler hashes it and rewrites selectors so they only match this component's elements. Source order is preserved across multiple blocks. See [Scoped styles](/guides/scoped-styles/) for how scoping works and how to escape it.

## The `<script>` region

A `<script>` makes the file a [client component](/guides/client-components/). Its imports are the component's **client dependency manifest** — a machine imported here runs in the browser. The file's root must be a custom element whose tag matches the exported `StatorElement` subclass.

### is:inline and src opt-outs

Because an inline `<script>` *means* "this is a client component," Stator needs a way to write a literal script tag. Two opt-outs emit the script verbatim instead:

- **`<script src="...">`** — an external reference is never a component.
- **`<script is:inline>`** — a verbatim inline script (its body bypasses the compiler, so braces and `<` survive).

The discriminator keys off the **presence** of `src`/`is:inline`, not "has any attribute." That's intentional: an incidental `<script type="module">` or `<script lang="ts">` you meant as a component won't be silently demoted to dead markup — and a bare inline `<script>` with no `StatorElement` is a compile error, not a silent drop. For typed structured data, prefer the [`<JsonLd>` component](/guides/templates/#embed-structured-data-with-jsonld) over a hand-written `<script>`.
