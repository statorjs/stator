---
title: Scoped styles
description: "Component-scoped <style> via the data-s-<hash> attribute, and :global escapes."
sidebar:
  order: 3
---

A `<style>` block in a `.stator` file is scoped to that component — its rules can't leak out or bleed in.

## How scoping works

The compiler hashes the component and appends a `data-s-<hash>` attribute to every element it renders, then rewrites each selector's **subject** to require that attribute:

```css
/* you write */        .card { padding: 1rem }
/* compiles to */      .card[data-s-a1b2c3] { padding: 1rem }
```

Only the subject (the rightmost compound) is scoped, so descendant and combinator selectors keep working:

```css
.card .title { … }   →   .card .title[data-s-a1b2c3] { … }
```

## Escape with :global(...)

Wrap a selector (or part of one) in `:global(...)` to opt out of scoping — useful for styling markup you don't own:

```css
:global(.prose a) { text-decoration: underline }
```

## Keyframes

`@keyframes` names are scoped per-hash automatically, and `animation` / `animation-name` references are rewritten to match — so two components can both define `@keyframes spin` without collision.

## With class:list

Scoped rules match classes composed at runtime by [`class:list`](/guides/directives/#classlist--reactive-classes), since the scope attribute is on the element, not the class. A reactively-toggled class picks up its scoped rule exactly like a static one.
