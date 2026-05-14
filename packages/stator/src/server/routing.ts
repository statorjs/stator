import type { MachineDef } from './define-machine.ts'
import type { HtmlFragment } from '../template/types.ts'

export type RouteContext = Record<string, unknown>

export interface RouteDefinition {
  readonly __isStatorRoute: true
  reads: MachineDef<any, any>[]
  render: (ctx: RouteContext) => HtmlFragment
}

export interface DefineRouteConfig<TReads extends ReadonlyArray<MachineDef<any, any>>> {
  reads: TReads
  render: (ctx: RouteContext) => HtmlFragment
}

export function defineRoute<TReads extends ReadonlyArray<MachineDef<any, any>>>(
  config: DefineRouteConfig<TReads>,
): RouteDefinition {
  return {
    __isStatorRoute: true,
    reads: [...config.reads],
    render: config.render,
  }
}

export function isStatorRoute(v: unknown): v is RouteDefinition {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorRoute === true
  )
}
