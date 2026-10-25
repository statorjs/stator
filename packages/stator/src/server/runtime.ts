/**
 * `/server/runtime` — the TOOLCHAIN tier of the server: what compiled `.stator`
 * output, the dev server, the build and the framework's own tests run on.
 * Public because they must be importable from a package boundary, not
 * because an app should need them; per the docs' stability policy these may
 * change in a minor. The STABLE app surface lives on `/server`.
 */
export { discoverBoot, isBootDefinition, runBoot } from './boot.ts'
export { isStatorMachine } from './define-machine.ts'
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
export type { ResolvedImagesConfig } from './images.ts'
export { DEFAULT_IMAGE_WIDTHS, resolveImagesConfig } from './images.ts'
export type { InspectPayload, InspectRoute, InspectRouteMethod } from './inspect.ts'
export { buildInspectPayload } from './inspect.ts'
export type { InstanceHandle } from './instance-proxy.ts'
export { createInstanceProxy, defForProxy } from './instance-proxy.ts'
export { codeHashOf, codeInputsOf } from './machine-hash.ts'
export { MachineStore } from './machine-store.ts'
export { discoverMiddleware, isMiddlewareDefinition } from './middleware.ts'
export { runQueryRoute } from './query-route.ts'
export { recompute } from './recompute.ts'
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
export { isStatorApiRoute, isStatorQueryRoute, isStatorRoute } from './routing.ts'
export { getOrCreateSessionId, SESSION_COOKIE, setSessionSameSite } from './session.ts'
export { SessionRuntime } from './session-runtime.ts'
export type { Connection } from './sse.ts'
export { fanOut, registerConnection, unregisterConnection } from './sse.ts'
