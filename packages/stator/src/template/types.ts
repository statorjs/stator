import type { MachineDef } from '../server/define-machine.ts'
import type { EventDescriptor } from '../server/render-context.ts'

/**
 * The template-facing shape of a machine instance.
 * Selectors appear as plain properties (callable if the selector returns a function).
 * `send`, `state`, `snapshot` are framework-provided.
 */
export type InstanceOf<TDef extends MachineDef<any, any, any>> =
  TDef extends MachineDef<infer _TCtx, infer TS, infer TStateKey>
    ? { readonly [K in keyof TS]: ReturnType<TS[K]> } & InstanceCommon<TStateKey>
    : never

export interface InstanceCommon<TStateKey extends string = string> {
  send(event: { type: string; [k: string]: unknown }): EventDescriptor | void
  readonly state: TStateKey
  readonly snapshot: unknown
}

/**
 * Opaque marker for rendered HTML chunks. Produced by the `html` tag.
 */
export interface HtmlFragment {
  readonly __isHtmlFragment: true
  readonly html: string
}

export function createHtmlFragment(html: string): HtmlFragment {
  return { __isHtmlFragment: true, html }
}

export function isHtmlFragment(v: unknown): v is HtmlFragment {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isHtmlFragment === true
  )
}
