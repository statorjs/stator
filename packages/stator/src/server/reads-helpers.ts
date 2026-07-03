import type { ActionHelpers, AnyMachineDef } from '../engine/index.ts'
import { getDispatchContext } from './dispatch-context.ts'

/**
 * Server-side resolver for an action/guard's `reads` helper. The engine is
 * host-agnostic (it imports no server module); the *server* supplies how reads
 * are resolved — through the active dispatch context's runtime, exactly as the
 * POC did. A reads-free machine never invokes this; a machine that dereferences
 * reads outside an active dispatch gets a clear error (matching prior behavior).
 */
export function serverReadsResolver(def: AnyMachineDef): () => ActionHelpers {
  return () => {
    const dc = getDispatchContext()
    if (!dc) {
      return {
        reads: new Proxy({} as Record<string, unknown>, {
          get(_t, prop) {
            throw new Error(
              `stator: "${def.name}" accessed reads.${String(prop)} outside an active dispatch — ` +
                `actions/guards that use reads must run through store.processEvent(...) ` +
                `(or actor.send() inside a subscription handler), not a bare send.`,
            )
          },
        }),
      }
    }
    const reads: Record<string, unknown> = {}
    for (const r of def.reads) {
      const proxy = dc.runtime.proxyFor(r.name)
      if (!proxy) {
        throw new Error(
          `stator: "${def.name}" declares reads on "${r.name}" but it's not loaded ` +
            `in the active runtime — loadGraph(...) should pull it in transitively.`,
        )
      }
      reads[r.name] = proxy
    }
    return { reads }
  }
}
