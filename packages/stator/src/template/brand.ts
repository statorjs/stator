/**
 * Trust brands for template values.
 *
 * The `html` tag splices some values verbatim — an `html`/`raw()` fragment, an
 * `each`/`when`/`match`/`defer` region — and treats others as live bindings
 * (`read()`, an item read, a directive). It recognises them by a brand. A brand
 * must be something no untrusted input can carry: a string-keyed property such
 * as `{ "__isHtmlFragment": true }` survives `JSON.parse`, so a value from a
 * store, a remote API or an event payload could claim to be trusted markup.
 *
 * Symbol-keyed properties are dropped by `JSON.parse` (and by structured clone),
 * so a brand here can only be set by the framework's own constructors.
 * `Symbol.for` puts the symbols in the global registry: two copies of the
 * package loaded in one process (an app and a component library, say) mint the
 * same symbols and recognise each other's values.
 */

export const HTML_FRAGMENT: unique symbol = Symbol.for('@statorjs/stator:html-fragment')
export const EACH_RESULT: unique symbol = Symbol.for('@statorjs/stator:each-result')
export const BRANCH_RESULT: unique symbol = Symbol.for('@statorjs/stator:branch-result')
export const DEFER_RESULT: unique symbol = Symbol.for('@statorjs/stator:defer-result')
export const READ_RESULT: unique symbol = Symbol.for('@statorjs/stator:read-result')
export const ITEM_READ: unique symbol = Symbol.for('@statorjs/stator:item-read')
export const DIRECTIVE_INVOCATION: unique symbol = Symbol.for(
  '@statorjs/stator:directive-invocation',
)

/** True when `v` is an object carrying `brand`. Only framework constructors set
 *  a brand; nothing parsed from JSON can. */
export function hasBrand(v: unknown, brand: symbol): boolean {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[brand] === true
}
