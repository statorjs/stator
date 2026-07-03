import type { AnyMachineDef, InstanceOf as SelectorsOf } from '../engine/index.ts'
import type { EventDescriptor } from '../server/render-context.ts'

/**
 * The template-facing shape of a machine instance: the engine's selector view
 * (each selector as a property carrying its return type, callable if it returns
 * a function) plus the framework-provided `send` / `state` / `snapshot`.
 */
export type InstanceOf<TDef extends AnyMachineDef> = SelectorsOf<TDef> & InstanceCommon

export interface InstanceCommon<TStateKey extends string = string> {
  send(event: { type: string; [k: string]: unknown }): EventDescriptor | undefined
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
    typeof v === 'object' && v !== null && (v as Record<string, unknown>).__isHtmlFragment === true
  )
}
