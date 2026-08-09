import { isUrlAttribute, safeAttrUrl } from './safe-url.ts'

/**
 * THE attribute-value contract — one implementation for every tier that
 * writes an attribute: static render (template/html.ts), the live diff
 * (server/recompute.ts), the island writer codegen (compiler/client-emit.ts,
 * via the client re-export), and the wire applier (wire/apply.ts).
 *
 * Boolean-absent semantics: `false`/`null`/`undefined` → `null`, meaning the
 * attribute is ABSENT (`checked={expr}` must be able to render unchecked, and
 * a static render must agree with what a live patch of the same attribute
 * does). `true` → present-and-empty. Arrays join with no separator (matching
 * text interpolation); everything else stringifies.
 *
 * History: this contract used to live in four drifting copies, and two of
 * them disagreed in ways users hit — `checked={false}` rendered
 * `checked="false"` on the static path, and array values patched as "a,b"
 * but rendered as "ab". One implementation, so the seams can't disagree.
 */
export function attrValue(v: unknown): string | null {
  if (v === false || v === null || v === undefined) return null
  if (v === true) return ''
  return stringifyAttr(v)
}

function stringifyAttr(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(stringifyAttr).join('')
  return String(v)
}

/** The text-position value contract, shared by static render and text
 *  patches: null/undefined → empty, arrays join with no separator (an
 *  interpolated list of fragments/strings renders concatenated, not
 *  comma-joined), everything else stringifies. */
export function textValue(v: unknown): string {
  return stringifyAttr(v)
}

/** Scheme guard for url-bearing attributes (href/src/…): strip a
 *  javascript:/vbscript: value whether it arrives at first render or through
 *  a later diff. `null` (attribute-absent) passes through. */
export function sanitizeAttr(name: string, value: string): string
export function sanitizeAttr(name: string, value: string | null): string | null
export function sanitizeAttr(name: string, value: string | null): string | null {
  if (value === null) return null
  return isUrlAttribute(name) ? safeAttrUrl(value) : value
}

/** The DOM half of the contract: `null` removes, a string sets. */
export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
}
