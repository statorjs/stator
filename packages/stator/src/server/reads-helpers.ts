import type { ActionHelpers, AnyMachineDef } from '../engine/index.ts'
import { getDispatchContext } from './dispatch-context.ts'

/**
 * Server-side resolver for an action/guard's `peers` helper (also handed out
 * under its old name, `reads`). The engine is host-agnostic (it imports no
 * server module); the *server* supplies how peers are resolved — through the
 * active dispatch context's runtime, exactly as the POC did. A peer-free
 * machine never invokes this; a machine that dereferences peers outside an
 * active dispatch gets a clear error (matching prior behavior).
 */
export function serverReadsResolver(def: AnyMachineDef): () => ActionHelpers {
  return () => {
    const dc = getDispatchContext()
    if (!dc) {
      const peers = new Proxy({} as Record<string, unknown>, {
        get(_t, prop) {
          throw new Error(
            `stator: "${def.name}" accessed peers.${String(prop)} (helpers.peers, or its old ` +
              `name helpers.reads) outside an active dispatch — actions/guards that use peers ` +
              `must run through store.processEvent(...) (or actor.send() inside a subscription ` +
              `handler), not a bare send.`,
          )
        },
      })
      return { peers, reads: peers }
    }
    const peers: Record<string, unknown> = {}
    for (const r of def.reads) {
      const proxy = dc.runtime.proxyFor(r.name)
      if (!proxy) {
        throw new Error(
          `stator: "${def.name}" declares "${r.name}" as a peer but it's not loaded ` +
            `in the active runtime — loadGraph(...) should pull it in transitively.`,
        )
      }
      peers[r.name] = proxy
    }
    return { peers, reads: peers }
  }
}
