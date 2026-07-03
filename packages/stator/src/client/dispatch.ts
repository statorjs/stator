import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { applyDirectives, applyPatches } from '../wire/apply.ts'
import type { WireEnvelope } from '../wire/index.ts'

/**
 * Commit an event to a SERVER machine over the existing `/__events` wire — the
 * one visible boundary crossing from a client island. Addressed by the imported
 * machine def (not a magic string); the event is typed against that machine's
 * event union. Applies the returned patches.
 *
 * This is the client half of [[typed-events-and-machine-mediated-dispatch]].
 * The compiler resolves a server-machine identity import into a stub carrying
 * `{ name }`; this helper reads the name and posts.
 */
export async function dispatch<D extends AnyMachineDef>(
  machine: D,
  event: EventOf<D>,
): Promise<boolean> {
  let res: Response
  try {
    res = await fetch('/__events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Stator-Route': `GET ${location.pathname}`,
      },
      credentials: 'same-origin',
      body: JSON.stringify({ machine: machine.name, event }),
    })
  } catch (err) {
    console.error('stator: dispatch network error', err)
    return false
  }
  if (!res.ok) {
    console.error('stator: dispatch failed', res.status)
    return false
  }
  const data = (await res.json()) as WireEnvelope
  applyPatches(data.patches ?? [])
  applyDirectives(data.directives ?? [])
  return true
}
