import { escapeAttribute } from './parser.ts'

/**
 * Server-side: render a client component's declared attributes onto its
 * custom-element root. A client component's server module calls this to map
 * camelCase props → kebab DOM attributes (`unitPrice` → `unit-price`), per the
 * `static attrs` coercer kinds. Booleans are presence flags; other scalars are
 * stringified + escaped. `null`/`undefined`/`false`-boolean → omitted.
 *
 * Returns a leading-spaced attribute string (or '') to splice into the open tag.
 */
export function clientShellAttrs(
  props: Record<string, unknown>,
  decl: Record<string, 'number' | 'string' | 'boolean'>,
): string {
  let out = ''
  for (const key in decl) {
    const v = props[key]
    if (v == null) continue
    const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    if (decl[key] === 'boolean') {
      if (v) out += ` ${name}`
    } else {
      out += ` ${name}="${escapeAttribute(String(v))}"`
    }
  }
  return out
}
