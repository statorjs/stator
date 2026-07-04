---
title: "template"
description: "The server rendering primitives: html, read, each/when/match, raw, and directives."
sidebar:
  order: 4
---

`@statorjs/stator/template` is what `.stator` templates compile down to — you import from it directly when writing render functions in plain TS.

## html

```ts
function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlFragment
```

The tagged template that builds a page. Plain interpolated values are auto-escaped for their position (text or attribute value); nested `html` fragments, `each`/`when`/`match` results, and `read` results are handled structurally. Position rules are enforced: fragments and control-flow results only in text position, directive invocations only in attribute-name position, and a violation throws at render time rather than emitting broken markup.

## read

```ts
function read<TDef, T>(instance: InstanceOf<TDef>, selector: (instance) => T): ReadResult<T>
```

The reactive primitive. Called with a machine instance from the route context and a selector, it renders the current value **and** registers a binding at that DOM position — when a dispatch changes the selected value, the server emits a patch for exactly that slot. A `ReadResult` also feeds `each`, `when`, `match`, and the `classList`/`styleList` specs to make those positions reactive.

## each

```ts
function each<T>(
  items: readonly T[] | ReadResult<readonly T[]>,
  fn: (item: T, index: number) => HtmlFragment,
  opts?: { key?: (item: T) => string | number },
): EachResult
```

Renders a list inside an invisible (`display: contents`) marker span. Pass a `ReadResult` and the list is reactive; without `key`, any list change re-renders the whole body.

With `key`, list changes emit per-item `insert`/`remove`/`move` patches instead — inner state like focus and CSS transitions survives reorders. Keyed lists have two hard rules, both enforced with thrown errors: keys must be unique strings or finite numbers (duplicates are a data bug, not something to be polite about), and each keyed item must render **exactly one root element** — the patch ops address list children by index, so a multi-root item would corrupt every sibling index after it.

## when

```ts
function when<T>(cond: T | ReadResult<T>, fn: () => HtmlFragment): BranchResult
```

Renders `fn()` when `cond` is truthy, nothing otherwise — the inactive branch's DOM is genuinely absent, not hidden. Re-renders only when truthiness flips; toggling between two truthy values doesn't swap.

## match

```ts
function match<TKey extends string>(
  key: TKey | ReadResult<TKey>,
  cases: Partial<Record<TKey, () => HtmlFragment>>,
): BranchResult
```

Renders the case matching `key`, or nothing when no case matches. Re-renders only when the key changes. When `key` is a `ReadResult` over a string-literal union, the cases are checked against that union.

## raw

```ts
function raw(html: string): HtmlFragment
```

The one documented unsafe seam: wraps a trusted HTML string so it's emitted **verbatim**, bypassing auto-escaping — the server analog of `set:html`. Only pass markup you constructed or fully trust, never unsanitized user input. Typical use is an already-escaped serialized block; for JSON-LD specifically, reach for [`JsonLd`](/reference/components/#jsonld) instead.

## on

```ts
function on(modifier: string, handler: () => EventDescriptor): DirectiveInvocation
```

The event directive, placed in attribute-name position: `${on('click', () => cart.send({ type: 'ADD' }))}`. The handler must be exactly one `machine.send(...)` call — it's serialized into a `data-event-*` attribute the client runtime posts back, not executed in the browser.

## classList / styleList

```ts
function classList(spec: ClassListSpec): DirectiveInvocation
function styleList(spec: StyleListSpec): DirectiveInvocation
```

Compound-attribute directives that own the whole `class` / `style` attribute. A spec mixes static strings, arrays, and `{ name: condition }` objects, where any condition (or entry) may be a `read()` — the directive registers one binding per machine in the spec, and any change re-emits the **full** composed attribute value in a single patch. Spec types: `ClassListSpec`, `StyleListSpec`.

## defineDirective

```ts
function defineDirective<TArg>(def: { name: string; apply(ctx: DirectiveContext<TArg>): void }): Directive<TArg>
```

Defines a custom template directive. `apply` runs at render time with `{ elementId, modifier, arg, addAttribute, registerCleanup }` — most directives compose down to attributes the client runtime interprets. Pair with `invoke(directive, modifier, arg)` to produce the invocation you interpolate. Related types: `Directive`, `DirectiveContext`, `DirectiveDefinition`, `DirectiveInvocation`.

## Lower-level exports

- `HtmlFragment` / `createHtmlFragment` / `isHtmlFragment` — the branded fragment type and its constructors.
- `ReadResult` / `isReadResult` — the reactive-value carrier `read()` returns.
- `EachResult` / `isEachResult` / `renderListBody` — list result shape and the body renderer recompute reuses.
- `BranchResult` / `isBranchResult` / `renderBranchBody` — the `when`/`match` equivalents.
- `invoke` / `isDirectiveInvocation` — directive invocation plumbing.
- `clientShellAttrs` — attributes the compiler puts on a client island's server-rendered shell.
- `InstanceOf` — re-exported machine instance type (what `read`'s first parameter is).
