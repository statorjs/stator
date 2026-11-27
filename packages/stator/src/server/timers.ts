import type { AnyMachineDef } from '../engine/index.ts'
import { dispatchToApp } from './app-dispatch.ts'
import { reenterSessionEvent } from './effects.ts'
import { logSid, scopedLogger } from './logger.ts'
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
 * restart drops armed timers (non-durable, like effects).
 */
const timers = new Map<string, LongTimer[]>()

/** Longest delay `setTimeout` honours (2^31-1 ms, about 24.8 days). Node
 *  clamps anything larger to 1 ms, so a longer `after` is waited out in steps
 *  of at most this size. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

/** One `after` timer. `handle` is whichever step is pending, so a cancel
 *  mid-way clears the step that is actually ticking. */
interface LongTimer {
  handle: ReturnType<typeof setTimeout> | undefined
}

/** `setTimeout` for any delay: a delay over `MAX_TIMEOUT_MS` is waited out in
 *  steps, and `fn` runs once at the end. Each step re-reads the clock and
 *  waits for what is left of the deadline, so a late step doesn't push the
 *  fire later. Every step is unref'd — a pending timer doesn't keep the
 *  process alive. */
function setLongTimeout(fn: () => void, delay: number): LongTimer {
  const timer: LongTimer = { handle: undefined }
  const finish = (): void => {
    timer.handle = undefined
    fn()
  }
  // The common case (and NaN) is exactly the setTimeout call it always was.
  if (!(delay > MAX_TIMEOUT_MS)) {
    timer.handle = unrefd(setTimeout(finish, delay))
    return timer
  }
  const deadline = Date.now() + delay
  const step = (): void => {
    const remaining = deadline - Date.now()
    timer.handle = unrefd(
      remaining > MAX_TIMEOUT_MS ? setTimeout(step, MAX_TIMEOUT_MS) : setTimeout(finish, remaining),
    )
  }
  step()
  return timer
}

const unrefd = (h: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
  ;(h as unknown as { unref?: () => void }).unref?.()
  return h
}

function clearLongTimeout(timer: LongTimer): void {
  if (timer.handle !== undefined) clearTimeout(timer.handle)
  timer.handle = undefined
}

const key = (scope: string, machineName: string, stateKey: string): string =>
  `${scope} ${machineName} ${stateKey}`

/** Cancel every `after` timer armed for a (scope, machine, state). `scope` is
 *  the session id for session machines, `APP_SCOPE` for app machines. */
export function cancelAfterTimers(scope: string, machineName: string, stateKey: string): void {
  const k = key(scope, machineName, stateKey)
  const handles = timers.get(k)
  if (!handles) return
  for (const t of handles) clearLongTimeout(t)
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
    // Through setLongTimeout, not setTimeout: a day-scale delay (or a
    // restored remainder of one) past 2^31-1 ms would otherwise fire in 1 ms.
    return setLongTimeout(() => {
      timers.delete(k) // a state has one arm-set; drop the whole key on fire
      const fire =
        def.lifecycle === 'app'
          ? dispatchToApp(store, def, entry.send as never).then(() => {})
          : reenterSessionEvent(store, scope, def.name, entry.send)
      void fire.catch((err) => {
        timerLog.error(
          { scope: logSid(scope), machine: def.name, state: stateKey, err: String(err) },
          'after-timer dispatch failed',
        )
      })
    }, delay)
  })
  timers.set(k, handles)
}
