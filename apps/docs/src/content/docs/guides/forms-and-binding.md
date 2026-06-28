---
title: Forms and two-way binding
description: "Two-way bind:value/checked, the @set built-in, and isomorphic validation."
sidebar:
  order: 5
---

Two-way binding keeps an input and a client machine in sync. It's a [client component](/guides/client-components/) feature — bind to **client** state, never server state (you don't want the network in the typing loop).

## Bind an input

```astro
<input bind:value={draft.query} />
<input type="checkbox" bind:checked={draft.agree} />
```

## How it desugars

`bind:value` is two halves: a state→DOM write (keeps the input current) and a DOM→state update via the engine's built-in `@set` event (assigns one context key on input). You get both directions from one directive.

## Loop-break and IME safety

The writeback is suppressed when the value is unchanged, so the cursor isn't reset mid-edit, and no update fires while an IME composition is in progress (`isComposing`). Composed input (CJK, accents) works correctly.

## Typed values

`bind:checked` reads `.checked`; an `<input type="number">` coerces to a number. You get the native typed value, not a string.

## Isomorphic validation

A validation selector is a plain function of context, so the **same** selector runs server- and client-side. Bind its result back into the form:

```js
select: { error: (s) => s.email.includes('@') ? null : 'Invalid email' }
```

```astro
<span bind:text={form.error}></span>
```

## Custom commit timing

For commit-on-blur, debounce, or transform-before-store, drop `bind:value` and wire the two halves yourself:

```astro
<input value={read(draft, d => d.query)}
       on:change={(e) => draft.send({ type: '@set', key: 'query', value: e.target.value })} />
```

:::caution[Deferred]
A `bind:value|lazy` modifier is **not** available — the `|` pipe doesn't parse as JSX. Use the eject pattern above for non-default commit timing.
:::
