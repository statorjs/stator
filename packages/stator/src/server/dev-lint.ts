import type { TransitionConfig } from '../engine/index.ts'
import type { AnyMachineDef } from './define-machine.ts'

/**
 * Dev-plane lints over the machine graph. Pure analysis — the dev server logs
 * the findings; production builds never run this.
 */

export interface PollLoopFinding {
  machine: string
  state: string
  event: string
  /** One representative cycle, e.g. ['ready', 'revalidating', 'ready']. */
  cycle: string[]
}

/**
 * Detect self-rescheduling poll loops on SESSION machines: a state's `after`
 * timer sends an event whose transitions leave the state and eventually return
 * to it, with an entry effect somewhere on the loop. That shape re-arms its
 * own timer on every lap — server-side polling that runs for sessions nobody
 * is watching (and, before the TTL guard, kept them alive doing it).
 *
 * Deliberately NOT flagged, by construction:
 *   - after-rescue (the timer fires once into an error/terminal state — no
 *     path back, no cycle),
 *   - action-only or same-state `after` handlers (no state change means no
 *     re-entry, so the timer never re-arms — not a loop),
 *   - app machines (process housekeeping is the legitimate home for
 *     non-durable server clocks).
 *
 * The steer for a real finding: put the clock on the client and the staleness
 * policy in a guard — see the effects guide, "Who owns the clock".
 */
export function findPollLoops(defs: readonly AnyMachineDef[]): PollLoopFinding[] {
  const findings: PollLoopFinding[] = []

  for (const def of defs) {
    if (def.lifecycle !== 'session') continue

    // State graph over value-changing transitions only (engine semantics: a
    // missing or same-state `to` never re-enters, so it can't re-arm).
    const edges = new Map<string, Set<string>>()
    for (const [stateKey, node] of Object.entries(def.states)) {
      const targets = new Set<string>()
      for (const raw of Object.values(node.on ?? {})) {
        const candidates = Array.isArray(raw) ? raw : [raw]
        for (const c of candidates) {
          const to =
            typeof c === 'function' ? undefined : (c as TransitionConfig<object, never, string>).to
          if (to && to !== stateKey) targets.add(to)
        }
      }
      edges.set(stateKey, targets)
    }

    const hasEntry = (s: string): boolean => def.states[s]?.entry !== undefined

    for (const [stateKey, node] of Object.entries(def.states)) {
      for (const after of node.after ?? []) {
        const event = (after.send as { type: string }).type
        const raw = node.on?.[event]
        if (!raw) continue
        const candidates = Array.isArray(raw) ? raw : [raw]
        for (const c of candidates) {
          const to =
            typeof c === 'function' ? undefined : (c as TransitionConfig<object, never, string>).to
          if (!to || to === stateKey) continue

          // BFS from the after-target: can we get back to stateKey?
          const parent = new Map<string, string>()
          const queue = [to]
          const seen = new Set([to])
          let found = false
          while (queue.length > 0 && !found) {
            const cur = queue.shift()!
            for (const next of edges.get(cur) ?? []) {
              if (next === stateKey) {
                parent.set(next, cur)
                found = true
                break
              }
              if (!seen.has(next)) {
                seen.add(next)
                parent.set(next, cur)
                queue.push(next)
              }
            }
          }
          if (!found) continue

          // Reconstruct one lap and require an entry effect somewhere on it —
          // a data-load somewhere in the loop is what makes it a POLL.
          const path: string[] = []
          let cursor: string | undefined = stateKey
          while (cursor !== undefined) {
            path.push(cursor)
            if (cursor === to) break
            cursor = parent.get(cursor)
          }
          path.reverse() // [to, ..., stateKey]
          const lap = [stateKey, ...path]
          if (!lap.some(hasEntry)) continue

          findings.push({ machine: def.name, state: stateKey, event, cycle: lap })
        }
      }
    }
  }

  return findings
}
