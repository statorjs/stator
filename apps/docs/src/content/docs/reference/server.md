---
title: "server"
description: "App assembly, machine and route definition, server-originated dispatch, and the persistence stores."
sidebar:
  order: 2
---

`@statorjs/stator/server` is the Node-side surface: everything that assembles, serves, and persists an app.

## createApp

```ts
function createApp(config: CreateAppConfig): Promise<StatorApp>

interface CreateAppConfig {
  machinesDir: string
  routesDir: string
  staticDir?: string
  store?: Store            // session persistence; default InMemoryStore
  appStore?: AppStore      // persistence for `persist: true` app machines; default in-memory
  sessionTtlSeconds?: number // per-session TTL; default 86400 (24h)
  headExtras?: (filePath: string) => string | Promise<string>
}

interface StatorApp {
  listen(port: number): Promise<void>
  fetch(request: Request): Response | Promise<Response>
  store: MachineStore
}
```

The production entry point. Discovers machines and routes from the given directories, boots app-lifecycle machines, wires cross-machine effects, and serves over Hono. `fetch` is the raw handler for tests; `store` is what you hand to [`dispatchToApp`](#dispatchtoapp) for server-originated events. In production, pass [`loadProductionHead`](/reference/dev-and-build/#loadproductionhead)'s result as `headExtras`.

## defineMachine

Re-exported from [`@statorjs/stator/machine`](/reference/machine/#definemachine) so server code has one import surface — see that page for the full config. The machine-side types (`MachineDef`, `DefineMachineConfig`, `ActionHelpers`, `Lifecycle`, `SelectorMap`, `SubscribeEntry`, `SubscribeEvent`) are re-exported here too.

## defineRoute

```ts
function defineRoute(config: DefineRouteConfig): RouteDefinition

interface DefineRouteConfig {
  reads: MachineDef[]
  render: (ctx: RouteRenderContext, request: RouteRequest) => HtmlFragment
  live?: boolean
}
```

Defines a GET page. `reads` declares the machines the page renders from; `render` receives a context keyed by machine name plus a reserved `response` object (`status`, `headers`, and a `cookies.set`/`cookies.delete` helper) for response-level concerns. `request` wraps the underlying `Request` (`raw`) with parsed `params`, `query`, and body helpers (`formData()`, `json()`, `text()`, `arrayBuffer()`).

Set `live: true` and the rendered page opens an SSE channel that receives patches whenever any of the route's `reads` machines change — from any session, not just the viewer's own POSTs. Without it, the route operates purely on request/response.

`RouteDefinition`, `RouteRequest`, `RouteRenderContext`, `RouteResponseContext`, and `RouteCookieOptions` are all exported.

## defineApiRoute

```ts
function defineApiRoute(config: DefineApiRouteConfig): ApiRouteDefinition

interface DefineApiRouteConfig {
  reads?: MachineDef[]
  handler: (request: RouteRequest, helpers: ApiRouteHelpers) => ApiRouteResult | Promise<ApiRouteResult>
}
```

Defines a non-page endpoint. The handler returns either a raw `Response` or an `ApiRouteEnvelope` (the same `{ patches?, directives? }` wire envelope the client already knows how to apply). `helpers.dispatch(machine, event)` sends an event to a machine addressed by its imported def — the event is type-checked against that machine's event union, and the machine must be in the route's `reads` graph. Related exports: `ApiRouteDefinition`, `ApiRouteHelpers`, `ApiRouteResult`, `ApiRouteEnvelope`, `Directive`.

## dispatchToApp

```ts
function dispatchToApp(store: MachineStore, machine: MachineDef, event: EventOf<typeof machine>): Promise<void>
```

Server-originated dispatch to an **app-lifecycle** machine — the entry point for webhooks, cron jobs, and out-of-band work. No HTTP request, no session: it sends the event, persists any touched `persist: true` app machines, and fans the change out to every live SSE connection whose route reads a touched machine. Typed like client dispatch (imported def, checked event union). Throws if the machine is session-lifecycle or unknown.

## Session stores

```ts
interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId, machineName, snapshot, opts?: { ttlSeconds?: number }): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
}
```

The persistence boundary for session-scoped machine state. TTL is **per-session, not per-entry**: any `set` refreshes the whole session's expiry, so an active checkout keeps the cart alive too. Implementations:

- **`InMemoryStore`** — the default. Lazy expiry, gone on restart. Fine for dev.
- **`RedisStore`** — one Redis hash per session, machine names as fields; `HSET` + `EXPIRE` pipelined so the session TTL refreshes atomically. Takes a `redis://`/`rediss://` URL or ioredis options. Exposes `close()` and the raw client.
- **`CachedStore`** — a write-through, read-cached decorator over any backing `Store`. Bounded LRU (`maxEntries`, default 10 000) with a memory TTL capped at the backing TTL (`memoryTtlSeconds`, default 300). Single-replica only. Options type: `CachedStoreOptions`.

## App stores

```ts
interface AppStore {
  loadAppMachine(name: string): Promise<unknown | null>
  saveAppMachine(name: string, snapshot: unknown): Promise<void>
}
```

The sibling boundary for **app-lifecycle** machines that opt in with `persist: true`: one blob per machine name, no TTL, no session key. `InMemoryAppStore` is the restart-wipe default; `RedisAppStore` makes app state durable. Two replicas persisting the same app machine will drift — single-writer is assumed in 1.x.

## Wire types

```ts
type Patch =
  | { target: SlotTarget; op: 'text' | 'html'; value: string }
  | { target: ElementTarget; op: 'attr'; name: string; value: string }
  | { target: SlotTarget; op: 'insert'; index: number; value: string }
  | { target: SlotTarget; op: 'remove'; index: number }
  | { target: SlotTarget; op: 'move'; from: number; to: number }

interface WireEnvelope { patches?: Patch[]; directives?: Directive[] }
```

The shapes that cross the server/client boundary, re-exported for API routes and custom tooling: `Patch`, `PatchTarget`, `SlotTarget`, `ElementTarget`, `WireEnvelope`. Slot targets address `data-slot` positions; element targets address `data-stator-id` identities. The keyed-list ops (`insert`/`remove`/`move`) index element children sequentially — each op assumes the previous ops in the batch have been applied.

## logger

```ts
const logger: Logger                       // pino
function scopedLogger(scope: string): Logger
```

The framework's pino logger, exported for application use. Pretty colored output in dev (when `pino-pretty` is installed), JSON in production; level via `LOG_LEVEL` (default `info`). `scopedLogger('checkout')` returns a child tagged with a `scope` field for filtering.

## Lower-level exports

Plumbing the framework itself runs on. Exported because the dev server and tests load the runtime through Vite, not because your app should need them:

- `MachineStore` — the machine registry + actor manager behind `StatorApp.store`.
- `discoverMachines` / `discoverRoutes` (+ `DiscoveryResult`, `DiscoveredRoute`) — filesystem discovery `createApp` runs.
- `buildHonoApp` (+ `HttpConfig`) — assembles the Hono app from routes and a store.
- `renderRoute` (+ `RenderResult`) — renders one route for one session.
- `recompute` — re-evaluates bindings after a dispatch and emits wire patches.
- `withDispatchContext` / `getDispatchContext` / `recordTouch` (+ `DispatchContext`) — the ambient context a dispatch runs under.
- `scheduleSessionEffects` / `wireAppEffects` — host-side effect scheduling.
- `createInstanceProxy` / `defForProxy` (+ `InstanceHandle`) — the machine instance proxies `read()` resolves against.
- Render context: `createRenderState`, `runInRender`, `getCurrentRenderState`, `requireCurrentRenderState`, `registerBinding`, `unregisterBindingsForScope`, `allocElementId`, `allocSlotId`, `pushListScope`, `popListScope`, `createEventDescriptor`, `isEventDescriptor` (+ `Binding`, `BindingKind`, `ElementId`, `EventDescriptor`, `MachineName`, `RenderState`, `SessionId`, `SlotId`) — slot/binding bookkeeping during render.
- Sessions: `getOrCreateSessionId`, `SESSION_COOKIE`, `SessionRuntime`.
- SSE: `registerConnection`, `unregisterConnection`, `fanOut`, `activeConnectionCount` (+ `Connection`).
- Brand guards: `isStatorMachine`, `isStatorRoute`, `isStatorApiRoute`.
