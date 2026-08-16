import type { MiddlewareHandler } from 'hono'

// A global-registry symbol so the brand survives the dev dual-instance: the app's
// `middleware.ts` is loaded through Vite while the framework may check it from the
// native module instance — `Symbol.for` resolves to the same symbol in both.
const MIDDLEWARE_BRAND = Symbol.for('stator.middleware.definition')

/**
 * The value an app's `middleware.ts` exports (default) — an ordered list of
 * Hono middleware plus whether the framework's security defaults are prepended.
 * Opaque: build it with `defineMiddleware` / `dangerouslyDefineMiddleware`.
 */
export interface MiddlewareDefinition {
  readonly [MIDDLEWARE_BRAND]: true
  readonly handlers: readonly MiddlewareHandler[]
  /** Prepend the framework's default security stack (`crossSiteGuard`, …)? */
  readonly withDefaults: boolean
}

/** Type guard for a discovered `middleware.ts` default export. */
export function isMiddlewareDefinition(value: unknown): value is MiddlewareDefinition {
  return typeof value === 'object' && value !== null && MIDDLEWARE_BRAND in value
}

/**
 * Define the app's HTTP middleware. The framework's security defaults
 * (`crossSiteGuard`, …) run first, then these handlers, then the route — so a
 * guard added here can't be missed by a route added later. Export the result as
 * the default from `middleware.ts` at the app root.
 *
 * Handlers are plain Hono middleware and run in array order.
 */
export function defineMiddleware(handlers: readonly MiddlewareHandler[]): MiddlewareDefinition {
  return { [MIDDLEWARE_BRAND]: true, handlers, withDefaults: true }
}

/**
 * Like `defineMiddleware`, but WITHOUT the framework security defaults — these
 * handlers are the entire stack. The `dangerously` name is the point: opting out
 * of the defaults is a visible, greppable decision that says "this app owns its
 * security." Re-add the exported primitives (`crossSiteGuard()`, …) as needed.
 *
 * This only skips the *security* defaults; framework request plumbing (sessions,
 * dispatch routing, logging, static) is not middleware and is never bypassed.
 */
export function dangerouslyDefineMiddleware(
  handlers: readonly MiddlewareHandler[],
): MiddlewareDefinition {
  return { [MIDDLEWARE_BRAND]: true, handlers, withDefaults: false }
}
