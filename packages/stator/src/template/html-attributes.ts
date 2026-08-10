/**
 * Type-only HTML attribute surface for authoring components that extend a native
 * element — the Astro/Svelte `HTMLAttributes<'button'>` pattern. So a component
 * can be `Stator.props<HTMLAttributes<'button'> & { variant: 'primary' }>()` and
 * get every native button attribute typed + validated, plus its own props.
 *
 * Hand-authored and intentionally LEAN: a useful subset, not the whole DOM. It
 * mirrors `svelte/elements`' shape — a shared base (global attrs + ARIA + the
 * Stator directives) plus a per-element attribute map, combined by tag. Grow the
 * per-element map on demand; there is no compiler machinery behind this.
 *
 * STATOR REACTIVITY: a template attribute value can be a literal OR a live
 * `read(...)` binding (`ReadResult<T>`), so every non-directive attribute value
 * is `Reactive<T>`. This is the adaptation that makes typed intrinsics coexist
 * with Stator templates — the load-bearing difference from Astro/Svelte, where
 * attributes are plain values.
 */

import type { ReadResult } from './read.ts'

/** A template attribute value: a literal, or a live `read(...)` binding. */
export type Reactive<T> = T | ReadResult<T>

/** Wrap every property value in `Reactive` (bindings allowed on any attribute).
 *  Homomorphic, so it preserves the `data-*`/`aria-*` index signatures. */
type Reactivize<A> = { [K in keyof A]: Reactive<A[K]> }

/** Stator template directives — colon-namespaced, valid on any element and on any
 *  component that forwards them. Not reactivized: their values are handlers/specs,
 *  not bindings. Values are `unknown` for now — a later pass gives `on:`/`bind:`/
 *  `ref:` their Stator-specific types. */
export interface StatorDirectiveAttributes {
  'class:list'?: unknown
  'style:list'?: unknown
  [key: `on:${string}`]: unknown
  [key: `ref:${string}`]: unknown
}

/** ARIA — `role` plus the open-ended `aria-*` family. */
export interface AriaAttributes {
  role?: string
  [key: `aria-${string}`]: unknown
}

/** Global attributes present on every HTML element (a lean subset). Numeric
 *  attributes accept `string` too, since templates write them as strings. */
export interface GlobalHTMLAttributes {
  class?: string
  id?: string
  style?: string
  title?: string
  hidden?: boolean
  tabindex?: number | string
  lang?: string
  dir?: 'ltr' | 'rtl' | 'auto'
  draggable?: boolean | 'true' | 'false'
  popover?: boolean | string
  /** Stator named-slot target — `child="header"` fills `<children name="header"/>`. */
  child?: string
  [key: `data-${string}`]: unknown
}

/** Per-element extra attributes. Extend as components need them. */
export interface ElementSpecificAttributes {
  a: { href?: string; target?: string; rel?: string; download?: string | boolean }
  button: {
    type?: 'submit' | 'reset' | 'button'
    disabled?: boolean
    name?: string
    value?: string
    form?: string
    autofocus?: boolean
    popovertarget?: string
    popovertargetaction?: 'show' | 'hide' | 'toggle'
  }
  input: {
    type?: string
    name?: string
    value?: string | number
    placeholder?: string
    disabled?: boolean
    required?: boolean
    readonly?: boolean
    checked?: boolean
    min?: string | number
    max?: string | number
    step?: string | number
    minlength?: number | string
    maxlength?: number | string
    pattern?: string
    autocomplete?: string
    inputmode?: string
    autofocus?: boolean
  }
  label: { for?: string }
  form: {
    action?: string
    method?: 'get' | 'post' | 'GET' | 'POST' | 'dialog'
    novalidate?: boolean
  }
  select: {
    name?: string
    disabled?: boolean
    required?: boolean
    multiple?: boolean
    value?: string | number
  }
  option: { value?: string | number; selected?: boolean; disabled?: boolean }
  textarea: {
    name?: string
    placeholder?: string
    rows?: number | string
    cols?: number | string
    disabled?: boolean
    required?: boolean
    readonly?: boolean
    minlength?: number | string
    maxlength?: number | string
  }
  img: {
    src?: string
    alt?: string
    width?: number | string
    height?: number | string
    loading?: 'eager' | 'lazy'
  }
}

/**
 * The attribute type for a native element `Tag`. Intersect it in a component's
 * props to forward native attributes:
 *
 *   const { variant, ...rest } =
 *     Stator.props<HTMLAttributes<'button'> & { variant: 'primary' | 'danger' }>()
 *
 * `Tag` defaults to the shared base (global + ARIA + directives) for elements not
 * in the per-element map. HTML attribute values are `Reactive` (literal or live
 * binding); directives keep their own value types.
 */
export type HTMLAttributes<Tag extends string = string> = Reactivize<
  GlobalHTMLAttributes &
    AriaAttributes &
    (Tag extends keyof ElementSpecificAttributes
      ? ElementSpecificAttributes[Tag]
      : Record<never, never>)
> &
  StatorDirectiveAttributes

/**
 * The per-element intrinsic map wired into `JSX.IntrinsicElements`, so a typo on
 * a plain `<button typ=>` is a real error. Common HTML tags are typed;
 * the `[tag: string]: any` fallback keeps custom elements (client-island tags
 * like `<live-sky>`) and everything not listed (SVG, rare tags) permissive — the
 * escape valve that stops the typing from flooding real templates. Every explicit
 * entry is assignable to `any`, so the index signature is satisfied.
 */
export interface StatorIntrinsicElements {
  a: HTMLAttributes<'a'>
  button: HTMLAttributes<'button'>
  input: HTMLAttributes<'input'>
  select: HTMLAttributes<'select'>
  option: HTMLAttributes<'option'>
  textarea: HTMLAttributes<'textarea'>
  label: HTMLAttributes<'label'>
  form: HTMLAttributes<'form'>
  img: HTMLAttributes<'img'>
  div: HTMLAttributes<'div'>
  span: HTMLAttributes<'span'>
  p: HTMLAttributes<'p'>
  h1: HTMLAttributes<'h1'>
  h2: HTMLAttributes<'h2'>
  h3: HTMLAttributes<'h3'>
  h4: HTMLAttributes<'h4'>
  h5: HTMLAttributes<'h5'>
  h6: HTMLAttributes<'h6'>
  ul: HTMLAttributes<'ul'>
  ol: HTMLAttributes<'ol'>
  li: HTMLAttributes<'li'>
  nav: HTMLAttributes<'nav'>
  header: HTMLAttributes<'header'>
  footer: HTMLAttributes<'footer'>
  section: HTMLAttributes<'section'>
  main: HTMLAttributes<'main'>
  article: HTMLAttributes<'article'>
  aside: HTMLAttributes<'aside'>
  strong: HTMLAttributes<'strong'>
  em: HTMLAttributes<'em'>
  small: HTMLAttributes<'small'>
  code: HTMLAttributes<'code'>
  pre: HTMLAttributes<'pre'>
  time: HTMLAttributes<'time'>
  cite: HTMLAttributes<'cite'>
  hr: HTMLAttributes<'hr'>
  br: HTMLAttributes<'br'>
  figure: HTMLAttributes<'figure'>
  figcaption: HTMLAttributes<'figcaption'>
  details: HTMLAttributes<'details'>
  summary: HTMLAttributes<'summary'>
  dialog: HTMLAttributes<'dialog'>
  table: HTMLAttributes<'table'>
  thead: HTMLAttributes<'thead'>
  tbody: HTMLAttributes<'tbody'>
  tr: HTMLAttributes<'tr'>
  td: HTMLAttributes<'td'>
  th: HTMLAttributes<'th'>
  fieldset: HTMLAttributes<'fieldset'>
  legend: HTMLAttributes<'legend'>
  // biome-ignore lint/suspicious/noExplicitAny: escape valve — custom-element islands, SVG, and unlisted tags stay fully permissive; every explicit entry above is assignable to this index signature.
  [tag: string]: any
}
