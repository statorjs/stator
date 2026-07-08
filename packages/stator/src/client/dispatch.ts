import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { applyDirectives, applyPatches } from '../wire/apply.ts'
import type { WireEnvelope } from '../wire/index.ts'
import { clientId } from './client-id.ts'

export interface DispatchResult {
  /** The POST reached the server and returned 200. */
  ok: boolean
  /** The event committed a transition. `ok && !committed` means a guard
   *  dropped it — the UI should not pretend something happened. */
  committed: boolean
  /** Patches applied to THIS page (a committed event may patch zero slots
   *  here if the touched machines aren't bound on the current route). */
  patchCount: number
}

/**
 * Commit an event to a SERVER machine over the existing `/__events` wire — the
 * one visible boundary crossing from a client island. Addressed by the imported
 * machine def (not a magic string); the event is typed against that machine's
 * event union. Applies the returned patches and reports what actually
 * happened: transport success, commit, and patch count are three different
 * facts, and buttons that say "done" should be looking at `committed`.
 *
 * This is the client half of [[typed-events-and-machine-mediated-dispatch]].
 * The compiler resolves a server-machine identity import into a stub carrying
 * `{ name }`; this helper reads the name and posts.
 */
export async function dispatch<D extends AnyMachineDef>(
  machine: D,
  event: EventOf<D>,
): Promise<DispatchResult> {
  let res: Response
  try {
    res = await fetch('/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Stator-Route': `GET ${location.pathname}${location.search}`,
        'X-Stator-Client': clientId,
      },
      credentials: 'same-origin',
      body: JSON.stringify({ machine: machine.name, event }),
    })
  } catch (err) {
    console.error('stator: dispatch network error', err)
    return { ok: false, committed: false, patchCount: 0 }
  }
  if (!res.ok) {
    console.error('stator: dispatch failed', res.status)
    return { ok: false, committed: false, patchCount: 0 }
  }
  const data = (await res.json()) as WireEnvelope
  applyPatches(data.patches ?? [])
  applyDirectives(data.directives ?? [])
  return {
    ok: true,
    committed: data.committed ?? true,
    patchCount: data.patches?.length ?? 0,
  }
}
