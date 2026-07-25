import type { AnyMachineDef } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { reenterSessionEvent } from './effects.ts'
import { scopedLogger } from './logger.ts'
import type { MachineStore } from './machine-store.ts'

const timerLog = scopedLogger('timers')

/** Timer scope for app machines. They're process singletons (one instance per
 *  name), so they share one scope and the machine name disambiguates the key —
 *  unlike session machines, which scope by session id. */
export const APP_SCOPE = '@app'

/**
 * Process-wide, in-memory, NON-DURABLE registry for `after` state timeouts.
 * Session runtimes are transient (per request) and app instances live for the
 * process, so a timer can't live on either — it lives here, keyed by the state
 * it's counting down for, and fires across (or between) requests. A process
 * restart drops armed timers (the 1.0 non-durable contract, same as effects).
 */
const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

const key = (scope: string, machineName: string, stateKey: string): string =>
  `${scope} ${machineName} ${stateKey}`

/** Cancel every `after` timer armed for a (scope, machine, state). `scope` is
 *  the session id for session machines, `APP_SCOPE` for app machines. */
export function cancelAfterTimers(scope: string, machineName: string, stateKey: string): void {
  const k = key(scope, machineName, stateKey)
  const handles = timers.get(k)
  if (!handles) return
  for (const h of handles) clearTimeout(h)
  timers.delete(k)
}

/** Floor for a re-armed timer whose deadline already passed while no process
 *  was watching — fires promptly, but after the arming request's lock work. */
const OVERDUE_FIRE_MS = 40

/**
 * Arm the `after` timers declared on `stateKey` (a no-op if it declares none).
 * The host calls this when a machine ENTERS the state — or, with
 * `opts.enteredAt`, when a hydrating runtime RESTORES it: the delay is then
 * credited with time already served (deadline = enteredAt + delay, so re-arms
 * across requests are deadline-idempotent, and a deadline that passed while no
 * process was alive fires promptly instead of never). Each timer, on elapse,
 * dispatches its `send` event back through the machine's normal event path —
 * a session machine through the session re-entry (fresh lock + hydrate), an app
 * machine through `dispatchToApp` (no lock; the long-lived instance is sent
 * directly). Either way it's guard-dropped if the state has since moved on (the
 * cancel-on-exit is the fast path; the guard-drop is the correctness backstop).
 * Re-arming clears any stale timers for the key first.
 */
export function armAfterTimers(
  store: MachineStore,
  scope: string,
  def: AnyMachineDef,
  stateKey: string,
  ctx: object,
  opts?: { restore: true; enteredAt?: number },
): void {
  const after = def.states[stateKey]?.after
  if (!after || after.length === 0) return
  const k = key(scope, def.name, stateKey)
  // Restore mode: an arm-set already ticking in this process is authoritative
  // (same deadline by construction) — re-arming here would RESET an overdue
  // timer's short fuse on every hydration, and a hot session could starve it
  // forever. Restore only fills the void after a restart or lost timer. This
  // holds even for pre-upgrade snapshots with no enteredAt (unknown elapsed
  // time restarts the full delay — once, not per request).
  if (opts?.restore && timers.has(k)) return
  cancelAfterTimers(scope, def.name, stateKey)
  const handles = after.map((entry) => {
    const declared = typeof entry.delay === 'function' ? entry.delay(ctx as never) : entry.delay
    const delay =
      opts?.restore && opts.enteredAt !== undefined
        ? Math.max(declared - (Date.now() - opts.enteredAt), OVERDUE_FIRE_MS)
        : declared
    const h = setTimeout(() => {
      timers.delete(k) // a state has one arm-set; drop the whole key on fire
      const fire =
        def.lifecycle === 'app'
          ? dispatchToApp(store, def, entry.send as never).then(() => {})
          : reenterSessionEvent(store, scope, def.name, entry.send)
      void fire.catch((err) => {
        timerLog.error(
          { scope, machine: def.name, state: stateKey, err: String(err) },
          'after-timer dispatch failed',
        )
      })
    }, delay)
    // Don't keep the process alive for a pending timer.
    ;(h as unknown as { unref?: () => void }).unref?.()
    return h
  })
  timers.set(k, handles)
}
