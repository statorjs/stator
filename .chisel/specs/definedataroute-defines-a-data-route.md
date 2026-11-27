---
title: defineDataRoute defines a data route
status: shipped
created: 2026-11-27
updated: 2026-11-27
area: routing
---

## What and Why

`defineApiRoute` builds two different things. With `method: 'GET'` it builds a read-only data route: the handler gets `{ machines }`, and the config may carry `revision`. Without `method` it builds a command route: the handler gets `dispatch`, `rotateSession` and the claims and cookie helpers, and the export name (`POST`, `PUT`, `PATCH`, `DELETE`) is the HTTP method. `method: 'GET'` is the discriminator for both the overloads and the runtime branch in `server/routing.ts`.

Because a data route needs `method: 'GET'`, people guess that a command route takes `method: 'POST'`. It does not: that is a type error, which reads as "Stator can't do POST" (hit by indiepub.dev, 2026-11-15). [[defineapiroute-takes-any-http-method]] proposed making `method` legal on command routes (#282). The owner closed that PR on 2026-11-27 in favour of this spec: give the data route its own definer, so no route needs a `method` field, and remove `method` from `defineApiRoute` at 4.0.

## Success Criteria

- `defineDataRoute(config)` is exported from `@statorjs/stator/server`, with its config type `DefineDataRouteConfig`. The config is the data-route form of `defineApiRoute`'s config minus `method`: `reads?`, `handler`, `revision?`.
- It returns a `QueryRouteDefinition` with the same brand (`__isStatorQueryRoute`) and the same runtime shape as `defineApiRoute({ method: 'GET' })` built from the same fields. Discovery, dispatch, the response synthesis, conditional GETs, `revision`, derived caching, the inspector and packages built on Stator cannot tell the two apart, so an app can move one route at a time.
- One code path builds a data-route definition: the `method: 'GET'` branch of `defineApiRoute` calls `defineDataRoute`.
- The handler is typed as today's data-route handler: `machines` is typed off `reads`, and there is no `dispatch` or other command helper. `method` and `maxBodyBytes` on a `defineDataRoute` config are type errors.
- `defineApiRoute({ method: 'GET', … })` behaves exactly as before. Its overload carries `@deprecated`, pointing at `defineDataRoute`, so an editor strikes it through. The command overload is not deprecated: `defineApiRoute` stays the way to write a command route.
- `method: 'POST'` on a command route stays a type error. The command overload and `DefineApiRouteConfig` carry a doc comment, shown on hover, saying the export name is the method and there is no `method` field.
- A `defineDataRoute` exported as `POST`, `PUT`, `PATCH` or `DELETE` is rejected by discovery with the message a `method: 'GET'` definition gets today.
- The docs teach `defineDataRoute`, mark the `method: 'GET'` form deprecated with one note that it works until 4.0, and the API routes guide shows a `DELETE` command route with no `method` field.

## Constraints

- Minor release, non-breaking. Every existing `defineApiRoute` call typechecks and behaves the same.
- No runtime deprecation warning, and no field on the definition recording which function built it. The owner removed an equivalent tracking field from another change on the same day; the editor's `@deprecated` strike-through is the report for now.
- `server/http.ts` and `server/route-discovery.ts` do not change. Both read the brand, and the brand is the same.
- No `method` field is added anywhere, including to make the `method: 'POST'` error clearer.
- `examples/` and the test fixtures keep `defineApiRoute({ method: 'GET' })`. The examples must keep running on the published 3.0.x, because scaffolds fetch them from `main`.

## Approach

Verified against `feat/request-body-limits` (3.0.x plus body limits), 2026-11-27.

**The types** (`server/routing.ts`). `DefineDataRouteConfig<TReads>` holds the three data-route fields. `DefineQueryRouteConfig<TReads>`, the existing name, becomes `DefineDataRouteConfig<TReads>` plus `method: 'GET'`, so the two cannot drift. `QueryRouteDefinition`, `QueryRouteHelpers` and `QueryRouteResult` keep their names.

```ts
export interface DefineDataRouteConfig<TReads extends ReadonlyArray<AnyMachineDef> = readonly []> {
  reads?: TReads
  handler: (request: RouteRequest, helpers: QueryRouteHelpers<TReads>) => Promise<QueryRouteResult> | QueryRouteResult
  revision?: () => string | number | Promise<string | number>
}

export interface DefineQueryRouteConfig<TReads extends ReadonlyArray<AnyMachineDef> = readonly []>
  extends DefineDataRouteConfig<TReads> {
  method: 'GET'
}
```

`method` and `maxBodyBytes` passed to `defineDataRoute` in an object literal are excess-property errors (`'method' does not exist in type 'DefineDataRouteConfig<readonly []>'`).

**The functions.**

```ts
export function defineDataRoute<TReads extends ReadonlyArray<AnyMachineDef> = readonly []>(
  config: DefineDataRouteConfig<TReads>,
): QueryRouteDefinition {
  return {
    __isStatorQueryRoute: true,
    reads: config.reads ? [...config.reads] : [],
    handler: config.handler,
    revision: config.revision,
  }
}
```

`defineApiRoute`'s implementation replaces its inline data-route literal with `return defineDataRoute(config)` inside the existing `method === 'GET'` branch. The extra `method` property is not copied, as it was not before.

**Deprecation.** TypeScript reads JSDoc per overload, so the `@deprecated` tag goes on the `DefineQueryRouteConfig` overload only. A call that resolves to the command overload shows no strike-through. The tag's text names `defineDataRoute` and 4.0.

**The `method: 'POST'` error.** It stays `No overload matches this call`, ending in `'method' does not exist in type 'DefineApiRouteConfig<…>'`. The command overload's doc comment and `DefineApiRouteConfig`'s doc comment say the export name is the method and a data GET is `defineDataRoute`; an editor shows them on hover over the call or the type named in the error. That costs no API.

**Docs.** `reference/server.md` gains a `defineDataRoute` section (signature, `DefineDataRouteConfig` with `revision`, a short example) and its `defineApiRoute` section describes the command route, lists the GET overload as deprecated, and says it is removed in 4.0. `guides/api-routes.md` writes its data route with `defineDataRoute`, adds one note that the old spelling works until 4.0, and shows a `DELETE` command route. The root `README.md` and the package `README.md` name `defineDataRoute`. No recipe teaches `method: 'GET'`.

## Alternatives Considered

- **Accept `method` on command routes** (#282, [[defineapiroute-takes-any-http-method]]). `method?: CommandMethod` on `DefineApiRouteConfig`, checked against the export name by discovery. It makes the guess legal instead of removing the reason for it: two sources for one fact (the export name and the field), a new discovery check to keep them agreeing, and `method` still meaning "a different kind of route" when it is `'GET'`. Closed on 2026-11-27.
- **A type annotation on the export** (`export const GET: DataRoute = defineApiRoute({ … })`). An annotation cannot change which overload a call resolves to, so the handler's helpers would still be typed by `method`, and every data route would carry a type import.
- **Discovery infers the kind from the export name.** Discovery could build a data route from any `GET` export of `defineApiRoute`, with no `method`. That fixes the runtime but cannot type the handler: neither `defineApiRoute` nor TypeScript can see the name of the constant the result is assigned to, so the handler would not know whether it gets `machines` or `dispatch`.

## Not in this change

- **Reporting deprecated calls in `stator check`.** It comes with the route half of [[the-reads-family-rename-ships-as-aliases-machines-on-routes-peers-on-machines]], which adds one mechanism for every deprecated name. Until then the editor's `@deprecated` strike-through is the only report.
- **A runtime warning, or a field recording which function built a definition.** Left out on purpose; see Constraints.
- **Converting `examples/` and the test fixtures.** A scripted sweep after 3.1 is published converts them, so the examples keep running on 3.0.x until then.
- **Discovery's error messages.** They still name `defineApiRoute({ method: 'GET' })` as the way to write a data route, and a `defineDataRoute` under `DELETE` is reported as "created with method: 'GET'". Changing them means changing `server/route-discovery.ts`, which this change leaves alone.
- **Removing `method` from `defineApiRoute`.** At 4.0, recorded in the ROADMAP's 4.0 ledger: a `GET` export comes from `defineDataRoute`.

## Implementation Notes

One PR, S, stacked on `docs/request-body-limits`. Changeset: minor.

- `packages/stator/src/server/routing.ts`: `DefineDataRouteConfig`, `DefineQueryRouteConfig` extending it, `defineDataRoute`, the per-overload doc comments with `@deprecated` on the GET one, the doc comment on `DefineApiRouteConfig`.
- `packages/stator/src/server/index.ts`: export `defineDataRoute` and the `DefineDataRouteConfig` type. The root entry exports only config, so nothing else re-exports route definers.
- Tests: `tests/define-data-route.test.ts` (the two definers build equal definitions; a `defineDataRoute` GET serves JSON through `machines`, an ETag and 304, `revision` answering 304 without the handler, derived caching equal to the old spelling's, a claims read withdrawing it, a command POST in the same file; discovery lists it as GET and rejects it under `DELETE`), fixtures in `tests/fixtures/define-data-route/` and `tests/fixtures/data-route-as-delete/`; `tests/define-data-route-typing.test-d.ts` (typed `machines`, no `dispatch`, `method` and `maxBodyBytes` rejected, command routes unchanged and `method: 'POST'` still rejected); `tests/server-barrels.test.ts` lists `defineDataRoute`.
- Docs as listed under Approach. `ROADMAP.md` and [[implementation-plan-3-1-through-3-3]] name `defineDataRoute` in place of "any method" and add the 4.0 row.
