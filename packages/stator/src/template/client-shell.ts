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
  base: Record<string, string | boolean> = {},
): string {
  // The component's own root static attributes are the BASE; usage-site props
  // (below) win on scalar conflict and `class`/`style` concatenate (FINDINGS #4).
  // Live read() props emit separately since their value changes over the wire.
  const staticAttrs = new Map<string, string | true>()
  for (const key in base) {
    const v = base[key]
    if (v === false) continue
    staticAttrs.set(key, v === true ? true : String(v))
  }
  const setMerged = (name: string, value: string | true): void => {
    const prev = staticAttrs.get(name)
    if (
      (name === 'class' || name === 'style') &&
      typeof prev === 'string' &&
      typeof value === 'string'
    ) {
      staticAttrs.set(name, `${prev} ${value}`.trim())
    } else {
      staticAttrs.set(name, value)
    }
  }

  let elementId: string | null = null
  let liveOut = ''
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
      if (!elementId) elementId = allocElementId(state)
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
      liveOut += r.value === true ? ` ${name}` : ` ${name}="${escapeAttribute(String(r.value))}"`
      continue
    }

    if (decl[key] === 'boolean') {
      if (v) setMerged(name, true)
    } else {
      setMerged(name, String(v))
    }
  }

  let out = ''
  if (elementId) out += ` data-stator-id="${elementId}"`
  for (const [name, value] of staticAttrs) {
    out += value === true ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`
  }
  return out + liveOut
}
