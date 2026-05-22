---
title: Route request context with path params and query
status: draft
created: 2026-05-21
updated: 2026-05-21
area: runtime
---

## What and Why

The framework's route definition today is machine-shaped. `defineRoute({ reads, render })` gives the render function a context object keyed by machine name. Anything that isn't machine state, the route can't see.

That worked for the example app because the cart, checkout, and admin routes are all "render the user's session." A real app needs more. A poll has an id in its URL. A search page has a query string. A document view has a slug. None of those live in machine state, they live in the request.

The why: routes are the boundary where URL state meets machine state. Routes that can't read URL state aren't really routes, they're machine projections at fixed URLs. The framework needs the boundary to be expressible.

The dogfood that surfaced this: a live poll demo where `/p/:id` shows a specific poll. The id isn't session state, it isn't app state, it's request state. Building anything beyond toy demos without this is awkward.

## Success Criteria

- A route file at `apps/x/routes/p/[id].ts` is discovered and mounts at `/p/:id`.
- A route file at `apps/x/routes/p/index.ts` is discovered and mounts at `/p`.
- A route's `render` function receives the param as `request.params.id` (typed `string`).
- A route's `render` function also receives `request.query` as `Record<string, string | undefined>` for query strings.
- The existing example app's routes either keep working unchanged (if they ignore the new arg) or update minimally to accept it.
- SSE routes with path params work: the connection's `routeKey` is the literal path (`GET /p/abc-123`), the server resolves it back to a route pattern + params on connection open, and fan-out correctly identifies which patches go to which connection's poll.

## Constraints

- Bracket convention for params: `[name].ts`. This is the convention every modern JS meta-framework uses (Next, Astro, SvelteKit, Solid Start). Adopt it rather than inventing a new one.
- Nested params fall out for free: `[user]/[id].ts` works the same as a single param.
- Catch-all (`[...slug]`) and optional (`[[id]]`) params are deferred. Not needed for the dogfood, and the convention space is bigger than what one demo needs to validate.
- Files that don't export `GET`/`POST` are silently skipped during discovery. The old "throw if no method" behavior breaks recursive walks where utility files might coexist with route files.
- Query and params are plain strings. No schema validation at this layer. A Zod-validated overlay is V1 work, the same shape as the existing event-payload validation gap.

## Approach

**Discovery (`route-discovery.ts`):**

- Walk the routes directory recursively.
- For each file ending `.ts`/`.js` that exports `GET` or `POST`, compute the URL path by joining segments:
  - `index` segment maps to the directory itself (`p/index.ts` → `/p`).
  - `[name]` segment becomes `:name` in the resulting pattern.
  - Other segments are literal.
- The route's discovered record stores both the original pattern (`/p/:id`) for Hono registration and the list of param names (`['id']`) for runtime extraction.

**Route definition (`routing.ts`):**

```ts
defineRoute({
  reads: [PollsMachine],
  render: ({ PollsMachine }, request) => {
    const pollId = request.params.id        // string
    const sort = request.query.sort         // string | undefined
    ...
  }
})
```

The `request` arg is optional in the function signature; existing routes ignore it.

**Render (`render.ts`):**

- `renderRoute` accepts a `request: { params, query }` arg and passes it through to `route.render`.

**HTTP layer (`http.ts`):**

- For each discovered route, register with Hono using the pattern (`app.get('/p/:id', handler)`).
- Extract `params` via `c.req.param()` for each declared name. Extract `query` via `c.req.query()`. Pass both to `renderRoute`.

**SSE (`http.ts` + `sse.ts`):**

- The `/__sse?route=GET %2Fp%2Fabc-123` query carries the literal path.
- On open, match the literal path against the registered route patterns (Hono's matcher does this internally; we surface it).
- Extract the params at match time, store them in the `Connection` record, pass them into `renderRoute` for the initial render and into recompute for fan-out re-renders.

**Naming gotcha:** the framework's internal `RouteContext` type is reused. The first arg stays "machine context"; the second is the new "request context" with a different type. Renaming for clarity is fine but not required for correctness.

## Alternatives Considered

- **Single combined arg** (`render: (ctx) => ...` where `ctx` includes both machines and request). Rejected. Mixes two namespaces (machine names, framework keys) and creates collision risk if a user names a machine `request`.
- **Function-style routes** (`defineRoute('/p/:id', { reads, render })`). Considered as an alternative to file-based discovery for parameterized routes specifically. Rejected because mixing two route-declaration styles is worse than extending the file-based one consistently.
- **Different param syntax** (`$id`, `:id`, `{id}`). Bracket convention wins on commonality across the JS ecosystem.
- **Throw on no-method-export during discovery (status quo).** Rejected because it breaks the natural pattern of mixing utility files into the routes tree. Silent skip is the friendlier behavior.

## Open Questions

- Should `request` also carry headers, the raw `Request`, or the Hono `Context`? For the demo, just `params` + `query` is enough. Headers and raw access can grow into the type later. The principle: expose what's needed when it's needed, don't preemptively flatten the entire request object into the surface.
- Type safety for params. Today the param record is `Record<string, string>`. A type-aware version (where `[id].ts` produces a render signature with `request.params.id: string` typed exactly) is V1 work, paired with the rest of the type-safety push.
- Conflict resolution between query and param names. If a route is `/p/[id]` and the URL is `/p/abc?id=def`, which wins for `request.id`? My pick: keep them in separate namespaces (`request.params.id` and `request.query.id`). Never merge.

## Implementation Notes

(Will fill in after the change lands. Built alongside the poll demo as a dogfood.)
