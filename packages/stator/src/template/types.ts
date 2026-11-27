import type {
  AnyMachineDef,
  BrowserEventOf,
  InstanceOf as SelectorsOf,
  StateNameOf,
} from '../engine/index.ts'
import type { EventDescriptor } from '../server/render-context.ts'
import { HTML_FRAGMENT, hasBrand } from './brand.ts'

/**
 * The template-facing shape of a machine instance: the engine's selector view
 * (each selector as a property carrying its return type, callable if it returns
 * a function) plus the framework-provided `send` / `state` / `snapshot`. Both
 * `state` (the state-name union) and `send` (the event union) are typed to the
 * machine's own def, so `s.state === 'ready'` and `m.send({ type: 'SAVE', … })`
 * autocomplete and a typo — in the name or the payload — is a compile error.
 */
export type InstanceOf<TDef extends AnyMachineDef> = SelectorsOf<TDef> &
  InstanceCommon<StateNameOf<TDef>, BrowserEventOf<TDef>>

export interface InstanceCommon<
  TStateKey extends string = string,
  TEvent = { type: string; [k: string]: unknown },
> {
  send(event: TEvent): EventDescriptor | undefined
  readonly state: TStateKey
  readonly snapshot: unknown
}

/**
 * Opaque marker for rendered HTML chunks. Produced by the `html` tag and
 * `raw()`. The brand is symbol-keyed (./brand.ts), so a look-alike object
 * parsed from JSON is not a fragment and renders as escaped text.
 */
export interface HtmlFragment {
  readonly [HTML_FRAGMENT]: true
  readonly html: string
}

export function createHtmlFragment(html: string): HtmlFragment {
  return { [HTML_FRAGMENT]: true, html }
}

export function isHtmlFragment(v: unknown): v is HtmlFragment {
  return hasBrand(v, HTML_FRAGMENT)
}
