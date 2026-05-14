import type { MachineDef } from './define-machine.ts'
import type { HtmlFragment } from '../template/types.ts'

export type RouteContext = Record<string, unknown>

export interface RouteDefinition {
  readonly __isStatorRoute: true
  reads: MachineDef<any, any>[]
  render: (ctx: RouteContext) => HtmlFragment
  /** When true, the rendered page opens an SSE channel that receives
   *  patches when any of the route's `reads:` machines change state — from
   *  any session, not just the viewer's own POSTs. Opt-in: routes without
   *  this flag operate purely on POST request/response. */
  live: boolean
}

export interface DefineRouteConfig<TReads extends ReadonlyArray<MachineDef<any, any>>> {
  reads: TReads
  render: (ctx: RouteContext) => HtmlFragment
  live?: boolean
}

export function defineRoute<TReads extends ReadonlyArray<MachineDef<any, any>>>(
  config: DefineRouteConfig<TReads>,
): RouteDefinition {
  return {
    __isStatorRoute: true,
    reads: [...config.reads],
    render: config.render,
    live: config.live ?? false,
  }
}

export function isStatorRoute(v: unknown): v is RouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorRoute === true
  )
}
