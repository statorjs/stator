/**
 * `/server` carries two tiers (see the docs' stability policy): the STABLE
 * app surface (createApp, defineMachine, defineApiRoute, the stores, logger,
 * dispatchToApp, rotateSession) and the TOOLCHAIN plumbing the compiler/Vite
 * module graph needs importable (recompute, renderRoute, buildHonoApp,
 * SessionRuntime, render-context internals, …). The Toolchain tier is not
 * covered by semver and is RESERVED to move to a dedicated subpath
 * (`@statorjs/stator/server/runtime`) in a 2.x minor — import it expecting
 * that move.
 */
export type {
  ElementTarget,
  Patch,
  PatchTarget,
  SlotTarget,
  WireEnvelope,
} from '../wire/index.ts'
export { dispatchToApp } from './app-dispatch.ts'
export type { AppStore } from './app-store.ts'
export { InMemoryAppStore } from './app-store.ts'
export type { BootContext, BootDefinition, BootFn, BootTeardown } from './boot.ts'
export { defineBoot, discoverBoot, isBootDefinition, runBoot } from './boot.ts'
export type { CachedStoreOptions } from './cached-store.ts'
export { CachedStore } from './cached-store.ts'
export type { StatorContext } from './context.ts'
export { stator } from './context.ts'
export type { CorsOptions } from './cors.ts'
export { cors } from './cors.ts'
export type { CreateAppConfig, StatorApp } from './create-app.ts'
export { createApp } from './create-app.ts'
export { crossSiteGuard } from './csrf.ts'
export type {
  ActionHelpers,
  DefineMachineConfig,
  Lifecycle,
  MachineDef,
  SelectorMap,
  SubscribeEntry,
  SubscribeEvent,
} from './define-machine.ts'
export { defineMachine, isStatorMachine } from './define-machine.ts'
export type { PollLoopFinding } from './dev-lint.ts'
export { findPollLoops } from './dev-lint.ts'
export type { DiscoveryResult } from './discovery.ts'
export { discoverMachines } from './discovery.ts'
export type { DispatchContext } from './dispatch-context.ts'
export {
  getDispatchContext,
  recordTouch,
  withDispatchContext,
} from './dispatch-context.ts'
export { scheduleSessionEffects, wireAppEffects } from './effects.ts'
export type { HttpConfig } from './http.ts'
export { buildHonoApp } from './http.ts'
export type { ImageTransformer, ResolvedImagesConfig } from './images.ts'
export {
  DEFAULT_IMAGE_WIDTHS,
  probeImage,
  resolveImagesConfig,
  sharpTransformer,
} from './images.ts'
export type { InspectPayload, InspectRoute, InspectRouteMethod } from './inspect.ts'
export { buildInspectPayload } from './inspect.ts'
export type { InstanceHandle } from './instance-proxy.ts'
export { createInstanceProxy, defForProxy } from './instance-proxy.ts'
export { logger, scopedLogger, setLogLevel } from './logger.ts'
export { codeHashOf, codeInputsOf } from './machine-hash.ts'
export { MachineStore } from './machine-store.ts'
export type { MiddlewareDefinition } from './middleware.ts'
export {
  dangerouslyDefineMiddleware,
  defineMiddleware,
  discoverMiddleware,
  isMiddlewareDefinition,
} from './middleware.ts'
export { runQueryRoute } from './query-route.ts'
export { recompute } from './recompute.ts'
export { RedisAppStore, RedisStore } from './redis-store.ts'
export type { RenderResult } from './render.ts'
export { renderRoute } from './render.ts'
export type {
  Binding,
  BindingKind,
  ElementId,
  EventDescriptor,
  MachineName,
  RenderState,
  SessionId,
  SlotId,
} from './render-context.ts'
export {
  allocElementId,
  allocSlotId,
  createEventDescriptor,
  createRenderState,
  getCurrentRenderState,
  isEventDescriptor,
  popListScope,
  pushListScope,
  registerBinding,
  requireCurrentRenderState,
  runInRender,
  unregisterBindingsForScope,
} from './render-context.ts'
export type { DiscoveredRoute } from './route-discovery.ts'
export { discoverRoutes } from './route-discovery.ts'
export type {
  ApiRouteDefinition,
  ApiRouteEnvelope,
  ApiRouteHelpers,
  ApiRouteResult,
  DefineApiRouteConfig,
  DefineQueryRouteConfig,
  DefineRouteConfig,
  Directive,
  QueryRouteDefinition,
  QueryRouteHelpers,
  QueryRouteResult,
  RouteContext,
  RouteCookieOptions,
  RouteDefinition,
  RouteRenderContext,
  RouteRequest,
  RouteResponseContext,
} from './routing.ts'
export {
  defineApiRoute,
  defineRoute,
  isStatorApiRoute,
  isStatorQueryRoute,
  isStatorRoute,
} from './routing.ts'
export type { SecurityHeadersOptions } from './security-headers.ts'
export { securityHeaders } from './security-headers.ts'
export { getOrCreateSessionId, SESSION_COOKIE, setSessionSameSite } from './session.ts'
export { SessionRuntime } from './session-runtime.ts'
export type { Connection } from './sse.ts'
export {
  activeConnectionCount,
  fanOut,
  registerConnection,
  unregisterConnection,
} from './sse.ts'
export type { Store } from './store.ts'
export { InMemoryStore } from './store.ts'
