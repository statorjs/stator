import type { RenderState } from './render-context.ts'

const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * A hash of a render's root-scope bindings: what each one is, where it sits
 * and which selector feeds it. Two renders with the same fingerprint address
 * the same elements by the same ids, so patches computed from one apply to a
 * page produced by the other. Bindings inside a `when`/`match` arm, a list row
 * or a `defer` slot (a `:` in the slot id) are left out: those scopes are
 * rebuilt by their own patches.
 *
 * Undefined when the render has no root-scope bindings. A consistency check
 * between renders by the same server code, not a security boundary.
 */
export function layoutFingerprint(state: RenderState): string | undefined {
  let hash = FNV_OFFSET
  let found = false
  const add = (part: string): void => {
    for (let i = 0; i < part.length; i++) {
      hash = Math.imul(hash ^ part.charCodeAt(i), FNV_PRIME)
    }
    // Field separator, so adjacent parts cannot run together.
    hash = Math.imul(hash ^ 0xff, FNV_PRIME)
  }
  for (const binding of state.bindings.values()) {
    if (binding.slotId.includes(':')) continue
    found = true
    add(binding.slotId)
    add(binding.kind)
    add(binding.machineName)
    if (binding.kind === 'attr') {
      add(binding.parentId)
      add(binding.attrName)
    }
    add(String(binding.selector))
  }
  return found ? (hash >>> 0).toString(16).padStart(8, '0') : undefined
}
