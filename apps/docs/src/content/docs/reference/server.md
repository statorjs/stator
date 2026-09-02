---
title: "server"
description: "App assembly, machine and route definition, server-originated dispatch, and the persistence stores."
sidebar:
  order: 2
---

`@statorjs/stator/server` is the Node-side surface: everything that assembles, serves, and persists an app.

## createApp

Most apps don't call this directly — the [`stator` CLI](/introduction/installation/#the-cli) (`stator dev`/`build`/`start`) is the entry point, and configuration lives in [`stator.config.ts`](/reference/config/). `createApp` underlies `stator start` and is exported for hand-wiring a custom production entry. Its config mirrors `stator.config.ts`; the deprecated flat keys (`store`, `appStore`, `sessionTtlSeconds`, `ssePingMs`, `inspector`) still work but are superseded by the nested shape.

```ts
function createApp(config: CreateAppConfig): Promise<StatorApp>

interface CreateAppConfig {
  machinesDir: string
  routesDir: string
  staticDir?: string
  persistence?: {
    session?: Store          // session persistence; default InMemoryStore
    app?: AppStore           // persistence for `persist: true` app machines; default in-memory
  }
  sessions?: {
    ttlSeconds?: number                 // per-session TTL; default 86400 (24h)
    cookie?: { sameSite?: 'Lax' | 'Strict' }  // 'Strict' = allowlist-only CSRF posture
  }
  realtime?: { pingMs?: number }        // SSE heartbeat interval; default 25s
  dev?: { inspector?: boolean }         // serve + inject the wire inspector toolbar
  logging?: { level?: LogLevel }        // default warn in prod, info in dev; LOG_LEVEL wins
  host?: string                         // bind address (containers: '0.0.0.0')
  origin?: string                       // canonical URL; exposed via stator(c).origin
  trustedOrigins?: string[]             // cross-site WRITE allowlist (exact or *.wildcard)
  cors?: { origins?: string[]; credentials?: boolean }  // cross-origin READ policy
  headExtras?: (filePath: string) => string | Promise<string>
  buildId?: string                      // per-build id for the reload handshake
  machineHashes?: Record<string, string> // loadProductionHead(dist).machines
  middlewareFile?: string               // path to the app's middleware.ts
}

interface StatorApp {
  listen(port: number): Promise<void>
  hono: Hono                            // break-glass: the raw Hono app
  fetch(request: Request): Response | Promise<Response>
  store: MachineStore
  dispatchToApp(machine: MachineDef, event: EventOf<typeof machine>): Promise<{ committed: boolean }>
}
```

The production entry point. Discovers machines and routes from the given directories, boots app-lifecycle machines, wires cross-machine effects, and serves over Hono. `fetch` is the raw handler for tests; `store` is what you hand to [`dispatchToApp`](#dispatchtoapp) for server-originated events. In production, pass [`loadProductionHead`](/reference/dev-and-build/#loadproductionhead)'s result into the config (`headExtras`, `buildId`, and `machines` as `machineHashes` — a machine missing from the supplied hashes is a boot error; omit `machineHashes` and machines are hashed live at boot). The dev server serves the wire inspector toolbar by default; `dev: { inspector: true }` opts a production app in (demo sites want the wire visible).

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
function defineApiRoute(config: DefineQueryRouteConfig): QueryRouteDefinition  // method: 'GET'
function defineApiRoute(config: DefineApiRouteConfig): ApiRouteDefinition     // commands

interface DefineApiRouteConfig {
  reads?: MachineDef[]
  handler: (request: RouteRequest, helpers: ApiRouteHelpers) => ApiRouteResult | Promise<ApiRouteResult>
}

interface DefineQueryRouteConfig {
  method: 'GET'
  reads?: MachineDef[]
  handler: (request: RouteRequest, helpers: QueryRouteHelpers) => QueryRouteResult | Promise<QueryRouteResult>
}
```

Defines a non-page endpoint. Without `method`, it is a **command** route (`POST`/`PUT`/`PATCH`/`DELETE`): the handler returns either a raw `Response` or an `ApiRouteEnvelope` (the same `{ patches?, directives? }` wire envelope the client already knows how to apply), and `helpers.dispatch(machine, event)` sends an event to a machine addressed by its imported def — type-checked against that machine's event union, session-lifecycle only, and the machine must be in the route's `reads` graph.

With `method: 'GET'`, it is a **data route**: the handler receives `helpers.machines` (read proxies keyed by machine name, the same shape a page render context uses) and no `dispatch`. A plain return value is served as JSON; a string takes its `Content-Type` from the URL's extension; a raw `Response` passes through verbatim. Synthesized responses carry a strong `ETag` and answer `If-None-Match` with 304. See the [API routes guide](/guides/api-routes/#data-get-routes).

Command helpers also carry **`rotateSession(opts?: { clear?: boolean })`** — the session-fixation defense for privilege changes. Call it on login (state moves to a fresh session id; a captured old id becomes worthless) and on logout with `{ clear: true }` (the old session's state is deleted and the browser starts anonymous). It applies after the handler returns: state persists under the new id and the response carries the new cookie. Requires a store with `renameSession` — all built-in stores have it. See the [authentication recipe](/recipes/authentication/).

```ts
type Directive =
  | { type: 'navigate'; to: string }
  | { type: 'reload' }
  | { type: 'push-url'; to: string }
  | { type: 'replace-url'; to: string }
  | { type: 'focus'; target: { kind: 'slot' | 'element'; id: string } }
  | { type: 'scroll'; target: { kind: 'slot' | 'element'; id: string }; behavior?: 'smooth' | 'auto' }
  | { type: 'event'; name: string; detail?: unknown }
```

Related exports: `ApiRouteDefinition`, `ApiRouteHelpers`, `ApiRouteResult`, `ApiRouteEnvelope`, `QueryRouteDefinition`, `QueryRouteHelpers`, `QueryRouteResult`, `Directive`.

## dispatchToApp

```ts
function dispatchToApp(store: MachineStore, machine: MachineDef, event: EventOf<typeof machine>): Promise<{ committed: boolean }>
```

Server-originated dispatch to an **app-lifecycle** machine — the entry point for webhooks, cron jobs, and out-of-band work. No HTTP request, no session: it sends the event, persists any touched `persist: true` app machines, and fans the change out to every live SSE connection whose route reads a touched machine. Typed like client dispatch (imported def, checked event union). Returns `{ committed }` — a guard-dropped event commits nothing, which is how a webhook receiver tells a processed event from a dropped duplicate. Throws if the machine is session-lifecycle or unknown.

Prefer the bound method `app.dispatchToApp(machine, event)` — on both `StatorApp` and [`DevApp`](/reference/dev-and-build/) — over the standalone form: the standalone form needs the `store`, which the dev server doesn't expose (and in dev the method also runs in the right module instance, so SSE fan-out reaches live connections).

## Session stores

```ts
interface Store {
  get(sessionId: string, machineName: string): Promise<unknown | null>
  set(sessionId, machineName, snapshot, opts?: { ttlSeconds?: number }): Promise<void>
  has(sessionId: string, machineName: string): Promise<boolean>
  deleteSession(sessionId: string): Promise<void>
  renameSession?(oldSessionId: string, newSessionId: string): Promise<void>
}
```

The persistence boundary for session-scoped machine state. TTL is **per-session, not per-entry**: any `set` refreshes the whole session's expiry, so an active checkout keeps the cart alive too. `renameSession` is optional on custom adapters, but `rotateSession` throws without it (and `CachedStore` requires it on its backing store to expose it). Implementations:

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

The sibling boundary for **app-lifecycle** machines that opt in with `persist: true`: one blob per machine name, no TTL, no session key. `InMemoryAppStore` is the restart-wipe default; `RedisAppStore` makes app state durable. Two replicas persisting the same app machine will drift — single-writer is assumed.

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

## Images

```ts
interface ImageTransformer {
  probe(bytes: Uint8Array): Promise<{ width: number | null; height: number | null }>
  transform(input: Uint8Array, opts: { width?: number; height?: number; format: 'jpeg' | 'png' | 'webp' | 'avif' }): Promise<Uint8Array>
}
function sharpTransformer(): ImageTransformer   // the default implementation
function probeImage(bytes: Uint8Array, transformer?: ImageTransformer): Promise<{ width: number | null; height: number | null }>
```

The transformer seam behind the [image endpoint](/guides/styling-and-assets/#images): pure bytes-in/bytes-out, so the default (sharp, lazy-imported — image-free apps never load it) can be swapped via `images.transformer` in config. The framework owns everything around the adapter — path resolution, the variant disk cache, conditional GET. `probeImage` is for upload handlers: probe intrinsic dimensions **once at write time** and store them beside the file path; renders are synchronous and never do image IO, which is why [`<Image>`](/reference/components/#image--picture) requires dimensions from data. EXIF orientation is normalized on both sides of the seam: `probeImage` reports *display* dimensions for transposing orientations, and the default transformer bakes the rotation into every variant's pixels — stored dims and served bytes agree by construction.

## logger

```ts
const logger: Logger                       // pino
function scopedLogger(scope: string): Logger
```

The framework's pino logger, exported for application use. Pretty colored output in dev (when `pino-pretty` is installed), JSON in production. Level defaults to `warn` from `createApp`/production (errors and warnings only — successful per-request and per-connection lines log at `debug`) and `info` from the dev server; precedence is `LOG_LEVEL` env > `stator.config.ts`'s `logging.level` > default. `scopedLogger('checkout')` returns a child tagged with a `scope` field for filtering.

## Middleware & security

See the [Middleware & security guide](/guides/middleware/) for the full picture.

```ts
function defineMiddleware(handlers: MiddlewareHandler[]): MiddlewareDefinition
function dangerouslyDefineMiddleware(handlers: MiddlewareHandler[]): MiddlewareDefinition
function crossSiteGuard(opts?: { trustedOrigins?: string[]; strict?: boolean }): MiddlewareHandler
function cors(opts?: CorsOptions): MiddlewareHandler
function securityHeaders(opts?: SecurityHeadersOptions): MiddlewareHandler
function stator(c: Context): StatorContext  // resolved config on the request context
```

- **`defineMiddleware`** — the app's `middleware.ts` default export. Framework security defaults run first, then these handlers, then the route.
- **`dangerouslyDefineMiddleware`** — the same, without the security defaults (a greppable opt-out; skips only security, never framework plumbing).
- **`crossSiteGuard`** — the default cross-site (CSRF) write guard, exported so a `dangerously…` app can re-add it. On by default; reads `trustedOrigins` from the context.
- **`cors`** — cross-origin *read* policy. `origins` defaults to `trustedOrigins`.
- **`securityHeaders`** — opt-in baseline headers (nosniff always; frame/referrer by default; HSTS/CSP opt-in).
- **`stator(c)`** — read resolved config (`origin`, `trustedOrigins`, `cors`, `sameSite`) inside a middleware.

## Lower-level exports

Plumbing the framework itself runs on. Exported because compiled `.stator` output and the framework's own tooling import them, not because your app should need them — and held to the **Toolchain** tier of the [stability policy](/reference/overview/#stability-policy): these may change in a minor.

- `MachineStore` — the machine registry + actor manager behind `StatorApp.store`.
- `findPollLoops` (+ `PollLoopFinding`) — the dev-plane lint that detects self-rescheduling poll loops on session machines (an `after` timer whose event cycles back and re-arms it); the dev server runs it at boot and logs findings.
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
