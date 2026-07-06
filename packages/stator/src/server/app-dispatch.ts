import type { AnyMachineDef, EventOf } from '../engine/index.ts'
import { withDispatchContext } from './dispatch-context.ts'
import type { MachineStore } from './machine-store.ts'
import { SessionRuntime } from './session-runtime.ts'
import { fanOut } from './sse.ts'

/**
 * Server-originated dispatch to an APP-lifecycle machine — the entry point
 * for webhooks, cron jobs, and app-effect completions. No HTTP request, no
 * session, no lock (app actors are long-lived and in-process; sends are
 * atomic): send → persist opted-in touched app machines → fan out to every
 * live SSE connection whose route reads a touched machine.
 *
 * Typed like client dispatch: the machine is addressed by its imported def
 * and the event checks against its declared union.
 */
export async function dispatchToApp<D extends AnyMachineDef>(
  store: MachineStore,
  machine: D,
  event: EventOf<D>,
): Promise<void> {
  const name = machine.name
  const handle = store.appInstance(name)
  if (!handle) {
    const known = store.hasMachine(name)
    throw new Error(
      known
        ? `stator: dispatchToApp("${name}") — machine is not app-lifecycle. ` +
            `Session machines are dispatched per-session via /__events or an API route.`
        : `stator: dispatchToApp("${name}") — unknown machine. Is it in the machines directory?`,
    )
  }

  const touched = new Set<string>([name])
  // A throwaway runtime backs `reads` resolution for the dispatch context:
  // app machines resolve via its app-instance fallback, and a stray read of a
  // session machine throws (correct — there is no session here).
  const runtime = new SessionRuntime(`@app-dispatch:${name}`, store)
  try {
    const before = handle.actor.getCommitCount()
    withDispatchContext({ runtime, touched }, () => {
      handle.actor.send(event as never)
    })
    if (handle.actor.getCommitCount() === before) touched.delete(name)
    for (const touchedName of touched) {
      await store.persistAppMachine(touchedName)
    }
    await fanOut(touched)
  } finally {
    runtime.dispose()
  }
}
