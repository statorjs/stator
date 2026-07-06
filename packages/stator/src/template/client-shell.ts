import { allocElementId, getCurrentRenderState, registerBinding } from '../server/render-context.ts'
import { escapeAttribute } from './parser.ts'
import { isReadResult, type ReadResult } from './read.ts'

/**
 * Server-side: render a client component's declared attributes onto its
 * custom-element root. A client component's server module calls this to map
 * camelCase props → kebab DOM attributes (`unitPrice` → `unit-price`), per the
 * `static attrs` coercer kinds. Booleans are presence flags; other scalars are
 * stringified + escaped. `null`/`undefined`/`false`-boolean → omitted.
 *
 * A prop may be a `read(...)`: the attribute becomes a LIVE binding — the
 * server patches it like any attr binding, and the island (which observes
 * its declared attrs) receives `${key}Changed(next)`. This is the sanctioned
 * channel for live server state flowing INTO an island.
 *
 * Returns a leading-spaced attribute string (or '') to splice into the open tag.
 */
export function clientShellAttrs(
  props: Record<string, unknown>,
  decl: Record<string, 'number' | 'string' | 'boolean'>,
): string {
  let out = ''
  let elementId: string | null = null
  for (const key in decl) {
    const v = props[key]
    if (v == null) continue
    const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

    if (isReadResult(v)) {
      const state = getCurrentRenderState()
      if (!state) {
        throw new Error(
          `stator: read() passed as island prop "${key}" outside a render — ` +
            `live island attrs only make sense inside a route render.`,
        )
      }
      if (!elementId) {
        elementId = allocElementId(state)
        out += ` data-stator-id="${elementId}"`
      }
      const r = v as ReadResult
      registerBinding(state, {
        slotId: r.slotId,
        machineName: r.machineName,
        selector: r.selector,
        lastValue: r.value,
        kind: 'attr',
        attrName: name,
        parentId: elementId,
      })
      // Same value semantics as template attr bindings (boolean-aware).
      if (r.value === false || r.value === null || r.value === undefined) continue
      out += r.value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(r.value))}"`
      continue
    }

    if (decl[key] === 'boolean') {
      if (v) out += ` ${name}`
    } else {
      out += ` ${name}="${escapeAttribute(String(v))}"`
    }
  }
  return out
}
