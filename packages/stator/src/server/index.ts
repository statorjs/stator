export { defineMachine, isStatorMachine } from './define-machine.ts'
export type {
  MachineDef,
  DefineMachineConfig,
  Lifecycle,
  SelectorMap,
  ActionHelpers,
  SubscribeEntry,
  SubscribeEvent,
} from './define-machine.ts'

export { MachineStore } from './machine-store.ts'
export { createInstanceProxy, defForProxy } from './instance-proxy.ts'
export type { InstanceHandle } from './instance-proxy.ts'

export { InMemoryStore } from './store.ts'
export type { Store } from './store.ts'

export { RedisStore } from './redis-store.ts'

export { CachedStore } from './cached-store.ts'
export type { CachedStoreOptions } from './cached-store.ts'

export { SessionRuntime } from './session-runtime.ts'

export { discoverMachines } from './discovery.ts'
export type { DiscoveryResult } from './discovery.ts'

export { defineRoute, isStatorRoute } from './routing.ts'
export type { RouteDefinition, RouteContext, DefineRouteConfig } from './routing.ts'

export { discoverRoutes } from './route-discovery.ts'
export type { DiscoveredRoute } from './route-discovery.ts'

export { renderRoute } from './render.ts'
export type { RenderResult } from './render.ts'

export { recompute } from './recompute.ts'
export type { Patch, SlotTarget, ElementTarget } from './recompute.ts'

export { getOrCreateSessionId, SESSION_COOKIE } from './session.ts'

export { buildHonoApp } from './http.ts'
export type { HttpConfig } from './http.ts'

export { logger, scopedLogger } from './logger.ts'

export { fanOut, registerConnection, unregisterConnection, activeConnectionCount } from './sse.ts'
export type { Connection } from './sse.ts'

export { createApp } from './create-app.ts'
export type { CreateAppConfig, StatorApp } from './create-app.ts'

export {
  getDispatchContext,
  withDispatchContext,
  recordTouch,
} from './dispatch-context.ts'
export type { DispatchContext } from './dispatch-context.ts'

export {
  createRenderState,
  runInRender,
  getCurrentRenderState,
  requireCurrentRenderState,
  allocSlotId,
  allocElementId,
  pushListScope,
  popListScope,
  registerBinding,
  unregisterBindingsForScope,
  createEventDescriptor,
  isEventDescriptor,
} from './render-context.ts'
export type {
  RenderState,
  Binding,
  BindingKind,
  EventDescriptor,
  SlotId,
  MachineName,
  SessionId,
  ElementId,
} from './render-context.ts'
