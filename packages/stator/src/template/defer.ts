import { allocSlotId, requireCurrentRenderState, type SlotId } from '../server/render-context.ts'
import { createResource } from './resource.ts'
import type { HtmlFragment } from './types.ts'

/**
 * A deferred async region. Same position-marker shape as `EachResult` /
 * `BranchResult` — a `data-slot` span the resolve phase fills. Unlike those, it
 * registers no machine binding, so it is never re-diffed (static, one-shot).
 */
export interface DeferResult {
  readonly __isDeferResult: true
  readonly html: string
  readonly slotId: SlotId
}

export function isDeferResult(v: unknown): v is DeferResult {
  return (
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isDeferResult === true
  )
}

export interface DeferArms<T> {
  ready: (value: Awaited<T>) => HtmlFragment
  /** Optional. Absent ⇒ a rejection bubbles to route-level error handling. */
  error?: (reason: unknown) => HtmlFragment
}

/** The fill phase replaces this exact token with the rendered arm. An HTML
 *  comment: invisible if a slot somehow never fills, and uniquely keyed. */
export function deferSentinel(slotId: SlotId): string {
  return `<!--defer:${slotId}-->`
}

function deferPlaceholder(slotId: SlotId, inner: string): DeferResult {
  // `display: contents` so the wrapper span doesn't disturb the surrounding
  // element's layout — same rationale as each()/when().
  const html = `<span data-slot="${slotId}" data-defer="true" style="display:contents">${inner}</span>`
  return { __isDeferResult: true, html, slotId }
}

/**
 * Render an async region without making frontmatter async. `thunk` is kicked
 * during the synchronous render pass (closing over frontmatter locals); its
 * result is wrapped in a peekable resource and recorded, and the resolve phase
 * (server/render.ts) awaits it — in parallel with every other defer on the page
 * — then renders `ready(value)` / `error(reason)` inline. A synchronous thunk
 * result fills with no added latency and no placeholder.
 *
 * The thunk belongs *inside* `defer` (not a frontmatter const), so the framework
 * owns the kick: fired once on a cold render, never re-run on the `/__events`
 * re-diff.
 */
export function defer<T>(thunk: () => T | Promise<T>, arms: DeferArms<T>): DeferResult {
  const state = requireCurrentRenderState()
  const slotId = allocSlotId(state)

  // `/__events` re-diff baseline (under the session lock): never kick the thunk —
  // that would run I/O under the lock. The slot is static and never diffed, so an
  // inert placeholder is correct; the client keeps the content from its first render.
  if (!state.resolveDeferred) {
    return deferPlaceholder(slotId, '')
  }

  const resource = createResource(thunk)
  state.deferred.push({
    slotId,
    resource,
    ready: arms.ready as (value: unknown) => HtmlFragment,
    error: arms.error,
  })
  return deferPlaceholder(slotId, deferSentinel(slotId))
}
