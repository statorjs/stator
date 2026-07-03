import type { AnyMachineDef, EventOf } from '../engine/index.ts'

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
  const data = (await res.json()) as { patches?: Patch[] }
  applyPatches(data.patches ?? [])
  return true
}

type Patch =
  | { target: { kind: 'slot'; id: string }; op: 'text'; value: string }
  | { target: { kind: 'slot'; id: string }; op: 'html'; value: string }
  | {
      target: { kind: 'element'; id: string }
      op: 'attr'
      name: string
      value: string
    }

function applyPatches(patches: Patch[]): void {
  for (const p of patches) {
    if (p.target.kind === 'slot') {
      const el = document.querySelector(`[data-slot="${p.target.id}"]`)
      if (!el) continue
      if (p.op === 'text') el.textContent = p.value
      else if (p.op === 'html') el.innerHTML = p.value
    } else if (p.target.kind === 'element' && p.op === 'attr') {
      const el = document.querySelector(`[data-stator-id="${p.target.id}"]`)
      if (el) el.setAttribute(p.name, p.value)
    }
  }
}
