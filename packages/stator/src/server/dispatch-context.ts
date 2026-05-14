import type { SessionRuntime } from './session-runtime.ts'

/**
 * The slice of runtime context an action or guard needs while a single
 * event is being processed:
 *   - `runtime` so it can resolve `reads:` proxies on demand (both session
 *     and app-scoped) via the active SessionRuntime
 *   - `touched` for cross-machine subscription listeners to record which
 *     machines need recomputed patches after the event settles
 *
 * Populated by `SessionRuntime.processEvent`. A single dispatch may fan
 * out through subscription listeners that synchronously call
 * `actor.send` on other machines; all of those nested calls share this
 * same context, so actions running in any of them see the same runtime.
 */
export interface DispatchContext {
  runtime: SessionRuntime
  touched: Set<string>
}

let current: DispatchContext | null = null

export function getDispatchContext(): DispatchContext | null {
  return current
}

export function withDispatchContext<T>(ctx: DispatchContext, fn: () => T): T {
  const prev = current
  current = ctx
  try {
    return fn()
  } finally {
    current = prev
  }
}

export function recordTouch(machineName: string): void {
  if (current) current.touched.add(machineName)
}
