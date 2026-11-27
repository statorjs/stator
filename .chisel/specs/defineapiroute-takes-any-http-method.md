---
title: defineApiRoute takes any HTTP method
status: archived
created: 2026-11-15
updated: 2026-11-27
area: routing
---

Not shipped. Its PR (#282) was closed on 2026-11-27 in favour of a separate definer for data routes, so that no route needs a `method` field at all: `defineDataRoute` ships in 3.1, `defineApiRoute({ method: 'GET' })` is deprecated, and `method` is removed from `defineApiRoute` at 4.0. Making `method` legal on command routes would have added a second source for a fact the export name already states. See [`definedataroute-defines-a-data-route`](./definedataroute-defines-a-data-route.md).

## What and Why

A route file's export name already sets its HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`; `route-discovery.ts`). Inside `defineApiRoute`, though, `method` accepts only `'GET'`, where it switches the route to a read-only data route. Writing `method: 'POST'` (or `'DELETE'`) for a command route is a type error, which reads as "Stator can't do POST" (hit by indiepub.dev, 2026-11-15). The field should name the method for any route, with GET still meaning the data-route shape.

## Success Criteria

- `defineApiRoute({ method, … })` accepts every `HttpMethod`. `'GET'` keeps today's data-route typing (`{ machines }`, `revision`); any other method gives the command-route typing (`dispatch`, `rotateSession`, …).
- `method` stays optional for non-GET routes, so existing command routes don't change.
- Discovery checks every declared method against its export name, not only GET (`export const DELETE = defineApiRoute({ method: 'POST' })` is a located error).
- A wrong shape is caught twice, each time by name. The type error points at the helper that isn't there (`Property 'machines' does not exist on type 'ApiRouteHelpers'`); the discovery error names the fix ("a GET export needs `method: 'GET'`"). Types cannot see the export name, so the method-versus-export check is discovery's.
- `guides/api-routes.md` shows a DELETE command route.

## Constraints

- Non-breaking: every existing `defineApiRoute` call typechecks and behaves the same.
- Types and discovery only. Dispatch in `server/http.ts` already routes by export name and does not change; the declared method is a cross-check, never the routing key.
- No new HTTP methods. `HEAD` and `OPTIONS` stay out of `HTTP_METHODS`; CORS preflight is the `cors()` middleware's.

## Approach

Verified against `main` at 3.0.3 (2026-11-22).

**Where it stands.** `defineApiRoute` (`server/routing.ts`) has two overloads: `DefineQueryRouteConfig`, which requires `method: 'GET'`, and `DefineApiRouteConfig`, which has no `method` field at all. `method: 'POST'` therefore fails both, as an excess-property error on the second. The runtime branch is `'method' in config && config.method === 'GET'`; anything else becomes an `ApiRouteDefinition`, which does not keep the method. Discovery (`server/route-discovery.ts`) checks three things: a `GET` export that is a command definition, a non-GET export that carries the query brand, and a non-GET export that is not a `defineApiRoute` at all. A command definition has no method to compare, so `export const DELETE = defineApiRoute({ … })` can only ever be trusted. Dispatch (`server/http.ts`, the `app.on(method, '*', …)` loop) reads `matched.route[method]` by export name. Nothing in `packages/language-server`, `stator check` or `create-stator` knows about `defineApiRoute`; its typing is these overloads and nothing else, so there is no editor-side work.

**The type.** `HTTP_METHODS` and `HttpMethod` move from `route-discovery.ts` to `routing.ts`, because `route-discovery.ts` already imports from `routing.ts` and the config type now needs the union. `route-discovery.ts` re-exports both, so `inspect.ts` and any test importing them from there is untouched. Alongside them:

```ts
/** Every method a command route can be exported under. */
export type CommandMethod = Exclude<HttpMethod, 'GET'>

export interface DefineApiRouteConfig<TReads extends ReadonlyArray<AnyMachineDef>> {
  /** The method this route is exported under. Optional for a command route:
   *  the export name is what routes. Discovery checks the two agree. */
  method?: CommandMethod
  reads?: TReads
  handler: (request: RouteRequest, helpers: ApiRouteHelpers) => Promise<ApiRouteResult> | ApiRouteResult
}

export interface ApiRouteDefinition {
  readonly __isStatorApiRoute: true
  /** The declared method, when the route declared one. */
  method?: CommandMethod
  reads: AnyMachineDef[]
  handler: …
}
```

The overload order stays (query first, command second). Checked with `tsc` against a copy of the two config types: no `method`, `'POST'` and `'DELETE'` resolve to the command overload with `dispatch`/`rotateSession` typed; `'GET'` resolves to the query overload with `machines` typed; `method: 'POST'` with `{ machines }` reports `Property 'machines' does not exist on type 'ApiRouteHelpers'`; `method: 'GET'` with `{ dispatch }` reports `Property 'dispatch' does not exist on type 'QueryRouteHelpers<readonly []>'`; `method: 'OPTIONS'` and a `method` typed as the whole `HttpMethod` union report `No overload matches this call`. The last one is the cost of discriminating on a literal: a method held in a variable has to be narrowed before the call. Nobody writes that in a route file.

**The runtime.** `defineApiRoute` keeps its `=== 'GET'` branch and copies `method` onto the command definition when given. A value outside `HTTP_METHODS` (reachable from JavaScript, or through a cast) throws at definition time: `stator: defineApiRoute method must be one of GET, POST, PUT, PATCH, DELETE — got "post".` Lowercase is not normalised; the export names are uppercase and the field should read the same.

**Discovery.** The per-method loop gains one check, after the existing two:

```ts
const declared = (mod[m] as ApiRouteDefinition).method
if (declared !== undefined && declared !== m) {
  throw new Error(
    `stator: ${filePath} exports ${m} created with method: '${declared}' — the declared method ` +
      `must match the export name. Rename the export or change the method.`,
  )
}
```

The existing query-brand message ("Data routes are GET-only") stays, since `method: 'GET'` under a `POST` export is the same mistake seen from the other side. The `GET` branch splits its command-definition message in two: without a declared method it says what it says today (`without method: 'GET'`); with one, it says `exports GET created with method: 'POST'`. Both name `method: 'GET'` or `defineRoute` as the fix.

**Docs.** `guides/api-routes.md` gains a DELETE command route that declares its method, and one sentence that `method` is optional on a command route and required on a data route. `reference/server.md` adds `method?` to the `DefineApiRouteConfig` block and rewrites "Without `method`, it is a command route" to "Without `method`, or with any method but `'GET'`".

## Alternatives Considered

- **One config type with `method?: HttpMethod` and a conditional handler type.** A single signature reads well, but the handler's helper type then depends on a generic inferred from an optional property, and an omitted `method` has to default to the command shape through a conditional. The two-overload form already does this with plain interfaces and produces the property-level errors above.
- **Require `method` on every route.** Makes the file self-describing and breaks every existing command route. Could ride a major; nothing asks for it.
- **Route by the declared method instead of the export name.** Two sources of truth for one fact, and the export name is the one discovery, the inspector and the merge-by-URL step already read.
- **Leave discovery alone and treat `method` as documentation.** Then `export const DELETE = defineApiRoute({ method: 'POST' })` silently serves DELETE, which is the kind of quiet disagreement the GET check exists to prevent.

## Implementation Notes

One PR, small. Changeset: minor (a new accepted value on a public config type).

- `packages/stator/src/server/routing.ts`: `HTTP_METHODS`, `HttpMethod`, `CommandMethod`; `method?` on `DefineApiRouteConfig` and `ApiRouteDefinition`; the runtime copy and the definition-time throw; the doc comment above the overloads.
- `packages/stator/src/server/route-discovery.ts`: re-export `HTTP_METHODS`/`HttpMethod` from `routing.ts`; the declared-method check; the split GET message.
- `packages/stator/src/server/index.ts`: export `HttpMethod` and `CommandMethod` as types beside `DefineApiRouteConfig`.
- Tests: `tests/discovery.test.ts` (a `method: 'POST'` definition under `DELETE` is a located error; under `GET` it gets the new message; a matching declared method loads; an undeclared one still loads), with fixtures beside `tests/fixtures/route-query-as-post/` and `tests/fixtures/route-mismatch/`. A new `tests/api-route-method-typing.test-d.ts` in the style of `data-route-reads-typing.test-d.ts` for the six type cases above. One unit test for the definition-time throw.
- Docs: `apps/docs/src/content/docs/guides/api-routes.md`, `apps/docs/src/content/docs/reference/server.md`.
- **Ordering with [[request-body-size-limits-for-uploads-and-api-routes]].** That spec adds `maxBodyBytes?` to the same two interfaces and to the same object literal in `defineApiRoute`. Land this one first and build the body-limit route override on top of it; done in parallel worktrees the two collide in `routing.ts` on adjacent lines. `maxBodyBytes` belongs on the command config only, which this spec's `CommandMethod` split makes explicit.
