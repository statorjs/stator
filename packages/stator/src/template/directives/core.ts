import type { ElementId } from '../../server/render-context.ts'

export interface DirectiveContext<TArg> {
  /** The synthetic id of the element this directive is attached to. */
  elementId: ElementId
  /** The modifier portion of the directive, e.g. 'click' in `on('click', ...)`. */
  modifier: string
  /** The argument passed to the directive, e.g. the handler function. */
  arg: TArg
  /** Adds an attribute to the element (e.g. `data-event-click="..."`). */
  addAttribute(name: string, value: string): void
  /**
   * Records a cleanup function. Unused server-side in the POC; reserved
   * for V1 directives that bind server-side timers / SSE.
   */
  registerCleanup(fn: () => void): void
}

export interface DirectiveDefinition<TArg> {
  name: string
  apply(ctx: DirectiveContext<TArg>): void
}

export interface Directive<TArg> extends DirectiveDefinition<TArg> {
  readonly __isStatorDirective: true
}

export function defineDirective<TArg>(def: DirectiveDefinition<TArg>): Directive<TArg> {
  return { ...def, __isStatorDirective: true }
}

export interface DirectiveInvocation<TArg = unknown> {
  readonly __isStatorDirectiveInvocation: true
  directive: Directive<TArg>
  modifier: string
  arg: TArg
}

export function isDirectiveInvocation(v: unknown): v is DirectiveInvocation {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>).__isStatorDirectiveInvocation === true
  )
}

export function invoke<TArg>(
  directive: Directive<TArg>,
  modifier: string,
  arg: TArg,
): DirectiveInvocation<TArg> {
  return {
    __isStatorDirectiveInvocation: true,
    directive,
    modifier,
    arg,
  }
}
