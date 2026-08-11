---
title: "template"
description: "The server rendering primitives: html, read, each/when/match, defer, raw, and directives."
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

Renders a list delimited by HTML comment markers — no wrapper element is injected, so the rows are real children of their parent (`each` works inside `<tbody>`, `<select>`, and `<ul>`, and sibling selectors like `.a + .b` or `:nth-child` match what you wrote). Pass a `ReadResult` and the list is reactive; without `key`, any list change re-renders the whole body.

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

## defer

```ts
function defer<T>(
  thunk: () => T | Promise<T>,
  arms: { ready: (value: Awaited<T>) => HtmlFragment; error?: (reason: unknown) => HtmlFragment },
): DeferResult
```

An async region inside a synchronous render. The thunk is kicked during the render pass (closing over frontmatter locals), awaited in parallel with every other `defer` on the page, and the `ready`/`error` arm renders inline — a synchronous or already-resolved value fills with no added latency. Without an `error` arm, a rejection bubbles to route-level error handling.

Unlike `each`/`when`/`match` results, a `DeferResult` registers **no binding**: the region is static, never re-diffed, and the thunk is never re-run by `/__events` recomputes (that would run I/O under the session lock). Use it for request-scoped data; state that changes after first render belongs in a machine — see [Defer vs. machine](/recipes/defer-vs-machine/). Arm/result types: `DeferArms`, `DeferResult`.

## raw

```ts
function raw(html: string): HtmlFragment
```

The one documented unsafe seam: wraps a trusted HTML string so it's emitted **verbatim**, bypassing auto-escaping — the server analog of React's `dangerouslySetInnerHTML`. Only pass markup you constructed or fully trust, never unsanitized user input. Typical use is an already-escaped serialized block; for JSON-LD specifically, reach for [`JsonLd`](/reference/components/#jsonld) instead.

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

## Lower-level exports

What the compiler's output and the recompute pass run on — **Toolchain** tier per the [stability policy](/reference/overview/#stability-policy): these may change in a minor. (`HtmlFragment`, `ReadResult`, and `InstanceOf` are the exceptions your own render functions legitimately type against; they're Stable.)

- `HtmlFragment` / `createHtmlFragment` / `isHtmlFragment` — the branded fragment type and its constructors.
- `ReadResult` / `isReadResult` — the reactive-value carrier `read()` returns.
- `EachResult` / `isEachResult` / `renderListBody` — list result shape and the body renderer recompute reuses.
- `BranchResult` / `isBranchResult` / `renderBranchBody` — the `when`/`match` equivalents.
- `DeferResult` / `isDeferResult` — the `defer` result shape (no body renderer — defer regions never re-render).
- `itemBind` — per-row item-binding plumbing the compiler lowers `read(item, …)` to inside keyed lists.
- `isDirectiveInvocation` — directive invocation plumbing.
- `spreadAttrs` — the attribute-bag renderer `{...rest}` lowers to.
- `clientShellAttrs` — attributes the compiler puts on a client island's server-rendered shell.
- `InstanceOf` — re-exported machine instance type (what `read`'s first parameter is). An instance's `state` is typed to the machine's state-name union and its `send()` to the event union, so a typo in a state comparison, an event name, or a payload is a compile error.
- Attribute types: `HTMLAttributes<Tag>` (a component's typed pass-through surface — see [attribute spread](/guides/templates/#attribute-spread)), `GlobalHTMLAttributes`, `AriaAttributes`, `ElementSpecificAttributes`, `StatorIntrinsicElements`, `StatorDirectiveAttributes`, and `Reactive` (the wrapper admitting a `ReadResult` where a plain value is expected). `SpreadAttrs` types the `{...rest}` bag.
